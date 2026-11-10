/**
 * Server pipeline on the emulator with fake ADS-B and route data:
 * market creation, bets through the HTTP API with a demo wallet, batching,
 * a simulated landing, oracle resolution and a claim.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { airportByIcao, destinationPoint, type Aircraft } from "@flightradar/core";
import type { AdsbSource } from "../src/adsb.js";
import { buildApi } from "../src/api.js";
import { Batcher } from "../src/batcher.js";
import { createChain, type ChainContext } from "../src/chain.js";
import { ChainIndex } from "../src/chainIndex.js";
import { loadConfig } from "../src/config.js";
import { MarketMaker } from "../src/marketMaker.js";
import { Oracle } from "../src/oracle.js";
import type { Route, RouteSource } from "../src/routes.js";
import { Store } from "../src/store.js";
import { Tracker } from "../src/tracker.js";
import { CamTraffic } from "../src/traffic.js";

class FakeAdsb implements AdsbSource {
  planes = new Map<string, Aircraft>();
  async area() {
    return [...this.planes.values()];
  }
  async byHex(hexes: string[]) {
    return hexes.map((h) => this.planes.get(h)).filter((a): a is Aircraft => !!a);
  }
  track(hexes: string[]) {
    return this.byHex(hexes);
  }
  async byCallsign(cs: string) {
    return [...this.planes.values()].filter((a) => a.callsign === cs);
  }
}

class FakeRoutes implements RouteSource {
  async lookup(callsign: string): Promise<Route | null> {
    return callsign === "BAW902" ? { callsign, flightNumber: "BA902", airline: "British Airways", origin: "EGLL", destination: "EDDF" } : null;
  }
}

const FRA = airportByIcao("EDDF")!;
const HEX = "4007f1";

let ctx: ChainContext;
let app: FastifyInstance;
let adsb: FakeAdsb;
let index: ChainIndex;
let maker: MarketMaker;
let tracker: Tracker;
let traffic: CamTraffic;
let oracle: Oracle;
let batcher: Batcher;
let marketId: string;

async function call<T>(method: "GET" | "POST", url: string, payload?: unknown): Promise<T> {
  const res = await app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
  if (res.statusCode >= 400) throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

async function block() {
  ctx.emulator!.awaitBlock(1);
  await index.refresh();
}

async function betAs(wallet: string, outcome: number, ada: number) {
  const w = await call<{ address: string; utxos: string[] }>("GET", `/api/demo/wallets/${wallet}/utxos`);
  const { tx } = await call<{ tx: string }>("POST", "/api/tx/bet", { ...w, marketId, outcome, stake: String(ada * 1_000_000) });
  const { witness } = await call<{ witness: string }>("POST", `/api/demo/wallets/${wallet}/sign`, { tx });
  return call<{ txHash: string }>("POST", "/api/tx/submit", { tx, witness });
}

async function lovelaceOf(wallet: string): Promise<bigint> {
  const res = await call<{ wallets: Array<{ name: string; lovelace: string }> }>("GET", "/api/demo/wallets");
  return BigInt(res.wallets.find((w) => w.name.toLowerCase() === wallet)!.lovelace);
}

describe("server pipeline (emulator, fake flight data)", () => {
  beforeAll(async () => {
    const cfg = loadConfig({ DEMO: "1", DATA_DIR: mkdtempSync(join(tmpdir(), "frf-")) } as NodeJS.ProcessEnv);
    ctx = await createChain(cfg);
    adsb = new FakeAdsb();
    const store = new Store(cfg.DATA_DIR);
    tracker = new Tracker(adsb);
    traffic = new CamTraffic(adsb);
    index = new ChainIndex(ctx);
    maker = new MarketMaker(cfg, ctx, index, adsb, new FakeRoutes(), undefined, store, tracker);
    oracle = new Oracle(ctx, tracker, undefined, store);
    batcher = new Batcher(ctx);
    app = await buildApi({ cfg, ctx, index, adsb, routes: new FakeRoutes(), schedule: undefined, store, maker, traffic, tracker });
    // BA902 cruising towards Frankfurt, 600 km west of it.
    const now = ctx.now();
    const p = destinationPoint(FRA, 270, 600);
    adsb.planes.set(HEX, { hex: HEX, callsign: "BAW902", lat: p.lat, lon: p.lon, altitudeFt: 36000, onGround: false, groundSpeedKt: 450, trackDeg: 90, timestamp: now });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("creates a seeded landing market on request", async () => {
    const created = await call<{ marketId: string; existing: boolean }>("POST", "/api/markets", { kind: "landing_before", hex: HEX });
    marketId = created.marketId;
    expect(created.existing).toBe(false);
    const again = await call<{ marketId: string; existing: boolean }>("POST", "/api/markets", { kind: "landing_before", hex: HEX });
    expect(again).toMatchObject({ marketId, existing: true });
    await block();
    const { market } = await call<{ market: { phase: string; pools: string[]; question: { threshold: number } } }>("GET", `/api/markets/${marketId}`);
    expect(market.phase).toBe("open");
    expect(market.pools.reduce((a, b) => a + BigInt(b), 0n)).toBe(20_000_000n);
  });

  it("shows only webcam-airport movements and flights with markets", async () => {
    const zrh = airportByIcao("LSZH")!;
    const p = destinationPoint(zrh, 0, 60);
    adsb.planes.set("4b1234", { hex: "4b1234", callsign: "SWR9", lat: p.lat, lon: p.lon, altitudeFt: 9000, onGround: false, groundSpeedKt: 250, trackDeg: 180, verticalRateFpm: -1200, timestamp: ctx.now() });
    adsb.planes.set("4b9999", { hex: "4b9999", callsign: "OVER1", lat: p.lat, lon: p.lon, altitudeFt: 38000, onGround: false, groundSpeedKt: 450, trackDeg: 90, verticalRateFpm: 0, timestamp: ctx.now() });
    await call("GET", "/api/aircraft"); // marks a client as watching
    for (let i = 0; i < 20; i++) await traffic.step();
    const { aircraft } = await call<{ aircraft: Array<{ hex: string; phase?: string; airport?: string; markets?: number }> }>("GET", "/api/aircraft");
    expect(aircraft.find((a) => a.hex === "4b1234")).toMatchObject({ phase: "landing", airport: "LSZH" });
    expect(aircraft.find((a) => a.hex === "4b9999")).toBeUndefined();
    expect(aircraft.find((a) => a.hex === HEX)).toMatchObject({ markets: 1 }); // 600 km out, shown because it has a market
    adsb.planes.delete("4b1234");
    adsb.planes.delete("4b9999");
  });

  it("takes bets through the API and batches them", async () => {
    await betAs("alice", 0, 10);
    await betAs("bob", 1, 4);
    await block();
    await batcher.tick(index.live, index.orders);
    await block();
    const { market } = await call<{ market: { pools: string[]; pending: { orders: number } } }>("GET", `/api/markets/${marketId}`);
    expect(market.pending.orders).toBe(0);
    expect(market.pools.reduce((a, b) => a + BigInt(b), 0n)).toBe(34_000_000n);
  });

  it("resolves YES after a touchdown before the line, and pays the winner", async () => {
    const { market } = await call<{ market: { question: { threshold: number }; pools: string[]; feeBps: number } }>("GET", `/api/markets/${marketId}`);
    const t = market.question.threshold - 10 * 60_000;
    // final approach and a ground position at Frankfurt ten minutes before the line
    adsb.planes.set(HEX, { hex: HEX, callsign: "BAW902", lat: 50.04, lon: 8.66, altitudeFt: 1100, onGround: false, groundSpeedKt: 145, verticalRateFpm: -700, trackDeg: 250, timestamp: t - 60_000 });
    await tracker.poll(t);
    adsb.planes.set(HEX, { hex: HEX, callsign: "BAW902", lat: 50.04, lon: 8.58, onGround: true, groundSpeedKt: 40, trackDeg: 250, timestamp: t });
    await tracker.poll(t + 1000);
    await oracle.tick(index.live);
    await block();
    const resolved = await call<{ market: { phase: string; winner: number; resolution?: { reason: string } }; evidence: { verdict: { winner: number } } }>(
      "GET",
      `/api/markets/${marketId}`,
    );
    expect(resolved.market.phase).toBe("resolved");
    expect(resolved.market.winner).toBe(0);
    expect(resolved.evidence.verdict.winner).toBe(0);

    const before = await lovelaceOf("alice");
    const w = await call<{ address: string; utxos: string[] }>("GET", "/api/demo/wallets/alice/utxos");
    const claim = await call<{ tx: string; value: string }>("POST", "/api/tx/claim", { ...w, marketId });
    expect(BigInt(claim.value)).toBeGreaterThan(10_000_000n);
    const { witness } = await call<{ witness: string }>("POST", "/api/demo/wallets/alice/sign", { tx: claim.tx });
    await call("POST", "/api/tx/submit", { tx: claim.tx, witness });
    await block();
    await batcher.tick(index.live, index.orders);
    await block();
    const after = await lovelaceOf("alice");
    // payout minus the claim order's batcher fee and network fees
    expect(after - before).toBeGreaterThan(BigInt(claim.value) - 1_000_000n);
  });
});
