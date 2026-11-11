/** Shadow evaluation on synthetic flights with a known model error. */
import { describe, expect, it } from "vitest";
import type { ShadowFlight } from "../src/shadow.js";
import { calibration, etaErrors, informedReturn, neededMargin, playerBets, report, simulateMarket } from "../src/shadowReport.js";

const MIN = 60_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
}

/**
 * Flights with a calibrated model: the error at each sample is the error of
 * the next sample plus fresh independent noise, so earlier estimates carry
 * no extra information and L − eta(t) ~ N(0, σ(t)). Plus a fixed bias.
 */
function flights(n: number, biasMin: number, seed = 7): ShadowFlight[] {
  const r = rng(seed);
  const out: ShadowFlight[] = [];
  const sigma = (remaining: number) => (1.5 + 0.06 * remaining) * MIN;
  for (let i = 0; i < n; i++) {
    const landedAt = 1_800_000_000_000 + i * 3 * 60 * MIN + Math.floor(r() * 5 * MIN);
    const times: number[] = [];
    for (let t = landedAt - 55 * MIN; t <= landedAt - MIN; t += 30_000) times.push(t);
    const samples = new Array(times.length);
    let err = gauss(r) * sigma(1);
    for (let k = times.length - 1; k >= 0; k--) {
      const rem = (landedAt - times[k]!) / MIN;
      if (k < times.length - 1) {
        const prev = (landedAt - times[k + 1]!) / MIN;
        err += gauss(r) * Math.sqrt(sigma(rem) ** 2 - sigma(prev) ** 2);
      }
      samples[k] = { t: times[k]!, distKm: rem * 7, etaMs: Math.round(landedAt - err - biasMin * MIN), sigmaMs: Math.round(sigma(rem)) };
    }
    out.push({ v: 1, hex: `a${String(i).padStart(5, "0")}`, airport: "EGLL", firstListedAt: times[0]!, samples, outcome: { status: "landed", landedAt, lastSeenAt: landedAt } });
  }
  return out;
}

describe("shadow report", () => {
  it("finds a calibrated model calibrated", () => {
    const fs = flights(3000, 0);
    const lead20 = etaErrors(fs).find((l) => l.lead === 20)!;
    expect(lead20.within1).toBeGreaterThan(0.64);
    expect(lead20.within1).toBeLessThan(0.72);
    expect(Math.abs(lead20.biasMin)).toBeLessThan(0.3);
    const markets = fs.map(simulateMarket).filter((m) => m !== null);
    expect(markets.length).toBeGreaterThan(2900);
    // Sampling noise and the 5-minute rounding of T leave some room.
    expect(neededMargin(calibration(markets))!).toBeLessThan(0.2);
  });

  it("asks for a large margin when the model is biased", () => {
    const markets = flights(3000, 5).map(simulateMarket).filter((m) => m !== null);
    expect(neededMargin(calibration(markets))!).toBeGreaterThan(0.5);
  });

  it("shows that a player with later information beats fixed odds; a margin only thins out the bets", () => {
    const markets = flights(3000, 0).map(simulateMarket).filter((m) => m !== null);
    const r = [0, 0.25].flatMap((m) => [5, 15].map((a) => informedReturn(markets, m, a)));
    expect(r[0]!.perUnit).toBeGreaterThan(0); // 5 min ahead, no margin
    expect(r[1]!.perUnit).toBeGreaterThan(r[0]!.perUnit); // more information, more profit
    expect(r[3]!.bets).toBeLessThan(r[1]!.bets); // a margin removes bets
  });

  it("prices real bets only when submitted, and sums the house result", () => {
    const fs = flights(2, 0);
    const f = fs[0]!;
    const T = f.outcome.landedAt! + 5 * MIN; // landed before T: "yes" wins
    const base = { v: 1 as const, kind: "bet" as const, at: f.outcome.landedAt! - 40 * MIN, marketId: "m", question: "landing_before", hex: f.hex, threshold: T, stake: "10000000", wallet: "w1", closeTime: f.outcome.landedAt! - 25 * MIN, pools: [], multiplier: 2, model: { etaMs: T, sigmaMs: 3 * MIN, pYes: 0.5 } };
    const recs = [
      { ...base, txHash: "a", outcome: 0 },
      { ...base, txHash: "b", outcome: 1 },
      { ...base, txHash: "c", outcome: 1 },
      { v: 1 as const, kind: "submitted" as const, txHash: "a", at: 0 },
      { v: 1 as const, kind: "submitted" as const, txHash: "b", at: 0 },
    ];
    const r = playerBets(fs, recs, [0, 0.1]);
    expect(r.submitted).toBe(2);
    // margin 0: yes pays 2 × 10, no loses 10 → house 20 − 20 = 0
    expect(r.results[0]!.houseAda).toBeCloseTo(0, 6);
    expect(r.results[1]!.houseAda).toBeCloseTo(20 - 10 * (1 / (0.5 * 1.1)), 6);
    expect(report(fs, recs)).toContain("Real players");
  });
});
