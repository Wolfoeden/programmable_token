import { Emulator, generateEmulatorAccount, getAddressDetails, Lucid, type EmulatorAccount, type LucidEvolution } from "@lucid-evolution/lucid";
import type { FlightRef, Question } from "@flightradar/core";
import { loadContracts, type Contracts, type FtMetadata } from "../src/index.js";

export interface Actor {
  account: EmulatorAccount;
  lucid: LucidEvolution;
  keyHash: string;
}

export interface World {
  emulator: Emulator;
  contracts: Contracts;
  operator: Actor;
  alice: Actor;
  bob: Actor;
  batcher: Actor;
  mallory: Actor;
}

const ADA = 1_000_000n;

export async function makeWorld(): Promise<World> {
  const accounts = {
    operator: generateEmulatorAccount({ lovelace: 5_000n * ADA }),
    alice: generateEmulatorAccount({ lovelace: 1_000n * ADA }),
    bob: generateEmulatorAccount({ lovelace: 1_000n * ADA }),
    batcher: generateEmulatorAccount({ lovelace: 500n * ADA }),
    mallory: generateEmulatorAccount({ lovelace: 500n * ADA }),
  };
  const emulator = new Emulator(Object.values(accounts));
  const actor = async (account: EmulatorAccount): Promise<Actor> => {
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(account.seedPhrase);
    const keyHash = getAddressDetails(account.address).paymentCredential!.hash;
    return { account, lucid, keyHash };
  };
  const operator = await actor(accounts.operator);
  return {
    emulator,
    contracts: loadContracts("Custom", operator.keyHash),
    operator,
    alice: await actor(accounts.alice),
    bob: await actor(accounts.bob),
    batcher: await actor(accounts.batcher),
    mallory: await actor(accounts.mallory),
  };
}

export const flight: FlightRef = { callsign: "DLH400", flightNumber: "LH400", icao24: "3c4b21", origin: "KJFK", destination: "EDDF" };

export function landingQuestion(threshold: number): Question {
  return { kind: "landing_before", flight, threshold };
}

export function metadata(n: number): FtMetadata[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `LH400 <18:30Z ${i === 0 ? "Yes" : "No"}`,
    description: "flightradar.fun position token",
    ticker: i === 0 ? "LH400Y" : "LH400N",
    url: "https://flightradar.fun",
    decimals: 6,
  }));
}

export async function submit(tx: { sign: { withWallet: () => { complete: () => Promise<{ submit: () => Promise<string> }> } } }, emulator: Emulator) {
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  emulator.awaitBlock(1);
  return hash;
}
