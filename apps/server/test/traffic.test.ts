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
  for (let i = 0; i < webcamAirports().length; i++) await t.step();
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
