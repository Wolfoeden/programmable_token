/**
 * Plutus data codecs for the on-chain types in onchain/lib/flightradar/types.ak.
 * Aiken encodes a record as Constr 0 [fields...] and the n-th constructor of
 * an enum as Constr n [fields...]. Option: Some = Constr 0 [x], None = Constr 1 [].
 */
import { Constr, Data, credentialToAddress, getAddressDetails, type Network } from "@lucid-evolution/lucid";
import type { FlightRef, Question } from "@flightradar/core";
import { hexToUtf8, utf8ToHex } from "./tokens.js";

type PData = Data;

export type MarketState = { kind: "open" } | { kind: "resolved"; winner: number | null };

export interface MarketDatum {
  marketId: string;
  question: Question;
  pools: bigint[];
  closeTime: bigint;
  resolveDeadline: bigint;
  claimDeadline: bigint;
  feeBps: bigint;
  maxTotal: bigint;
  state: MarketState;
}

export type OrderKind = { kind: "bet"; outcome: number; stake: bigint } | { kind: "claim" };

export interface OrderDatum {
  owner: string;
  ownerKey: string;
  marketId: string;
  order: OrderKind;
  batcherFee: bigint;
  deadline: bigint;
}

function asConstr(d: PData, what: string): Constr<PData> {
  if (!(d instanceof Constr)) throw new Error(`${what}: expected Constr`);
  return d;
}

function field<T extends PData>(c: Constr<PData>, i: number, what: string): T {
  const f = c.fields[i];
  if (f === undefined) throw new Error(`${what}: missing field ${i}`);
  return f as T;
}

function asBigInt(d: PData, what: string): bigint {
  if (typeof d !== "bigint") throw new Error(`${what}: expected integer`);
  return d;
}

function asBytes(d: PData, what: string): string {
  if (typeof d !== "string") throw new Error(`${what}: expected bytes`);
  return d;
}

// ## Option<Int>

export const optionInt = (v: number | null): Constr<PData> =>
  v === null ? new Constr(1, []) : new Constr(0, [BigInt(v)]);

function decodeOptionInt(d: PData): number | null {
  const c = asConstr(d, "Option");
  if (c.index === 1) return null;
  return Number(asBigInt(field(c, 0, "Some"), "Some"));
}

// ## Question

function encodeFlight(f: FlightRef): Constr<PData> {
  return new Constr(0, [utf8ToHex(f.callsign), utf8ToHex(f.flightNumber), f.icao24.toLowerCase(), utf8ToHex(f.origin), utf8ToHex(f.destination)]);
}

function decodeFlight(d: PData): FlightRef {
  const c = asConstr(d, "FlightRef");
  return {
    callsign: hexToUtf8(asBytes(field(c, 0, "callsign"), "callsign")),
    flightNumber: hexToUtf8(asBytes(field(c, 1, "flightNumber"), "flightNumber")),
    icao24: asBytes(field(c, 2, "icao24"), "icao24"),
    origin: hexToUtf8(asBytes(field(c, 3, "origin"), "origin")),
    destination: hexToUtf8(asBytes(field(c, 4, "destination"), "destination")),
  };
}

export function encodeQuestion(q: Question): Constr<PData> {
  switch (q.kind) {
    case "landing_before":
      return new Constr(0, [encodeFlight(q.flight), BigInt(q.threshold)]);
    case "delay":
      return new Constr(1, [encodeFlight(q.flight), BigInt(q.scheduledArrival), BigInt(q.minutes)]);
    case "cancellation":
      return new Constr(2, [encodeFlight(q.flight), BigInt(q.scheduledDeparture)]);
    case "race":
      return new Constr(3, [q.flights.map(encodeFlight)]);
  }
}

export function decodeQuestion(d: PData): Question {
  const c = asConstr(d, "Question");
  switch (c.index) {
    case 0:
      return { kind: "landing_before", flight: decodeFlight(field(c, 0, "flight")), threshold: Number(asBigInt(field(c, 1, "threshold"), "threshold")) };
    case 1:
      return {
        kind: "delay",
        flight: decodeFlight(field(c, 0, "flight")),
        scheduledArrival: Number(asBigInt(field(c, 1, "scheduledArrival"), "scheduledArrival")),
        minutes: Number(asBigInt(field(c, 2, "minutes"), "minutes")),
      };
    case 2:
      return {
        kind: "cancellation",
        flight: decodeFlight(field(c, 0, "flight")),
        scheduledDeparture: Number(asBigInt(field(c, 1, "scheduledDeparture"), "scheduledDeparture")),
      };
    case 3: {
      const flights = field(c, 0, "flights");
      if (!Array.isArray(flights)) throw new Error("race: expected list");
      return { kind: "race", flights: flights.map(decodeFlight) };
    }
    default:
      throw new Error(`unknown question constructor ${c.index}`);
  }
}

// ## Market datum

export function encodeMarketDatum(m: MarketDatum): string {
  const state = m.state.kind === "open" ? new Constr(0, []) : new Constr(1, [optionInt(m.state.winner)]);
  return Data.to(
    new Constr(0, [m.marketId, encodeQuestion(m.question), m.pools, m.closeTime, m.resolveDeadline, m.claimDeadline, m.feeBps, m.maxTotal, state]),
  );
}

export function decodeMarketDatum(cbor: string): MarketDatum {
  const c = asConstr(Data.from(cbor), "MarketDatum");
  const pools = field(c, 2, "pools");
  if (!Array.isArray(pools)) throw new Error("pools: expected list");
  const st = asConstr(field(c, 8, "state"), "state");
  return {
    marketId: asBytes(field(c, 0, "market_id"), "market_id"),
    question: decodeQuestion(field(c, 1, "question")),
    pools: pools.map((p) => asBigInt(p, "pool")),
    closeTime: asBigInt(field(c, 3, "close_time"), "close_time"),
    resolveDeadline: asBigInt(field(c, 4, "resolve_deadline"), "resolve_deadline"),
    claimDeadline: asBigInt(field(c, 5, "claim_deadline"), "claim_deadline"),
    feeBps: asBigInt(field(c, 6, "fee_bps"), "fee_bps"),
    maxTotal: asBigInt(field(c, 7, "max_total"), "max_total"),
    state: st.index === 0 ? { kind: "open" } : { kind: "resolved", winner: decodeOptionInt(field(st, 0, "winner")) },
  };
}

// ## Addresses

export function addressToData(address: string): Constr<PData> {
  const details = getAddressDetails(address);
  const pc = details.paymentCredential;
  if (!pc) throw new Error("address has no payment credential");
  const payment = new Constr(pc.type === "Key" ? 0 : 1, [pc.hash]);
  const sc = details.stakeCredential;
  const stake = sc ? new Constr(0, [new Constr(0, [new Constr(sc.type === "Key" ? 0 : 1, [sc.hash])])]) : new Constr(1, []);
  return new Constr(0, [payment, stake]);
}

export function dataToAddress(d: PData, network: Network): string {
  const c = asConstr(d, "Address");
  const pay = asConstr(field(c, 0, "payment"), "payment");
  const payment = { type: pay.index === 0 ? ("Key" as const) : ("Script" as const), hash: asBytes(field(pay, 0, "hash"), "hash") };
  const stakeOpt = asConstr(field(c, 1, "stake"), "stake");
  if (stakeOpt.index === 1) return credentialToAddress(network, payment);
  const referenced = asConstr(field(stakeOpt, 0, "referenced"), "referenced");
  if (referenced.index !== 0) throw new Error("pointer addresses are not supported");
  const cred = asConstr(field(referenced, 0, "credential"), "credential");
  const stake = { type: cred.index === 0 ? ("Key" as const) : ("Script" as const), hash: asBytes(field(cred, 0, "hash"), "hash") };
  return credentialToAddress(network, payment, stake);
}

// ## Order datum

export function encodeOrderDatum(o: OrderDatum): string {
  const kind = o.order.kind === "bet" ? new Constr(0, [BigInt(o.order.outcome), o.order.stake]) : new Constr(1, []);
  return Data.to(new Constr(0, [addressToData(o.owner), o.ownerKey, o.marketId, kind, o.batcherFee, o.deadline]));
}

export function decodeOrderDatum(cbor: string, network: Network): OrderDatum {
  const c = asConstr(Data.from(cbor), "OrderDatum");
  const kind = asConstr(field(c, 3, "kind"), "kind");
  return {
    owner: dataToAddress(field(c, 0, "owner"), network),
    ownerKey: asBytes(field(c, 1, "owner_key"), "owner_key"),
    marketId: asBytes(field(c, 2, "market_id"), "market_id"),
    order:
      kind.index === 0
        ? { kind: "bet", outcome: Number(asBigInt(field(kind, 0, "outcome"), "outcome")), stake: asBigInt(field(kind, 1, "stake"), "stake") }
        : { kind: "claim" },
    batcherFee: asBigInt(field(c, 4, "batcher_fee"), "batcher_fee"),
    deadline: asBigInt(field(c, 5, "deadline"), "deadline"),
  };
}

/** Inline datum that tags the payment for the order at this output reference. */
export function outRefTag(txHash: string, outputIndex: number): string {
  return Data.to(new Constr(0, [txHash, BigInt(outputIndex)]));
}

// ## Redeemers

export const MintRedeemer = {
  create: (txHash: string, outputIndex: number) => Data.to(new Constr(0, [new Constr(0, [txHash, BigInt(outputIndex)])])),
  mintOrBurn: () => Data.to(new Constr(1, [])),
};

export const SpendRedeemer = {
  bet: () => Data.to(new Constr(0, [])),
  resolve: (winner: number | null) => Data.to(new Constr(1, [optionInt(winner)])),
  forceVoid: () => Data.to(new Constr(2, [])),
  claim: () => Data.to(new Constr(3, [])),
  close: () => Data.to(new Constr(4, [])),
};

export const OrderRedeemer = {
  cancel: () => Data.to(new Constr(0, [])),
  fill: () => Data.to(new Constr(1, [])),
  refund: () => Data.to(new Constr(2, [])),
};

// ## CIP-68 metadata (label 333 fungible token)

export interface FtMetadata {
  name: string;
  description: string;
  ticker: string;
  url?: string;
  logo?: string;
  decimals: number;
}

/** CIP-68 reference datum: Constr 0 [metadata map, version, extra]. */
export function encodeCip68Ft(m: FtMetadata): string {
  const entries: Array<[PData, PData]> = [
    [utf8ToHex("name"), utf8ToHex(m.name)],
    [utf8ToHex("description"), utf8ToHex(m.description.slice(0, 256))],
    [utf8ToHex("ticker"), utf8ToHex(m.ticker)],
    [utf8ToHex("decimals"), BigInt(m.decimals)],
  ];
  if (m.url) entries.push([utf8ToHex("url"), utf8ToHex(m.url)]);
  if (m.logo) entries.push([utf8ToHex("logo"), utf8ToHex(m.logo)]);
  return Data.to(new Constr(0, [new Map(entries), 1n, new Constr(0, [])]));
}
