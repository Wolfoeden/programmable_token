# Safe Passage: fixed odds and collateral

This is an additional market in the existing aircraft panel. The map and
existing parimutuel markets are unchanged. The new `safe_passage.safe_market`
validator has its own policy/address. Existing validator bytecode is unchanged.

## Exact rules

- YES pays **1.0001x gross**, including stake.
- NO pays **1000x gross**, including stake.
- No timed-exit condition or automatic loss after a timeout.
- Landing and turning back are not NO outcomes.
- NO means a **verified crash or shoot-down within one of the six red countries
  during this passage**, after the market opened. The countries are Lebanon,
  Syria, Iraq, Yemen, Iran and Afghanistan.
- Missing ADS-B reception, stale data, a diversion or an unconfirmed report
  never automatically resolves NO. Fresh airborne positions inside a country
  polygon are required to fund a market and build a new bet.
- Every settlement, including YES and refunds, requires a frozen review state
  and a signed operator verification. No automatic incident inference is made.
- The operator may refund an inconclusive case. Until a decision is verified,
  the frozen market holds its funds indefinitely. There is no force-void clock.
- After verified settlement users have 90 days to claim. Only then may the
  operator sweep the remaining reserve. This is a claim window, not a flight deadline.

## Coverage and limits

All calculations use integer lovelace. YES payout is `floor(stake * 10001 / 10000)`;
NO payout is `stake * 1000`. No parimutuel fee changes these fixed amounts.
Network fees for placing and claiming bets are additional. In particular, fees
can exceed the small YES profit; the confirmation view states this explicitly.

Creation locks operator reserve R plus a separate 3 ADA min-output buffer.
There are no seed position tokens. Before each bet the **on-chain validator**
requires both `YES payout(total YES stakes)` and `NO payout(total NO stakes)`
to fit within `R + YES stakes + NO stakes`. The 3 ADA buffer is not bankroll.
Refunds are covered as well. Accepted bets cannot consume the same market UTxO
twice: competing quotes contend on-chain and a stale transaction must be rebuilt.
No unfunded pending order is represented as an accepted fixed-odds bet.

Defaults: 1,000 ADA reserve per funded market, five unresolved markets, minimum
1 ADA stake, maximum 1,000 ADA per bet subject to the stricter live collateral
limit. With only the initial 1,000 ADA reserve and no bets, the NO capacity is
1.001001 ADA. The incoming stake contributes to the coverage; this is why the
capacity is slightly greater than 1 ADA. The contract rejects excess exposure
even if a caller bypasses the UI and HTTP API.

## Render setup (owner deploys)

1. Merge this PR and use the existing Node 22 Render build/start commands.
   The rebuilt `onchain/plutus.json` is committed; Render does not need Aiken.
2. Set `SAFE_PASSAGE_ENABLED=1` to enable the feature. It defaults to disabled.
3. Optional settings: `SAFE_PASSAGE_RESERVE_ADA=1000`,
   `SAFE_PASSAGE_MAX_OPEN=5`, `SAFE_PASSAGE_MAX_STAKE_ADA=1000`.
4. Keep the existing `OPERATOR_SEED` and `ADMIN_TOKEN`. The operator wallet
   needs the desired reserve plus fees on the configured network. No new key.
5. Leave **`DATA_DIR=data`**. No paid Render instance or persistent disk is
   required. `safe-passage.json` is a local cache, not the permanent source of
   confirmed states or verification evidence. No additional database/key is needed.
6. Open `/#operator`, authenticate with the existing admin token, select a
   regional aircraft, then explicitly confirm funding its market. Merely
   opening a flight never transfers or locks operator funds.

## Render Free recovery

Reserves, stakes, receipts and confirmed market states are already on-chain.
Freeze and verification transactions now also create a full evidence archive
output at the existing operator-controlled metadata-store address. That output
contains the exact JSON manifest. Its SHA-256 must match the evidence hash in
the authenticated market datum, and the market ID/action/winner are validated
before displaying recovered evidence. Arbitrary deposits or changed payloads
are not trusted. Receipt claims can move the market UTxO without losing the
archive; recovery does not depend on transaction-history APIs.

On a cold start, the server reads current markets from the existing Cardano
provider and recovers their required evidence outputs. `data` may disappear
between Render Free deployments; the confirmed funds, states and new evidence
remain recoverable. Provider outages do not invent a result. Missing evidence
is shown as unavailable and retried. The signed market state still governs claims.

**Open markets require operator review after complete cache loss.** A restart
cannot prove whether an incident was suspected just before the process stopped
and its freeze transaction failed or had not confirmed. Such older open markets
are therefore held at the API/UI level. In the operator section either retry the
freeze, or explicitly acknowledge the restart review and choose **Nach Neustart
freigeben** when no unverified suspicion exists. A confirmed on-chain Frozen
market cannot be reopened through that action. A suspicion retained in a surviving
cache also cannot be cleared by the restart-review button. Quotes already built
before a freeze contend on-chain; the contract enforces its confirmed state.

This review requirement is the deliberate fail-closed behavior, not an automatic
loss or automatic settlement. A brand-new market explicitly funded by the current
process is not quarantined. Confirmed frozen/resolved markets recover automatically.

Evidence outputs are public blockchain data. Recording them incurs normal network
fees and an additional ADA minimum-output deposit based on record size. The operator
wallet pays these, separately from bettor collateral. No Render upgrade or external
storage subscription is required. Evidence is limited to 8192 UTF-8 bytes per record.
Do not reclaim these archive outputs while their evidence is still needed. Existing
automatic reference-NFT reclamation does not select them.

Evidence from an older deployment that never wrote archive outputs can only be
read while its old local copy exists. Already-lost historical local-only evidence
cannot be reconstructed from a hash alone. New freeze/verification records use the
on-chain archive atomically with the state transition.

## Suspicion and verification

In the aircraft card's operator section:

1. Enter a reason and optional source links; choose **Bei Verdacht einfrieren**.
   The API closes immediately and persists that block before submission.
   After chain confirmation, the validator also rejects direct bets and claims.
   A previously built competing bet can confirm before the freeze; full coverage
   is still enforced. The UI shows pending confirmation rather than claiming
   that an unconfirmed freeze is already enforced by the blockchain.
2. Investigate the actual aircraft identity, event time and location.
3. Supply the decision, reason and HTTPS evidence sources; explicitly confirm
   personal review. NO additionally requires two distinct source hostnames,
   an independent-source review confirmation, event timestamp and country.
   Different hostnames alone do **not** prove independent reporting; that is
   the operator's responsibility. Link syntax checks are not fact verification.
4. Submit **Verifiziert abrechnen**. The exact evidence manifest is SHA-256
   hashed; the signed settlement commits the hash and writes the full manifest
   to its archive output in the same transaction. Sources/reason appear in the
   aircraft card and can be reloaded after `DATA_DIR` is erased.
5. Players redeem their receipts through **Portfolio**. The contract permits
   no early payout, duplicate redemption or withdrawal above fixed entitlement.

The contract authenticates the operator and commits the decision/evidence hash;
it does not itself inspect news websites or prove real-world events. Verification
is explicitly manual. Resolved decisions cannot be changed by a later API call.

Submission failures remain fail-closed. After the submitted transaction's
validity window has expired (six-minute operational safety margin), a fresh
chain read clears its pending marker, allowing a retry. The suspicion block
does not expire. If the blockchain still shows Open, the operator must retry
the freeze before verification becomes available.

## API

Public: `GET /api/safe-passage/flight/:hex`, `GET /api/safe-passage/markets`,
`POST /api/safe-passage/quote`, `POST /api/safe-passage/portfolio`,
`POST /api/safe-passage/claim`. Bet/claim transactions use the existing wallet
signature and `/api/tx/submit` flow.

Existing admin Bearer token required:

- `POST /api/admin/safe-passage/fund`: `{hex, confirmReserve:true}`
- `POST /api/admin/safe-passage/:id/freeze`: `{reason, sources:[]}`
- `POST /api/admin/safe-passage/:id/resume-after-restart`: `{reviewed:true, reason}`;
  only for an open market held after cache loss, never a confirmed Frozen market.
- `POST /api/admin/safe-passage/:id/verify`:
  `{winner:0|1|null, reason, sources:[], reviewed:true}`; NO also needs
  `independentSourcesConfirmed:true`, `incidentAt` (Unix ms), `incidentZone`.
- `POST /api/admin/safe-passage/:id/close`: only after the 90-day claim window.

Funding a later, separate flight by the same aircraft is an explicit operator
action after its previous market has resolved; it must represent a new passage.
The service permits only one unresolved market per aircraft.

## Validation

Tests cover fixed payouts, exact capacity, uncollateralised bets bypassing the
builder, frozen-state bets bypassing the API, unauthorized freeze/verification,
overclaims, duplicate claims, YES/NO/refund redemption, claim-window protection,
admin authentication, evidence validation and restart recovery after a failed
freeze submission. Existing market lifecycle tests remain in the full suite.
Recovery tests use a completely new empty DATA_DIR, preserve a confirmed freeze,
reload verified evidence after a claim moves the market UTxO, reject mismatched
archive payloads and validate the explicit restart-review gate. No production
transaction or Render deployment was performed during development.
