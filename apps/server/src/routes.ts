/**
 * Callsign -> route lookup (adsbdb.com, backed by community route data).
 * Routes can be wrong; the ETA model refuses markets for aircraft that fly
 * away from the looked-up destination.
 */
import { fetchJson, Throttle, TtlCache } from "./util.js";

export interface Route {
  callsign: string;
  flightNumber: string;
  airline?: string;
  origin: string;
  destination: string;
}

interface AdsbdbAirport {
  icao_code?: string;
}

interface AdsbdbResponse {
  response?:
    | {
        flightroute?: {
          callsign?: string;
          callsign_iata?: string;
          airline?: { name?: string };
          origin?: AdsbdbAirport;
          destination?: AdsbdbAirport;
        };
      }
    | string;
}

export interface RouteSource {
  lookup(callsign: string): Promise<Route | null>;
}

export class RouteClient implements RouteSource {
  private cache = new TtlCache<Promise<Route | null>>(6 * 3600_000, 20_000);
  private throttle = new Throttle(5);

  constructor(private baseUrl: string) {}

  lookup(callsign: string): Promise<Route | null> {
    const cs = callsign.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(cs)) return Promise.resolve(null);
    const hit = this.cache.get(cs);
    if (hit) return hit;
    const p = this.fetchRoute(cs).catch(() => null).then(route => {
      // A transient miss must not hide the destination for six hours.
      if (!route) this.cache.set(cs, Promise.resolve(null), 30_000);
      return route;
    });
    this.cache.set(cs, p);
    return p;
  }

  private async fetchRoute(cs: string): Promise<Route | null> {
    await this.throttle.wait();
    let res: AdsbdbResponse;
    try {
      res = await fetchJson<AdsbdbResponse>(`${this.baseUrl}/v0/callsign/${cs}`);
    } catch {
      return null; // adsbdb answers 404 for unknown callsigns
    }
    const fr = typeof res.response === "object" ? res.response.flightroute : undefined;
    const origin = fr?.origin?.icao_code?.toUpperCase();
    const destination = fr?.destination?.icao_code?.toUpperCase();
    if (!fr || !origin || !destination) return null;
    const route: Route = { callsign: cs, flightNumber: fr.callsign_iata ?? "", origin, destination };
    if (fr.airline?.name) route.airline = fr.airline.name;
    return route;
  }
}
