//// Parimutuel payout arithmetic. Every function floors, so the sum of all
//// payouts can never exceed what the market holds.

use aiken/collection/list
use aiken/fuzz

/// Basis points in 100 %.
pub const bps: Int = 10000

pub fn total(pools: List<Int>) -> Int {
  list.foldl(pools, 0, fn(pool, acc) { acc + pool })
}

/// Fee charged when `winner` wins: `fee_bps` of the losing pools.
pub fn fee(pools: List<Int>, winner: Int, fee_bps: Int) -> Int {
  expect Some(winning) = list.at(pools, winner)
  ( total(pools) - winning ) * fee_bps / bps
}

/// What the winning side shares: all pools minus the fee.
pub fn pot(pools: List<Int>, winner: Int, fee_bps: Int) -> Int {
  total(pools) - fee(pools, winner, fee_bps)
}

/// Payout for `burned` winning tokens.
pub fn winner_payout(
  pools: List<Int>,
  winner: Int,
  fee_bps: Int,
  burned: Int,
) -> Int {
  expect Some(winning) = list.at(pools, winner)
  burned * pot(pools, winner, fee_bps) / winning
}

test fee_only_on_losing_pool() {
  // 70 ADA on YES, 30 ADA on NO, 3 % fee, YES wins: fee = 0.9 ADA
  fee([70_000_000, 30_000_000], 0, 300) == 900_000
}

test winner_gets_stake_back_plus_share() {
  // 10 of 70 ADA on the winning side get 10 + 30 * 0.97 * 10 / 70
  winner_payout([70_000_000, 30_000_000], 0, 300, 10_000_000) == 14_157_142
}

test zero_fee_splits_everything() {
  winner_payout([50, 50], 1, 0, 50) == 100
}

// ## Property tests

/// Random market: 2..8 pools of 1 lovelace to 1M ADA, a winner, a fee.
fn market_fuzzer() -> Fuzzer<(List<Int>, Int, Int)> {
  fuzz.list_between(fuzz.int_between(1, 1_000_000_000_000), 2, 8)
    |> fuzz.and_then(
        fn(pools) {
          fuzz.map2(
            fuzz.int_between(0, list.length(pools) - 1),
            fuzz.int_between(0, 1000),
            fn(winner, fee_bps) { (pools, winner, fee_bps) },
          )
        },
      )
}

test prop_claims_never_exceed_pot((pools, winner, fee_bps) via market_fuzzer()) {
  expect Some(winning) = list.at(pools, winner)
  // Split the winning side among three holders with uneven stakes.
  let a = winning / 3
  let b = winning / 7
  let c = winning - a - b
  let paid =
    winner_payout(pools, winner, fee_bps, a) + winner_payout(
      pools,
      winner,
      fee_bps,
      b,
    ) + winner_payout(pools, winner, fee_bps, c)
  and {
    paid <= pot(pools, winner, fee_bps),
    pot(pools, winner, fee_bps) <= total(pools),
    winner_payout(pools, winner, fee_bps, winning) == pot(pools, winner, fee_bps),
  }
}

test prop_winners_never_lose_stake(
  (pools, winner, fee_bps) via market_fuzzer(),
) {
  expect Some(winning) = list.at(pools, winner)
  let stake = winning / 2
  winner_payout(pools, winner, fee_bps, stake) >= stake
}

test prop_fee_only_from_losers((pools, winner, fee_bps) via market_fuzzer()) {
  expect Some(winning) = list.at(pools, winner)
  let losing = total(pools) - winning
  let f = fee(pools, winner, fee_bps)
  and {
    f >= 0,
    f <= losing,
    f <= losing * 1000 / bps,
  }
}
