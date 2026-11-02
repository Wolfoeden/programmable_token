/**
 * Arrival time model for airborne aircraft, used to set market lines and the
 * status-quo probabilities of landing-time and race markets.
 *
 * Model (documented assumptions, calibrate with resolved markets):
 * - Flown distance = great-circle distance * 1.05 + 20 km for arrival
 *   routing and vectoring.
 * - Cruise segment at current ground speed; the last 150 km at
 *   min(ground speed, 280 kt) for descent and approach.
 * - Uncertainty grows with remaining time: sigma = 1.5 min + 6 % of it.
 * - Aircraft heading away from the destination (> 90 deg off, more than
 *   50 km out) get no estimate: the route is probably wrong.
 */
import type { Aircraft } from "./aircraft.js";
import { bearingDeg, distanceKm, headingDelta, KM_PER_NM, type LatLon } from "./geo.js";
import { gaussian, mulberry32, normalCdf } from "./stats.js";

export interface EtaEstimate {
  /** Expected touchdown, unix ms. */
  etaMs: number;
  /** One standard deviation, ms. */
  sigmaMs: number;
  remainingKm: number;
  remainingMin: number;
}

const MIN = 60_000;
const DESCENT_KM = 150;
const DESCENT_KT = 280;
const MIN_SPEED_KT = 140;

export function estimateEta(ac: Aircraft, dest: LatLon, nowMs: number): EtaEstimate | null {
  if (ac.onGround) return null;
  const gs = ac.groundSpeedKt;
  if (gs === undefined || gs < 60) return null;
  const direct = distanceKm(ac, dest);
  if (ac.trackDeg !== undefined && direct > 50 && headingDelta(ac.trackDeg, bearingDeg(ac, dest)) > 90) {
    return null;
  }
  const flown = direct * 1.05 + 20;
  const kmPerMin = (kt: number) => (Math.max(kt, MIN_SPEED_KT) * KM_PER_NM) / 60;
  const descentSpeed = kmPerMin(Math.min(gs, DESCENT_KT));
  let minutes: number;
  if (flown > DESCENT_KM) {
    minutes = (flown - DESCENT_KM) / kmPerMin(gs) + DESCENT_KM / descentSpeed;
  } else {
    minutes = flown / descentSpeed;
  }
  const elapsedSincePosition = Math.max(0, nowMs - ac.timestamp) / MIN;
  minutes = Math.max(0, minutes - elapsedSincePosition);
  const sigmaMin = 1.5 + 0.06 * minutes;
  return {
    etaMs: Math.round(nowMs + minutes * MIN),
    sigmaMs: Math.round(sigmaMin * MIN),
    remainingKm: direct,
    remainingMin: minutes,
  };
}

/** P(touchdown before `thresholdMs`). */
export function probabilityBefore(eta: EtaEstimate, thresholdMs: number): number {
  return normalCdf((thresholdMs - eta.etaMs) / eta.sigmaMs);
}

/**
 * P(flight i touches down first) for independent normal arrival times.
 * Exact for two flights, Monte Carlo (seeded, deterministic) for more.
 */
export function raceProbabilities(etas: readonly EtaEstimate[], samples = 20_000, seed = 1): number[] {
  if (etas.length < 2) throw new RangeError("a race needs at least two flights");
  if (etas.length === 2) {
    const [a, b] = etas as [EtaEstimate, EtaEstimate];
    const p = normalCdf((b.etaMs - a.etaMs) / Math.hypot(a.sigmaMs, b.sigmaMs));
    return [p, 1 - p];
  }
  const rng = mulberry32(seed);
  const wins = etas.map(() => 0);
  for (let s = 0; s < samples; s++) {
    let best = Infinity;
    let bestIdx = 0;
    etas.forEach((e, i) => {
      const t = e.etaMs + gaussian(rng) * e.sigmaMs;
      if (t < best) {
        best = t;
        bestIdx = i;
      }
    });
    wins[bestIdx]! += 1;
  }
  return wins.map((w) => w / samples);
}
