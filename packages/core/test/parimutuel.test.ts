import { describe, expect, it } from "vitest";
import { parimutuel as pm } from "../src/index.js";

describe("parimutuel math matches the Aiken implementation", () => {
  it("takes the fee from the losing pool only", () => {
    expect(pm.fee([70_000_000n, 30_000_000n], 0, 300n)).toBe(900_000n);
  });

  it("pays stake plus share (Aiken test winner_gets_stake_back_plus_share)", () => {
    expect(pm.winnerPayout([70_000_000n, 30_000_000n], 0, 300n, 10_000_000n)).toBe(14_157_142n);
  });

  it("matches the claim scenario in validators/market.ak", () => {
    // 7 ADA YES, 8 ADA NO, YES wins, 1 ADA of YES
    expect(pm.winnerPayout([7_000_000n, 8_000_000n], 0, 300n, 1_000_000n)).toBe(2_108_571n);
    expect(pm.pot([7_000_000n, 8_000_000n], 0, 300n)).toBe(14_760_000n);
  });

  it("never pays out more than the pot across many holders", () => {
    const pools = [1_234_567n, 9_876_543n, 5_555_555n];
    const holders = [1n, 7n, 1_000_000n, 233_566n]; // sums to the winning pool
    const paid = holders.reduce((acc, h) => acc + pm.winnerPayout(pools, 0, 250n, h), 0n);
    expect(paid).toBeLessThanOrEqual(pm.pot(pools, 0, 250n));
  });

  it("quotes include the bettor's own stake in the pool", () => {
    const q = pm.quote([7_000_000n, 3_000_000n], 1, 300n, 5_000_000n);
    // pools after: 7 / 8; NO wins: fee 3 % of 7 ADA = 0.21 ADA; pot 14.79 ADA
    expect(q.poolsAfter).toEqual([7_000_000n, 8_000_000n]);
    expect(q.payout).toBe((5_000_000n * 14_790_000n) / 8_000_000n);
    expect(q.probabilityAfter).toBeCloseTo(8 / 15, 6);
    expect(q.multiplier).toBeGreaterThan(1);
  });

  it("marginal odds equal 1/p adjusted for the fee", () => {
    const [yes, no] = pm.marginalOdds([7_000_000n, 3_000_000n], 0n);
    expect(yes).toBeCloseTo(10 / 7, 9);
    expect(no).toBeCloseTo(10 / 3, 9);
  });

  it("seeds pools proportional to probabilities with a minimum", () => {
    expect(pm.seedPools([0.7, 0.3], 10_000_000n, 1_000_000n)).toEqual([7_000_000n, 3_000_000n]);
    // a 1 % event with 10 ADA would need 0.1 ADA: lifted to the 1 ADA minimum
    expect(pm.seedPools([0.01, 0.99], 10_000_000n, 1_000_000n)).toEqual([1_000_000n, 10_000_000n]);
    expect(pm.seedPools([0.01, 0.99], 100_000_000n, 1_000_000n)).toEqual([1_000_000n, 99_000_000n]);
  });
});
