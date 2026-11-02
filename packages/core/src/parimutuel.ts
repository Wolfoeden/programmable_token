/**
 * Parimutuel arithmetic, mirroring onchain/lib/flightradar/payout.ak exactly
 * (bigint, floor division). Off-chain quotes therefore match what the
 * validator will allow to be withdrawn.
 *
 * Model: every outcome has a pool. Bettors buy position tokens 1:1 per
 * lovelace. When outcome `w` wins, the fee is taken from the losing pools
 * and all winning tokens share the rest pro rata:
 *
 *   fee     = (total - pool[w]) * feeBps / 10000
 *   pot     = total - fee
 *   payout  = tokens * pot / pool[w]
 *
 * A winner never gets back less than their stake.
 */

export const BPS = 10_000n;

export function total(pools: readonly bigint[]): bigint {
  return pools.reduce((a, b) => a + b, 0n);
}

function at(pools: readonly bigint[], i: number): bigint {
  const p = pools[i];
  if (p === undefined) throw new RangeError(`outcome ${i} out of range`);
  return p;
}

export function fee(pools: readonly bigint[], winner: number, feeBps: bigint): bigint {
  return ((total(pools) - at(pools, winner)) * feeBps) / BPS;
}

export function pot(pools: readonly bigint[], winner: number, feeBps: bigint): bigint {
  return total(pools) - fee(pools, winner, feeBps);
}

export function winnerPayout(pools: readonly bigint[], winner: number, feeBps: bigint, tokens: bigint): bigint {
  const w = at(pools, winner);
  if (w === 0n) throw new RangeError("winning pool is empty");
  return (tokens * pot(pools, winner, feeBps)) / w;
}

/** Implied probability of each outcome: its share of all stakes. */
export function impliedProbabilities(pools: readonly bigint[]): number[] {
  const t = Number(total(pools));
  if (t === 0) return pools.map(() => 1 / pools.length);
  return pools.map((p) => Number(p) / t);
}

export interface Quote {
  /** Lovelace paid out if `outcome` wins, given the pools after this bet. */
  payout: bigint;
  /** payout / stake, the decimal odds at the current pools. */
  multiplier: number;
  /** Profit if the outcome wins. */
  profit: bigint;
  /** Implied probability of the outcome after the bet. */
  probabilityAfter: number;
  /** Pools after the bet. */
  poolsAfter: bigint[];
}

/**
 * What a bet of `stake` on `outcome` would pay if betting closed right after
 * it. Later bets change the final payout: more money on the other side
 * raises it, more money on the same side lowers it.
 */
export function quote(pools: readonly bigint[], outcome: number, feeBps: bigint, stake: bigint): Quote {
  if (stake <= 0n) throw new RangeError("stake must be positive");
  const poolsAfter = pools.map((p, i) => (i === outcome ? p + stake : p));
  const payout = winnerPayout(poolsAfter, outcome, feeBps, stake);
  return {
    payout,
    multiplier: Number(payout) / Number(stake),
    profit: payout - stake,
    probabilityAfter: impliedProbabilities(poolsAfter)[outcome] ?? 0,
    poolsAfter,
  };
}

/** Decimal odds for a marginal (infinitesimal) bet on each outcome. */
export function marginalOdds(pools: readonly bigint[], feeBps: bigint): number[] {
  const t = Number(total(pools));
  const f = Number(feeBps) / Number(BPS);
  return pools.map((p) => {
    const w = Number(p);
    if (w === 0) return Infinity;
    return (w + (t - w) * (1 - f)) / w;
  });
}

/**
 * Split `seedTotal` across outcomes so the implied probabilities match
 * `probabilities` as closely as possible, with at least `minSeed` per
 * outcome. Rounds to whole ADA. The sum may exceed `seedTotal` when the
 * minimum forces it.
 */
export function seedPools(probabilities: readonly number[], seedTotal: bigint, minSeed: bigint): bigint[] {
  const n = probabilities.length;
  if (n < 2) throw new RangeError("need at least two outcomes");
  const sum = probabilities.reduce((a, b) => a + b, 0);
  const norm = probabilities.map((p) => (sum > 0 ? Math.max(p, 0) / sum : 1 / n));
  const ada = 1_000_000n;
  const raw = norm.map((p) => BigInt(Math.round((Number(seedTotal) * p) / 1_000_000)) * ada);
  return raw.map((v) => (v < minSeed ? minSeed : v));
}
