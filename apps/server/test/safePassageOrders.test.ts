import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { createChain, encodeUtxo } from "../src/chain.js";
import { SafePassageService } from "../src/safePassage.js";
import { registerSafePassageApi } from "../src/safePassageApi.js";
import { HttpError } from "../src/util.js";
import type { AdsbSource } from "../src/adsb.js";

async function setup() {
  const cfg = loadConfig({ DEMO: "1", SAFE_PASSAGE_ENABLED: "1", SAFE_PASSAGE_MAX_OPEN: "2", DATA_DIR: mkdtempSync(join(tmpdir(), "safe-orders-")) });
  const ctx = await createChain(cfg);
  let inZone = true;
  const adsb: AdsbSource = { area: async () => [], byHex: async hex => hex.map(hex => ({ hex, lat: inZone ? 32 : 0, lon: inZone ? 54 : 0, onGround: false, timestamp: Date.now() })), track: async () => [], byCallsign: async () => [] };
  const service = new SafePassageService(cfg, ctx, adsb);
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ error: String(e) }));
  registerSafePassageApi(app, service, b => ctx.userLucid(b.address, b.utxos), () => { throw new HttpError(401, "unauthorized"); }, ctx);
  const user = ctx.demoWallets[0]!;
  const wallet = async () => ({ address: user.account.address, utxos: (await ctx.provider.getUtxos(user.account.address)).map(encodeUtxo) });
  const post = async (path: string, data = {}) => app.inject({ method: "POST", url: `/api/safe-passage/${path}`, payload: { ...await wallet(), ...data } });
  const submit = async (tx: string) => { const l = await ctx.newLucid(); l.selectWallet.fromSeed(user.account.seedPhrase); await (await l.fromTx(tx).sign.withWallet().complete()).submit(); ctx.emulator!.awaitBlock(1); };
  return { app, ctx, service, wallet, post, submit, leave: () => { inZone = false; } };
}

describe("Safe Passage uses the existing order lifecycle", () => {
  it("creates on first review, does not debit the bettor until signing, and reuses the same market", async () => {
    const x = await setup();
    try {
      const balance = async () => (await x.ctx.provider.getUtxos((await x.wallet()).address)).reduce((n, u) => n + (u.assets.lovelace ?? 0n), 0n);
      const initialBalance = await balance();
      const before = await x.wallet();
      await x.app.inject("/api/safe-passage/flight/abcdef");
      expect(x.service.all()).toHaveLength(0);
      const q = await x.post("quote", { hex: "abcdef", outcome: 0, stake: "5000000" });
      expect(q.statusCode, q.body).toBe(200);
      expect(await x.wallet()).toEqual(before);
      expect(await x.service.openOrders()).toHaveLength(0);
      const again = await x.post("quote", { hex: "abcdef", outcome: 0, stake: "5000000" });
      expect(again.json().marketId).toBe(q.json().marketId);
      await x.submit(q.json().tx);
      const afterOrder = await balance();
      expect(initialBalance - afterOrder).toBe(5_000_000n + 400_000n + 2_000_000n + BigInt(q.json().fee));
      expect((await x.post("portfolio")).json().orders).toHaveLength(1);
      await x.service.tick(); x.ctx.emulator!.awaitBlock(1); await x.service.refresh(true);
      expect(await balance() - afterOrder).toBe(2_000_000n);
      const portfolio = (await x.post("portfolio")).json();
      expect(portfolio.orders).toHaveLength(0);
      expect(portfolio.positions[0].yes).toBe("5000000");
      expect((await x.service.require(q.json().marketId)).datum.yes).toBe(5000000n);
    } finally { await x.app.close(); }
  });
  it("rejects invalid exposure before funding, preserves a frozen order, and lets its owner cancel", async () => {
    const x = await setup();
    try {
      const bad = await x.post("quote", { hex: "abcdef", outcome: 1, stake: "2000000" });
      expect(bad.statusCode).toBe(409); expect(x.service.all()).toHaveLength(0);
      const q = await x.post("quote", { hex: "abcdef", outcome: 1, stake: "1000000" });
      expect(q.statusCode, q.body).toBe(200); await x.submit(q.json().tx);
      await x.service.freeze(q.json().marketId, "Suspicion must stop pending order fills", []);
      x.ctx.emulator!.awaitBlock(1); await x.service.tick();
      expect((await x.service.require(q.json().marketId)).datum.no).toBe(0n);
      const [o] = (await x.post("portfolio")).json().orders;
      const cancel = await x.post("cancel", { txHash: o.txHash, outputIndex: o.outputIndex });
      expect(cancel.statusCode, cancel.body).toBe(200); await x.submit(cancel.json().tx);
      expect(await x.service.openOrders()).toHaveLength(0);
    } finally { await x.app.close(); }
  });
  it("never overbooks two competing 1000x orders; refunds an unfilled order after expiry", async () => {
    const x = await setup();
    try {
      const first = await x.post("quote", { hex: "abcdef", outcome: 1, stake: "1000000" });
      expect(first.statusCode, first.body).toBe(200); await x.submit(first.json().tx);
      const second = await x.post("quote", { marketId: first.json().marketId, outcome: 1, stake: "1000000" });
      expect(second.statusCode, second.body).toBe(200); await x.submit(second.json().tx);
      await x.service.tick(); x.ctx.emulator!.awaitBlock(1); await x.service.refresh(true);
      expect((await x.service.require(first.json().marketId)).datum.no).toBe(1000000n);
      expect(await x.service.openOrders()).toHaveLength(1);
      x.ctx.emulator!.awaitSlot(7 * 60);
      await x.service.tick(); x.ctx.emulator!.awaitBlock(1);
      expect(await x.service.openOrders()).toHaveLength(0);
      expect((await x.service.require(first.json().marketId)).datum.no).toBe(1000000n);
    } finally { await x.app.close(); }
  });
  it("does not book a queued bet once the aircraft leaves the zone", async () => {
    const x = await setup();
    try {
      const q = await x.post("quote", { hex: "abcdef", outcome: 0, stake: "1000000" });
      expect(q.statusCode, q.body).toBe(200); await x.submit(q.json().tx);
      x.leave(); await x.service.tick();
      expect((await x.service.require(q.json().marketId)).datum.yes).toBe(0n);
      expect(await x.service.openOrders()).toHaveLength(1);
    } finally { await x.app.close(); }
  });
});
