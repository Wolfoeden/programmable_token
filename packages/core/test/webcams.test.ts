import { describe, expect, it } from "vitest";
import { airportByIcao, classifyMovement, destinationPoint, landingWithinHour, WEBCAMS, webcamAirports, webcamFor, type Aircraft } from "../src/index.js";

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
});
