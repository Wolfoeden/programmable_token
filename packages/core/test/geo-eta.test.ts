import { describe, expect, it } from "vitest";
import {
  airportByIcao,
  destinationPoint,
  distanceKm,
  estimateEta,
  nearestAirport,
  probabilityBefore,
  raceProbabilities,
  type Aircraft,
} from "../src/index.js";

const FRA = airportByIcao("EDDF")!;
const JFK = airportByIcao("KJFK")!;

function inbound(distanceKmFromFra: number, gs: number, now: number, bearingFromFra = 270): Aircraft {
  const p = destinationPoint(FRA, bearingFromFra, distanceKmFromFra);
  return {
    hex: "3c6444",
    callsign: "DLH123",
    lat: p.lat,
    lon: p.lon,
    altitudeFt: 30000,
    onGround: false,
    groundSpeedKt: gs,
    trackDeg: (bearingFromFra + 180) % 360,
    timestamp: now,
  };
}

describe("geo", () => {
  it("knows the distance Frankfurt to New York", () => {
    expect(distanceKm(FRA, JFK)).toBeGreaterThan(6150);
    expect(distanceKm(FRA, JFK)).toBeLessThan(6250);
  });

  it("finds the nearest airport", () => {
    expect(nearestAirport({ lat: 50.04, lon: 8.56 }, 5)?.icao).toBe("EDDF");
    expect(nearestAirport({ lat: 45, lon: -30 }, 50)).toBeUndefined();
  });
});

describe("eta model", () => {
  const now = Date.UTC(2026, 10, 2, 17, 0);

  it("estimates about 40 minutes for 450 km at 450 kt", () => {
    const eta = estimateEta(inbound(450, 450, now), FRA, now)!;
    expect(eta.remainingMin).toBeGreaterThan(35);
    expect(eta.remainingMin).toBeLessThan(50);
    expect(eta.sigmaMs).toBeGreaterThan(3 * 60_000);
  });

  it("refuses aircraft heading away from the destination", () => {
    const away = { ...inbound(450, 450, now), trackDeg: 270 };
    expect(estimateEta(away, FRA, now)).toBeNull();
  });

  it("gives 50 % at the expected time and grows monotonically", () => {
    const eta = estimateEta(inbound(450, 450, now), FRA, now)!;
    expect(probabilityBefore(eta, eta.etaMs)).toBeCloseTo(0.5, 6);
    expect(probabilityBefore(eta, eta.etaMs + 10 * 60_000)).toBeGreaterThan(0.9);
    expect(probabilityBefore(eta, eta.etaMs - 10 * 60_000)).toBeLessThan(0.1);
  });

  it("favours the closer aircraft in a race", () => {
    const near = estimateEta(inbound(200, 400, now), FRA, now)!;
    const far = estimateEta(inbound(400, 400, now, 90), FRA, now)!;
    const [pNear, pFar] = raceProbabilities([near, far]);
    expect(pNear).toBeGreaterThan(0.9);
    expect(pNear! + pFar!).toBeCloseTo(1, 9);
  });

  it("splits a three-way race into probabilities that sum to one", () => {
    const etas = [200, 210, 400].map((d, i) => estimateEta(inbound(d, 400, now, 90 * i), FRA, now)!);
    const ps = raceProbabilities(etas);
    expect(ps.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(ps[2]).toBeLessThan(0.05);
  });
});
