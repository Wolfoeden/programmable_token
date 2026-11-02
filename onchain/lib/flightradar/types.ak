//// Shared on-chain types for flight prediction markets.
////
//// A market is a single UTxO at the `market` script address. It holds the
//// market NFT and all staked lovelace. Its inline datum tracks one pool per
//// outcome. Bettors receive CIP-68 fungible position tokens (label 333), one
//// token per staked lovelace, minted under the same script hash.

use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/transaction.{OutputReference}

/// Lifecycle of a market.
pub type MarketState {
  /// Bets are accepted until `close_time`.
  Open
  /// Outcome is final. `None` voids the market: every position token
  /// redeems 1:1 for its stake.
  Resolved { winner: Option<Int> }
}

/// Inline datum of the market UTxO.
pub type MarketDatum {
  /// 27 bytes derived from the seed UTxO consumed at creation.
  market_id: ByteArray,
  /// What the market is about (flight, airport, threshold). Interpreted
  /// off-chain by the oracle and the UI; immutable on-chain.
  question: Data,
  /// Lovelace staked per outcome. Its length is the number of outcomes.
  pools: List<Int>,
  /// POSIX milliseconds. Bets must be entirely before this instant.
  close_time: Int,
  /// POSIX milliseconds. An unresolved market can be voided by anyone after it.
  resolve_deadline: Int,
  /// POSIX milliseconds. After it the operator may close the market and
  /// sweep what is left (unclaimed winnings, rounding dust).
  claim_deadline: Int,
  /// Fee in basis points, charged on the losing pools only.
  fee_bps: Int,
  /// Upper bound for the sum of all pools.
  max_total: Int,
  state: MarketState,
}

/// Redeemer of the market minting policy.
pub type MarketMintRedeemer {
  /// Create a new market. `seed` must be spent by the transaction and
  /// determines the market id.
  CreateMarket { seed: OutputReference }
  /// Mint position tokens for a bet, or burn any token of this policy.
  MintOrBurn
}

/// Redeemer of the market spending validator.
pub type MarketSpendRedeemer {
  /// Deposit lovelace and mint the same amount of position tokens.
  Bet
  /// Oracle sets the outcome (or voids) and withdraws the fee.
  Resolve { winner: Option<Int> }
  /// Anyone voids a market the oracle did not resolve in time.
  ForceVoid
  /// Burn position tokens and withdraw their payout.
  Claim
  /// Operator closes the market after the claim deadline.
  Close
}

/// What an order asks the batcher to do.
pub type OrderKind {
  /// Stake `stake` lovelace on `outcome` and send the minted position
  /// tokens back to the owner.
  BetOrder { outcome: Int, stake: Int }
  /// Burn all position tokens held by the order and send the payout back.
  ClaimOrder
}

/// Inline datum of an order UTxO.
pub type OrderDatum {
  /// Address that receives the result of the order.
  owner: Address,
  /// Key that may cancel the order at any time.
  owner_key: VerificationKeyHash,
  market_id: ByteArray,
  kind: OrderKind,
  /// Lovelace the batcher may keep for processing the order.
  batcher_fee: Int,
  /// POSIX milliseconds. After it anyone may refund the order to its owner.
  deadline: Int,
}

/// Redeemer of the order validator.
pub type OrderRedeemer {
  /// Owner takes the order back.
  Cancel
  /// Batcher executes the order against the market.
  Fill
  /// Anyone returns an expired order to its owner.
  Refund
}
