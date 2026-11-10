/**
 * The traffic shown on the map: only aircraft landing at or taking off from
 * airports that have a public webcam. One upstream request per airport in a
 * slow round-robin, shared by all clients, and paused while nobody is
 * watching. This keeps upstream calls, CPU and payload small and constant.
 */
import { classifyMovement, MOVEMENT_RADIUS_NM, webcamAirports, type Aircraft, type Airport, type Movement } from "@flightradar/core";
import type { AdsbSource } from "./adsb.js";

export interface Shown {
  aircraft: Aircraft;
  phase: Movement;
  airport: string;
}

const IDLE_AFTER_MS = 2 * 60_000;
const STALE_AFTER_MS = 3 * 60_000;

export class CamTraffic {
  private airports: Airport[] = webcamAirports();
  private perAirport = new Map<string, { at: number; list: Shown[] }>();
  private next = 0;
  private lastClientAt = 0;

  constructor(private adsb: AdsbSource) {}

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
    const shown: Shown[] = [];
    for (const ac of list) {
      if (!ac.callsign) continue;
      const phase = classifyMovement(ac, airport);
      if (phase) shown.push({ aircraft: ac, phase, airport: airport.icao });
    }
    // An empty answer is usually an upstream hiccup: keep the last list.
    if (shown.length > 0 || !this.perAirport.has(airport.icao)) this.perAirport.set(airport.icao, { at: Date.now(), list: shown });
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
