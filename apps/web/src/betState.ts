/** When a flight takes predictions: as soon as it is shown, until 25 min before landing (close at 20 at the latest). */
import { CLOSE_LEAD_MIN } from "@flightradar/core/eta";
import type { AircraftDto } from "./types";

export type BetState = { kind: "open" } | { kind: "soon"; inMin: number } | { kind: "closed" };

export function betState(a: AircraftDto, now: number): BetState {
  if (a.markets) return { kind: "open" };
  if (!a.etaMs) return { kind: "closed" };
  const left = (a.etaMs - now) / 60_000;
  if (left >= CLOSE_LEAD_MIN + 5) return { kind: "open" };
  return { kind: "closed" };
}

export const betLabel = (s: BetState, short = false) =>
  s.kind === "open" ? (short ? "open" : "betting open") : s.kind === "soon" ? `opens in ${s.inMin} min` : short ? "closed" : "betting closed";
