//// Separate fixed-odds policy; existing parimutuel scripts stay unchanged.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use flightradar/checks
use flightradar/safe_passage as sp
use flightradar/safe_passage.{
  Bet, Claim, Close, Datum, Freeze, Frozen, Open, Resolved, Verify,
}
use flightradar/tokens
use flightradar/types.{CreateMarket, MarketMintRedeemer, MintOrBurn}

validator safe_market(operator: VerificationKeyHash) {
  mint(redeemer: MarketMintRedeemer, policy: PolicyId, tx: Transaction) {
    when redeemer is {
      CreateMarket { seed } -> {
        let id = tokens.market_id(seed)
        let nft = tokens.market_nft(id)
        expect Some(out) = list.find(
          tx.outputs,
          fn(o) { assets.quantity_of(o.value, policy, nft) == 1 },
        )
        expect Script(credential) = out.address.payment_credential
        let (_, d) = continuing(tx.outputs, out.address, policy, nft)
        and {
          (credential == policy)?,
          checks.signed_by(tx, operator)?,
          list.any(tx.inputs, fn(i) { i.output_reference == seed })?,
          (d.market_id == id)?,
          (bytearray.length(d.flight) == 3)?,
          sp.valid_zone(d.zone)?,
          (d.state == Open)?,
          (d.reserve > 0)?,
          (d.yes == 0 && d.no == 0 && d.claimed_yes == 0 && d.claimed_no == 0)?,
          (assets.lovelace_of(out.value) == d.reserve + sp.buffer)?,
          (assets.tokens(tx.mint, policy) == assets.tokens(
            assets.from_asset(policy, nft, 1),
            policy,
          ))?,
          interval.is_entirely_after(tx.validity_range, d.opened_at - 1000)?,
          interval.is_entirely_before(tx.validity_range, d.opened_at + 300_000)?,
        }
      }
      MintOrBurn ->
        assets.tokens(tx.mint, policy)
          |> dict.to_pairs
          |> list.all(
              fn(Pair(name, quantity)) {
                if quantity < 0 {
                  True
                } else {
                  when tokens.position_market_id(name) is {
                    Some(id) ->
                      list.any(
                        tx.inputs,
                        fn(i) {
                          and {
                            i.output.address.payment_credential == Script(
                              policy,
                            ),
                            assets.quantity_of(
                              i.output.value,
                              policy,
                              tokens.market_nft(id),
                            ) == 1,
                          }
                        },
                      )
                    None -> False
                  }
                }
              },
            )
    }
  }

  spend(
    datum: Option<Datum>,
    action: sp.Action,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(input) = transaction.find_input(tx.inputs, own_ref)
    expect Script(policy) = input.output.address.payment_credential
    let nft = tokens.market_nft(d.market_id)
    expect assets.quantity_of(input.output.value, policy, nft) == 1
    expect [dy, dn] = checks.position_deltas(tx.mint, policy, d.market_id, 2)
    expect checks.no_foreign_outcomes(tx.mint, policy, d.market_id, 2)
    let cash = assets.lovelace_of(input.output.value)
    when action is {
      Close -> {
        expect Resolved { settled_at, .. } = d.state
        and {
          checks.signed_by(tx, operator),
          interval.is_entirely_after(
            tx.validity_range,
            settled_at + sp.claim_window,
          ),
          assets.quantity_of(tx.mint, policy, nft) == -1,
          dy <= 0,
          dn <= 0,
        }
      }
      _ -> {
        let (out, next) = continuing(
          tx.outputs,
          input.output.address,
          policy,
          nft,
        )
        let remaining = assets.lovelace_of(out.value)
        when action is {
          Bet -> {
            expect Open = d.state
            let expected = Datum { ..d, yes: d.yes + dy, no: d.no + dn }
            and {
              dy >= 0,
              dn >= 0,
              dy + dn > 0,
              next == expected,
              sp.covered(expected),
              remaining == cash + dy + dn,
            }
          }
          Freeze { evidence } -> {
            expect Open = d.state
            and {
              checks.signed_by(tx, operator),
              bytearray.length(evidence) == 32,
              next == Datum { ..d, state: Frozen { evidence } },
              dy == 0,
              dn == 0,
              remaining == cash,
            }
          }
          Verify { winner, evidence, settled_at } -> {
            // Even YES and refunds pass through a frozen review state.
            expect Frozen { .. } = d.state
            and {
              checks.signed_by(tx, operator),
              bytearray.length(evidence) == 32,
              list.has([None, Some(0), Some(1)], winner),
              settled_at >= d.opened_at,
              interval.is_entirely_after(tx.validity_range, settled_at - 1000),
              interval.is_entirely_before(
                tx.validity_range,
                settled_at + 300_000,
              ),
              next == Datum {
                ..d,
                state: Resolved { winner, evidence, settled_at },
              },
              dy == 0,
              dn == 0,
              remaining == cash,
            }
          }
          Claim -> {
            expect Resolved { winner, .. } = d.state
            let cy = d.claimed_yes - dy
            let cn = d.claimed_no - dn
            let expected = Datum { ..d, claimed_yes: cy, claimed_no: cn }
            // Floor each redemption; splitting receipts never increases payout.
            let allowed = when winner is {
              Some(0) -> sp.payout(0, -dy)
              Some(1) -> sp.payout(1, -dn)
              None -> -dy - dn
              _ -> fail
            }
            and {
              dy <= 0,
              dn <= 0,
              dy + dn < 0,
              cy <= d.yes,
              cn <= d.no,
              next == expected,
              remaining >= cash - allowed,
              remaining >= sp.buffer,
            }
          }
          Close -> fail
        }
      }
    }
  }

  else(_) {
    fail
  }
}

fn continuing(
  outputs: List<Output>,
  address: Address,
  policy: PolicyId,
  nft: ByteArray,
) -> (Output, Datum) {
  expect Some(out) = list.find(
    outputs,
    fn(o) { assets.quantity_of(o.value, policy, nft) == 1 },
  )
  expect out.address == address
  expect None = out.reference_script
  expect assets.without_lovelace(out.value) == assets.from_asset(policy, nft, 1)
  expect InlineDatum(raw) = out.datum
  expect d: Datum = raw
  (out, d)
}
