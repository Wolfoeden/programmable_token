import { describe, expect, it } from "vitest";
import { airportByIcao, bearingDeg, classifyMovement, isShortHaul, onRoute, destinationPoint, landingWithinHour, WEBCAMS, webcamAirports, webcamFor, type Aircraft } from "../src/index.js";

const LHR = airportByIcao("EGLL")!;
const at = (km: number, bearing: number, o: Partial<Aircraft>): Aircraft => {
  const p = destinationPoint(LHR, bearing, km);
  return { hex: "aaaaaa", lat: p.lat, lon: p.lon, onGround: false, timestamp: 0, ...o };
};

describe("live-stream airports", () => {
  it("are the five chosen airports, all in the database", () => {
    expect(WEBCAMS.map((w) => w.icao)).toEqual(["EGLL", "GCRR", "KLAS", "RJTT", "LPMA"]);
    expect(webcamAirports()).toHaveLength(5);
    expect(webcamFor("egll")?.url).toContain("youtube.com");
    expect(webcamFor("LSZH")).toBeUndefined();
  });

  it("keeps only flights landing within the hour", () => {
    // 150 km out, descending towards Heathrow: about 20 minutes
    const near = at(150, 90, { trackDeg: 270, altitudeFt: 20000, verticalRateFpm: -1500, groundSpeedKt: 380 });
    expect(classifyMovement(near, LHR)).toBe("landing");
    expect(landingWithinHour(near, LHR)!.remainingMin).toBeLessThan(60);
    // 450 km out, slow: more than an hour away
    expect(classifyMovement(at(450, 90, { trackDeg: 270, altitudeFt: 37000, verticalRateFpm: 0, groundSpeedKt: 240 }), LHR)).toBeNull();
    // climbing away after take-off
    expect(classifyMovement(at(20, 270, { trackDeg: 270, altitudeFt: 7000, verticalRateFpm: 2500, groundSpeedKt: 280 }), LHR)).toBeNull();
    // flying past
    expect(classifyMovement(at(100, 90, { trackDeg: 0, altitudeFt: 15000, verticalRateFpm: -1000, groundSpeedKt: 350 }), LHR)).toBeNull();
  });

  it("counts only departure airports within about an hour", () => {
    expect(isShortHaul("LFPG", "EGLL")).toBe(true); // Paris, ~350 km
    expect(isShortHaul("GCLP", "GCRR")).toBe(true); // Gran Canaria
    expect(isShortHaul("KLAX", "KLAS")).toBe(true);
    expect(isShortHaul("WSSS", "EGLL")).toBe(false); // Singapore
    expect(isShortHaul("LPPT", "LPMA")).toBe(false); // Lisbon, ~970 km
    expect(isShortHaul("EGLL", "EGLL")).toBe(false);
  });

  it("rejects stale routes where the aircraft is nowhere near the line", () => {
    expect(onRoute({ lat: 50.9, lon: 2.2 }, "EBBR", "EGLL")).toBe(true); // over the Channel coast
    expect(onRoute({ lat: 48.2, lon: -2.0 }, "EBBR", "EGLL")).toBe(false); // over Brittany
  });

  it("rejects a reused flight number flying to another airport in a similar direction", () => {
    // SWA2697 listed as Oakland → Las Vegas, actually flying Oakland → Phoenix (about 15° apart).
    const OAK = airportByIcao("KOAK")!;
    const LAS = airportByIcao("KLAS")!;
    const PHX = airportByIcao("KPHX")!;
    const toPhx = (km: number) => {
      const p = destinationPoint(OAK, bearingDeg(OAK, PHX), km);
      return { ...p, trackDeg: bearingDeg(p, PHX) };
    };
    for (const km of [50, 150, 250, 400]) expect(onRoute(toPhx(km), "KOAK", "KLAS")).toBe(false);
    // The real Oakland → Las Vegas flight passes once under way.
    const toLas = (km: number) => {
      const p = destinationPoint(OAK, bearingDeg(OAK, LAS), km);
      return { ...p, trackDeg: bearingDeg(p, LAS) };
    };
    // Too early to tell: Phoenix fits the position as well.
    for (const km of [50, 150]) expect(onRoute(toLas(km), "KOAK", "KLAS")).toBe(false);
    for (const km of [300, 450, 600]) expect(onRoute(toLas(km), "KOAK", "KLAS")).toBe(true);
  });
});
