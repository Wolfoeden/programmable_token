//// Jackpot for opt-in side bets. The order validator makes the batcher pay
//// every side bet in here. Anyone may spend the jackpot to add to it, but
//// only if it does not shrink; paying it out needs the operator, because the
//// winning rule (an extreme case of a bet) is not defined yet.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets
use cardano/transaction.{Input, Output, OutputReference, Transaction}
use flightradar/checks
use flightradar/fixtures as fx
use flightradar/types.{Deposit, JackpotRedeemer, Payout}

validator jackpot(operator: VerificationKeyHash) {
  spend(
    _datum: Option<Data>,
    redeemer: JackpotRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    when redeemer is {
      Deposit -> {
        expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
        let own = own_input.output.address.payment_credential
        let before =
          list.foldl(
            self.inputs,
            0,
            fn(input: Input, acc) {
              if input.output.address.payment_credential == own {
                acc + assets.lovelace_of(input.output.value)
              } else {
                acc
              }
            },
          )
        let after =
          list.foldl(
            self.outputs,
            0,
            fn(output: Output, acc) {
              if output.address.payment_credential == own {
                acc + assets.lovelace_of(output.value)
              } else {
                acc
              }
            },
          )
        after >= before
      }
      Payout -> checks.signed_by(self, operator)
    }
  }

  else(_) {
    fail
  }
}

// ## Tests

fn pot_input(lovelace: Int) -> Input {
  Input {
    output_reference: fx.ref(9),
    output: Output {
      address: fx.jackpot_address(),
      value: assets.from_lovelace(lovelace),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

fn pot_output(lovelace: Int) -> Output {
  Output {
    address: fx.jackpot_address(),
    value: assets.from_lovelace(lovelace),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

fn pot_tx(before: Int, outputs: List<Output>, signers: List<ByteArray>) {
  fx.tx([pot_input(before)], outputs, assets.zero, fx.before(fx.close_time), signers)
}

test deposit_growing_ok() {
  jackpot.spend(fx.operator, None, Deposit, fx.ref(9), pot_tx(5_000_000, [pot_output(7_000_000)], []))
}

test deposit_keeping_ok() {
  jackpot.spend(fx.operator, None, Deposit, fx.ref(9), pot_tx(5_000_000, [pot_output(5_000_000)], []))
}

test deposit_shrinking_fails() fail {
  jackpot.spend(
    fx.operator,
    None,
    Deposit,
    fx.ref(9),
    pot_tx(5_000_000, [pot_output(4_999_999), fx.wallet_output(fx.mallory, assets.from_lovelace(1))], []),
  )
}

test payout_by_operator_ok() {
  jackpot.spend(fx.operator, None, Payout, fx.ref(9), pot_tx(5_000_000, [fx.wallet_output(fx.alice, assets.from_lovelace(5_000_000))], [fx.operator]))
}

test payout_without_operator_fails() fail {
  jackpot.spend(fx.operator, None, Payout, fx.ref(9), pot_tx(5_000_000, [fx.wallet_output(fx.mallory, assets.from_lovelace(5_000_000))], [fx.mallory]))
}
