import { beforeAll, describe, expect, it } from "vitest";
import { safeCapacity, safeClaim, safePayout, type SafeDatum } from "@flightradar/core/safePassage";
import { buildSafeCreate, buildSafeBet, buildSafeFreeze, buildSafeVerify, buildSafeClaim, buildSafeClose,
  fetchSafeMarkets, loadSafeContracts, type SafeContracts, type SafeMarket } from "../src/safePassage.js";
import { makeWorld, submit, type World } from "./helpers.js";
import { MintRedeemer } from "../src/codec.js";
import { positionName } from "../src/tokens.js";
import { Constr, Data } from "@lucid-evolution/lucid";
import { encodeSafeDatum } from "../src/safePassage.js";

const ADA = 1_000_000n;
let w: World, c: SafeContracts, id: string;
const proof = "ab".repeat(32);
async function market(): Promise<SafeMarket> {
  const m = (await fetchSafeMarkets(w.operator.lucid, c)).find(m => m.datum.marketId === id);
  if (!m) throw new Error("not found"); return m;
}

describe("Safe Passage fixed-odds chain lifecycle", () => {
  beforeAll(async () => { w = await makeWorld(); c = loadSafeContracts("Custom", w.contracts.operatorKeyHash); });
  it("prefunds a separate market without changing legacy contracts", async () => {
    const created = await buildSafeCreate(w.operator.lucid, c, "abcdef", "IRN", 1000n * ADA, w.emulator.now());
    id = created.datum.marketId; await submit(created.tx, w.emulator);
    const m = await market(); expect(m.utxo.assets.lovelace).toBe(1003n * ADA);
    expect(m.datum.yes + m.datum.no).toBe(0n);
    expect(c.policy).not.toBe(w.contracts.marketHash);
  });
  it("accepts fully covered YES and NO bets at fixed rates", async () => {
    await submit(await buildSafeBet(w.alice.lucid, c, await market(), 0, 10n * ADA, w.emulator.now()), w.emulator);
    await submit(await buildSafeBet(w.bob.lucid, c, await market(), 1, ADA, w.emulator.now()), w.emulator);
    const m = await market(); expect(m.datum.yes).toBe(10n * ADA); expect(m.datum.no).toBe(ADA);
    expect(safePayout(0, 10n * ADA)).toBe(10_001_000n); expect(safePayout(1, ADA)).toBe(1000n * ADA);
  });
  it("rejects an uncovered bet in the builder and the validator", async () => {
    const m = await market();
    await expect(buildSafeBet(w.bob.lucid, c, m, 1, ADA, w.emulator.now())).rejects.toThrow("Covered");
    const receipt = c.policy + positionName(id, 1);
    await expect(w.bob.lucid.newTx().collectFrom([m.utxo], Data.to(new Constr(0, []))).attach.SpendingValidator(c.script)
      .mintAssets({ [receipt]: ADA }, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.script)
      .pay.ToContract(c.address, { kind: "inline", value: encodeSafeDatum({ ...m.datum, no: m.datum.no + ADA }) }, { ...m.utxo.assets, lovelace: m.utxo.assets.lovelace! + ADA })
      .complete()).rejects.toThrow();
  });
  it("does not allow verification or payout before the freeze/review step", async () => {
    await expect(buildSafeVerify(w.operator.lucid, c, await market(), 1, proof, w.emulator.now())).rejects.toThrow("Freeze");
    await expect(buildSafeClaim(w.alice.lucid, c, await market(), w.emulator.now())).rejects.toThrow("verified");
  });
  it("rejects an unauthorized freeze", async () => {
    const tx = await buildSafeFreeze(w.alice.lucid, c, await market(), proof, w.emulator.now());
    await expect(submit(tx, w.emulator)).rejects.toThrow();
  });
  it("freezes the market and blocks bets and payouts at the contract", async () => {
    await submit(await buildSafeFreeze(w.operator.lucid, c, await market(), proof, w.emulator.now()), w.emulator);
    const m = await market(); expect(m.datum.state.kind).toBe("frozen");
    await expect(buildSafeBet(w.alice.lucid, c, m, 0, ADA, w.emulator.now())).rejects.toThrow();
    await expect(buildSafeClaim(w.bob.lucid, c, m, w.emulator.now())).rejects.toThrow();
    // Bypass the off-chain checks to test the actual frozen-state validator.
    const receipt = c.policy + positionName(id, 0);
    await expect(w.alice.lucid.newTx().collectFrom([m.utxo], Data.to(new Constr(0, []))).attach.SpendingValidator(c.script)
      .mintAssets({ [receipt]: ADA }, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.script)
      .pay.ToContract(c.address, { kind: "inline", value: encodeSafeDatum({ ...m.datum, yes: m.datum.yes + ADA }) }, { ...m.utxo.assets, lovelace: m.utxo.assets.lovelace! + ADA }).complete()).rejects.toThrow();
  });
  it("resolves NO only with operator signature and records evidence hash", async () => {
    const unauthorized = await buildSafeVerify(w.alice.lucid, c, await market(), 1, proof, w.emulator.now());
    await expect(submit(unauthorized, w.emulator)).rejects.toThrow();
    await submit(await buildSafeVerify(w.operator.lucid, c, await market(), 1, proof, w.emulator.now()), w.emulator);
    const m = await market(); expect(m.datum.state).toMatchObject({ kind: "resolved", winner: 1, evidence: proof });
    expect(safeClaim(m.datum, 0n, ADA)).toBe(1000n * ADA);
  });
  it("pays the fixed NO entitlement, rejects duplicate claims and protects the reserve", async () => {
    const m = await market();
    const receipt = c.policy + positionName(id, 1);
    await expect(w.bob.lucid.newTx().collectFrom([m.utxo], Data.to(new Constr(3, []))).attach.SpendingValidator(c.script)
      .mintAssets({ [receipt]: -ADA }, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.script)
      .pay.ToContract(c.address, { kind: "inline", value: encodeSafeDatum({ ...m.datum, claimedNo: ADA }) }, { ...m.utxo.assets, lovelace: m.utxo.assets.lovelace! - 1000n * ADA - 1n }).complete()).rejects.toThrow();
    await submit(await buildSafeClaim(w.bob.lucid, c, await market(), w.emulator.now()), w.emulator);
    expect((await market()).utxo.assets.lovelace).toBe(14n * ADA);
    await expect(buildSafeClaim(w.bob.lucid, c, await market(), w.emulator.now())).rejects.toThrow("No receipts");
    await expect(buildSafeClose(w.operator.lucid, c, await market(), w.emulator.now())).rejects.toThrow("Claim window");
    await submit(await buildSafeClaim(w.alice.lucid, c, await market(), w.emulator.now()), w.emulator);
    expect((await market()).datum.claimedYes).toBe(10n * ADA);
  });
});

describe("fixed-rate coverage arithmetic", () => {
  it.each([0, 1] as const)("admits exactly the available capacity for outcome %s", outcome => {
    for (const reserve of [1n, 999n, 1_000_000n, 1_000_000_000n]) {
      const d = { reserve, yes: 0n, no: 0n };
      const cap = safeCapacity(d, outcome);
      const stake = outcome === 0 ? "yes" : "no";
      const covered = (n: bigint) => safePayout(outcome, n) <= reserve + n;
      expect(covered(cap)).toBe(true); expect(covered(cap + 1n)).toBe(false);
    }
  });
});


describe("Safe Passage YES and refund settlement", () => {
  it.each([0, null] as const)("redeems both sides correctly for winner %s", async winner => {
    const world = await makeWorld(); const contracts = loadSafeContracts("Custom", world.contracts.operatorKeyHash);
    const created = await buildSafeCreate(world.operator.lucid, contracts, "abcdef", "IRQ", 1000n * ADA, world.emulator.now());
    await submit(created.tx, world.emulator);
    const current = async () => (await fetchSafeMarkets(world.operator.lucid, contracts))[0]!;
    await submit(await buildSafeBet(world.alice.lucid, contracts, await current(), 0, 10n * ADA, world.emulator.now()), world.emulator);
    await submit(await buildSafeBet(world.bob.lucid, contracts, await current(), 1, ADA, world.emulator.now()), world.emulator);
    await submit(await buildSafeFreeze(world.operator.lucid, contracts, await current(), proof, world.emulator.now()), world.emulator);
    await submit(await buildSafeVerify(world.operator.lucid, contracts, await current(), winner, proof, world.emulator.now()), world.emulator);
    const m = await current(); expect(safeClaim(m.datum, 10n * ADA, ADA)).toBe(winner === 0 ? 10_001_000n : 11n * ADA);
    await submit(await buildSafeClaim(world.alice.lucid, contracts, await current(), world.emulator.now()), world.emulator);
    await submit(await buildSafeClaim(world.bob.lucid, contracts, await current(), world.emulator.now()), world.emulator);
    expect((await current()).utxo.assets.lovelace).toBe(winner === 0 ? 1_003_999_000n : 1003n * ADA);
  });
});
