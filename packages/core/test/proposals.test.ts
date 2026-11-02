import { describe, expect, it } from "vitest";
import {
  airportByIcao,
  BASE_RATES,
  destinationPoint,
  gateDelayExceedance,
  outcomeLabels,
  proposeCancellation,
  proposeDelayScheduled,
  proposeLandingBefore,
  proposeRace,
  questionRules,
  questionTitle,
  tokenLabel,
  touchdownDelayExceedance,
  type Aircraft,
  type FlightRef,
} from "../src/index.js";

const FRA = airportByIcao("EDDF")!;
const now = Date.UTC(2026, 10, 2, 17, 0);
const MIN = 60_000;

function plane(hex: string, km: number, bearing: number): Aircraft {
  const p = destinationPoint(FRA, bearing, km);
  return { hex, lat: p.lat, lon: p.lon, altitudeFt: 30000, onGround: false, groundSpeedKt: 440, trackDeg: (bearing + 180) % 360, timestamp: now };
}

const flight = (callsign: string, hex: string): FlightRef => ({ callsign, flightNumber: "", icao24: hex, origin: "EGLL", destination: "EDDF" });

describe("proposals", () => {
  it("puts the landing line at the ETA, rounded to 5 minutes", () => {
    const r = proposeLandingBefore(plane("aaaaaa", 600, 300), flight("BAW902", "aaaaaa"), now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.proposal.question;
    expect(q.kind).toBe("landing_before");
    if (q.kind !== "landing_before") return;
    expect(q.threshold % (5 * MIN)).toBe(0);
    expect(r.proposal.closeTime).toBeLessThan(q.threshold);
    expect(r.proposal.closeTime).toBeGreaterThan(now);
    const [yes, no] = r.proposal.probabilities;
    expect(yes! + no!).toBeCloseTo(1, 9);
    expect(yes).toBeGreaterThan(0.2);
    expect(yes).toBeLessThan(0.8);
  });

  it("produces integer times for the on-chain datum", () => {
    for (const km of [300, 777, 1234, 2500]) {
      const r = proposeLandingBefore(plane("aaaaaa", km, 300), flight("BAW902", "aaaaaa"), now + 123);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(Number.isInteger(r.proposal.closeTime)).toBe(true);
      expect(Number.isInteger(r.proposal.resolveDeadline)).toBe(true);
    }
    const race = proposeRace(
      [
        { ac: plane("aaaaaa", 777, 300), flight: flight("BAW902", "aaaaaa") },
        { ac: plane("bbbbbb", 801, 60), flight: flight("DLH9", "bbbbbb") },
      ],
      now + 77,
    );
    expect(race.ok && Number.isInteger(race.proposal.closeTime) && Number.isInteger(race.proposal.resolveDeadline)).toBe(true);
  });

  it("refuses markets too close to landing", () => {
    const r = proposeLandingBefore(plane("aaaaaa", 40, 300), flight("BAW902", "aaaaaa"), now);
    expect(r).toEqual({ ok: false, error: "too_close_to_landing" });
  });

  it("prices a two-plane race", () => {
    const r = proposeRace(
      [
        { ac: plane("aaaaaa", 500, 300), flight: flight("BAW902", "aaaaaa") },
        { ac: plane("bbbbbb", 520, 60), flight: flight("DLH9", "bbbbbb") },
      ],
      now,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.probabilities[0]).toBeGreaterThan(0.5);
    expect(r.proposal.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("prices scheduled delay and cancellation markets from base rates", () => {
    const f = flight("DLH400", "");
    const dep = now + 6 * 60 * MIN;
    const delay = proposeDelayScheduled(f, dep, dep + 8 * 60 * MIN, 15, now);
    const cancel = proposeCancellation(f, dep, now);
    expect(delay.ok && delay.proposal.probabilities[0]).toBeCloseTo(touchdownDelayExceedance(15, "EDDF"), 9);
    expect(cancel.ok && cancel.proposal.probabilities[0]).toBeCloseTo(0.02, 9); // 0.98 % lifted to the 2 % floor
  });
});

describe("base rates", () => {
  it("uses the published 2025 European punctuality", () => {
    expect(BASE_RATES.arrivalDelayOver15Europe.value).toBeCloseTo(0.239, 3);
    expect(gateDelayExceedance(15, "EDDF")).toBeCloseTo(0.239, 3);
  });

  it("thins the tail for larger delays", () => {
    expect(gateDelayExceedance(60, "EDDF")).toBeLessThan(gateDelayExceedance(30, "EDDF"));
    expect(touchdownDelayExceedance(15, "EDDF")).toBeLessThan(gateDelayExceedance(15, "EDDF"));
  });
});

describe("question texts", () => {
  const q = { kind: "landing_before" as const, flight: { ...flight("DLH400", "3c4b21"), flightNumber: "LH400" }, threshold: Date.UTC(2026, 10, 2, 18, 30) };

  it("renders German and English titles", () => {
    expect(questionTitle(q, "de")).toBe("Landet LH400 vor 18:30 UTC in EDDF?");
    expect(questionTitle(q, "en")).toBe("Will LH400 land at EDDF before 18:30 UTC?");
    expect(outcomeLabels(q, "de")).toEqual(["Ja", "Nein"]);
    expect(questionRules(q, "de")).toContain("annulliert");
  });

  it("keeps token labels short", () => {
    expect(tokenLabel(q, 0)).toBe("LH400 <18:30Z Yes");
    expect(tokenLabel(q, 1).length).toBeLessThanOrEqual(64);
  });
});
