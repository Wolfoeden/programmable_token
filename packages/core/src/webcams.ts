/**
 * Airports with a public live stream. The map only shows flights that will
 * land at one of them within the next hour, and only those flights can get
 * a market. The live-stream link is shown for these airports only.
 */
import type { Aircraft } from "./aircraft.js";
import { AIRPORTS, airportByIcao, type Airport } from "./airports.js";
import { estimateEta, type EtaEstimate } from "./eta.js";
import { bearingDeg, crossTrackKm, distanceKm, headingDelta } from "./geo.js";

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

/** Flights are shown from cruise altitude, up to this long before landing. */
export const MAX_MINUTES_SHOWN = 330;

/** "At cruise": at least this high and not climbing. */
export const CRUISE_MIN_FT = 20_000;

/** Query radius around a live-stream airport (about one hour at cruise). */
export const MOVEMENT_RADIUS_NM = 250;

export type Movement = "landing";

/**
 * Route limit: flights of up to about five hours. The departure airport
 * must be within 3,800 km of the live-stream airport (great circle; about
 * 4 h 45 min at ~800 km/h cruise plus climb and descent).
 */
export const MAX_ROUTE_KM = 3800;

/**
 * Route data can be wrong for today: airlines reuse a flight number for
 * several legs a day, and route databases know only one (e.g. SWA2697 is
 * listed as Oakland → Las Vegas but also flies to Phoenix, almost the same
 * direction from Oakland). So the aircraft must
 * - be well under way, so that destinations in a similar direction differ
 *   (at least 120 km, or 30 % of a shorter route, from the origin),
 * - lie within 40 km of the origin–destination line (airways are not
 *   straight), and
 * - head for the destination (±15°) while more than 60 km out.
 * On the last 60 km approach patterns are allowed to wander.
 */
export const ROUTE_MAX_OFFSET_KM = 40;
export const ROUTE_MAX_HEADING_DEG = 15;

/** Is the aircraft flying the leg origin → destination, judged by geometry alone? */
function fitsLeg(ac: { lat: number; lon: number; trackDeg?: number }, o: Airport, d: Airport): boolean {
  const route = distanceKm(o, d);
  const toDest = distanceKm(ac, d);
  const fromOrigin = distanceKm(o, ac);
  if (fromOrigin + toDest > 1.25 * route + 60) return false;
  if (toDest <= 60) return true;
  if (crossTrackKm(ac, o, d) > ROUTE_MAX_OFFSET_KM) return false;
  if (ac.trackDeg !== undefined && headingDelta(ac.trackDeg, bearingDeg(ac, d)) > ROUTE_MAX_HEADING_DEG) return false;
  return true;
}

/** Alternatives closer than this to the destination are not told apart (the oracle voids a landing there). */
const AMBIGUITY_MIN_SEPARATION_KM = 80;

/** Geometry only: the aircraft lies on the leg and heads for the destination (no ambiguity check). */
export function onLeg(ac: { lat: number; lon: number; trackDeg?: number }, origin: string | undefined, destination: string | undefined): boolean {
  const o = airportByIcao(origin);
  const d = airportByIcao(destination);
  return !!o && !!d && fitsLeg(ac, o, d);
}

export function onRoute(ac: { lat: number; lon: number; trackDeg?: number }, origin: string | undefined, destination: string | undefined): boolean {
  const o = airportByIcao(origin);
  const d = airportByIcao(destination);
  if (!o || !d || !fitsLeg(ac, o, d)) return false;
  if (distanceKm(ac, d) <= 60) return true;
  // Ambiguous while the position fits a leg from the same origin to another airport.
  const reach = distanceKm(o, d) * 1.6 + 100;
  for (const a of AIRPORTS) {
    if (a.size !== 2 || a.icao === o.icao || a.icao === d.icao) continue;
    if (Math.abs(a.lat - o.lat) * 111 > reach) continue; // cheap pre-filter
    const oa = distanceKm(o, a);
    if (oa < 150 || oa > reach || distanceKm(a, d) < AMBIGUITY_MIN_SEPARATION_KM) continue;
    if (distanceKm(ac, a) <= 60) continue;
    // An airport beyond the destination on the same line is no real
    // alternative: the descent profile (checked elsewhere) tells them apart.
    if (oa > distanceKm(o, d) && crossTrackKm(d, o, a) < 40) continue;
    if (fitsLeg(ac, o, a)) return false;
  }
  return true;
}

/** Is the route at most about five hours of flying? */
export function isWithinRange(origin: string | undefined, destination: string | undefined): boolean {
  const o = airportByIcao(origin);
  const d = airportByIcao(destination);
  return !!o && !!d && o.icao !== d.icao && distanceKm(o, d) <= MAX_ROUTE_KM;
}

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

/**
 * Inbound to the airport and worth showing: within the last hour by the
 * descent-aware test above; further out once the aircraft is at cruise
 * (high, not climbing) and heading for the airport (±25°), up to
 * MAX_MINUTES_SHOWN before landing.
 */
export function inboundAtCruise(ac: Aircraft, airport: Airport, now = ac.timestamp): EtaEstimate | null {
  const near = landingWithinHour(ac, airport, now);
  if (near) return near;
  if (ac.onGround || ac.altitudeFt === undefined || ac.trackDeg === undefined) return null;
  if (ac.altitudeFt < CRUISE_MIN_FT || (ac.verticalRateFpm ?? 0) > 500) return null;
  if (headingDelta(ac.trackDeg, bearingDeg(ac, airport)) > 25) return null;
  const eta = estimateEta(ac, airport, now);
  if (!eta || eta.remainingMin > MAX_MINUTES_SHOWN) return null;
  return eta;
}

export function classifyMovement(ac: Aircraft, airport: Airport): Movement | null {
  return landingWithinHour(ac, airport) ? "landing" : null;
}
