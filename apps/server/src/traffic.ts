/**
 * The traffic shown on the map: only aircraft landing at or taking off from
 * airports that have a public webcam. One upstream request per airport in a
 * slow round-robin, shared by all clients, and paused while nobody is
 * watching. This keeps upstream calls, CPU and payload small and constant.
 */
import { destinationPoint, distanceKm, isWithinRange, landingWithinHour, onRoute, MOVEMENT_RADIUS_NM, webcamAirports, type Aircraft, type Airport, type Movement } from "@flightradar/core";
import type { AdsbSource } from "./adsb.js";
import type { RouteSource } from "./routes.js";
import type { ShadowFlight, ShadowSample } from "./shadow.js";

export interface Shown {
  aircraft: Aircraft;
  phase: Movement;
  airport: string;
  /** Departure airport (ICAO), within about an hour of `airport`. */
  origin?: string;
  /** IATA flight number from the route data, if known. */
  flightNumber?: string;
  /** Estimated touchdown (model, unix ms) and one standard deviation. */
  etaMs: number;
  etaSigmaMs: number;
}

/**
 * What happened to a flight after it was listed. "approaching": on the
 * list. "final": off the list (inside the last minute, or a go-around) but
 * still airborne. "landed": first ADS-B ground report within 6 km of the
 * airport. "lost": no ground report and no signal for 5 minutes; the
 * landing is then unconfirmed.
 */
export type ArrivalStatus = "approaching" | "final" | "landed" | "lost";

export interface Arrival {
  hex: string;
  airport: string;
  callsign?: string;
  flightNumber?: string;
  origin?: string;
  type?: string;
  status: ArrivalStatus;
  lat: number;
  lon: number;
  altitudeFt?: number;
  /** Last position report, unix ms. */
  lastSeenAt: number;
  /** Time of the first ground report at the airport (status landed). */
  landedAt?: number;
  /** When the status became landed or lost. */
  endedAt?: number;
}

/** A position along a flight's path: lon, lat, unix ms. */
export type TrackPoint = [number, number, number];

/** Ground reports further out than this do not count as landing here. */
const LANDED_RADIUS_KM = 6;
/** No position for this long after leaving the list: landing unconfirmed. */
const LOST_AFTER_MS = 5 * 60_000;
/** Airborne off the list for this long (e.g. holding): give up. */
const FINAL_GIVE_UP_MS = 20 * 60_000;
/** Ended arrivals stay visible this long. */
const KEEP_ENDED_MS = 30 * 60_000;
const MAX_TRACK_POINTS = 150;

/** What the map can say about its data right now. */
export type TrafficStatus = "loading" | "ok" | "unavailable";

const IDLE_AFTER_MS = 2 * 60_000;
const STALE_AFTER_MS = 3 * 60_000;

/**
 * One upstream area query reaches 250 nm (463 km), but a jet is 700-800 km
 * out an hour before landing. Besides the airport itself, each airport is
 * also queried around four points 380 km to the north, east, south and
 * west, which together see inbound traffic up to about 840 km out.
 */
const RING_KM = 380;
const RING_BEARINGS = [0, 90, 180, 270];

interface Slot {
  airport: Airport;
  /** 0 = the airport itself, 1..4 = ring points. */
  k: number;
  lat: number;
  lon: number;
}

export class CamTraffic {
  private airports: Airport[] = webcamAirports();
  private slots: Slot[] = this.airports.flatMap((a) => [
    { airport: a, k: 0, lat: a.lat, lon: a.lon },
    ...RING_BEARINGS.map((b, i) => ({ airport: a, k: i + 1, ...destinationPoint(a, b, RING_KM) })),
  ]);
  /** Steps until every query point (airports and ring points) has been asked once. */
  get slotsPerRound(): number {
    return 2 * Math.max(this.airports.length, this.slots.length - this.airports.length);
  }
  private perAirport = new Map<string, { at: number; list: Shown[] }>();
  private next = 0;
  private lastClientAt = 0;
  private arrivals = new Map<string, Arrival>();
  private tracks = new Map<string, TrackPoint[]>();
  private samples = new Map<string, { firstListedAt: number; list: ShadowSample[] }>();
  /** Called once per flight when its arrival is decided (shadow log). */
  onFinished?: (f: ShadowFlight) => void;
  /** Keep refreshing without viewers (for the shadow log). */
  alwaysOn = false;
  /** Airports refreshed at least once since the list went active. */
  private refreshed = new Set<string>();
  updatedAt = 0;

  constructor(
    private adsb: AdsbSource,
    private routes?: RouteSource,
  ) {}

  /** Called by the API on every map request. */
  touch(): void {
    if (!this.active) this.refreshed.clear();
    this.lastClientAt = Date.now();
  }

  /**
   * loading: not every airport has been queried since someone started
   * watching. unavailable: the upstream source has been failing for over a
   * minute. ok: the list reflects current data (it may be empty).
   */
  status(): TrafficStatus {
    const h = this.adsb.health?.();
    const now = Date.now();
    if (h && h.lastFailAt > h.lastOkAt && now - h.lastOkAt > 60_000 && h.lastFailAt > 0) return "unavailable";
    // Loading until every airport itself has been queried (the ring points follow).
    if (this.airports.some((a) => !this.refreshed.has(`${a.icao}#0`))) return "loading";
    return "ok";
  }

  get active(): boolean {
    return this.alwaysOn || Date.now() - this.lastClientAt < IDLE_AFTER_MS;
  }

  /** Refresh one query point. Call every 1.5 s or so. */
  async step(): Promise<void> {
    if (!this.active || this.slots.length === 0) return;
    // Alternate: an airport itself (touchdowns are seen there, every ~15 s
    // for five airports), then the next ring point (each about once a minute).
    const centers = this.slots.filter((x) => x.k === 0);
    const rings = this.slots.filter((x) => x.k > 0);
    const n = this.next;
    const slot = n % 2 === 0 || rings.length === 0 ? centers[(n >> 1) % centers.length]! : rings[(n >> 1) % rings.length]!;
    const airport = slot.airport;
    this.next += 1;
    // Judge only this request: a failure keeps the previous list (it ages out).
    let list: Aircraft[] = [];
    let failed = false;
    try {
      list = this.adsb.areaStrict
        ? await this.adsb.areaStrict(slot.lat, slot.lon, MOVEMENT_RADIUS_NM)
        : await this.adsb.area(slot.lat, slot.lon, MOVEMENT_RADIUS_NM);
    } catch {
      failed = true;
    }
    // Only flights landing at this airport within the hour are shown.
    const shown: Shown[] = [];
    for (const ac of list) {
      if (!ac.callsign) continue;
      const eta = landingWithinHour(ac, airport);
      if (!eta) continue;
      const phase: Movement = "landing";
      // Geometry alone also catches traffic for neighbouring airports
      // (London has six). Keep only flights whose route ends here.
      // Only flights of up to about three hours (departure within 2,200 km).
      let origin: string | undefined;
      let flightNumber: string | undefined;
      if (this.routes) {
        const route = await this.routes.lookup(ac.callsign);
        if (route?.destination !== airport.icao || !isWithinRange(route.origin, airport.icao) || !onRoute(ac, route.origin, airport.icao)) continue;
        origin = route.origin;
        if (route.flightNumber) flightNumber = route.flightNumber;
      }
      shown.push({
        aircraft: ac,
        phase,
        airport: airport.icao,
        etaMs: eta.etaMs,
        etaSigmaMs: eta.sigmaMs,
        ...(origin ? { origin } : {}),
        ...(flightNumber ? { flightNumber } : {}),
      });
    }
    // An empty answer is usually an upstream hiccup: keep the last list.
    // A failed request keeps the previous list; it ages out after 3 minutes.
    if (!failed) {
      this.perAirport.set(`${airport.icao}#${slot.k}`, { at: Date.now(), list: shown });
      this.updatedAt = Date.now();
      // Arrivals and touchdowns are judged from the query at the airport,
      // against everything currently listed for it (all query points).
      if (slot.k === 0) this.follow(airport, this.list().filter((x) => x.airport === airport.icao), list);
    }
    this.refreshed.add(`${airport.icao}#${slot.k}`);
  }

  /** Update arrivals at this airport from one fresh answer. */
  private follow(airport: Airport, shown: Shown[], raw: Aircraft[], now = Date.now()): void {
    const listed = new Set<string>();
    for (const s of shown) {
      const ac = s.aircraft;
      listed.add(ac.hex);
      const prev = this.arrivals.get(ac.hex);
      if (prev && prev.airport !== airport.icao && prev.status !== "approaching") this.arrivals.delete(ac.hex);
      this.arrivals.set(ac.hex, {
        hex: ac.hex,
        airport: airport.icao,
        status: "approaching",
        lat: ac.lat,
        lon: ac.lon,
        lastSeenAt: ac.timestamp,
        ...(ac.altitudeFt !== undefined ? { altitudeFt: ac.altitudeFt } : {}),
        ...(ac.callsign ? { callsign: ac.callsign } : {}),
        ...(s.flightNumber ? { flightNumber: s.flightNumber } : {}),
        ...(s.origin ? { origin: s.origin } : {}),
        ...(ac.type ? { type: ac.type } : {}),
      });
      this.record(ac);
      this.sample(s, airport);
    }
    for (const a of this.arrivals.values()) {
      if (a.airport !== airport.icao || listed.has(a.hex) || a.status === "landed" || a.status === "lost") continue;
      const ac = raw.find((x) => x.hex === a.hex);
      if (ac && ac.timestamp >= a.lastSeenAt) {
        this.record(ac);
        a.lat = ac.lat;
        a.lon = ac.lon;
        a.lastSeenAt = ac.timestamp;
        if (ac.altitudeFt !== undefined) a.altitudeFt = ac.altitudeFt;
        else delete a.altitudeFt;
        if (ac.onGround && (ac.groundSpeedKt ?? 0) <= 200 && distanceKm(ac, airport) <= LANDED_RADIUS_KM) {
          a.status = "landed";
          a.landedAt = ac.timestamp;
          a.endedAt = now;
          this.finish(a, "landed");
          continue;
        }
        a.status = "final";
      } else if (a.status === "approaching") {
        a.status = "final";
      }
      if (now - a.lastSeenAt > LOST_AFTER_MS || (ac && !ac.onGround && now - a.lastSeenAt < 60_000 && distanceKm(ac, airport) > 150)) {
        a.status = "lost";
        a.endedAt = now;
        this.finish(a, "lost");
      }
    }
    // Off the list and airborne for too long, or long finished: forget.
    for (const [hex, a] of this.arrivals) {
      const gone = (a.endedAt !== undefined && now - a.endedAt > KEEP_ENDED_MS) || (a.status === "final" && now - a.lastSeenAt > FINAL_GIVE_UP_MS);
      if (gone) {
        if (a.status === "final") this.finish(a, "gave_up");
        this.arrivals.delete(hex);
        this.tracks.delete(hex);
      }
    }
  }

  private sample(s: Shown, airport: Airport): void {
    const ac = s.aircraft;
    const rec = this.samples.get(ac.hex) ?? { firstListedAt: ac.timestamp, list: [] };
    const last = rec.list[rec.list.length - 1];
    if (!last || ac.timestamp - last.t >= 30_000) {
      rec.list.push({
        t: ac.timestamp,
        distKm: Math.round(distanceKm(ac, airport) * 10) / 10,
        ...(ac.altitudeFt !== undefined ? { altFt: ac.altitudeFt } : {}),
        ...(ac.groundSpeedKt !== undefined ? { gsKt: ac.groundSpeedKt } : {}),
        ...(ac.verticalRateFpm !== undefined ? { vrFpm: ac.verticalRateFpm } : {}),
        etaMs: s.etaMs,
        sigmaMs: s.etaSigmaMs,
      });
      if (rec.list.length > 200) rec.list.shift();
    }
    this.samples.set(ac.hex, rec);
  }

  private finish(a: Arrival, status: ShadowFlight["outcome"]["status"]): void {
    const rec = this.samples.get(a.hex);
    this.samples.delete(a.hex);
    if (!rec || rec.list.length === 0 || !this.onFinished) return;
    this.onFinished({
      v: 1,
      hex: a.hex,
      airport: a.airport,
      firstListedAt: rec.firstListedAt,
      samples: rec.list,
      outcome: { status, lastSeenAt: a.lastSeenAt, ...(a.landedAt !== undefined ? { landedAt: a.landedAt } : {}) },
      ...(a.callsign ? { callsign: a.callsign } : {}),
      ...(a.flightNumber ? { flightNumber: a.flightNumber } : {}),
      ...(a.type ? { type: a.type } : {}),
      ...(a.origin ? { origin: a.origin } : {}),
    });
  }

  /** Model estimate for a listed flight right now (for the bet log). */
  estimate(hex: string): { etaMs: number; sigmaMs: number } | undefined {
    const s = this.list().find((x) => x.aircraft.hex === hex);
    return s ? { etaMs: s.etaMs, sigmaMs: s.etaSigmaMs } : undefined;
  }

  private record(ac: Aircraft): void {
    const pts = this.tracks.get(ac.hex) ?? [];
    const last = pts[pts.length - 1];
    if (last && last[2] >= ac.timestamp) return;
    pts.push([Math.round(ac.lon * 1e5) / 1e5, Math.round(ac.lat * 1e5) / 1e5, ac.timestamp]);
    if (pts.length > MAX_TRACK_POINTS) pts.splice(0, pts.length - MAX_TRACK_POINTS);
    this.tracks.set(ac.hex, pts);
  }

  /** Arrivals at live-stream airports: listed, on final, landed or lost. */
  arrivalList(): Arrival[] {
    return [...this.arrivals.values()].map((a) => ({ ...a }));
  }

  /** Positions recorded since the flight was first listed. */
  track(hex: string): TrackPoint[] {
    return this.tracks.get(hex)?.slice() ?? [];
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
