/**
 * Live aircraft positions from an ADS-B aggregator speaking the readsb v2
 * API (adsb.lol by default; its data is ODbL licensed, attribution required).
 *
 * Two separate request budgets: map views (many clients, cached and
 * quantised) and flight tracking for the oracle, which must never starve.
 * On HTTP 429 map views back off and serve the last good snapshot.
 */
import { fromReadsb, type Aircraft, type ReadsbAircraft } from "@flightradar/core";
import { fetchJson, HttpError, log, Throttle, TtlCache } from "./util.js";

interface ReadsbResponse {
  /** adsb.lol */
  ac?: ReadsbAircraft[];
  /** adsb.fi */
  aircraft?: ReadsbAircraft[];
  /** ms (adsb.lol) or seconds (adsb.fi) */
  now?: number;
}

export interface AdsbSource {
  area(lat: number, lon: number, radiusNm: number): Promise<Aircraft[]>;
  /** Lookup for user-facing requests (shares the map budget). */
  byHex(hexes: string[]): Promise<Aircraft[]>;
  /** Lookup for the oracle's flight tracker (own budget, fallback source). */
  track(hexes: string[]): Promise<Aircraft[]>;
  byCallsign(callsign: string): Promise<Aircraft[]>;
  /** Like `area`, but throws when no source answered (no cached fallback). */
  areaStrict?(lat: number, lon: number, radiusNm: number): Promise<Aircraft[]>;
  /** When the last upstream request succeeded or failed (unix ms, 0 = never). */
  health?(): { lastOkAt: number; lastFailAt: number };
}

const RADII = [25, 50, 100, 150, 250];

export class AdsbClient implements AdsbSource {
  private areaCache = new TtlCache<Promise<Aircraft[]>>(5000, 500);
  private lastGood = new TtlCache<Aircraft[]>(90_000, 500);
  private mapThrottle = new Throttle(2);
  private trackThrottle = new Throttle(1);
  private backoffUntil = 0;
  private lastOkAt = 0;
  private lastFailAt = 0;

  health() {
    return { lastOkAt: this.lastOkAt, lastFailAt: this.lastFailAt };
  }

  constructor(
    private baseUrl: string,
    private fallbackUrl?: string,
  ) {}

  private async get(base: string, path: string, throttle: Throttle): Promise<Aircraft[]> {
    await throttle.wait();
    let res: ReadsbResponse;
    try {
      res = await fetchJson<ReadsbResponse>(`${base}${path}`);
      this.lastOkAt = Date.now();
    } catch (e) {
      this.lastFailAt = Date.now();
      throw e;
    }
    const now = res.now === undefined ? Date.now() : res.now < 1e12 ? res.now * 1000 : res.now;
    return (res.ac ?? res.aircraft ?? []).map((a) => fromReadsb(a, now)).filter((a): a is Aircraft => a !== null);
  }

  private rateLimited(e: unknown): boolean {
    return e instanceof HttpError && e.message.includes("HTTP 429");
  }

  /** Aircraft within `radiusNm` of a point. Keys are quantised for caching. */
  area(lat: number, lon: number, radiusNm: number): Promise<Aircraft[]> {
    const r = RADII.find((x) => x >= radiusNm) ?? 250;
    const step = r <= 50 ? 0.25 : 0.5;
    const qlat = Math.round(lat / step) * step;
    const qlon = Math.round(lon / step) * step;
    const key = `${qlat.toFixed(2)},${qlon.toFixed(2)},${r}`;
    const hit = this.areaCache.get(key);
    if (hit) return hit;
    if (Date.now() < this.backoffUntil) return Promise.resolve(this.lastGood.get(key) ?? []);
    const path = `/v2/point/${qlat.toFixed(3)}/${qlon.toFixed(3)}/${r}`;
    const fromFallback = () =>
      this.fallbackUrl
        ? this.get(this.fallbackUrl, `/v2/lat/${qlat.toFixed(3)}/lon/${qlon.toFixed(3)}/dist/${r}`, this.mapThrottle)
        : Promise.reject(new Error("no fallback"));
    const p = this.get(this.baseUrl, path, this.mapThrottle)
      .then((list) => (list.length === 0 && this.fallbackUrl ? fromFallback().catch(() => list) : list))
      .catch((e) => {
        if (this.rateLimited(e)) this.backoffUntil = Date.now() + 15_000;
        return fromFallback();
      })
      .then((list) => {
        this.lastGood.set(key, list);
        return list;
      })
      .catch((e) => {
        if (this.rateLimited(e)) {
          this.backoffUntil = Date.now() + 15_000;
          log.warn("adsb rate limited, map views back off for 15 s");
        }
        return this.lastGood.get(key) ?? [];
      });
    this.areaCache.set(key, p);
    return p;
  }

  async areaStrict(lat: number, lon: number, radiusNm: number): Promise<Aircraft[]> {
    const r = RADII.find((x) => x >= radiusNm) ?? 250;
    const primary = `/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${r}`;
    try {
      const list = await this.get(this.baseUrl, primary, this.mapThrottle);
      if (list.length > 0 || !this.fallbackUrl) return list;
    } catch (e) {
      if (!this.fallbackUrl) throw e;
    }
    return this.get(this.fallbackUrl!, `/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${r}`, this.mapThrottle);
  }

  private async hexes(hexes: string[], throttle: Throttle, allowFallback: boolean): Promise<Aircraft[]> {
    const unique = [...new Set(hexes.map((h) => h.toLowerCase()).filter((h) => /^[0-9a-f]{6}$/.test(h)))];
    const out: Aircraft[] = [];
    for (let i = 0; i < unique.length; i += 40) {
      const path = `/v2/hex/${unique.slice(i, i + 40).join(",")}`;
      try {
        out.push(...(await this.get(this.baseUrl, path, throttle)));
      } catch (e) {
        if (!allowFallback || !this.fallbackUrl) throw e;
        out.push(...(await this.get(this.fallbackUrl, path, throttle)));
      }
    }
    return out;
  }

  byHex(hexes: string[]): Promise<Aircraft[]> {
    return this.hexes(hexes, this.mapThrottle, true);
  }

  track(hexes: string[]): Promise<Aircraft[]> {
    return this.hexes(hexes, this.trackThrottle, true);
  }

  byCallsign(callsign: string): Promise<Aircraft[]> {
    return this.get(this.baseUrl, `/v2/callsign/${encodeURIComponent(callsign.trim().toUpperCase())}`, this.trackThrottle);
  }
}
