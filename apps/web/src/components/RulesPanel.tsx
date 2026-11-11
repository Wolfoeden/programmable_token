import { CLOSE_LEAD_MIN } from "@flightradar/core/eta";
import { utcClock } from "../format";
import type { MarketDto } from "../types";

const dateTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)} ${utcClock(ms)}`;

/**
 * "Rules & settlement": what the oracle, batcher and contract actually do.
 * Every statement here mirrors packages/core/src/resolution.ts,
 * apps/server/src/{oracle,batcher}.ts and onchain/validators.
 */
export function RulesPanel({ m }: { m: MarketDto }) {
  const fee = m.feeBps / 100;
  const q = m.question;
  return (
    <details className="rules-panel">
      <summary>Rules &amp; settlement</summary>
      <h4>When betting ends</h4>
      <p>
        Betting closes at <strong>{m.closeTime ? dateTime(m.closeTime) : "–"}</strong>, at least {CLOSE_LEAD_MIN} minutes before the estimated landing. Bets go in as orders that a batcher books into the pool. It
        books orders only until 1 minute before close. An order not booked by then is returned after close, minus the 0.4 ₳ batcher fee; the 2 ₳
        deposit comes back.
      </p>
      <h4>What decides the result</h4>
      <p>
        Public ADS-B positions (adsb.lol, adsb.fi as fallback), as collected by this site's oracle. It checks each flight every 10 s, and every 2 s
        once it is below about 4,000 ft within 40 km of its destination.
      </p>
      <p>
        <strong>“Landed”</strong> means the first position report flagged “on ground” within 6 km of the destination airport, after the aircraft was
        seen airborne. Its timestamp is the landing time. Ground reports faster than 200 kt are ignored as glitches. If the signal ends on short final
        (last position at most 1,500 ft above the airport and within 15 km, no climb, then 10 minutes without data), the landing time is estimated from
        the last height and descent rate.
      </p>
      {q.kind === "landing_before" && (
        <p>
          <strong>Yes</strong> wins if that time is before {utcClock(q.threshold)}, otherwise <strong>No</strong>. Exactly {utcClock(q.threshold)} counts as No.
        </p>
      )}
      {q.kind === "delay" && (
        <p>
          <strong>Yes</strong> wins if that time is at or after the scheduled arrival plus {q.minutes} minutes ({utcClock(q.scheduledArrival + q.minutes * 60_000)}),
          otherwise <strong>No</strong>.{m.simulated ? " In this demo the scheduled arrival comes from a simulated timetable, not from the airline." : ""}
        </p>
      )}
      {q.kind === "race" && (
        <p>The flight with the earliest landing time at its own destination wins. Landing times less than 1 second apart void the market.</p>
      )}
      <h4>Go-arounds, diversions, missing data</h4>
      <ul>
        <li>A go-around produces no ground report, so it is not a landing; the later landing counts.</li>
        <li>Landing at any other airport voids the market{q.kind === "race" ? " (for any flight in the race)" : ""}.</li>
        <li>
          If no landing is observed by {m.resolveDeadline ? dateTime(m.resolveDeadline - 30 * 60_000) : "the deadline"}, the oracle voids the market.
          If it does not act by {m.resolveDeadline ? dateTime(m.resolveDeadline) : "the deadline"}, anyone can void it on chain.
        </li>
        <li>
          The oracle uses only what it observed. If reports arrive late or are missed, the first ground report it did see counts, which can be later
          than the real touchdown. A decision recorded on chain is final.
        </li>
      </ul>
      <h4>Void and refunds</h4>
      <p>
        A void market refunds every position token 1:1 at its stake, with no pool fee. You claim it like a win: the claim order costs the 0.4 ₳
        batcher fee plus the network fee, and returns the 2 ₳ deposit.
      </p>
      <h4>Pools, fees, payouts</h4>
      <p>
        Each outcome has a pool. The percentages shown are <strong>pool shares</strong>: how the demo stakes are split so far. They are market-based
        values, not an objective probability that the event happens. When an outcome wins, {fee} % of the losing pools is kept as a fee. Every winning
        token then pays (all pools − fee) ÷ winning pool, rounded down, so a winner never gets less than the stake back. Payouts and odds change with
        every bet until betting closes. Each market starts with a small operator stake split by a model; that stake wins or loses like any other.
      </p>
      <p>
        Claims are possible until {m.claimDeadline ? dateTime(m.claimDeadline) : "the claim deadline"}. After that the operator may close the market
        and keep what is unclaimed.
      </p>
      <h4>Demo</h4>
      <p>
        Demo mode runs on a simulated blockchain with play money. It has no monetary value and resets when the server restarts; positions are then
        gone.
      </p>
    </details>
  );
}
