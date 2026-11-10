/**
 * Airports with a public live stream. The map only shows flights that will
 * land at one of them within the next hour, and only those flights can get
 * a market. The live-stream link is shown for these airports only.
 */
import type { Aircraft } from "./aircraft.js";
import { airportByIcao, type Airport } from "./airports.js";
import { estimateEta, type EtaEstimate } from "./eta.js";
import { bearingDeg, distanceKm, headingDelta } from "./geo.js";

export interface Webcam {
  icao: string;
  name: string;
  url: string;
  kind: "video" | "still";
  note?: string;
}

export const WEBCAMS: Webcam[] = [
  { icao: "EGLL", name: "London Heathrow", url: "https://www.youtube.com/watch?v=SgvpyjQX_HM", kind: "video", note: "runway 27L/09R" },
  { icao: "GCRR", name: "Lanzarote", url: "https://www.youtube.com/watch?v=4nC8r5neaow", kind: "video", note: "arrivals and departures, 24/7" },
  { icao: "KLAS", name: "Las Vegas", url: "https://www.youtube.com/watch?v=V7_orOtu-oo", kind: "video", note: "runways 26R/26L" },
  { icao: "RJTT", name: "Tokyo Haneda", url: "https://www.youtube.com/watch?v=3w4zEyFamuA", kind: "video", note: "Nippon TV" },
  { icao: "LPMA", name: "Madeira", url: "https://www.youtube.com/@madeiraairportlive", kind: "video", note: "landings and take-offs" },
];

const byIcao = new Map(WEBCAMS.map((w) => [w.icao, w]));

export function webcamFor(icao: string | undefined): Webcam | undefined {
  return icao ? byIcao.get(icao.toUpperCase()) : undefined;
}

export function webcamAirports(): Airport[] {
  return WEBCAMS.map((w) => airportByIcao(w.icao)).filter((a): a is Airport => !!a);
}

/** Only flights landing within this many minutes are shown and bettable. */
export const MAX_MINUTES_TO_LANDING = 60;

/** Query radius around a live-stream airport (about one hour at cruise). */
export const MOVEMENT_RADIUS_NM = 250;

export type Movement = "landing";

/**
 * Is this aircraft on its way to land at the airport within the hour?
 * Geometry only (no flight plan): pointing at the airport (±20° beyond
 * 60 km, ±35° inside, any direction on the last 15 km), not climbing, near
 * a plausible descent profile, and an estimated arrival under 60 minutes.
 */
export function landingWithinHour(ac: Aircraft, airport: Airport, now = ac.timestamp): EtaEstimate | null {
  if (ac.onGround || ac.altitudeFt === undefined || ac.trackDeg === undefined) return null;
  const dist = distanceKm(ac, airport);
  const agl = ac.altitudeFt - airport.elevationFt;
  const vr = ac.verticalRateFpm ?? 0;
  const off = headingDelta(ac.trackDeg, bearingDeg(ac, airport));
  const aligned = dist <= 15 ? off <= 90 : dist <= 60 ? off <= 35 : off <= 20;
  // Top of descent is roughly 3 nm per 1,000 ft; allow generous margin.
  const onProfile = agl <= 6000 + 330 * dist;
  if (!aligned || !onProfile || vr > 300) return null;
  const eta = estimateEta(ac, airport, now);
  if (!eta || eta.remainingMin > MAX_MINUTES_TO_LANDING) return null;
  return eta;
}

export function classifyMovement(ac: Aircraft, airport: Airport): Movement | null {
  return landingWithinHour(ac, airport) ? "landing" : null;
}
