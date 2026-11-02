/**
 * Airport database built from OurAirports (public domain) by
 * scripts/build-airports.py. Large and medium airports with scheduled service.
 */
import type { LatLon } from "./geo.js";
import { distanceKm } from "./geo.js";
import rows from "./data/airports.json" with { type: "json" };

export interface Airport extends LatLon {
  icao: string;
  iata: string;
  name: string;
  city: string;
  country: string;
  elevationFt: number;
  /** 2 = large, 1 = medium */
  size: 1 | 2;
}

type Row = [string, string, string, string, string, number, number, number, number];

export const AIRPORTS: Airport[] = (rows as Row[]).map(([icao, iata, name, city, country, lat, lon, elevationFt, size]) => ({
  icao,
  iata,
  name,
  city,
  country,
  lat,
  lon,
  elevationFt,
  size: size === 2 ? 2 : 1,
}));

const byIcao = new Map(AIRPORTS.map((a) => [a.icao, a]));
const byIata = new Map(AIRPORTS.filter((a) => a.iata).map((a) => [a.iata, a]));

export function airportByIcao(icao: string | undefined): Airport | undefined {
  return icao ? byIcao.get(icao.toUpperCase()) : undefined;
}

export function airportByIata(iata: string | undefined): Airport | undefined {
  return iata ? byIata.get(iata.toUpperCase()) : undefined;
}

/** Nearest airport within `maxKm`, if any. Linear scan, ~3k entries. */
export function nearestAirport(p: LatLon, maxKm = 10): Airport | undefined {
  let best: Airport | undefined;
  let bestKm = maxKm;
  for (const a of AIRPORTS) {
    if (Math.abs(a.lat - p.lat) > 1) continue;
    const d = distanceKm(p, a);
    if (d <= bestKm) {
      best = a;
      bestKm = d;
    }
  }
  return best;
}
