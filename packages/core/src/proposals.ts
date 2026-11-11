/**
 * Market proposals: turn live data into a question, betting window and
 * status-quo probabilities. The market maker seeds the pools with these
 * probabilities, so the first quote a user sees is the model's fair price.
 */
import type { Aircraft } from "./aircraft.js";
import { airportByIcao } from "./airports.js";
import { cancellationRate, touchdownDelayExceedance } from "./baseRates.js";
import { CLOSE_LEAD_MIN, estimateEta, probabilityBefore, raceProbabilities, type EtaEstimate } from "./eta.js";
import type { FlightRef, Question } from "./questions.js";
import { clamp } from "./stats.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface Proposal {
  question: Question;
  /** Status-quo probability per outcome. */
  probabilities: number[];
  closeTime: number;
  resolveDeadline: number;
  /** How the probabilities were obtained. */
  model: string;
  eta?: EtaEstimate[];
}

export type ProposalError =
  | "unknown_destination"
  | "no_eta"
  | "too_close_to_landing"
  | "already_departed"
  | "too_late"
  | "needs_two_flights"
  | "same_flight"
  | "line_changed";

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: ProposalError };

/** Probabilities are kept away from 0 and 1 so both sides stay bettable. */
const bound = (p: number) => clamp(p, 0.02, 0.98);

/** Bets close a bit before landing: 10 min or 30 % of the remaining time,
 * rounded down to the full minute (on-chain times are integers). */

function closeBeforeLanding(eta: EtaEstimate): number {
  return Math.floor((eta.etaMs - Math.max(CLOSE_LEAD_MIN * MIN, 0.3 * eta.remainingMin * MIN)) / MIN) * MIN;
}

function roundTo(ms: number, step: number): number {
  return Math.round(ms / step) * step;
}

function etaFor(ac: Aircraft, flight: FlightRef, now: number): EtaEstimate | ProposalError {
  const dest = airportByIcao(flight.destination);
  if (!dest) return "unknown_destination";
  const eta = estimateEta(ac, dest, now);
  return eta ?? "no_eta";
}

/** Over/under on touchdown time, line at the estimated arrival. */
/**
 * `thresholdMs`: keep the line the user was shown (it must stay within 30
 * minutes of the current estimate); otherwise the estimate rounded to 5 min.
 */
export function proposeLandingBefore(ac: Aircraft, flight: FlightRef, now: number, thresholdMs?: number): ProposalResult {
  const eta = etaFor(ac, flight, now);
  if (typeof eta === "string") return { ok: false, error: eta };
  const closeTime = closeBeforeLanding(eta);
  if (closeTime < now + 5 * MIN) return { ok: false, error: "too_close_to_landing" };
  if (thresholdMs !== undefined && (thresholdMs % (5 * MIN) !== 0 || Math.abs(thresholdMs - eta.etaMs) > 30 * MIN)) return { ok: false, error: "line_changed" };
  const threshold = thresholdMs ?? roundTo(eta.etaMs, 5 * MIN);
  const pYes = bound(probabilityBefore(eta, threshold));
  return {
    ok: true,
    proposal: {
      question: { kind: "landing_before", flight, threshold },
      probabilities: [pYes, 1 - pYes],
      closeTime,
      resolveDeadline: threshold + 12 * HOUR,
      model: `ETA ${new Date(eta.etaMs).toISOString()} ± ${Math.round(eta.sigmaMs / MIN)} min (normal)`,
      eta: [eta],
    },
  };
}

/** Delay market for a flight that is already airborne. */
export function proposeDelayAirborne(
  ac: Aircraft,
  flight: FlightRef,
  scheduledArrival: number,
  minutes: number,
  now: number,
): ProposalResult {
  const eta = etaFor(ac, flight, now);
  if (typeof eta === "string") return { ok: false, error: eta };
  const closeTime = closeBeforeLanding(eta);
  if (closeTime < now + 5 * MIN) return { ok: false, error: "too_close_to_landing" };
  const limit = scheduledArrival + minutes * MIN;
  const pLate = bound(1 - probabilityBefore(eta, limit));
  return {
    ok: true,
    proposal: {
      question: { kind: "delay", flight, scheduledArrival, minutes },
      probabilities: [pLate, 1 - pLate],
      closeTime,
      resolveDeadline: Math.round(Math.max(limit, eta.etaMs) + 12 * HOUR),
      model: `ETA ${new Date(eta.etaMs).toISOString()} ± ${Math.round(eta.sigmaMs / MIN)} min vs. limit ${new Date(limit).toISOString()}`,
      eta: [eta],
    },
  };
}

/** Delay market before departure, priced from published punctuality. */
export function proposeDelayScheduled(
  flight: FlightRef,
  scheduledDeparture: number,
  scheduledArrival: number,
  minutes: number,
  now: number,
): ProposalResult {
  const closeTime = scheduledDeparture - 30 * MIN;
  if (closeTime < now + 5 * MIN) return { ok: false, error: "too_late" };
  const pLate = bound(touchdownDelayExceedance(minutes, flight.destination));
  return {
    ok: true,
    proposal: {
      question: { kind: "delay", flight, scheduledArrival, minutes },
      probabilities: [pLate, 1 - pLate],
      closeTime,
      resolveDeadline: scheduledArrival + minutes * MIN + 24 * HOUR,
      model: "base rate: published arrival punctuality with exponential delay tail",
    },
  };
}

/** Cancellation market, priced from published cancellation rates. */
export function proposeCancellation(flight: FlightRef, scheduledDeparture: number, now: number): ProposalResult {
  const closeTime = scheduledDeparture - 2 * HOUR;
  if (closeTime < now + 5 * MIN) return { ok: false, error: "too_late" };
  const p = bound(cancellationRate(flight.origin));
  return {
    ok: true,
    proposal: {
      question: { kind: "cancellation", flight, scheduledDeparture },
      probabilities: [p, 1 - p],
      closeTime,
      resolveDeadline: scheduledDeparture + 24 * HOUR,
      model: "base rate: published cancellation share of the region",
    },
  };
}

/** Race between two to four airborne flights: who touches down first. */
export function proposeRace(entries: ReadonlyArray<{ ac: Aircraft; flight: FlightRef }>, now: number): ProposalResult {
  if (entries.length < 2) return { ok: false, error: "needs_two_flights" };
  const keys = new Set(entries.map((e) => e.ac.hex));
  if (keys.size !== entries.length) return { ok: false, error: "same_flight" };
  const etas: EtaEstimate[] = [];
  for (const e of entries) {
    const eta = etaFor(e.ac, e.flight, now);
    if (typeof eta === "string") return { ok: false, error: eta };
    etas.push(eta);
  }
  const first = etas.reduce((a, b) => (a.etaMs <= b.etaMs ? a : b));
  const closeTime = closeBeforeLanding(first);
  if (closeTime < now + 5 * MIN) return { ok: false, error: "too_close_to_landing" };
  const probabilities = raceProbabilities(etas).map(bound);
  const sum = probabilities.reduce((a, b) => a + b, 0);
  const last = etas.reduce((a, b) => (a.etaMs >= b.etaMs ? a : b));
  return {
    ok: true,
    proposal: {
      question: { kind: "race", flights: entries.map((e) => e.flight) },
      probabilities: probabilities.map((p) => p / sum),
      closeTime,
      resolveDeadline: Math.round(last.etaMs + 12 * HOUR),
      model: "independent normal arrival times per flight",
      eta: etas,
    },
  };
}
