/**
 * Follows every flight that has an open market and keeps its position
 * history, which the oracle turns into touchdown times.
 */
import { airportByIcao, detectTouchdown, distanceKm, flightKey, type Aircraft, type FlightRef, type FlightStatus, type Observation } from "@flightradar/core";
import type { AdsbSource } from "./adsb.js";
import { log } from "./util.js";

interface Watch {
  flight: FlightRef;
  hex?: string;
  until: number;
}

const MAX_OBSERVATIONS = 3000;

export class Tracker {
  private watches = new Map<string, Watch>();
  private series = new Map<string, Observation[]>();
  private last = new Map<string, Aircraft>();

  constructor(private adsb: AdsbSource) {}

  watch(flight: FlightRef, until: number): void {
    const key = flightKey(flight);
    const w = this.watches.get(key);
    if (w) {
      w.until = Math.max(w.until, until);
      return;
    }
    const entry: Watch = { flight, until };
    if (flight.icao24) entry.hex = flight.icao24;
    this.watches.set(key, entry);
  }

  get watching(): number {
    return this.watches.size;
  }

  private record(key: string, ac: Aircraft): void {
    const obs = this.series.get(key) ?? [];
    const prev = obs[obs.length - 1];
    if (prev && ac.timestamp <= prev.t) return;
    const o: Observation = { t: ac.timestamp, lat: ac.lat, lon: ac.lon, onGround: ac.onGround };
    if (ac.altitudeFt !== undefined) o.altFt = ac.altitudeFt;
    if (ac.groundSpeedKt !== undefined) o.gsKt = ac.groundSpeedKt;
    if (ac.verticalRateFpm !== undefined) o.vrFpm = ac.verticalRateFpm;
    obs.push(o);
    if (obs.length > MAX_OBSERVATIONS) obs.splice(0, obs.length - MAX_OBSERVATIONS);
    this.series.set(key, obs);
    this.last.set(key, ac);
  }

  /** Seed history with a position the caller already has (e.g. at market creation). */
  ingest(flight: FlightRef, ac: Aircraft): void {
    this.record(flightKey(flight), ac);
  }

  async poll(now = Date.now()): Promise<void> {
    for (const [key, w] of this.watches) if (w.until < now) this.watches.delete(key);
    const byHex = new Map<string, string>();
    const byCallsign: Array<[string, Watch]> = [];
    for (const [key, w] of this.watches) {
      if (w.hex) byHex.set(w.hex, key);
      else byCallsign.push([key, w]);
    }
    try {
      if (byHex.size > 0) {
        for (const ac of await this.adsb.track([...byHex.keys()])) {
          const key = byHex.get(ac.hex);
          if (key) this.record(key, ac);
        }
      }
      // Flights booked before departure: find the aircraft by callsign once airborne.
      for (const [key, w] of byCallsign.slice(0, 10)) {
        if (!w.flight.callsign) continue;
        const found = (await this.adsb.byCallsign(w.flight.callsign)).filter((a) => !a.onGround || this.series.has(key));
        const ac = found[0];
        if (ac) {
          w.hex = ac.hex;
          this.record(key, ac);
        }
      }
    } catch (e) {
      log.warn("tracker poll failed", { error: String(e) });
    }
  }

  /**
   * Aircraft on final approach (below about 4,000 ft within 40 km of their
   * destination). They are polled every couple of seconds so the first
   * ground report, which decides landing markets, is caught promptly.
   */
  private finalApproach(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, w] of this.watches) {
      const ac = this.last.get(key);
      const dest = airportByIcao(w.flight.destination);
      if (!w.hex || !ac || ac.onGround || !dest) continue;
      if ((ac.altitudeFt ?? 99_999) < 4000 && distanceKm(ac, dest) < 40) out.set(w.hex, key);
    }
    return out;
  }

  async pollFinal(): Promise<void> {
    const finals = this.finalApproach();
    if (finals.size === 0) return;
    try {
      for (const ac of await this.adsb.track([...finals.keys()])) {
        const key = finals.get(ac.hex);
        if (key) this.record(key, ac);
      }
    } catch (e) {
      log.warn("final approach poll failed", { error: String(e) });
    }
  }

  observations(flight: FlightRef): Observation[] {
    return this.series.get(flightKey(flight)) ?? [];
  }

  latest(flight: FlightRef): Aircraft | undefined {
    return this.last.get(flightKey(flight));
  }

  status(flight: FlightRef, now: number): FlightStatus {
    const obs = this.observations(flight);
    return {
      touchdown: detectTouchdown(obs, now),
      departed: obs.some((o) => !o.onGround),
    };
  }
}
