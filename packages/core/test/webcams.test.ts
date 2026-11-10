import { describe, expect, it } from "vitest";
import { airportByIcao, classifyMovement, destinationPoint, WEBCAMS, webcamAirports, webcamFor, type Aircraft } from "../src/index.js";

const ZRH = airportByIcao("LSZH")!;
const at = (km: number, bearing: number, o: Partial<Aircraft>): Aircraft => {
  const p = destinationPoint(ZRH, bearing, km);
  return { hex: "aaaaaa", lat: p.lat, lon: p.lon, onGround: false, timestamp: 0, ...o };
};

describe("webcam airports", () => {
  it("are all in the airport database", () => {
    expect(webcamAirports()).toHaveLength(WEBCAMS.length);
    expect(webcamFor("lszh")?.kind).toBe("video");
    expect(webcamFor("EDDF")).toBeUndefined();
  });

  it("classifies approaches, departures and overflights", () => {
    // 80 km north, heading south towards the field, descending
    expect(classifyMovement(at(80, 0, { trackDeg: 180, altitudeFt: 14000, verticalRateFpm: -1500 }), ZRH)).toBe("landing");
    // short final, slightly offset
    expect(classifyMovement(at(8, 100, { trackDeg: 283, altitudeFt: 3000, verticalRateFpm: -700 }), ZRH)).toBe("landing");
    // just departed, climbing away
    expect(classifyMovement(at(15, 280, { trackDeg: 280, altitudeFt: 6000, verticalRateFpm: 2500 }), ZRH)).toBe("takeoff");
    // cruising overflight pointing at the field
    expect(classifyMovement(at(120, 0, { trackDeg: 180, altitudeFt: 38000, verticalRateFpm: 0 }), ZRH)).toBeNull();
    // descending but flying past
    expect(classifyMovement(at(80, 0, { trackDeg: 90, altitudeFt: 14000, verticalRateFpm: -1500 }), ZRH)).toBeNull();
    // on the ground
    expect(classifyMovement({ ...at(1, 0, { trackDeg: 180 }), onGround: true }, ZRH)).toBeNull();
  });
});
