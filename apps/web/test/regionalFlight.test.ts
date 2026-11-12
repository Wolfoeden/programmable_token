import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlightSwitcher } from "../src/components/FlightSwitcher";
import { AircraftPanel } from "../src/components/AircraftPanel";
import { flightState } from "../src/arrivals";
import type { AircraftDto } from "../src/types";

const regional: AircraftDto = { hex: "abcdef", callsign: "REG123", lat: 32, lon: 54, onGround: false, timestamp: Date.now() };
const landing: AircraftDto = { hex: "fedabc", callsign: "OTHER456", lat: 51, lon: 0, airport: "EGLL", etaMs: Date.now() + 3600000, onGround: false, timestamp: Date.now() };

describe("regional aircraft selection regression", () => {
  it("targets the selected regional flight even though it is not in the arrivals list", () => {
    const html = renderToStaticMarkup(createElement(FlightSwitcher, { flights: [landing], selectedHex: regional.hex, selectedAircraft: regional, status: "ok", notice: null, onSelect: () => undefined }));
    expect(html).toContain('aria-label="Bet on REG123"');
    expect(html).not.toContain('aria-label="Bet on OTHER456"');
    expect(html).toContain("Following REG123");
    expect(html).toContain("Safe Passage");
  });
  it("never substitutes another flight if the selected aircraft has not loaded", () => {
    const html = renderToStaticMarkup(createElement(FlightSwitcher, { flights: [landing], selectedHex: regional.hex, status: "ok", notice: null, onSelect: () => undefined }));
    expect(html).toContain('aria-label="No flight"');
    expect(html).not.toContain('aria-label="Bet on OTHER456"');
  });
  it("recognises a regional aircraft in the full map list as current data", () => {
    expect(flightState(regional.hex, [landing, regional], [])).toMatchObject({ kind: "approaching", flight: { hex: regional.hex } });
  });
  it("shows the selected destination and never offers a bet on a different aircraft", () => {
    const html = renderToStaticMarkup(createElement(AircraftPanel, {
      hex: regional.hex, live: regional, detail: { aircraft: regional, route: { callsign: "REG123", flightNumber: "RG123", origin: "OMDB", destination: "EIDW" }, origin: null, destination: null, markets: [] },
      markets: [], wallet: null, operator: null, onConnect: () => undefined, scheduleAvailable: false, busy: false, dataUpdatedAt: Date.now(), onPrepare: async () => null, onConfirm: async () => false, onCreate: async () => null, onClose: () => undefined,
    }));
    expect(html).toContain("DUB"); expect(html).toContain("Dublin");
    expect(html).toContain("Position received");
    expect(html).not.toContain("No prediction for this flight");
    expect(html).not.toContain("Bet on OTHER456");
  });
});
