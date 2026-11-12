import { describe, expect, it } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import { encodeSafeEvidence, decodeSafeEvidence } from "../src/safeEvidence.js";

describe("on-chain evidence archive encoding", () => {
  it("roundtrips multilingual evidence exactly for SHA-256 verification", () => {
    const hash = "ab".repeat(32); const json = JSON.stringify({ reason: "Geprüft — تأكيد ✈", sources: ["https://example.com/report"] });
    expect(decodeSafeEvidence(encodeSafeEvidence(hash, json))).toEqual({ hash, json });
  });
  it("rejects oversized UTF-8 records and invalid hashes", () => {
    expect(() => encodeSafeEvidence("ab".repeat(32), "ä".repeat(4097))).toThrow("8192");
    expect(() => encodeSafeEvidence("00", "{}")).toThrow();
  });
  it("ignores other inline data, malformed data and reference NFT metadata", () => {
    expect(decodeSafeEvidence("not-cbor")).toBe(null);
    expect(decodeSafeEvidence(Data.to(new Constr(0, [new Map(), 1n, new Constr(0, [])])))).toBe(null);
  });
});
