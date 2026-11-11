/** When a flight takes predictions: from an hour before landing until 25 min before (close at 20). */
import { CLOSE_LEAD_MIN } from "@flightradar/core/eta";
import type { AircraftDto } from "./types";

export const OPENS_BEFORE_MIN = 60;

export type BetState = { kind: "open" } | { kind: "soon"; inMin: number } | { kind: "closed" };

export function betState(a: AircraftDto, now: number): BetState {
  if (a.markets) return { kind: "open" };
  if (!a.etaMs) return { kind: "closed" };
  const left = (a.etaMs - now) / 60_000;
  if (left > OPENS_BEFORE_MIN) return { kind: "soon", inMin: Math.ceil(left - OPENS_BEFORE_MIN) };
  if (left >= CLOSE_LEAD_MIN + 5 && a.confirmed !== false) return { kind: "open" };
  return { kind: "closed" };
}

export const betLabel = (s: BetState, short = false) =>
  s.kind === "open" ? (short ? "open" : "betting open") : s.kind === "soon" ? `opens in ${s.inMin} min` : short ? "closed" : "betting closed";
