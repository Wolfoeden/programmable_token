/** Normalised aircraft state from ADS-B aggregators (readsb / tar1090 JSON). */

export interface Aircraft {
  /** ICAO 24-bit address, lowercase hex. */
  hex: string;
  /** Callsign as transmitted, trimmed. Usually ICAO airline code + number. */
  callsign?: string;
  registration?: string;
  /** ICAO aircraft type designator, e.g. "A320". */
  type?: string;
  lat: number;
  lon: number;
  /** Barometric altitude in feet. Undefined while unknown or on ground. */
  altitudeFt?: number;
  onGround: boolean;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  squawk?: string;
  /** Emitter category, e.g. "A3" (large), "A7" (rotorcraft). */
  category?: string;
  /** Unix ms at which the position was valid. */
  timestamp: number;
}

/** Raw aircraft record as returned by adsb.lol / adsb.fi v2 APIs. */
export interface ReadsbAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  category?: string;
  seen_pos?: number;
  seen?: number;
}

/**
 * Convert a readsb record into an `Aircraft`. Returns `null` without a
 * position or for stale positions (older than `maxAgeSec`).
 */
export function fromReadsb(raw: ReadsbAircraft, snapshotMs: number, maxAgeSec = 60): Aircraft | null {
  if (typeof raw.lat !== "number" || typeof raw.lon !== "number") return null;
  const age = raw.seen_pos ?? raw.seen ?? 0;
  if (age > maxAgeSec) return null;
  const onGround = raw.alt_baro === "ground";
  const callsign = raw.flight?.trim() || undefined;
  const track = raw.track ?? raw.true_heading;
  const vr = raw.baro_rate ?? raw.geom_rate;
  const ac: Aircraft = {
    hex: raw.hex.toLowerCase().replace(/^~/, ""),
    lat: raw.lat,
    lon: raw.lon,
    onGround,
    timestamp: Math.round(snapshotMs - age * 1000),
  };
  if (callsign) ac.callsign = callsign;
  if (raw.r) ac.registration = raw.r;
  if (raw.t) ac.type = raw.t;
  if (!onGround && typeof raw.alt_baro === "number") ac.altitudeFt = raw.alt_baro;
  if (typeof raw.gs === "number") ac.groundSpeedKt = raw.gs;
  if (typeof track === "number") ac.trackDeg = track;
  if (typeof vr === "number") ac.verticalRateFpm = vr;
  if (raw.squawk) ac.squawk = raw.squawk;
  if (raw.category) ac.category = raw.category;
  return ac;
}

/** Airline-style callsign: 3-letter ICAO prefix followed by a flight number. */
export function isAirlineCallsign(callsign: string | undefined): boolean {
  return !!callsign && /^[A-Z]{3}[0-9][0-9A-Z]{0,3}$/.test(callsign);
}
