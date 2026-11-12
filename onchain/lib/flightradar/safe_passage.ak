use aiken/collection/list

pub type State {
  Open
  Frozen { evidence: ByteArray }
  Resolved { winner: Option<Int>, evidence: ByteArray, settled_at: Int }
}

pub type Datum {
  market_id: ByteArray,
  flight: ByteArray,
  zone: ByteArray,
  opened_at: Int,
  reserve: Int,
  yes: Int,
  no: Int,
  claimed_yes: Int,
  claimed_no: Int,
  state: State,
}

pub type Action {
  Bet
  Freeze { evidence: ByteArray }
  Verify { winner: Option<Int>, evidence: ByteArray, settled_at: Int }
  Claim
  Close
}

pub const buffer: Int = 3_000_000

pub const claim_window: Int = 7_776_000_000

pub fn payout(outcome: Int, quantity: Int) -> Int {
  if outcome == 0 {
    quantity * 10001 / 10000
  } else {
    quantity * 1000
  }
}

pub fn covered(d: Datum) -> Bool {
  let cash = d.reserve + d.yes + d.no
  and {
    d.reserve > 0,
    d.yes >= 0,
    d.no >= 0,
    payout(0, d.yes) <= cash,
    payout(1, d.no) <= cash,
  }
}

pub fn valid_zone(zone: ByteArray) -> Bool {
  list.has(["LBN", "SYR", "IRQ", "YEM", "IRN", "AFG"], zone)
}

test fixed_rates() {
  and {
    payout(0, 1_000_000) == 1_000_100,
    payout(1, 1_000_000) == 1_000_000_000,
  }
}
