/**
 * Settlement logic used by the oracle. Pure functions over observations so
 * every resolution can be replayed and audited from the stored evidence.
 */
import { nearestAirport, type Airport } from "./airports.js";
import { flightsOf, type FlightRef, type Question } from "./questions.js";

export interface Observation {
  /** Unix ms of the position. */
  t: number;
  lat: number;
  lon: number;
  altFt?: number;
  onGround: boolean;
  gsKt?: number;
  vrFpm?: number;
}

export interface Touchdown {
  airport: string;
  /** Estimated touchdown, unix ms. */
  t: number;
  /** "ground": a ground position was seen. "signal-lost": the aircraft was
   * last seen on short final and then disappeared below coverage. */
  method: "ground" | "signal-lost";
  /** Width of the interval the touchdown is known to lie in, ms. */
  uncertaintyMs: number;
}

export interface TouchdownOptions {
  /** Max distance of a ground position from the airport reference point. */
  groundRadiusKm: number;
  /** Max distance of the last airborne position for "signal-lost". */
  finalRadiusKm: number;
  /** Max height above the airport for "signal-lost". */
  finalMaxAglFt: number;
  /** How long the signal must be gone before "signal-lost" counts. */
  silenceMs: number;
  airportLookup: (p: { lat: number; lon: number }, maxKm: number) => Airport | undefined;
}

export const DEFAULT_TOUCHDOWN_OPTIONS: TouchdownOptions = {
  groundRadiusKm: 6,
  finalRadiusKm: 15,
  finalMaxAglFt: 1500,
  silenceMs: 10 * 60_000,
  airportLookup: nearestAirport,
};

const DEFAULT_DESCENT_FPM = 700;

/** Time to descend `aglFt` at the observed (or a typical) descent rate. */
function descentMs(aglFt: number, vrFpm: number | undefined): number {
  const rate = Math.max(300, Math.abs(vrFpm ?? DEFAULT_DESCENT_FPM));
  return (Math.max(0, aglFt) / rate) * 60_000;
}

/**
 * First touchdown in a series of observations of one aircraft, or null.
 * Only counts after the aircraft has been seen airborne, so the departure
 * taxi phase is ignored.
 */
export function detectTouchdown(
  observations: readonly Observation[],
  nowMs: number,
  options: Partial<TouchdownOptions> = {},
): Touchdown | null {
  const o = { ...DEFAULT_TOUCHDOWN_OPTIONS, ...options };
  const obs = [...observations].sort((a, b) => a.t - b.t);
  let lastAirborne: Observation | undefined;
  for (const ob of obs) {
    if (!ob.onGround) {
      lastAirborne = ob;
      continue;
    }
    if (!lastAirborne) continue;
    if ((ob.gsKt ?? 0) > 200) continue; // ground flag glitch at speed
    const airport = o.airportLookup(ob, o.groundRadiusKm);
    if (!airport) continue;
    const gap = ob.t - lastAirborne.t;
    if (gap <= 180_000 && lastAirborne.altFt !== undefined) {
      const agl = lastAirborne.altFt - airport.elevationFt;
      const t = Math.min(ob.t, lastAirborne.t + descentMs(agl, lastAirborne.vrFpm));
      return { airport: airport.icao, t: Math.round(t), method: "ground", uncertaintyMs: gap };
    }
    return { airport: airport.icao, t: ob.t, method: "ground", uncertaintyMs: gap };
  }
  const last = obs[obs.length - 1];
  if (!last || last.onGround || last.altFt === undefined) return null;
  if (nowMs - last.t < o.silenceMs) return null;
  if ((last.vrFpm ?? 0) > 500) return null; // climbing away: go-around or departure
  const airport = o.airportLookup(last, o.finalRadiusKm);
  if (!airport) return null;
  const agl = last.altFt - airport.elevationFt;
  if (agl > o.finalMaxAglFt) return null;
  const dt = descentMs(agl, last.vrFpm);
  return { airport: airport.icao, t: Math.round(last.t + dt), method: "signal-lost", uncertaintyMs: Math.round(dt) };
}

/** What is known about one flight at a point in time. */
export interface FlightStatus {
  touchdown?: Touchdown | null;
  /** Schedule provider reports the flight as cancelled. */
  cancelled?: boolean;
  /** The flight has taken off (seen airborne, or provider says departed). */
  departed?: boolean;
}

export type Verdict =
  | { status: "pending"; note: string }
  | { status: "final"; winner: number | null; reason: string };

export function flightKey(f: FlightRef): string {
  return f.icao24 || f.callsign || f.flightNumber;
}

const voided = (reason: string): Verdict => ({ status: "final", winner: null, reason });

/**
 * Decide a market. `statuses` is keyed by `flightKey`. Returns "pending"
 * until the outcome is certain, and voids once `resolveDeadline` (minus a
 * safety margin the caller chooses) has passed without a result.
 */
export function judge(
  q: Question,
  statuses: Readonly<Record<string, FlightStatus>>,
  nowMs: number,
  giveUpAtMs: number,
): Verdict {
  const statusOf = (f: FlightRef): FlightStatus => statuses[flightKey(f)] ?? {};
  const late = nowMs >= giveUpAtMs;

  switch (q.kind) {
    case "landing_before":
    case "delay": {
      const s = statusOf(q.flight);
      if (s.cancelled) return voided("flight cancelled");
      const td = s.touchdown;
      if (!td) return late ? voided("no landing observed before the deadline") : { status: "pending", note: "airborne" };
      if (td.airport !== q.flight.destination) return voided(`diverted to ${td.airport}`);
      if (q.kind === "landing_before") {
        const yes = td.t < q.threshold;
        return { status: "final", winner: yes ? 0 : 1, reason: `touchdown ${new Date(td.t).toISOString()} (${td.method})` };
      }
      const limit = q.scheduledArrival + q.minutes * 60_000;
      const late15 = td.t >= limit;
      return { status: "final", winner: late15 ? 0 : 1, reason: `touchdown ${new Date(td.t).toISOString()} (${td.method})` };
    }
    case "cancellation": {
      const s = statusOf(q.flight);
      if (s.cancelled) return { status: "final", winner: 0, reason: "cancelled per schedule provider" };
      if (s.departed || s.touchdown) return { status: "final", winner: 1, reason: "flight operated" };
      return late ? voided("status unknown at the deadline") : { status: "pending", note: "scheduled" };
    }
    case "race": {
      const times: number[] = [];
      for (const f of flightsOf(q)) {
        const s = statusOf(f);
        if (s.cancelled) return voided(`${flightKey(f)} cancelled`);
        const td = s.touchdown;
        if (td && td.airport !== f.destination) return voided(`${flightKey(f)} diverted to ${td.airport}`);
        if (!td) {
          return late ? voided("not every flight landed before the deadline") : { status: "pending", note: "racing" };
        }
        times.push(td.t);
      }
      const best = Math.min(...times);
      const leaders = times.filter((t) => t - best < 1000);
      if (leaders.length > 1) return voided("dead heat");
      const winner = times.indexOf(best);
      return { status: "final", winner, reason: `first touchdown ${new Date(best).toISOString()}` };
    }
  }
}
