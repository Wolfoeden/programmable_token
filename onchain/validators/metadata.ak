//// Holds the CIP-68 reference NFTs (label 100) whose inline datums carry the
//// display metadata of the position tokens. Only the operator can update or
//// burn them.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{OutputReference, Transaction}

validator metadata_store(operator: VerificationKeyHash) {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    list.has(self.extra_signatories, operator)
  }

  else(_) {
    fail
  }
}
