/** Arrival tracking: listed flight → off the list → landed or lost. */
import { describe, expect, it } from "vitest";
import { airportByIcao, destinationPoint, webcamAirports, type Aircraft } from "@flightradar/core";
import type { AdsbSource } from "../src/adsb.js";
import { CamTraffic } from "../src/traffic.js";

const EGLL = airportByIcao("EGLL")!;

class Fake implements AdsbSource {
  planes: Aircraft[] = [];
  async area(lat: number) {
    return Math.abs(lat - EGLL.lat) < 0.01 ? this.planes : [];
  }
  async byHex() {
    return [];
  }
  async track() {
    return [];
  }
  async byCallsign() {
    return [];
  }
}

function inbound(km: number, now: number, extra: Partial<Aircraft> = {}): Aircraft {
  const p = destinationPoint(EGLL, 90, km);
  return { hex: "abc123", callsign: "BAW1", lat: p.lat, lon: p.lon, altitudeFt: 300 * km + 500, onGround: false, groundSpeedKt: 180, trackDeg: 270, verticalRateFpm: -800, timestamp: now, ...extra };
}

/** One full round over all live-stream airports. */
async function round(t: CamTraffic) {
  for (let i = 0; i < t.slotsPerRound; i++) await t.step();
}

describe("CamTraffic arrivals", () => {
  it("follows a listed flight to its first ground report", async () => {
    const adsb = new Fake();
    const t = new CamTraffic(adsb);
    t.touch();
    adsb.planes = [inbound(30, Date.now())];
    await round(t);
    expect(t.list().map((s) => s.aircraft.hex)).toEqual(["abc123"]);
    expect(t.arrivalList()[0]?.status).toBe("approaching");

    // Off the list: on the ground at the airport.
    const landed = Date.now();
    adsb.planes = [{ ...inbound(1, landed), onGround: true, groundSpeedKt: 120, altitudeFt: undefined }];
    await round(t);
    const a = t.arrivalList()[0]!;
    expect(a.status).toBe("landed");
    expect(a.landedAt).toBe(landed);
    expect(t.track("abc123").length).toBe(2);
  });

  it("keeps a flight on final as airborne, and does not count a distant ground report", async () => {
    const adsb = new Fake();
    const t = new CamTraffic(adsb);
    t.touch();
    adsb.planes = [inbound(30, Date.now())];
    await round(t);
    adsb.planes = [inbound(20, Date.now() + 1, { trackDeg: 90, verticalRateFpm: 1500 })]; // go-around, climbing away
    await round(t);
    expect(t.arrivalList()[0]?.status).toBe("final");
    adsb.planes = [{ ...inbound(20, Date.now() + 2), onGround: true, groundSpeedKt: 20 }];
    await round(t);
    expect(t.arrivalList()[0]?.status).toBe("final");
  });
});

describe("CamTraffic shadow log", () => {
  it("emits one record with samples when a flight lands", async () => {
    const adsb = new Fake();
    const t = new CamTraffic(adsb);
    const out: unknown[] = [];
    t.onFinished = (f) => out.push(f);
    t.alwaysOn = true;
    adsb.planes = [inbound(30, Date.now())];
    await round(t);
    adsb.planes = [{ ...inbound(1, Date.now() + 1), onGround: true, groundSpeedKt: 100, altitudeFt: undefined }];
    await round(t);
    await round(t);
    expect(out).toHaveLength(1);
    const rec = out[0] as { outcome: { status: string }; samples: unknown[]; airport: string };
    expect(rec.outcome.status).toBe("landed");
    expect(rec.samples.length).toBe(1);
    expect(rec.airport).toBe("EGLL");
  });
});

describe("CamTraffic far flights", () => {
  it("discovers a flight at cruise far away and follows it by hex", async () => {
    const MAD = airportByIcao("LEMD")!;
    const p = destinationPoint(MAD, 20, 300);
    let plane: Aircraft = { hex: "f00001", callsign: "IBE3166", lat: p.lat, lon: p.lon, altitudeFt: 37000, onGround: false, groundSpeedKt: 460, trackDeg: 0, verticalRateFpm: 0, timestamp: Date.now() };
    plane = { ...plane, trackDeg: Math.round((Math.atan2(EGLL.lon - plane.lon, EGLL.lat - plane.lat) * 180) / Math.PI + 360) % 360 };
    const hexCalls: string[][] = [];
    const adsb: AdsbSource = {
      area: async () => [plane],
      byHex: async (h: string[]) => (hexCalls.push(h), [{ ...plane, timestamp: Date.now() }]),
      track: async () => [],
      byCallsign: async () => [],
    };
    const t = new CamTraffic(adsb);
    t.touch();
    await t.stepFar(); // discovery tile
    const listed = t.list().find((x) => x.aircraft.hex === "f00001");
    expect(listed?.airport).toBe("EGLL");
    expect(listed!.etaMs - Date.now()).toBeGreaterThan(60 * 60_000);
    await t.stepFar(); // refresh by hex
    expect(hexCalls).toEqual([["f00001"]]);
    expect(t.list().some((x) => x.aircraft.hex === "f00001")).toBe(true);
  });
});
