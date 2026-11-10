/**
 * Airports with a public webcam or live stream. The map only shows traffic
 * landing at or taking off from these airports.
 *
 * Checked on 2026-11-10 (pages responded; list from aerotelegraph.com and the
 * operators' own sites). Frankfurt and Munich have no webcams by decision of
 * the airport or its authority.
 */
import type { Aircraft } from "./aircraft.js";
import { airportByIcao, type Airport } from "./airports.js";
import { bearingDeg, distanceKm, headingDelta } from "./geo.js";

export interface Webcam {
  icao: string;
  url: string;
  /** video = moving image, still = periodically refreshed picture */
  kind: "video" | "still";
  note?: string;
}

export const WEBCAMS: Webcam[] = [
  { icao: "LSZH", url: "https://www.flughafen-zuerich.ch/de/passagiere/erleben/erlebnisse/webcams", kind: "video", note: "schwenkbar" },
  { icao: "EDDL", url: "https://www.dus.com/de-de/erleben/webcams", kind: "video", note: "7 bis 12 Min. verzögert" },
  { icao: "EDDK", url: "https://www.koeln-bonn-airport.de/fluggaeste/flughafen-erleben/webcams.html", kind: "video" },
  { icao: "EDDH", url: "https://www.hamburg-airport.de/de/orientieren-erleben/airport-erleben/webcam-10932", kind: "video" },
  { icao: "EDDS", url: "https://www.stuttgart-airport.com/de/reisende-besucher/shoppen-erleben/webcams", kind: "video" },
  { icao: "EDDN", url: "https://www.airport-nuernberg.de/de/webcam", kind: "still" },
  { icao: "LKPR", url: "https://www.prg.aero/en/interest-airport-live-stream-grows-prague-airport-adds-side-runway-view", kind: "video", note: "Pistenkamera 06/24" },
  { icao: "LOWW", url: "https://viennaairport.panomax.com/", kind: "still", note: "360°-Panorama" },
  { icao: "LOWI", url: "https://innsbruck-airport.panomax.com/", kind: "still", note: "360°-Panorama" },
  { icao: "LOWS", url: "https://www.salzburg-airport.com/varia/webcams", kind: "still", note: "360°-Panorama" },
  { icao: "LOWL", url: "https://www.linz-airport.com/de/Passagiere-Besucher/Am-Flughafen/Webcams", kind: "still" },
  { icao: "LOWG", url: "https://graz-airport.at/reisende/am-flughafen/planespotting-mehr/", kind: "still", note: "360°-Panorama" },
  { icao: "EDLP", url: "https://www.airport-pad.com/de/news-media/impressionen/webcams/", kind: "still" },
  { icao: "KLAX", url: "https://www.youtube.com/@AirlineVideosLive/live", kind: "video", note: "Airline Videos Live, 24/7" },
];

const byIcao = new Map(WEBCAMS.map((w) => [w.icao, w]));

export function webcamFor(icao: string | undefined): Webcam | undefined {
  return icao ? byIcao.get(icao.toUpperCase()) : undefined;
}

/** Webcam airports that exist in the airport database. */
export function webcamAirports(): Airport[] {
  return WEBCAMS.map((w) => airportByIcao(w.icao)).filter((a): a is Airport => !!a);
}

export type Movement = "landing" | "takeoff";

/** Query radius around a webcam airport, nautical miles. */
export const MOVEMENT_RADIUS_NM = 100;

/**
 * Is this aircraft approaching or departing the airport?
 *
 * landing: within 185 km, pointing at the airport (±20° beyond 60 km, ±35°
 *   inside, any direction on the last 15 km), not climbing, near a normal
 *   descent path, and either descending or below 12,000 ft above the field.
 *   Without a flight plan this is a heuristic: a few aircraft bound for a
 *   neighbouring airport can be marked too.
 * takeoff: within 60 km, pointing away (≥ 120°), climbing, below 15,000 ft
 *   above the field.
 */
export function classifyMovement(ac: Aircraft, airport: Airport): Movement | null {
  if (ac.onGround || ac.altitudeFt === undefined || ac.trackDeg === undefined) return null;
  const dist = distanceKm(ac, airport);
  const agl = ac.altitudeFt - airport.elevationFt;
  const vr = ac.verticalRateFpm ?? 0;
  const off = headingDelta(ac.trackDeg, bearingDeg(ac, airport));
  const aligned = dist <= 15 ? off <= 90 : dist <= 60 ? off <= 35 : off <= 20;
  // Not far above a normal descent path (about 3 degrees, with margin).
  const onProfile = agl <= 4000 + 250 * dist;
  if (dist <= 185 && vr <= 300 && aligned && onProfile && (vr < -200 || agl < 12_000)) return "landing";
  if (dist <= 60 && off >= 120 && vr >= 300 && agl < 15_000) return "takeoff";
  return null;
}
