import type { Aircraft } from "@flightradar/core";
import { deathZoneAt, deathZoneTiles } from "@flightradar/core/deathzones";
import type { AdsbSource } from "./adsb.js";

const MAX_AGE = 120_000;

/** Shared regional discovery, independent of webcam/market eligibility.
 * One bounded upstream request per step, alternating discovery and fresh
 * positions of known aircraft. Never uses the oracle's reserved budget.
 */
export class DeathZoneTraffic {
  private planes = new Map<string, Aircraft>();
  private tile = 0;
  private cursor = 0;
  private discover = true;
  private busy = false;
  private touchedAt = 0;
  updatedAt = 0;
  private failed = false;
  constructor(private adsb: AdsbSource) {}

  touch() { this.touchedAt = Date.now(); }
  list(now = Date.now()): Aircraft[] {
    for (const [hex, a] of this.planes) if (now - a.timestamp > MAX_AGE) this.planes.delete(hex);
    return [...this.planes.values()];
  }
  status() {
    return this.failed ? "unavailable" : this.updatedAt ? "ok" : "loading";
  }
  async step(now = Date.now()): Promise<void> {
    if (this.busy || !this.touchedAt || now - this.touchedAt > 90_000) return;
    this.busy = true;
    try {
      const known = this.list(now);
      let list: Aircraft[];
      if (this.discover || !known.length) {
        const tile = deathZoneTiles[this.tile++ % deathZoneTiles.length]!;
        // Strict requests distinguish an empty response from upstream failure.
        if (!this.adsb.areaStrict) throw new Error("Regional traffic requires strict ADS-B queries");
        list = await this.adsb.areaStrict(tile.lat, tile.lon, 250);
      } else {
        const batch = Array.from({ length: Math.min(40, known.length) }, (_, i) => known[(this.cursor + i) % known.length]!.hex);
        this.cursor = (this.cursor + batch.length) % known.length;
        list = await this.adsb.byHex(batch);
      }
      this.discover = !this.discover;
      for (const a of list) {
        if (!a.onGround && now - a.timestamp <= MAX_AGE && a.timestamp <= now + 30_000 && deathZoneAt(a.lon, a.lat)) {
          const previous = this.planes.get(a.hex);
          if (!previous || a.timestamp >= previous.timestamp) this.planes.set(a.hex, a);
        } else if ((this.planes.get(a.hex)?.timestamp ?? 0) <= a.timestamp) this.planes.delete(a.hex);
      }
      this.updatedAt = now;
      this.failed = false;
    } catch {
      this.failed = true;
    } finally { this.busy = false; }
  }
}
