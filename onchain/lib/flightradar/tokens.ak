//// Asset naming. All market tokens live under the market script hash.
////
//// | Token            | Asset name                                    | Bytes |
//// |------------------|-----------------------------------------------|-------|
//// | Market NFT       | "MKT_" ++ market_id                           | 31    |
//// | Position (FT)    | CIP-68 label 333 ++ market_id ++ outcome byte | 32    |
//// | Reference NFT    | CIP-68 label 100 ++ market_id ++ outcome byte | 32    |

use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use cardano/transaction.{OutputReference}

/// Length of a market id in bytes.
pub const market_id_length: Int = 27

/// "MKT_"
pub const market_nft_prefix: ByteArray = #"4d4b545f"

/// CIP-67 label 333: fungible token.
pub const cip68_ft_prefix: ByteArray = #"0014df10"

/// CIP-67 label 100: reference NFT holding the token metadata.
pub const cip68_ref_prefix: ByteArray = #"000643b0"

/// Market id = first 27 bytes of blake2b-256(tx id ++ output index as 2 bytes big-endian).
pub fn market_id(seed: OutputReference) -> ByteArray {
  bytearray.concat(
    seed.transaction_id,
    bytearray.from_int_big_endian(seed.output_index, 2),
  )
    |> blake2b_256
    |> bytearray.take(market_id_length)
}

pub fn market_nft(market_id: ByteArray) -> ByteArray {
  bytearray.concat(market_nft_prefix, market_id)
}

pub fn position_token(market_id: ByteArray, outcome: Int) -> ByteArray {
  bytearray.concat(
    cip68_ft_prefix,
    bytearray.concat(market_id, bytearray.from_int_big_endian(outcome, 1)),
  )
}

pub fn reference_token(market_id: ByteArray, outcome: Int) -> ByteArray {
  bytearray.concat(
    cip68_ref_prefix,
    bytearray.concat(market_id, bytearray.from_int_big_endian(outcome, 1)),
  )
}

/// The market id embedded in a position token name, if `name` is one.
pub fn position_market_id(name: ByteArray) -> Option<ByteArray> {
  if and {
    bytearray.length(name) == 32,
    bytearray.take(name, 4) == cip68_ft_prefix,
  } {
    Some(name |> bytearray.drop(4) |> bytearray.take(market_id_length))
  } else {
    None
  }
}

/// The outcome index encoded in the last byte of a position token name.
pub fn position_outcome(name: ByteArray) -> Int {
  bytearray.at(name, 31)
}

test market_id_is_27_bytes() {
  let seed = OutputReference { transaction_id: #"00", output_index: 0 }
  bytearray.length(market_id(seed)) == 27
}

test market_id_depends_on_index() {
  let a = OutputReference { transaction_id: #"abcd", output_index: 0 }
  let b = OutputReference { transaction_id: #"abcd", output_index: 1 }
  market_id(a) != market_id(b)
}

test position_token_roundtrip() {
  let id = market_id(OutputReference { transaction_id: #"ff", output_index: 3 })
  let name = position_token(id, 1)
  and {
    bytearray.length(name) == 32,
    position_market_id(name) == Some(id),
    position_outcome(name) == 1,
  }
}

test reference_token_is_not_a_position() {
  let id = market_id(OutputReference { transaction_id: #"ff", output_index: 3 })
  position_market_id(reference_token(id, 0)) == None
}

test nft_is_not_a_position() {
  let id = market_id(OutputReference { transaction_id: #"ff", output_index: 3 })
  position_market_id(market_nft(id)) == None
}

/// Test vector shared with the TypeScript implementation.
test market_id_test_vector() {
  let seed =
    OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000001",
      output_index: 2,
    }
  market_id(seed) == #"72ce8add7e64b18bb810507fa93d9ea26d0cf07af37057c70d9365"
}
