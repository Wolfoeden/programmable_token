import { describe, expect, it } from "vitest";
import { generateEmulatorAccount, getAddressDetails } from "@lucid-evolution/lucid";
import type { Question } from "@flightradar/core";
import {
  decodeMarketDatum,
  decodeOrderDatum,
  encodeMarketDatum,
  encodeOrderDatum,
  marketIdFromSeed,
  parsePositionName,
  positionName,
  referenceName,
  marketNftName,
  type MarketDatum,
} from "../src/index.js";

const flight = { callsign: "DLH400", flightNumber: "LH400", icao24: "3c4b21", origin: "KJFK", destination: "EDDF" };

describe("token names", () => {
  it("market id matches the Aiken test vector", () => {
    expect(marketIdFromSeed("0000000000000000000000000000000000000000000000000000000000000001", 2)).toBe(
      "72ce8add7e64b18bb810507fa93d9ea26d0cf07af37057c70d9365",
    );
  });

  it("encodes names with CIP-68 labels and fits 32 bytes", () => {
    const id = marketIdFromSeed("ab".repeat(32), 0);
    expect(positionName(id, 1)).toMatch(/^0014df10[0-9a-f]{54}01$/);
    expect(referenceName(id, 0)).toMatch(/^000643b0[0-9a-f]{54}00$/);
    expect(positionName(id, 1).length / 2).toBe(32);
    expect(marketNftName(id).length / 2).toBe(31);
    expect(parsePositionName(positionName(id, 1))).toEqual({ marketId: id, outcome: 1 });
    expect(parsePositionName(referenceName(id, 1))).toBeNull();
  });
});

describe("datum codecs", () => {
  const questions: Question[] = [
    { kind: "landing_before", flight, threshold: 1_793_000_000_000 },
    { kind: "delay", flight, scheduledArrival: 1_793_000_000_000, minutes: 15 },
    { kind: "cancellation", flight: { ...flight, icao24: "" }, scheduledDeparture: 1_793_000_000_000 },
    { kind: "race", flights: [flight, { ...flight, callsign: "BAW902", flightNumber: "BA902", icao24: "400abc", origin: "EGLL" }] },
  ];

  for (const question of questions) {
    it(`round-trips a ${question.kind} market`, () => {
      const datum: MarketDatum = {
        marketId: marketIdFromSeed("cd".repeat(32), 1),
        question,
        pools: [7_000_000n, 3_000_000n],
        closeTime: 1n,
        resolveDeadline: 2n,
        claimDeadline: 3n,
        feeBps: 300n,
        maxTotal: 10n ** 12n,
        state: { kind: "resolved", winner: 1 },
      };
      expect(decodeMarketDatum(encodeMarketDatum(datum))).toEqual(datum);
      expect(decodeMarketDatum(encodeMarketDatum({ ...datum, state: { kind: "resolved", winner: null } })).state).toEqual({ kind: "resolved", winner: null });
      expect(decodeMarketDatum(encodeMarketDatum({ ...datum, state: { kind: "open" } })).state).toEqual({ kind: "open" });
    });
  }

  it("round-trips orders for base and enterprise addresses", () => {
    const base = generateEmulatorAccount({ lovelace: 1n }).address;
    const keyHash = getAddressDetails(base).paymentCredential!.hash;
    for (const owner of [base]) {
      const order = { owner, ownerKey: keyHash, marketId: "11".repeat(27), order: { kind: "bet" as const, outcome: 1, stake: 5_000_000n }, batcherFee: 400_000n, deadline: 99n };
      expect(decodeOrderDatum(encodeOrderDatum(order), "Custom")).toEqual(order);
      const claim = { ...order, order: { kind: "claim" as const } };
      expect(decodeOrderDatum(encodeOrderDatum(claim), "Custom")).toEqual(claim);
    }
  });
});
