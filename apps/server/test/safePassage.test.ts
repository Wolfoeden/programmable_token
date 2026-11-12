import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createChain, encodeUtxo, type ChainContext } from "../src/chain.js";
import { SafePassageService } from "../src/safePassage.js";
import { registerSafePassageApi } from "../src/safePassageApi.js";
import { HttpError } from "../src/util.js";
import type { AdsbSource } from "../src/adsb.js";

const token = "safe-test-operator-token";
const headers = { authorization: `Bearer ${token}` };
const cfg = loadConfig({ DEMO: "1", SAFE_PASSAGE_ENABLED: "1", SAFE_PASSAGE_MAX_OPEN: "1", DATA_DIR: mkdtempSync(join(tmpdir(), "safe-passage-")) });
let ctx: ChainContext, service: SafePassageService, id: string;
const app = Fastify();
const adsb: AdsbSource = { area: async () => [], byHex: async hex => hex.map(hex => ({ hex, lat: 32, lon: 54, onGround: false, timestamp: Date.now() })), track: async () => [], byCallsign: async () => [] };

describe("Safe Passage operator/API workflow", () => {
  beforeAll(async () => {
    ctx = await createChain(cfg); service = new SafePassageService(cfg, ctx, adsb);
    app.setErrorHandler((e, _req, reply) => reply.status(e instanceof HttpError ? e.status : e instanceof Error && e.name === "ZodError" ? 400 : 500).send({ error: e instanceof Error ? e.message : String(e) }));
    registerSafePassageApi(app, service, (b) => ctx.userLucid(b.address, b.utxos), req => {
      if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, "unauthorized");
    }, ctx);
    await app.ready();
  });
  afterAll(() => app.close());

  it("does not fund a market without authenticated explicit confirmation", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/safe-passage/fund", payload: { hex: "abcdef", confirmReserve: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/safe-passage/fund", headers, payload: { hex: "abcdef" } })).statusCode).toBe(400);
    expect((await app.inject("/api/safe-passage/flight/abcdef")).json().market).toBe(null);
  });
  it("funds a real escrow and enforces the operator's open-market cap", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/safe-passage/fund", headers, payload: { hex: "abcdef", confirmReserve: true } });
    expect(res.statusCode, res.body).toBe(200); id = res.json().marketId;
    ctx.emulator!.awaitBlock(1); await service.refresh(true);
    const response = (await app.inject("/api/safe-passage/flight/abcdef")).json();
    expect(response.market.odds).toEqual(["1.0001", "1000"]);
    expect(response.market.reserve).toBe("1000000000");
    const second = await app.inject({ method: "POST", url: "/api/admin/safe-passage/fund", headers, payload: { hex: "defabc", confirmReserve: true } });
    expect(second.statusCode).toBe(409);
  });
  it("quotes the exact fixed payout and rejects an uncovered stake", async () => {
    const w = ctx.demoWallets[0]!;
    const payload = { address: w.account.address, utxos: (await ctx.provider.getUtxos(w.account.address)).map(encodeUtxo), marketId: id, outcome: 1, stake: "1000000" };
    const quote = await app.inject({ method: "POST", url: "/api/safe-passage/quote", payload });
    expect(quote.statusCode, quote.body).toBe(200); expect(quote.json().payout).toBe("1000000000");
    expect((await app.inject({ method: "POST", url: "/api/safe-passage/quote", payload: { ...payload, stake: "2000000" } })).statusCode).toBe(409);
  });
  it("keeps a suspicion fail-closed across a submission failure and a restart", async () => {
    const run = vi.spyOn(ctx.operator, "run").mockRejectedValueOnce(new Error("submission failed"));
    await expect(service.freeze(id, "Unconfirmed incident report needs investigation", [])).rejects.toThrow("submission failed");
    run.mockRestore();
    const restarted = new SafePassageService(cfg, ctx, adsb);
    await expect(restarted.require(id, true)).rejects.toThrow("Betting is suspended");
    expect((await app.inject("/api/safe-passage/flight/abcdef")).json().market.phase).toBe("frozen");
  });
  it("freezes on chain and blocks payout before verification", async () => {
    const res = await app.inject({ method: "POST", url: `/api/admin/safe-passage/${id}/freeze`, headers, payload: { reason: "Unconfirmed incident report needs investigation", sources: [] } });
    expect(res.statusCode, res.body).toBe(200); ctx.emulator!.awaitBlock(1); await service.refresh(true);
    const w = ctx.demoWallets[0]!;
    const claim = await app.inject({ method: "POST", url: "/api/safe-passage/claim", payload: { address: w.account.address, utxos: [], marketId: id } });
    expect(claim.statusCode).toBe(409);
    expect((await app.inject("/api/safe-passage/flight/abcdef")).json().market.phase).toBe("frozen");
  });
  it("rejects NO without independent reviewed evidence and incident details", async () => {
    const url = `/api/admin/safe-passage/${id}/verify`;
    const base = { winner: 1, reason: "A report alone is not sufficient verification", sources: ["https://example.com/a"], reviewed: true };
    expect((await app.inject({ method: "POST", url, headers, payload: base })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url, headers, payload: { ...base, independentSourcesConfirmed: true, sources: ["https://example.com/a", "https://www.example.com/b"] } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url, payload: base })).statusCode).toBe(401);
    expect((await service.require(id)).datum.state.kind).toBe("frozen");
  });
  it("verifies a non-incident outcome and publishes the committed evidence", async () => {
    const res = await app.inject({ method: "POST", url: `/api/admin/safe-passage/${id}/verify`, headers,
      payload: { winner: 0, reason: "Confirmed successful passage; no qualifying incident", sources: ["https://example.com/verified-flight"], reviewed: true } });
    expect(res.statusCode, res.body).toBe(200); ctx.emulator!.awaitBlock(1); await service.refresh(true);
    const dto = (await app.inject("/api/safe-passage/flight/abcdef")).json().market;
    expect(dto.phase).toBe("resolved"); expect(dto.winner).toBe(0);
    expect(dto.evidenceHash).toBe(res.json().evidenceHash);
    expect(dto.evidence.reason).toContain("Confirmed successful");
  });
});
