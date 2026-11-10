/**
 * The traffic shown on the map: only aircraft landing at or taking off from
 * airports that have a public webcam. One upstream request per airport in a
 * slow round-robin, shared by all clients, and paused while nobody is
 * watching. This keeps upstream calls, CPU and payload small and constant.
 */
import { classifyMovement, isShortHaul, onRoute, MOVEMENT_RADIUS_NM, webcamAirports, type Aircraft, type Airport, type Movement } from "@flightradar/core";
import type { AdsbSource } from "./adsb.js";
import type { RouteSource } from "./routes.js";

export interface Shown {
  aircraft: Aircraft;
  phase: Movement;
  airport: string;
  /** Departure airport (ICAO), within about an hour of `airport`. */
  origin?: string;
}

const IDLE_AFTER_MS = 2 * 60_000;
const STALE_AFTER_MS = 3 * 60_000;

export class CamTraffic {
  private airports: Airport[] = webcamAirports();
  private perAirport = new Map<string, { at: number; list: Shown[] }>();
  private next = 0;
  private lastClientAt = 0;

  constructor(
    private adsb: AdsbSource,
    private routes?: RouteSource,
  ) {}

  /** Called by the API on every map request. */
  touch(): void {
    this.lastClientAt = Date.now();
  }

  get active(): boolean {
    return Date.now() - this.lastClientAt < IDLE_AFTER_MS;
  }

  /** Refresh one airport. Call every 1.5 s or so. */
  async step(): Promise<void> {
    if (!this.active || this.airports.length === 0) return;
    const airport = this.airports[this.next % this.airports.length]!;
    this.next += 1;
    const list = await this.adsb.area(airport.lat, airport.lon, MOVEMENT_RADIUS_NM);
    // Only flights landing at this airport within the hour are shown.
    const shown: Shown[] = [];
    for (const ac of list) {
      if (!ac.callsign) continue;
      const phase = classifyMovement(ac, airport);
      if (!phase) continue;
      // Geometry alone also catches traffic for neighbouring airports
      // (London has six). Keep only flights whose route ends here.
      // Only short hops: the departure airport is about an hour away at most.
      let origin: string | undefined;
      if (this.routes) {
        const route = await this.routes.lookup(ac.callsign);
        if (route?.destination !== airport.icao || !isShortHaul(route.origin, airport.icao) || !onRoute(ac, route.origin, airport.icao)) continue;
        origin = route.origin;
      }
      shown.push({ aircraft: ac, phase, airport: airport.icao, ...(origin ? { origin } : {}) });
    }
    // An empty answer is usually an upstream hiccup: keep the last list.
    if (shown.length > 0 || !this.perAirport.has(airport.icao)) this.perAirport.set(airport.icao, { at: Date.now(), list: shown });
  }

  /** A fresh position from the shared list, to avoid an extra upstream call. */
  find(hex: string, maxAgeMs = 60_000): Aircraft | undefined {
    const s = this.list().find((x) => x.aircraft.hex === hex);
    return s && Date.now() - s.aircraft.timestamp < maxAgeMs ? s.aircraft : undefined;
  }

  list(): Shown[] {
    const out = new Map<string, Shown>();
    const now = Date.now();
    for (const { at, list } of this.perAirport.values()) {
      if (now - at > STALE_AFTER_MS) continue;
      for (const s of list) {
        const prev = out.get(s.aircraft.hex);
        if (!prev || s.aircraft.timestamp > prev.aircraft.timestamp) out.set(s.aircraft.hex, s);
      }
    }
    return [...out.values()];
  }
}
