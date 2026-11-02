//// Market validator. One script hash serves as
////
//// - minting policy for the market NFT, the CIP-68 position tokens and
////   their reference NFTs, and
//// - spending validator for the market UTxO.
////
//// The validator only enforces conservation: lovelace in equals tokens
//// minted (bets), tokens burned equals lovelace out at the payout rate
//// (claims). Who receives tokens or lovelace is up to the transaction,
//// which is what makes batching through the `order` validator possible.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval
use cardano/address.{Address, Script}
use cardano/assets.{Assets, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use flightradar/checks
use flightradar/fixtures as fx
use flightradar/payout
use flightradar/tokens
use flightradar/types.{
  Bet, Claim, Close, CreateMarket, ForceVoid, MarketDatum, MarketMintRedeemer,
  MarketSpendRedeemer, MarketState, MintOrBurn, Open, Resolve, Resolved,
}

/// Minimum seed per outcome at creation (1 ADA), so every outcome has a
/// non-empty pool and a defined payout.
pub const min_seed: Int = 1_000_000

pub const max_outcomes: Int = 8

/// Fee cap: 10 % of the losing pools.
pub const max_fee_bps: Int = 1000

/// The oracle gets at least one hour after betting closes before anyone can
/// force-void the market.
pub const min_resolve_window: Int = 3_600_000

/// Bettors get at least 30 days after the resolve deadline to claim.
pub const min_claim_window: Int = 2_592_000_000

validator market(operator: VerificationKeyHash, metadata_store: ScriptHash) {
  mint(redeemer: MarketMintRedeemer, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      CreateMarket { seed } ->
        create_market(operator, metadata_store, seed, policy_id, self)
      MintOrBurn -> mint_or_burn(policy_id, self)
    }
  }

  spend(
    datum: Option<MarketDatum>,
    redeemer: MarketSpendRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum
    expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
    expect Script(policy_id) = own_input.output.address.payment_credential
    let nft = tokens.market_nft(datum.market_id)
    // Only the UTxO carrying the market NFT is a market.
    expect assets.quantity_of(own_input.output.value, policy_id, nft) == 1
    let outcomes = list.length(datum.pools)
    let deltas =
      checks.position_deltas(self.mint, policy_id, datum.market_id, outcomes)
    let ctx =
      Ctx {
        datum,
        deltas,
        in_lovelace: assets.lovelace_of(own_input.output.value),
        address: own_input.output.address,
        policy_id,
        nft,
      }
    and {
      checks.no_foreign_outcomes(
        self.mint,
        policy_id,
        datum.market_id,
        outcomes,
      ),
      when redeemer is {
        Bet -> bet(ctx, self)
        Resolve { winner } -> resolve(operator, winner, ctx, self)
        ForceVoid -> force_void(ctx, self)
        Claim -> claim(ctx, self)
        Close -> close(operator, ctx, self)
      },
    }
  }

  else(_) {
    fail
  }
}

type Ctx {
  datum: MarketDatum,
  deltas: List<Int>,
  in_lovelace: Int,
  address: Address,
  policy_id: PolicyId,
  nft: ByteArray,
}

// ## Minting

fn create_market(
  operator: VerificationKeyHash,
  metadata_store: ScriptHash,
  seed: OutputReference,
  policy_id: PolicyId,
  self: Transaction,
) -> Bool {
  let market_id = tokens.market_id(seed)
  let nft = tokens.market_nft(market_id)
  let (output, datum) =
    checks.continuing_market(
      self.outputs,
      // The address is taken from the output itself; only its payment part
      // is constrained below. The operator may choose a stake credential.
      find_market_address(self, policy_id, nft),
      policy_id,
      nft,
    )
  let outcomes = list.length(datum.pools)
  let indices = list.range(0, outcomes - 1)
  let expected_mint =
    list.foldl(
      indices,
      assets.from_asset(policy_id, nft, 1),
      fn(i, acc) {
        expect Some(pool) = list.at(datum.pools, i)
        acc
          |> assets.add(policy_id, tokens.position_token(market_id, i), pool)
          |> assets.add(policy_id, tokens.reference_token(market_id, i), 1)
      },
    )
  let total = payout.total(datum.pools)
  and {
    list.any(self.inputs, fn(input) { input.output_reference == seed }),
    checks.signed_by(self, operator),
    output.address.payment_credential == Script(policy_id),
    assets.lovelace_of(output.value) >= total,
    datum.market_id == market_id,
    datum.state == Open,
    outcomes >= 2,
    outcomes <= max_outcomes,
    list.all(datum.pools, fn(pool) { pool >= min_seed }),
    total <= datum.max_total,
    datum.fee_bps >= 0,
    datum.fee_bps <= max_fee_bps,
    interval.is_entirely_before(self.validity_range, datum.close_time),
    datum.resolve_deadline - datum.close_time >= min_resolve_window,
    datum.claim_deadline - datum.resolve_deadline >= min_claim_window,
    assets.tokens(self.mint, policy_id) == assets.tokens(
      expected_mint,
      policy_id,
    ),
    list.all(
      indices,
      fn(i) {
        let reference = tokens.reference_token(market_id, i)
        list.any(
          self.outputs,
          fn(o) {
            and {
              o.address.payment_credential == Script(metadata_store),
              assets.quantity_of(o.value, policy_id, reference) == 1,
            }
          },
        )
      },
    ),
  }
}

fn find_market_address(
  self: Transaction,
  policy_id: PolicyId,
  nft: ByteArray,
) -> Address {
  expect Some(output) =
    list.find(
      self.outputs,
      fn(o) { assets.quantity_of(o.value, policy_id, nft) == 1 },
    )
  output.address
}

/// Burning is always allowed. Position tokens may only be minted while the
/// market they belong to is spent, which hands all further checks to the
/// spending validator. The market NFT and reference NFTs can only be minted
/// through `CreateMarket`.
fn mint_or_burn(policy_id: PolicyId, self: Transaction) -> Bool {
  assets.tokens(self.mint, policy_id)
    |> dict.to_pairs
    |> list.all(
        fn(Pair(name, quantity)) {
          if quantity < 0 {
            True
          } else {
            when tokens.position_market_id(name) is {
              Some(market_id) -> {
                let nft = tokens.market_nft(market_id)
                list.any(
                  self.inputs,
                  fn(input: Input) {
                    and {
                      input.output.address.payment_credential == Script(
                        policy_id,
                      ),
                      assets.quantity_of(input.output.value, policy_id, nft) == 1,
                    }
                  },
                )
              }
              None -> False
            }
          }
        },
      )
}

// ## Spending

fn bet(ctx: Ctx, self: Transaction) -> Bool {
  expect Open = ctx.datum.state
  let (output, new_datum) =
    checks.continuing_market(self.outputs, ctx.address, ctx.policy_id, ctx.nft)
  let staked = payout.total(ctx.deltas)
  let new_pools =
    list.map2(ctx.datum.pools, ctx.deltas, fn(pool, delta) { pool + delta })
  and {
    interval.is_entirely_before(self.validity_range, ctx.datum.close_time),
    list.all(ctx.deltas, fn(delta) { delta >= 0 }),
    staked > 0,
    new_datum == MarketDatum { ..ctx.datum, pools: new_pools },
    payout.total(new_pools) <= ctx.datum.max_total,
    assets.lovelace_of(output.value) == ctx.in_lovelace + staked,
  }
}

fn resolve(
  operator: VerificationKeyHash,
  winner: Option<Int>,
  ctx: Ctx,
  self: Transaction,
) -> Bool {
  expect Open = ctx.datum.state
  let (output, new_datum) =
    checks.continuing_market(self.outputs, ctx.address, ctx.policy_id, ctx.nft)
  let fee =
    when winner is {
      Some(i) -> {
        // Fails for an outcome index the market does not have.
        expect Some(winning) = list.at(ctx.datum.pools, i)
        expect winning > 0
        payout.fee(ctx.datum.pools, i, ctx.datum.fee_bps)
      }
      None -> 0
    }
  and {
    checks.signed_by(self, operator),
    new_datum == MarketDatum { ..ctx.datum, state: Resolved { winner } },
    assets.lovelace_of(output.value) >= ctx.in_lovelace - fee,
    list.all(ctx.deltas, fn(delta) { delta == 0 }),
  }
}

fn force_void(ctx: Ctx, self: Transaction) -> Bool {
  expect Open = ctx.datum.state
  let (output, new_datum) =
    checks.continuing_market(self.outputs, ctx.address, ctx.policy_id, ctx.nft)
  and {
    interval.is_entirely_after(self.validity_range, ctx.datum.resolve_deadline),
    new_datum == MarketDatum { ..ctx.datum, state: Resolved { winner: None } },
    assets.lovelace_of(output.value) >= ctx.in_lovelace,
    list.all(ctx.deltas, fn(delta) { delta == 0 }),
  }
}

fn claim(ctx: Ctx, self: Transaction) -> Bool {
  expect Resolved { winner } = ctx.datum.state
  let (output, new_datum) =
    checks.continuing_market(self.outputs, ctx.address, ctx.policy_id, ctx.nft)
  let allowed =
    when winner is {
      Some(i) -> {
        expect Some(delta) = list.at(ctx.deltas, i)
        payout.winner_payout(ctx.datum.pools, i, ctx.datum.fee_bps, -delta)
      }
      None -> -payout.total(ctx.deltas)
    }
  and {
    list.all(ctx.deltas, fn(delta) { delta <= 0 }),
    new_datum == ctx.datum,
    assets.lovelace_of(output.value) >= ctx.in_lovelace - allowed,
  }
}

fn close(operator: VerificationKeyHash, ctx: Ctx, self: Transaction) -> Bool {
  and {
    checks.signed_by(self, operator),
    interval.is_entirely_after(self.validity_range, ctx.datum.claim_deadline),
    assets.quantity_of(self.mint, ctx.policy_id, ctx.nft) == -1,
    list.all(ctx.deltas, fn(delta) { delta <= 0 }),
  }
}

// ## Tests
//
// Scenario: a binary market "lands before 18:30Z" seeded by the operator with
// 7 ADA on YES (outcome 0) and 3 ADA on NO (outcome 1), i.e. 70 % implied.
// The market UTxO keeps 2 ADA on top of the pools as min-ADA buffer.

const buffer: Int = 2_000_000

fn seeded() -> MarketDatum {
  fx.open_datum([7_000_000, 3_000_000])
}

fn reference_output(outcome: Int) -> Output {
  Output {
    address: address.from_script(fx.metadata_store),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(fx.policy, tokens.reference_token(fx.market_id(), outcome), 1),
    datum: InlineDatum("cip68 metadata"),
    reference_script: None,
  }
}

fn creation_mint(pools: List<Int>) -> Assets {
  list.indexed_foldr(
    pools,
    fx.nft(),
    fn(i, pool, acc) {
      acc
        |> assets.merge(fx.position(i, pool))
        |> assets.add(fx.policy, tokens.reference_token(fx.market_id(), i), 1)
    },
  )
}

fn seed_input() -> Input {
  Input {
    output_reference: fx.seed,
    output: fx.wallet_output(fx.operator, assets.from_lovelace(100_000_000)),
  }
}

fn create(
  _datum: MarketDatum,
  mint: Assets,
  outputs: List<Output>,
  range: interval.Interval,
  signers: List<ByteArray>,
) -> Bool {
  market.mint(
    fx.operator,
    fx.metadata_store,
    CreateMarket { seed: fx.seed },
    fx.policy,
    fx.tx([seed_input()], outputs, mint, range, signers),
  )
}

fn default_outputs(d: MarketDatum) -> List<Output> {
  [
    fx.market_output(buffer + payout.total(d.pools), d),
    reference_output(0),
    reference_output(1),
  ]
}

test create_market_ok() {
  let d = seeded()
  create(
    d,
    creation_mint(d.pools),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_requires_operator() fail {
  let d = seeded()
  create(
    d,
    creation_mint(d.pools),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.mallory],
  )
}

test create_market_requires_seed() fail {
  let d = seeded()
  market.mint(
    fx.operator,
    fx.metadata_store,
    CreateMarket { seed: fx.ref(9) },
    fx.policy,
    fx.tx(
      [seed_input()],
      default_outputs(d),
      creation_mint(d.pools),
      fx.before(fx.close_time),
      [fx.operator],
    ),
  )
}

test create_market_rejects_tiny_seed() fail {
  let d = fx.open_datum([7_000_000, 999_999])
  create(
    d,
    creation_mint(d.pools),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_extra_tokens() fail {
  let d = seeded()
  create(
    d,
    creation_mint(d.pools) |> assets.merge(fx.position(2, 1)),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_more_positions_than_pool() fail {
  let d = seeded()
  create(
    d,
    creation_mint(d.pools) |> assets.merge(fx.position(0, 1)),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_requires_reference_nfts_in_store() fail {
  let d = seeded()
  let stolen =
    Output {
      ..reference_output(1),
      address: fx.wallet(fx.operator),
    }
  create(
    d,
    creation_mint(d.pools),
    [
      fx.market_output(buffer + payout.total(d.pools), d),
      reference_output(0),
      stolen,
    ],
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_past_close() fail {
  let d = seeded()
  create(
    d,
    creation_mint(d.pools),
    default_outputs(d),
    fx.after(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_high_fee() fail {
  let d = MarketDatum { ..seeded(), fee_bps: 1001 }
  create(
    d,
    creation_mint(d.pools),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_short_claim_window() fail {
  let base = seeded()
  let d =
    MarketDatum { ..base, claim_deadline: base.resolve_deadline + fx.day }
  create(
    d,
    creation_mint(d.pools),
    default_outputs(d),
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_underfunded_market() fail {
  let d = seeded()
  create(
    d,
    creation_mint(d.pools),
    [
      fx.market_output(payout.total(d.pools) - 1, d),
      reference_output(0),
      reference_output(1),
    ],
    fx.before(fx.close_time),
    [fx.operator],
  )
}

test create_market_rejects_single_outcome() fail {
  let d = fx.open_datum([10_000_000])
  create(
    d,
    creation_mint(d.pools),
    [fx.market_output(buffer + 10_000_000, d), reference_output(0)],
    fx.before(fx.close_time),
    [fx.operator],
  )
}

// ### Betting

fn spend(d: MarketDatum, r: MarketSpendRedeemer, t: Transaction) -> Bool {
  market.spend(fx.operator, fx.metadata_store, Some(d), r, fx.market_ref, t)
}

fn mint_check(t: Transaction) -> Bool {
  market.mint(fx.operator, fx.metadata_store, MintOrBurn, fx.policy, t)
}

/// Bob stakes `stake` on NO and declares `new_datum` / `new_lovelace` for the
/// continuing market output.
fn bet_tx(
  minted: Assets,
  new_datum: MarketDatum,
  new_lovelace: Int,
  range: interval.Interval,
) -> Transaction {
  let d = seeded()
  fx.tx(
    [
      fx.market_input(buffer + 10_000_000, d),
      fx.wallet_input(1, fx.bob, assets.from_lovelace(50_000_000)),
    ],
    [
      fx.market_output(new_lovelace, new_datum),
      fx.wallet_output(fx.bob, minted),
    ],
    minted,
    range,
    [],
  )
}

test bet_ok() {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      fx.open_datum([7_000_000, 8_000_000]),
      buffer + 15_000_000,
      fx.before(fx.close_time),
    )
  and {
    spend(seeded(), Bet, t),
    mint_check(t),
  }
}

test bet_on_both_outcomes_ok() {
  let minted =
    fx.position(0, 1_000_000) |> assets.merge(fx.position(1, 2_000_000))
  let t =
    bet_tx(
      minted,
      fx.open_datum([8_000_000, 5_000_000]),
      buffer + 13_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejected_after_close() fail {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      fx.open_datum([7_000_000, 8_000_000]),
      buffer + 15_000_000,
      fx.after(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejected_when_range_crosses_close() fail {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      fx.open_datum([7_000_000, 8_000_000]),
      buffer + 15_000_000,
      interval.between(fx.close_time - 10, fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejected_without_pool_update() fail {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      seeded(),
      buffer + 15_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejected_when_underpaid() fail {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      fx.open_datum([7_000_000, 8_000_000]),
      buffer + 14_999_999,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejected_when_pool_inflated() fail {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      fx.open_datum([7_000_000, 9_000_000]),
      buffer + 15_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_minimal_shape_ok() {
  // Same transaction shape as the cap and junk tests below, without the flaw.
  let d = seeded()
  let t =
    fx.tx(
      [fx.market_input(buffer + 10_000_000, d)],
      [fx.market_output(buffer + 15_000_000, after_bet())],
      fx.position(1, 5_000_000),
      fx.before(fx.close_time),
      [],
    )
  spend(d, Bet, t)
}

test bet_rejected_above_cap() fail {
  let capped = MarketDatum { ..seeded(), max_total: 12_000_000 }
  let t =
    fx.tx(
      [fx.market_input(buffer + 10_000_000, capped)],
      [
        fx.market_output(
          buffer + 15_000_000,
          MarketDatum { ..capped, pools: [7_000_000, 8_000_000] },
        ),
      ],
      fx.position(1, 5_000_000),
      fx.before(fx.close_time),
      [],
    )
  spend(capped, Bet, t)
}

test bet_rejects_cash_out() fail {
  // Burning YES tokens to take stake back before close is not allowed.
  let t =
    bet_tx(
      fx.position(0, -1_000_000),
      fx.open_datum([6_000_000, 3_000_000]),
      buffer + 9_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejects_side_switch() fail {
  // Burn 1 ADA of YES and mint 1 ADA of NO in one go.
  let minted =
    fx.position(0, -1_000_000) |> assets.merge(fx.position(1, 1_000_000))
  let t =
    bet_tx(
      minted,
      fx.open_datum([6_000_000, 4_000_000]),
      buffer + 10_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejects_unknown_outcome() fail {
  let minted =
    fx.position(1, 5_000_000) |> assets.merge(fx.position(2, 5_000_000))
  let t =
    bet_tx(
      minted,
      fx.open_datum([7_000_000, 8_000_000]),
      buffer + 15_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejects_junk_in_market_output() fail {
  let d = seeded()
  let new_datum = fx.open_datum([7_000_000, 8_000_000])
  let junk_output =
    Output {
      ..fx.market_output(buffer + 15_000_000, new_datum),
      value: assets.merge(
        fx.market_output(buffer + 15_000_000, new_datum).value,
        assets.from_asset(fx.order_script, "junk", 1),
      ),
    }
  let t =
    fx.tx(
      [fx.market_input(buffer + 10_000_000, d)],
      [junk_output],
      fx.position(1, 5_000_000),
      fx.before(fx.close_time),
      [],
    )
  spend(d, Bet, t)
}

test bet_rejects_changed_terms() fail {
  let t =
    bet_tx(
      fx.position(1, 5_000_000),
      MarketDatum { ..fx.open_datum([7_000_000, 8_000_000]), fee_bps: 0 },
      buffer + 15_000_000,
      fx.before(fx.close_time),
    )
  spend(seeded(), Bet, t)
}

test bet_rejects_moving_market() fail {
  let new_datum = fx.open_datum([7_000_000, 8_000_000])
  let moved =
    Output {
      ..fx.market_output(buffer + 15_000_000, new_datum),
      address: fx.wallet(fx.mallory),
    }
  let t =
    fx.tx(
      [fx.market_input(buffer + 10_000_000, seeded())],
      [moved],
      fx.position(1, 5_000_000),
      fx.before(fx.close_time),
      [],
    )
  spend(seeded(), Bet, t)
}

test minting_positions_requires_market_input() fail {
  mint_check(
    fx.tx(
      [fx.wallet_input(1, fx.mallory, assets.from_lovelace(5_000_000))],
      [fx.wallet_output(fx.mallory, fx.position(0, 1_000_000_000))],
      fx.position(0, 1_000_000_000),
      fx.before(fx.close_time),
      [],
    ),
  )
}

test minting_market_nft_outside_creation_fails() fail {
  mint_check(
    fx.tx(
      [fx.market_input(buffer + 10_000_000, seeded())],
      [],
      fx.nft(),
      fx.before(fx.close_time),
      [],
    ),
  )
}

test burning_is_always_allowed() {
  mint_check(
    fx.tx(
      [fx.wallet_input(1, fx.bob, fx.position(1, 5))],
      [],
      fx.position(1, -5),
      interval.everything,
      [],
    ),
  )
}

// ### Resolution

/// Pools after Bob's 5 ADA bet on NO: 7 ADA YES, 8 ADA NO.
fn after_bet() -> MarketDatum {
  fx.open_datum([7_000_000, 8_000_000])
}

fn resolved(winner: Option<Int>) -> MarketDatum {
  MarketDatum { ..after_bet(), state: Resolved { winner } }
}

fn resolve_tx(
  new_datum: MarketDatum,
  new_lovelace: Int,
  signers: List<ByteArray>,
) -> Transaction {
  fx.tx(
    [fx.market_input(buffer + 15_000_000, after_bet())],
    [fx.market_output(new_lovelace, new_datum)],
    assets.zero,
    fx.after(fx.close_time),
    signers,
  )
}

test resolve_yes_takes_fee() {
  // YES wins; fee = 3 % of the 8 ADA NO pool = 0.24 ADA.
  spend(
    after_bet(),
    Resolve { winner: Some(0) },
    resolve_tx(resolved(Some(0)), buffer + 15_000_000 - 240_000, [fx.operator]),
  )
}

test resolve_rejects_fee_overdraw() fail {
  spend(
    after_bet(),
    Resolve { winner: Some(0) },
    resolve_tx(resolved(Some(0)), buffer + 15_000_000 - 240_001, [fx.operator]),
  )
}

test resolve_requires_operator() fail {
  spend(
    after_bet(),
    Resolve { winner: Some(0) },
    resolve_tx(resolved(Some(0)), buffer + 15_000_000, [fx.mallory]),
  )
}

test resolve_rejects_unknown_outcome() fail {
  spend(
    after_bet(),
    Resolve { winner: Some(2) },
    resolve_tx(resolved(Some(2)), buffer + 15_000_000, [fx.operator]),
  )
}

test resolve_must_record_winner() fail {
  spend(
    after_bet(),
    Resolve { winner: Some(0) },
    resolve_tx(resolved(Some(1)), buffer + 15_000_000, [fx.operator]),
  )
}

test void_takes_no_fee() fail {
  spend(
    after_bet(),
    Resolve { winner: None },
    resolve_tx(resolved(None), buffer + 15_000_000 - 1, [fx.operator]),
  )
}

test void_ok() {
  spend(
    after_bet(),
    Resolve { winner: None },
    resolve_tx(resolved(None), buffer + 15_000_000, [fx.operator]),
  )
}

test resolve_twice_fails() fail {
  let already = resolved(Some(1))
  spend(
    already,
    Resolve { winner: Some(0) },
    fx.tx(
      [fx.market_input(buffer + 15_000_000, already)],
      [fx.market_output(buffer + 15_000_000, resolved(Some(0)))],
      assets.zero,
      fx.after(fx.close_time),
      [fx.operator],
    ),
  )
}

test force_void_after_deadline() {
  let d = after_bet()
  spend(
    d,
    ForceVoid,
    fx.tx(
      [fx.market_input(buffer + 15_000_000, d)],
      [fx.market_output(buffer + 15_000_000, resolved(None))],
      assets.zero,
      fx.after(d.resolve_deadline),
      [],
    ),
  )
}

test force_void_too_early() fail {
  let d = after_bet()
  spend(
    d,
    ForceVoid,
    fx.tx(
      [fx.market_input(buffer + 15_000_000, d)],
      [fx.market_output(buffer + 15_000_000, resolved(None))],
      assets.zero,
      fx.before(d.resolve_deadline),
      [],
    ),
  )
}

test force_void_cannot_take_funds() fail {
  let d = after_bet()
  spend(
    d,
    ForceVoid,
    fx.tx(
      [fx.market_input(buffer + 15_000_000, d)],
      [fx.market_output(buffer + 14_000_000, resolved(None))],
      assets.zero,
      fx.after(d.resolve_deadline),
      [],
    ),
  )
}

// ### Claims
//
// YES won. Market holds buffer + 15 ADA - 0.24 ADA fee. Winning pool 7 ADA,
// pot 14.76 ADA, so one YES token pays 14.76 / 7 lovelace.

fn claim_tx(
  d: MarketDatum,
  lovelace_before: Int,
  burned: Assets,
  lovelace_after: Int,
) -> Transaction {
  fx.tx(
    [
      fx.market_input(lovelace_before, d),
      fx.wallet_input(1, fx.alice, assets.negate(burned)),
    ],
    [
      fx.market_output(lovelace_after, d),
      fx.wallet_output(
        fx.alice,
        assets.from_lovelace(lovelace_before - lovelace_after),
      ),
    ],
    burned,
    fx.after(fx.close_time),
    [],
  )
}

const after_fee: Int = 16_760_000

test claim_partial_ok() {
  // 1 ADA of YES pays floor(1_000_000 * 14_760_000 / 7_000_000) = 2_108_571.
  let d = resolved(Some(0))
  let t = claim_tx(d, after_fee, fx.position(0, -1_000_000), after_fee - 2_108_571)
  and {
    spend(d, Claim, t),
    mint_check(t),
  }
}

test claim_overdraw_fails() fail {
  let d = resolved(Some(0))
  spend(
    d,
    Claim,
    claim_tx(d, after_fee, fx.position(0, -1_000_000), after_fee - 2_108_572),
  )
}

test claim_everything_leaves_buffer() {
  let d = resolved(Some(0))
  spend(d, Claim, claim_tx(d, after_fee, fx.position(0, -7_000_000), buffer))
}

test claim_with_losing_tokens_pays_nothing() fail {
  let d = resolved(Some(0))
  spend(
    d,
    Claim,
    claim_tx(d, after_fee, fx.position(1, -1_000_000), after_fee - 1),
  )
}

test void_claim_refunds_one_to_one() {
  let d = resolved(None)
  let burned =
    fx.position(0, -1_000_000) |> assets.merge(fx.position(1, -2_000_000))
  spend(
    d,
    Claim,
    claim_tx(d, buffer + 15_000_000, burned, buffer + 12_000_000),
  )
}

test void_claim_overdraw_fails() fail {
  let d = resolved(None)
  spend(
    d,
    Claim,
    claim_tx(
      d,
      buffer + 15_000_000,
      fx.position(1, -2_000_000),
      buffer + 12_999_999,
    ),
  )
}

test claim_on_open_market_fails() fail {
  let d = after_bet()
  spend(
    d,
    Claim,
    claim_tx(d, buffer + 15_000_000, fx.position(0, -1_000_000), buffer),
  )
}

test claim_cannot_mint() fail {
  let d = resolved(Some(0))
  spend(
    d,
    Claim,
    claim_tx(d, after_fee, fx.position(0, 1_000_000), after_fee),
  )
}

// ### Closing

fn close_tx(burn_nft: Bool, range: interval.Interval, signers: List<ByteArray>) {
  let d = resolved(Some(0))
  fx.tx(
    [fx.market_input(buffer, d)],
    [fx.wallet_output(fx.operator, assets.from_lovelace(buffer))],
    if burn_nft {
      assets.negate(fx.nft())
    } else {
      assets.zero
    },
    range,
    signers,
  )
}

test close_after_claim_deadline() {
  let d = resolved(Some(0))
  spend(d, Close, close_tx(True, fx.after(d.claim_deadline), [fx.operator]))
}

test close_too_early_fails() fail {
  let d = resolved(Some(0))
  spend(d, Close, close_tx(True, fx.before(d.claim_deadline), [fx.operator]))
}

test close_requires_nft_burn() fail {
  let d = resolved(Some(0))
  spend(d, Close, close_tx(False, fx.after(d.claim_deadline), [fx.operator]))
}

test close_requires_operator() fail {
  let d = resolved(Some(0))
  spend(d, Close, close_tx(True, fx.after(d.claim_deadline), [fx.mallory]))
}

test spending_without_nft_fails() fail {
  // A UTxO at the script address that copies a market datum but holds no NFT.
  let d = after_bet()
  let fake =
    Input {
      output_reference: fx.market_ref,
      output: Output {
        ..fx.market_output(buffer + 15_000_000, d),
        value: assets.from_lovelace(buffer + 15_000_000),
      },
    }
  spend(
    d,
    Resolve { winner: None },
    fx.tx(
      [fake],
      [fx.market_output(buffer + 15_000_000, resolved(None))],
      assets.zero,
      fx.after(fx.close_time),
      [fx.operator],
    ),
  )
}

test state_type_is_exported() {
  let s: MarketState = Open
  s == Open
}
