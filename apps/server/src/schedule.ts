/**
 * Flight schedules for departure boards, delay and cancellation markets.
 *
 * - AeroDataBox (RapidAPI key in AERODATABOX_KEY) for real schedules.
 * - SimulatedSchedule in demo mode only. Every flight it returns is marked
 *   `simulated` and the UI labels it as such.
 */
import { AIRPORTS, airportByIcao, cancellationRate, estimateEta, mulberry32, type Aircraft, type FlightRef } from "@flightradar/core";
import { fetchJson, Throttle, TtlCache } from "./util.js";

export type FlightStatusCode = "scheduled" | "delayed" | "boarding" | "departed" | "arrived" | "cancelled" | "diverted" | "unknown";

export interface ScheduledFlight {
  /** IATA flight number without spaces, e.g. "LH400". */
  flightNumber: string;
  callsign?: string;
  airline?: string;
  origin: string;
  destination: string;
  scheduledDeparture: number;
  scheduledArrival: number;
  status: FlightStatusCode;
  icao24?: string;
  simulated?: boolean;
}

export interface ScheduleProvider {
  readonly name: string;
  readonly simulated: boolean;
  departures(icao: string, fromMs: number, toMs: number): Promise<ScheduledFlight[]>;
  status(flightNumber: string, origin: string, scheduledDeparture: number): Promise<ScheduledFlight | null>;
  /** Schedule of a flight that is in the air right now. */
  airborne(flight: FlightRef, now: number, ac?: Aircraft): Promise<ScheduledFlight | null>;
}

// ## AeroDataBox

interface AdbTime {
  utc?: string;
}

interface AdbMovement {
  airport?: { icao?: string };
  scheduledTime?: AdbTime;
}

interface AdbFlight {
  number?: string;
  callSign?: string;
  status?: string;
  departure?: AdbMovement;
  arrival?: AdbMovement;
  movement?: AdbMovement;
  airline?: { name?: string };
  aircraft?: { modeS?: string };
}

const parseUtc = (t: AdbTime | undefined): number | undefined => {
  if (!t?.utc) return undefined;
  const ms = Date.parse(t.utc.replace(" ", "T"));
  return Number.isFinite(ms) ? ms : undefined;
};

function mapStatus(s: string | undefined): FlightStatusCode {
  switch ((s ?? "").toLowerCase()) {
    case "expected":
    case "checkin":
    case "gateclosed":
      return "scheduled";
    case "boarding":
      return "boarding";
    case "delayed":
      return "delayed";
    case "departed":
    case "enroute":
    case "approaching":
      return "departed";
    case "arrived":
      return "arrived";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "diverted":
      return "diverted";
    default:
      return "unknown";
  }
}

function localWindow(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

export class AeroDataBox implements ScheduleProvider {
  readonly name = "AeroDataBox";
  readonly simulated = false;
  private cache = new TtlCache<Promise<ScheduledFlight[]>>(5 * 60_000, 500);
  private throttle = new Throttle(1);

  constructor(
    private key: string,
    private host: string,
  ) {}

  private headers() {
    return { "x-rapidapi-key": this.key, "x-rapidapi-host": this.host };
  }

  private toFlight(f: AdbFlight, origin: string | undefined): ScheduledFlight | null {
    const dep = f.departure ?? (origin ? { ...f.movement, airport: { icao: origin } } : undefined);
    const arr = f.arrival ?? f.movement;
    const o = (dep?.airport?.icao ?? origin)?.toUpperCase();
    const d = arr?.airport?.icao?.toUpperCase();
    const sd = parseUtc(dep?.scheduledTime);
    const sa = parseUtc(f.arrival?.scheduledTime);
    if (!f.number || !o || !d || sd === undefined) return null;
    const out: ScheduledFlight = {
      flightNumber: f.number.replace(/\s+/g, "").toUpperCase(),
      origin: o,
      destination: d,
      scheduledDeparture: sd,
      scheduledArrival: sa ?? sd,
      status: mapStatus(f.status),
    };
    if (f.callSign) out.callsign = f.callSign.replace(/\s+/g, "").toUpperCase();
    if (f.airline?.name) out.airline = f.airline.name;
    if (f.aircraft?.modeS) out.icao24 = f.aircraft.modeS.toLowerCase();
    return out;
  }

  departures(icao: string, fromMs: number, toMs: number): Promise<ScheduledFlight[]> {
    const key = `${icao}:${Math.floor(fromMs / 600_000)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = (async () => {
      await this.throttle.wait();
      const url =
        `https://${this.host}/flights/airports/icao/${icao}/${localWindow(fromMs)}/${localWindow(Math.min(toMs, fromMs + 12 * 3600_000))}` +
        `?withLeg=true&direction=Departure&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false`;
      const res = await fetchJson<{ departures?: AdbFlight[] }>(url, { headers: this.headers() });
      return (res.departures ?? []).map((f) => this.toFlight(f, icao)).filter((f): f is ScheduledFlight => f !== null);
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.set(key, Promise.resolve([]), 30_000));
    return p;
  }

  async status(flightNumber: string, origin: string, scheduledDeparture: number): Promise<ScheduledFlight | null> {
    await this.throttle.wait();
    const date = new Date(scheduledDeparture).toISOString().slice(0, 10);
    const res = await fetchJson<AdbFlight[]>(`https://${this.host}/flights/number/${encodeURIComponent(flightNumber)}/${date}`, { headers: this.headers() });
    const flights = (Array.isArray(res) ? res : []).map((f) => this.toFlight(f, undefined)).filter((f): f is ScheduledFlight => f !== null);
    return flights.find((f) => f.origin === origin && Math.abs(f.scheduledDeparture - scheduledDeparture) < 3 * 3600_000) ?? null;
  }

  async airborne(flight: FlightRef, now: number): Promise<ScheduledFlight | null> {
    if (!flight.flightNumber) return null;
    for (const day of [now, now - 86_400_000]) {
      await this.throttle.wait();
      const date = new Date(day).toISOString().slice(0, 10);
      const res = await fetchJson<AdbFlight[]>(`https://${this.host}/flights/number/${encodeURIComponent(flight.flightNumber)}/${date}`, {
        headers: this.headers(),
      }).catch(() => [] as AdbFlight[]);
      const match = (Array.isArray(res) ? res : [])
        .map((f) => this.toFlight(f, undefined))
        .find((f) => f && f.origin === flight.origin && f.destination === flight.destination && f.scheduledDeparture < now && now < f.scheduledArrival + 6 * 3600_000);
      if (match) return match;
    }
    return null;
  }
}

// ## Simulation (demo mode only)

const SIM_AIRLINES = [
  ["LH", "DLH", "Lufthansa"],
  ["BA", "BAW", "British Airways"],
  ["AF", "AFR", "Air France"],
  ["KL", "KLM", "KLM"],
  ["FR", "RYR", "Ryanair"],
  ["U2", "EZY", "easyJet"],
  ["EW", "EWG", "Eurowings"],
  ["TK", "THY", "Turkish Airlines"],
] as const;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Deterministic made-up departures for demos without a schedule API key.
 * A flight "departs" at its scheduled time unless it is one of the
 * (base-rate frequent) cancellations, which are announced 3 hours before.
 */
export class SimulatedSchedule implements ScheduleProvider {
  readonly name = "Simulation";
  readonly simulated = true;
  private destinations = AIRPORTS.filter((a) => a.size === 2 && a.iata);

  private flightsFor(icao: string, hourStart: number): ScheduledFlight[] {
    const rng = mulberry32(hash(`${icao}:${hourStart}`));
    const origin = airportByIcao(icao);
    if (!origin) return [];
    const out: ScheduledFlight[] = [];
    const count = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i++) {
      const [iata, icaoCode, name] = SIM_AIRLINES[Math.floor(rng() * SIM_AIRLINES.length)]!;
      const dest = this.destinations[Math.floor(rng() * this.destinations.length)]!;
      if (dest.icao === icao) continue;
      const number = `${100 + Math.floor(rng() * 8900)}`;
      const dep = hourStart + Math.floor(rng() * 12) * 5 * 60_000;
      const durationMin = 60 + Math.floor(rng() * 300);
      const cancelled = rng() < cancellationRate(icao);
      out.push({
        flightNumber: `${iata}${number}`,
        callsign: `${icaoCode}${number}`,
        airline: name,
        origin: icao,
        destination: dest.icao,
        scheduledDeparture: dep,
        scheduledArrival: dep + durationMin * 60_000,
        status: cancelled ? "cancelled" : "scheduled",
        simulated: true,
      });
    }
    return out;
  }

  private withLiveStatus(f: ScheduledFlight, now: number): ScheduledFlight {
    if (f.status === "cancelled") return now >= f.scheduledDeparture - 3 * 3600_000 ? f : { ...f, status: "scheduled" };
    if (now >= f.scheduledArrival) return { ...f, status: "arrived" };
    if (now >= f.scheduledDeparture) return { ...f, status: "departed" };
    return f;
  }

  async departures(icao: string, fromMs: number, toMs: number): Promise<ScheduledFlight[]> {
    const out: ScheduledFlight[] = [];
    const now = Date.now();
    for (let h = Math.floor(fromMs / 3600_000) * 3600_000; h < toMs; h += 3600_000) {
      out.push(...this.flightsFor(icao.toUpperCase(), h));
    }
    return out
      .filter((f) => f.scheduledDeparture >= fromMs && f.scheduledDeparture < toMs)
      .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture)
      .map((f) => this.withLiveStatus(f, now));
  }

  /**
   * Made-up schedule for a real airborne flight: scheduled arrival somewhere
   * between 25 minutes before and 20 minutes after its estimated arrival.
   */
  async airborne(flight: FlightRef, now: number, ac?: Aircraft): Promise<ScheduledFlight | null> {
    const dest = airportByIcao(flight.destination);
    const eta = ac && dest ? estimateEta(ac, dest, now) : null;
    if (!eta) return null;
    const rng = mulberry32(hash(`${flight.callsign}:${new Date(now).toISOString().slice(0, 10)}`));
    const offset = Math.round(-25 + rng() * 45) * 60_000;
    const scheduledArrival = Math.round((eta.etaMs + offset) / 300_000) * 300_000;
    return {
      flightNumber: flight.flightNumber || flight.callsign,
      callsign: flight.callsign,
      origin: flight.origin,
      destination: flight.destination,
      scheduledDeparture: scheduledArrival - 2 * 3600_000,
      scheduledArrival,
      status: "departed",
      icao24: flight.icao24,
      simulated: true,
    };
  }

  async status(flightNumber: string, origin: string, scheduledDeparture: number): Promise<ScheduledFlight | null> {
    const hour = Math.floor(scheduledDeparture / 3600_000) * 3600_000;
    const f = this.flightsFor(origin.toUpperCase(), hour).find((x) => x.flightNumber === flightNumber && x.scheduledDeparture === scheduledDeparture);
    return f ? this.withLiveStatus(f, Date.now()) : null;
  }
}
