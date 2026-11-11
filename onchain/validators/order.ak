//// Order validator. Bettors lock lovelace (bet) or position tokens (claim)
//// here; a batcher executes many orders against a market in one
//// transaction, so concurrent users never compete for the market UTxO.
////
//// Every fill or refund must pay the owner through an output whose inline
//// datum is the order's own output reference. That tag is unique per order,
//// so one payment can never satisfy two orders.

use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Script}
use cardano/assets.{Assets, PolicyId}
use aiken/crypto.{ScriptHash}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use flightradar/checks
use flightradar/fixtures as fx
use flightradar/payout
use flightradar/tokens
use flightradar/types.{
  BetOrder, Cancel, ClaimOrder, Fill, MarketDatum, OrderDatum, OrderRedeemer,
  Refund, Resolved,
}

validator order(market_policy: PolicyId, jackpot: ScriptHash) {
  spend(
    datum: Option<OrderDatum>,
    redeemer: OrderRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(request) = datum
    when redeemer is {
      Cancel -> checks.signed_by(self, request.owner_key)
      Fill -> fill(market_policy, jackpot, request, own_ref, self)
      Refund -> refund(request, own_ref, self)
    }
  }

  else(_) {
    fail
  }
}

/// The output that pays the owner of the order at `own_ref`.
fn payment_to_owner(
  self: Transaction,
  own_ref: OutputReference,
  owner: Address,
) -> Output {
  let tag: Data = own_ref
  expect Some(output) =
    list.find(self.outputs, fn(output) { output.datum == InlineDatum(tag) })
  expect output.address == owner
  output
}

/// Side bets of all bet orders filled in this transaction must reach the
/// jackpot: what the jackpot script holds afterwards minus what it held
/// before is at least their sum.
fn jackpot_paid(self: Transaction, own_ref: OutputReference, jackpot: ScriptHash) -> Bool {
  expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
  let own_cred = own_input.output.address.payment_credential
  let sides =
    list.foldl(
      self.inputs,
      0,
      fn(input: Input, acc) {
        if input.output.address.payment_credential == own_cred {
          expect InlineDatum(data) = input.output.datum
          expect d: OrderDatum = data
          when d.kind is {
            BetOrder { side, .. } -> acc + side
            ClaimOrder -> acc
          }
        } else {
          acc
        }
      },
    )
  let held_before =
    list.foldl(
      self.inputs,
      0,
      fn(input: Input, acc) {
        if input.output.address.payment_credential == Script(jackpot) {
          acc + assets.lovelace_of(input.output.value)
        } else {
          acc
        }
      },
    )
  let held_after =
    list.foldl(
      self.outputs,
      0,
      fn(output: Output, acc) {
        if output.address.payment_credential == Script(jackpot) {
          acc + assets.lovelace_of(output.value)
        } else {
          acc
        }
      },
    )
  held_after - held_before >= sides
}

fn fill(
  market_policy: PolicyId,
  jackpot: ScriptHash,
  request: OrderDatum,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
  let in_value = own_input.output.value
  let output = payment_to_owner(self, own_ref, request.owner)
  when request.kind is {
    BetOrder { outcome, stake, side } -> {
      let token = tokens.position_token(request.market_id, outcome)
      let required =
        assets.without_lovelace(in_value)
          |> assets.add(market_policy, token, stake)
      and {
        stake > 0,
        side >= 0,
        checks.contains_tokens(output.value, required),
        assets.lovelace_of(output.value) >= assets.lovelace_of(in_value) - stake - request.batcher_fee - side,
        side == 0 || jackpot_paid(self, own_ref, jackpot),
      }
    }
    ClaimOrder -> {
      let market = checks.find_market(self, market_policy, request.market_id)
      expect Resolved { winner } = market.state
      let (positions, others) =
        checks.split_positions(in_value, market_policy, request.market_id)
      let due =
        when winner is {
          Some(w) -> {
            let burned =
              list.foldl(
                positions,
                0,
                fn((outcome, quantity), acc) {
                  if outcome == w {
                    acc + quantity
                  } else {
                    acc
                  }
                },
              )
            payout.winner_payout(market.pools, w, market.fee_bps, burned)
          }
          None ->
            list.foldl(positions, 0, fn((_, quantity), acc) { acc + quantity })
        }
      and {
        checks.contains_tokens(output.value, others),
        assets.lovelace_of(output.value) >= assets.lovelace_of(in_value) - request.batcher_fee + due,
      }
    }
  }
}

fn refund(request: OrderDatum, own_ref: OutputReference, self: Transaction) -> Bool {
  expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
  let in_value = own_input.output.value
  let output = payment_to_owner(self, own_ref, request.owner)
  and {
    interval.is_entirely_after(self.validity_range, request.deadline),
    checks.contains_tokens(output.value, assets.without_lovelace(in_value)),
    assets.lovelace_of(output.value) >= assets.lovelace_of(in_value) - request.batcher_fee,
  }
}

// ## Tests
//
// Alice locks 5 ADA stake + 0.3 ADA batcher fee + 2 ADA return deposit in a
// bet order on NO (outcome 1). Market pools before: 7 ADA YES, 3 ADA NO.


const deposit: Int = 2_000_000

const fee: Int = 300_000

const stake: Int = 5_000_000

fn bet_order(owner: ByteArray) -> OrderDatum {
  fx.order_datum(owner, BetOrder { outcome: 1, stake, side: 0 })
}

fn bet_order_input(n: Int, owner: ByteArray) -> Input {
  fx.order_input(n, assets.from_lovelace(stake + fee + deposit), bet_order(owner))
}

fn check(
  d: OrderDatum,
  r: OrderRedeemer,
  own: OutputReference,
  t: Transaction,
) -> Bool {
  order.spend(fx.policy, fx.jackpot_script, Some(d), r, own, t)
}

fn fill_bet_tx(orders: List<Input>, payments: List<Output>, staked: Int) {
  let before = fx.open_datum([7_000_000, 3_000_000])
  let after = fx.open_datum([7_000_000, 3_000_000 + staked])
  fx.tx(
    [fx.market_input(2_000_000 + 10_000_000, before), ..orders],
    [fx.market_output(2_000_000 + 10_000_000 + staked, after), ..payments],
    fx.position(1, staked),
    fx.before(fx.close_time),
    [],
  )
}

fn tokens_back(lovelace: Int, outcome: Int, quantity: Int) -> Assets {
  assets.from_lovelace(lovelace) |> assets.merge(fx.position(outcome, quantity))
}

test fill_bet_ok() {
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice)],
      [fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake))],
      stake,
    )
  check(bet_order(fx.alice), Fill, fx.ref(5), t)
}

test fill_bet_short_tokens_fails() fail {
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice)],
      [
        fx.order_payment(
          fx.alice,
          fx.ref(5),
          tokens_back(deposit, 1, stake - 1),
        ),
      ],
      stake,
    )
  check(bet_order(fx.alice), Fill, fx.ref(5), t)
}

test fill_bet_wrong_outcome_fails() fail {
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice)],
      [fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 0, stake))],
      stake,
    )
  check(bet_order(fx.alice), Fill, fx.ref(5), t)
}

test fill_bet_keeping_deposit_fails() fail {
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice)],
      [
        fx.order_payment(
          fx.alice,
          fx.ref(5),
          tokens_back(deposit - 1, 1, stake),
        ),
      ],
      stake,
    )
  check(bet_order(fx.alice), Fill, fx.ref(5), t)
}

test fill_bet_paying_someone_else_fails() fail {
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice)],
      [fx.order_payment(fx.mallory, fx.ref(5), tokens_back(deposit, 1, stake))],
      stake,
    )
  check(bet_order(fx.alice), Fill, fx.ref(5), t)
}

test fill_bet_untagged_payment_fails() fail {
  let untagged =
    Output {
      ..fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake)),
      datum: NoDatum,
    }
  let t = fill_bet_tx([bet_order_input(5, fx.alice)], [untagged], stake)
  check(bet_order(fx.alice), Fill, fx.ref(5), t)
}

test two_orders_two_payments_ok() {
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice), bet_order_input(6, fx.alice)],
      [
        fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake)),
        fx.order_payment(fx.alice, fx.ref(6), tokens_back(deposit, 1, stake)),
      ],
      2 * stake,
    )
  and {
    check(bet_order(fx.alice), Fill, fx.ref(5), t),
    check(bet_order(fx.alice), Fill, fx.ref(6), t),
  }
}

test double_satisfaction_fails() fail {
  // One payment carrying enough tokens for both orders cannot serve both:
  // it is tagged for ref 5 only, so the order at ref 6 finds no payment.
  let t =
    fill_bet_tx(
      [bet_order_input(5, fx.alice), bet_order_input(6, fx.alice)],
      [
        fx.order_payment(
          fx.alice,
          fx.ref(5),
          tokens_back(2 * deposit, 1, 2 * stake),
        ),
      ],
      2 * stake,
    )
  check(bet_order(fx.alice), Fill, fx.ref(6), t)
}

test cancel_by_owner_ok() {
  let t =
    fx.tx(
      [bet_order_input(5, fx.alice)],
      [fx.wallet_output(fx.alice, assets.from_lovelace(stake + fee + deposit))],
      assets.zero,
      interval.everything,
      [fx.alice],
    )
  check(bet_order(fx.alice), Cancel, fx.ref(5), t)
}

test cancel_by_stranger_fails() fail {
  let t =
    fx.tx(
      [bet_order_input(5, fx.alice)],
      [fx.wallet_output(fx.mallory, assets.from_lovelace(stake + fee + deposit))],
      assets.zero,
      interval.everything,
      [fx.mallory],
    )
  check(bet_order(fx.alice), Cancel, fx.ref(5), t)
}

fn refund_tx(range: interval.Interval, paid: Assets, order_value: Assets) {
  fx.tx(
    [fx.order_input(5, order_value, bet_order(fx.alice))],
    [fx.order_payment(fx.alice, fx.ref(5), paid)],
    assets.zero,
    range,
    [],
  )
}

test refund_after_deadline_ok() {
  let value = assets.from_lovelace(stake + fee + deposit)
  check(
    bet_order(fx.alice),
    Refund,
    fx.ref(5),
    refund_tx(
      fx.after(fx.close_time),
      assets.from_lovelace(stake + deposit),
      value,
    ),
  )
}

test refund_before_deadline_fails() fail {
  let value = assets.from_lovelace(stake + fee + deposit)
  check(
    bet_order(fx.alice),
    Refund,
    fx.ref(5),
    refund_tx(
      fx.before(fx.close_time),
      assets.from_lovelace(stake + deposit),
      value,
    ),
  )
}

test refund_taking_more_than_fee_fails() fail {
  let value = assets.from_lovelace(stake + fee + deposit)
  check(
    bet_order(fx.alice),
    Refund,
    fx.ref(5),
    refund_tx(
      fx.after(fx.close_time),
      assets.from_lovelace(stake + deposit - 1),
      value,
    ),
  )
}

test refund_must_return_tokens() fail {
  let value = tokens_back(fee + deposit, 0, 1_000_000)
  check(
    bet_order(fx.alice),
    Refund,
    fx.ref(5),
    refund_tx(fx.after(fx.close_time), assets.from_lovelace(deposit), value),
  )
}

// ### Claim orders
//
// YES won: pools 7 ADA YES / 8 ADA NO, 3 % fee on NO, pot 14.76 ADA.
// One YES token is worth 14.76 / 7 lovelace.

fn resolved(winner: Option<Int>) -> MarketDatum {
  MarketDatum {
    ..fx.open_datum([7_000_000, 8_000_000]),
    state: Resolved { winner },
  }
}

fn claim_order() -> OrderDatum {
  fx.order_datum(fx.alice, ClaimOrder)
}

fn claim_tx(
  market: MarketDatum,
  as_reference: Bool,
  order_value: Assets,
  paid: Assets,
) -> Transaction {
  let market_input = fx.market_input(16_760_000, market)
  let order_input = fx.order_input(5, order_value, claim_order())
  let base =
    fx.tx(
      if as_reference {
        [order_input]
      } else {
        [market_input, order_input]
      },
      [fx.order_payment(fx.alice, fx.ref(5), paid)],
      assets.zero,
      fx.after(fx.close_time),
      [],
    )
  if as_reference {
    Transaction { ..base, reference_inputs: [market_input] }
  } else {
    base
  }
}

test fill_claim_ok() {
  // 2.3 ADA - 0.3 ADA fee + floor(1_000_000 * 14_760_000 / 7_000_000)
  let t =
    claim_tx(
      resolved(Some(0)),
      False,
      tokens_back(deposit + fee, 0, 1_000_000),
      assets.from_lovelace(deposit + 2_108_571),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_underpaid_fails() fail {
  let t =
    claim_tx(
      resolved(Some(0)),
      False,
      tokens_back(deposit + fee, 0, 1_000_000),
      assets.from_lovelace(deposit + 2_108_570),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_with_market_as_reference_ok() {
  let t =
    claim_tx(
      resolved(Some(0)),
      True,
      tokens_back(deposit + fee, 0, 1_000_000),
      assets.from_lovelace(deposit + 2_108_571),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_on_open_market_fails() fail {
  let t =
    claim_tx(
      fx.open_datum([7_000_000, 8_000_000]),
      False,
      tokens_back(deposit + fee, 0, 1_000_000),
      assets.from_lovelace(deposit + 2_108_571),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_losing_tokens_returns_deposit() {
  let t =
    claim_tx(
      resolved(Some(0)),
      False,
      tokens_back(deposit + fee, 1, 1_000_000),
      assets.from_lovelace(deposit),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_void_refunds_stake() {
  let order_value =
    tokens_back(deposit + fee, 0, 1_000_000)
      |> assets.merge(fx.position(1, 500_000))
  let t =
    claim_tx(
      resolved(None),
      False,
      order_value,
      assets.from_lovelace(deposit + 1_500_000),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_must_return_foreign_tokens() fail {
  let order_value =
    tokens_back(deposit + fee, 0, 1_000_000)
      |> assets.add(fx.order_script, "souvenir", 1)
  let t =
    claim_tx(
      resolved(Some(0)),
      False,
      order_value,
      assets.from_lovelace(deposit + 2_108_571),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

test fill_claim_returning_foreign_tokens_ok() {
  let order_value =
    tokens_back(deposit + fee, 0, 1_000_000)
      |> assets.add(fx.order_script, "souvenir", 1)
  let t =
    claim_tx(
      resolved(Some(0)),
      False,
      order_value,
      assets.from_lovelace(deposit + 2_108_571)
        |> assets.add(fx.order_script, "souvenir", 1),
    )
  check(claim_order(), Fill, fx.ref(5), t)
}

// ## Side bets

const side: Int = 1_000_000

fn side_order(owner: ByteArray) -> OrderDatum {
  fx.order_datum(owner, BetOrder { outcome: 1, stake, side })
}

fn side_order_input(n: Int, owner: ByteArray) -> Input {
  fx.order_input(n, assets.from_lovelace(stake + fee + deposit + side), side_order(owner))
}

fn jackpot_out(lovelace: Int) -> Output {
  Output { address: fx.jackpot_address(), value: assets.from_lovelace(lovelace), datum: NoDatum, reference_script: None }
}

fn jackpot_in(lovelace: Int) -> Input {
  Input { output_reference: fx.ref(9), output: jackpot_out(lovelace) }
}

test side_bet_paid_into_new_jackpot_ok() {
  let t =
    fill_bet_tx(
      [side_order_input(5, fx.alice)],
      [fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake)), jackpot_out(side)],
      stake,
    )
  check(side_order(fx.alice), Fill, fx.ref(5), t)
}

test side_bet_paid_into_existing_jackpot_ok() {
  let t =
    fill_bet_tx(
      [jackpot_in(40_000_000), side_order_input(5, fx.alice)],
      [fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake)), jackpot_out(40_000_000 + side)],
      stake,
    )
  check(side_order(fx.alice), Fill, fx.ref(5), t)
}

test side_bet_kept_by_batcher_fails() fail {
  let t =
    fill_bet_tx(
      [side_order_input(5, fx.alice)],
      [fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake)), fx.wallet_output(fx.mallory, assets.from_lovelace(side))],
      stake,
    )
  check(side_order(fx.alice), Fill, fx.ref(5), t)
}

test two_side_bets_need_both_in_jackpot() fail {
  // Two side bets, but the jackpot grows by one only.
  let t =
    fill_bet_tx(
      [side_order_input(5, fx.alice), side_order_input(6, fx.bob)],
      [
        fx.order_payment(fx.alice, fx.ref(5), tokens_back(deposit, 1, stake)),
        fx.order_payment(fx.bob, fx.ref(6), tokens_back(deposit, 1, stake)),
        jackpot_out(side),
      ],
      2 * stake,
    )
  check(side_order(fx.alice), Fill, fx.ref(5), t)
}

test side_bet_refunded_to_owner_on_cancel_ok() {
  // Cancel returns everything, side bet included: only the owner signs.
  let t =
    fx.tx([side_order_input(5, fx.alice)], [fx.wallet_output(fx.alice, assets.from_lovelace(stake + fee + deposit + side))], assets.zero, fx.before(fx.close_time), [fx.alice])
  check(side_order(fx.alice), Cancel, fx.ref(5), t)
}
