/** Operator funds are split into several UTxOs even when funded after start. */
import { describe, expect, it } from "vitest";
import { Emulator, generateEmulatorAccount, Lucid, paymentCredentialOf } from "@lucid-evolution/lucid";
import { keepOperatorSplit, SerialWallet } from "../src/chain.js";

describe("keepOperatorSplit", () => {
  it("splits a single funded UTxO into twelve", async () => {
    const acc = generateEmulatorAccount({ lovelace: 1000_000_000n });
    const emulator = new Emulator([acc]);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(acc.seedPhrase);
    const w = new SerialWallet(lucid, acc.address, paymentCredentialOf(acc.address).hash);
    expect((await lucid.wallet().getUtxos()).length).toBe(1);
    await keepOperatorSplit(w);
    emulator.awaitBlock(1);
    const after = await lucid.wallet().getUtxos();
    expect(after.length).toBeGreaterThanOrEqual(12);
    // Nothing more to do once split.
    await keepOperatorSplit(w);
    emulator.awaitBlock(1);
    expect((await lucid.wallet().getUtxos()).length).toBe(after.length);
  });
});
