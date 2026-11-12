import { describe, expect, it, vi } from "vitest";
import type { Aircraft } from "@flightradar/core";
import { deathZoneAt, deathZones, deathZoneTiles } from "@flightradar/core/deathzones";
import { distanceKm } from "@flightradar/core/geo";
import { DeathZoneTraffic } from "../src/deathZoneTraffic.js";
import type { AdsbSource } from "../src/adsb.js";

describe("death zone boundaries", () => {
  it.each([
    [35.85, 33.9, "LBN"], [38.8, 35, "SYR"], [43.7, 33, "IRQ"],
    [47.4, 15.8, "YEM"], [54, 32, "IRN"], [66, 34, "AFG"],
    [54, 12.5, "YEM"], // Socotra, detached island
    [10, 50, null], [46.7, 24.7, null], [35, 33, null], [NaN, 33, null],
  ])("assigns %s,%s to %s", (lon, lat, code) => expect(deathZoneAt(lon as number, lat as number)).toBe(code));

  it("covers every polygon boundary with upstream query circles", () => {
    for (const f of deathZones.features) {
      const polygons = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const polygon of polygons) for (const [lon, lat] of polygon[0]!) {
        expect(deathZoneTiles.some(t => distanceKm(t, { lon: lon!, lat: lat! }) < 250 * 1.852)).toBe(true);
      }
    }
  });
});

describe("regional live traffic", () => {
  const now = Date.now();
  const plane = (extra: Partial<Aircraft> = {}): Aircraft => ({ hex: "abc123", lon: 54, lat: 32, onGround: false, timestamp: now, ...extra });
  const source = () => ({ area: vi.fn(async () => []), areaStrict: vi.fn(async () => [plane()]), byHex: vi.fn(async () => [plane()]), track: vi.fn(async () => []), byCallsign: vi.fn(async () => []) });

  it("discovers non-webcam flights, refreshes and deduplicates them, removes aircraft leaving countries", async () => {
    const adsb = source();
    adsb.areaStrict.mockResolvedValue([plane(), plane(), plane({ hex: "def456", lon: 10 }), plane({ hex: "fedcba", onGround: true })]);
    const traffic = new DeathZoneTraffic(adsb);
    traffic.touch(); await traffic.step(now);
    expect(traffic.list(now)).toEqual([plane()]);
    adsb.byHex.mockResolvedValue([plane({ lon: 10, timestamp: now + 5000 })]);
    await traffic.step(now + 5000);
    expect(traffic.list(now + 5000)).toEqual([]);
    expect(adsb.track).not.toHaveBeenCalled();
  });

  it("expires stale positions even after upstream failures and stops without viewers", async () => {
    const adsb = source(); const traffic = new DeathZoneTraffic(adsb);
    traffic.touch(); await traffic.step(now);
    adsb.byHex.mockRejectedValue(new Error("offline"));
    await traffic.step(now + 5000);
    expect(traffic.status()).toBe("unavailable");
    expect(traffic.list(now + 120001)).toEqual([]);
    await traffic.step(now + 180000);
    expect(adsb.areaStrict).toHaveBeenCalledTimes(1);
  });

  it("does not accept silent cached fallback as a successful regional scan", async () => {
    const adsb: AdsbSource = { ...source(), areaStrict: undefined };
    const traffic = new DeathZoneTraffic(adsb); traffic.touch(); await traffic.step(now);
    expect(traffic.status()).toBe("unavailable"); expect(traffic.list(now)).toEqual([]);
  });
});

describe("regional routes for the map", () => {
  it("looks up where an aircraft over the red areas comes from and goes to", async () => {
    const now = Date.now();
    const ac: Aircraft = { hex: "abc999", callsign: "THY760", lon: 54, lat: 32, onGround: false, timestamp: now };
    const adsb = { area: vi.fn(async () => []), areaStrict: vi.fn(async () => [ac]), byHex: vi.fn(async () => [ac]), track: vi.fn(async () => []), byCallsign: vi.fn(async () => []) };
    const lookup = vi.fn(async () => ({ callsign: "THY760", flightNumber: "TK760", origin: "LTFM", destination: "OMDB" }));
    const traffic = new DeathZoneTraffic(adsb, { lookup });
    traffic.touch();
    await traffic.step(now);
    await new Promise((r) => setTimeout(r, 0));
    expect(traffic.routeOf(ac)).toEqual({ from: "LTFM", to: "OMDB", flightNumber: "TK760" });
    await traffic.step(now + 1000);
    expect(lookup).toHaveBeenCalledTimes(1); // cached per callsign
  });
});
