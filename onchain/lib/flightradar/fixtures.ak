//// Test fixtures: keys, addresses and builders for mock transactions.
//// Only used by tests.

use aiken/interval.{Interval}
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use flightradar/tokens
use flightradar/types.{MarketDatum, MarketState, Open, OrderDatum, OrderKind}

pub const operator: ByteArray =
  #"0000000000000000000000000000000000000000000000000000aaaa"

pub const metadata_store: ByteArray =
  #"0000000000000000000000000000000000000000000000000000bbbb"

pub const policy: ByteArray =
  #"0000000000000000000000000000000000000000000000000000cccc"

pub const order_script: ByteArray =
  #"0000000000000000000000000000000000000000000000000000dddd"

pub const alice: ByteArray =
  #"00000000000000000000000000000000000000000000000000000a11"

pub const bob: ByteArray =
  #"00000000000000000000000000000000000000000000000000000b0b"

pub const mallory: ByteArray =
  #"0000000000000000000000000000000000000000000000000000bad0"

pub const seed: OutputReference =
  OutputReference {
    transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
    output_index: 0,
  }

pub const market_ref: OutputReference =
  OutputReference {
    transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
    output_index: 0,
  }

pub fn ref(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
    output_index: n,
  }
}

pub const close_time: Int = 1_800_000_000_000

pub const hour: Int = 3_600_000

pub const day: Int = 86_400_000

pub fn market_id() -> ByteArray {
  tokens.market_id(seed)
}

pub fn market_address() -> Address {
  address.from_script(policy)
}

pub fn order_address() -> Address {
  address.from_script(order_script)
}

pub fn wallet(key: ByteArray) -> Address {
  address.from_verification_key(key)
}

pub fn datum(pools: List<Int>, state: MarketState) -> MarketDatum {
  MarketDatum {
    market_id: market_id(),
    question: "DLH400 lands at KJFK before 18:30Z",
    pools,
    close_time,
    resolve_deadline: close_time + 2 * day,
    claim_deadline: close_time + 2 * day + 30 * day,
    fee_bps: 300,
    max_total: 1_000_000_000_000,
    state,
  }
}

pub fn open_datum(pools: List<Int>) -> MarketDatum {
  datum(pools, Open)
}

pub fn nft() -> Assets {
  assets.from_asset(policy, tokens.market_nft(market_id()), 1)
}

pub fn position(outcome: Int, quantity: Int) -> Assets {
  assets.from_asset(policy, tokens.position_token(market_id(), outcome), quantity)
}

pub fn market_output(lovelace: Int, d: MarketDatum) -> Output {
  Output {
    address: market_address(),
    value: assets.merge(assets.from_lovelace(lovelace), nft()),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn market_input(lovelace: Int, d: MarketDatum) -> Input {
  Input { output_reference: market_ref, output: market_output(lovelace, d) }
}

pub fn wallet_output(key: ByteArray, value: Assets) -> Output {
  Output {
    address: wallet(key),
    value,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn wallet_input(n: Int, key: ByteArray, value: Assets) -> Input {
  Input { output_reference: ref(n), output: wallet_output(key, value) }
}

pub fn order_datum(owner: ByteArray, kind: OrderKind) -> OrderDatum {
  OrderDatum {
    owner: wallet(owner),
    owner_key: owner,
    market_id: market_id(),
    kind,
    batcher_fee: 300_000,
    deadline: close_time,
  }
}

pub fn order_input(n: Int, value: Assets, d: OrderDatum) -> Input {
  Input {
    output_reference: ref(n),
    output: Output {
      address: order_address(),
      value,
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

/// Output paying an order owner, tagged with the order's output reference.
pub fn order_payment(key: ByteArray, tag: OutputReference, value: Assets) -> Output {
  Output {
    address: wallet(key),
    value,
    datum: InlineDatum(tag),
    reference_script: None,
  }
}

pub fn before(t: Int) -> Interval {
  interval.between(t - hour, t - 1)
}

pub fn after(t: Int) -> Interval {
  interval.between(t + 1, t + hour)
}

pub fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Assets,
  validity_range: Interval,
  signatories: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: inputs,
    outputs: outputs,
    mint: mint,
    validity_range: validity_range,
    extra_signatories: signatories,
  }
}
