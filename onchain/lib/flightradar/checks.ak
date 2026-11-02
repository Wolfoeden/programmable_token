//// Helpers shared by the validators.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address, Script}
use cardano/assets.{Assets, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use flightradar/tokens
use flightradar/types.{MarketDatum}

pub fn signed_by(self: Transaction, key: VerificationKeyHash) -> Bool {
  list.has(self.extra_signatories, key)
}

/// Quantity minted (positive) or burned (negative) per outcome for the
/// position tokens of one market, as a list indexed by outcome.
pub fn position_deltas(
  mint: Assets,
  policy_id: PolicyId,
  market_id: ByteArray,
  outcomes: Int,
) -> List<Int> {
  list.map(
    list.range(0, outcomes - 1),
    fn(i) {
      assets.quantity_of(mint, policy_id, tokens.position_token(market_id, i))
    },
  )
}

/// Every position token of `market_id` that is minted or burned in the
/// transaction must belong to one of its `outcomes`. Prevents minting a
/// token for an outcome index the market does not have.
pub fn no_foreign_outcomes(
  mint: Assets,
  policy_id: PolicyId,
  market_id: ByteArray,
  outcomes: Int,
) -> Bool {
  assets.tokens(mint, policy_id)
    |> dict.keys
    |> list.all(
        fn(name) {
          when tokens.position_market_id(name) is {
            Some(id) ->
              if id == market_id {
                tokens.position_outcome(name) < outcomes
              } else {
                True
              }
            None -> True
          }
        },
      )
}

/// The single output that carries the market NFT. It must stay at the same
/// address, carry nothing but lovelace and the NFT, have no reference script
/// and an inline market datum.
pub fn continuing_market(
  outputs: List<Output>,
  address: Address,
  policy_id: PolicyId,
  nft: ByteArray,
) -> (Output, MarketDatum) {
  expect Some(output) =
    list.find(
      outputs,
      fn(output) { assets.quantity_of(output.value, policy_id, nft) == 1 },
    )
  expect output.address == address
  expect None = output.reference_script
  expect
    assets.without_lovelace(output.value) == assets.from_asset(
      policy_id,
      nft,
      1,
    )
  expect InlineDatum(raw) = output.datum
  expect datum: MarketDatum = raw
  (output, datum)
}

/// Find the market UTxO of `market_id` among inputs or reference inputs.
/// The market NFT only ever exists at the market script, so holding it is
/// proof of authenticity.
pub fn find_market(
  self: Transaction,
  policy_id: PolicyId,
  market_id: ByteArray,
) -> MarketDatum {
  let nft = tokens.market_nft(market_id)
  let holds_nft =
    fn(input: Input) {
      and {
        input.output.address.payment_credential == Script(policy_id),
        assets.quantity_of(input.output.value, policy_id, nft) == 1,
      }
    }
  expect Some(input) =
    when list.find(self.inputs, holds_nft) is {
      Some(input) -> Some(input)
      None -> list.find(self.reference_inputs, holds_nft)
    }
  expect InlineDatum(raw) = input.output.datum
  expect datum: MarketDatum = raw
  datum
}

/// `value` holds at least every token listed in `required`.
pub fn contains_tokens(value: Assets, required: Assets) -> Bool {
  assets.flatten(required)
    |> list.all(fn((p, n, q)) { assets.quantity_of(value, p, n) >= q })
}

/// The position tokens of `market_id` inside `value`, removed from `value`.
pub fn split_positions(
  value: Assets,
  policy_id: PolicyId,
  market_id: ByteArray,
) -> (List<(Int, Int)>, Assets) {
  assets.flatten(assets.without_lovelace(value))
    |> list.foldr(
        ([], assets.zero),
        fn((p, n, q), (positions, rest)) {
          let is_position =
            p == policy_id && tokens.position_market_id(n) == Some(market_id)
          if is_position {
            ([(tokens.position_outcome(n), q), ..positions], rest)
          } else {
            (positions, assets.add(rest, p, n, q))
          }
        },
      )
}
