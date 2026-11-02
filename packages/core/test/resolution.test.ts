import { describe, expect, it } from "vitest";
import { detectTouchdown, judge, type FlightRef, type Observation, type Question } from "../src/index.js";

const flight: FlightRef = { callsign: "DLH400", flightNumber: "LH400", icao24: "3c4b21", origin: "KJFK", destination: "EDDF" };
const t0 = Date.UTC(2026, 10, 2, 17, 0);
const s = (sec: number) => t0 + sec * 1000;

/** Final approach into Frankfurt runway 25C from the east. */
const approach: Observation[] = [
  { t: s(0), lat: 50.06, lon: 8.95, altFt: 3000, onGround: false, gsKt: 160, vrFpm: -800 },
  { t: s(60), lat: 50.05, lon: 8.8, altFt: 2200, onGround: false, gsKt: 150, vrFpm: -750 },
  { t: s(120), lat: 50.04, lon: 8.66, altFt: 1100, onGround: false, gsKt: 145, vrFpm: -700 },
  { t: s(150), lat: 50.04, lon: 8.62, altFt: 700, onGround: false, gsKt: 140, vrFpm: -700 },
  { t: s(200), lat: 50.04, lon: 8.58, onGround: true, gsKt: 60 },
];

describe("touchdown detection", () => {
  it("detects a landing from a ground position after an approach", () => {
    const td = detectTouchdown(approach, s(300))!;
    expect(td.airport).toBe("EDDF");
    expect(td.method).toBe("ground");
    // 700 ft at 364 ft elevation -> 336 ft AGL at 700 fpm -> ~29 s after s(150)
    expect(td.t).toBeGreaterThan(s(150));
    expect(td.t).toBeLessThanOrEqual(s(200));
    expect(Math.abs(td.t - s(179))).toBeLessThan(2000);
  });

  it("ignores ground positions before the aircraft was airborne", () => {
    const taxiOut: Observation[] = [{ t: s(0), lat: 50.04, lon: 8.57, onGround: true, gsKt: 15 }];
    expect(detectTouchdown(taxiOut, s(100))).toBeNull();
  });

  it("infers a landing when the signal is lost on short final", () => {
    const lost = approach.slice(0, 4);
    expect(detectTouchdown(lost, s(300))).toBeNull(); // not silent long enough
    const td = detectTouchdown(lost, s(150 + 11 * 60))!;
    expect(td.method).toBe("signal-lost");
    expect(td.airport).toBe("EDDF");
  });

  it("does not call a go-around a landing", () => {
    const goAround = [...approach.slice(0, 4), { t: s(200), lat: 50.04, lon: 8.55, altFt: 1500, onGround: false, gsKt: 160, vrFpm: 2000 }];
    expect(detectTouchdown(goAround, s(200 + 11 * 60))).toBeNull();
  });
});

describe("judge", () => {
  const threshold = s(400);
  const q: Question = { kind: "landing_before", flight, threshold };
  const td = (airport: string, t: number) => ({ touchdown: { airport, t, method: "ground" as const, uncertaintyMs: 0 } });

  it("YES when landing before the line", () => {
    expect(judge(q, { [flight.icao24]: td("EDDF", s(100)) }, s(500), s(99999))).toMatchObject({ status: "final", winner: 0 });
  });

  it("NO when landing at or after the line", () => {
    expect(judge(q, { [flight.icao24]: td("EDDF", threshold) }, s(500), s(99999))).toMatchObject({ status: "final", winner: 1 });
  });

  it("voids on diversion", () => {
    expect(judge(q, { [flight.icao24]: td("EDDK", s(100)) }, s(500), s(99999))).toMatchObject({ status: "final", winner: null });
  });

  it("stays pending while airborne and voids at the deadline", () => {
    expect(judge(q, {}, s(500), s(99999))).toMatchObject({ status: "pending" });
    expect(judge(q, {}, s(99999), s(99999))).toMatchObject({ status: "final", winner: null });
  });

  it("delay: YES when 15 min late or more", () => {
    const dq: Question = { kind: "delay", flight, scheduledArrival: s(0), minutes: 15 };
    expect(judge(dq, { [flight.icao24]: td("EDDF", s(15 * 60)) }, s(2000), s(99999))).toMatchObject({ winner: 0 });
    expect(judge(dq, { [flight.icao24]: td("EDDF", s(15 * 60 - 1)) }, s(2000), s(99999))).toMatchObject({ winner: 1 });
  });

  it("cancellation markets settle on provider status or departure", () => {
    const pre = { ...flight, icao24: "" };
    const cq: Question = { kind: "cancellation", flight: pre, scheduledDeparture: s(3600) };
    expect(judge(cq, { [pre.callsign]: { cancelled: true } }, s(10), s(99999))).toMatchObject({ winner: 0 });
    expect(judge(cq, { [pre.callsign]: { departed: true } }, s(10), s(99999))).toMatchObject({ winner: 1 });
    expect(judge(cq, {}, s(10), s(99999))).toMatchObject({ status: "pending" });
  });

  it("race: first touchdown wins, diversion voids, dead heat voids", () => {
    const b: FlightRef = { ...flight, callsign: "BAW902", flightNumber: "BA902", icao24: "400abc", origin: "EGLL" };
    const rq: Question = { kind: "race", flights: [flight, b] };
    expect(judge(rq, { [flight.icao24]: td("EDDF", s(200)), [b.icao24]: td("EDDF", s(100)) }, s(500), s(9999))).toMatchObject({ winner: 1 });
    expect(judge(rq, { [flight.icao24]: td("EDDF", s(200)) }, s(500), s(9999))).toMatchObject({ status: "pending" });
    expect(judge(rq, { [flight.icao24]: td("EDDF", s(200)), [b.icao24]: td("EDDK", s(100)) }, s(500), s(9999))).toMatchObject({ winner: null });
    expect(judge(rq, { [flight.icao24]: td("EDDF", s(200)), [b.icao24]: td("EDDF", s(200)) }, s(500), s(9999))).toMatchObject({ winner: null });
  });
});
