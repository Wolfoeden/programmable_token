/** What the site can say about one flight's arrival, from the live list and the arrivals feed. */
import { utcClock } from "./format";
import type { AircraftDto, Arrival } from "./types";

export type FlightState =
  | { kind: "approaching"; flight: AircraftDto }
  | { kind: "final"; arrival: Arrival }
  | { kind: "landed"; arrival: Arrival }
  | { kind: "lost"; arrival: Arrival }
  | { kind: "unknown" };

export function flightState(hex: string, flights: AircraftDto[], arrivals: Arrival[]): FlightState {
  const f = flights.find((x) => x.hex === hex);
  if (f) return { kind: "approaching", flight: f };
  const a = arrivals.find((x) => x.hex === hex);
  if (!a || a.status === "approaching") return { kind: "unknown" };
  return { kind: a.status, arrival: a };
}

/** Finished: landed or lost. The view may then offer the next flight. */
export const ended = (s: FlightState) => s.kind === "landed" || s.kind === "lost";

export function stateText(s: FlightState, now: number): string {
  switch (s.kind) {
    case "approaching": {
      const eta = s.flight.etaMs;
      if (!eta) return "On approach.";
      const min = Math.round((eta - now) / 60_000);
      return min >= 1 ? `On approach · about ${min} min to touchdown (model estimate)` : "On approach · touchdown expected any moment";
    }
    case "final":
      return "Left the approach list but is still airborne (short final or a go-around). Waiting for a ground report …";
    case "landed":
      return `Landed: first ADS-B ground report at ${new Date(s.arrival.landedAt!).toISOString().slice(11, 19)} UTC.`;
    case "lost":
      return `No ground report: the signal was lost at ${utcClock(s.arrival.lastSeenAt)}. The landing is not confirmed by data.`;
    default:
      return "No current data for this flight.";
  }
}

export const flightName = (x: { flightNumber?: string; callsign?: string; hex: string }) => x.flightNumber || x.callsign || x.hex.toUpperCase();
