import { beforeAll, describe, expect, it } from "vitest";
import { parimutuel } from "@flightradar/core";
import {
  buildBatch,
  buildBet,
  buildBetOrder,
  buildCancelOrder,
  buildClaim,
  buildClaimOrder,
  buildClose,
  buildCreateMarket,
  buildForceVoid,
  buildRefunds,
  buildResolve,
  claimValue,
  fetchMarkets,
  fetchOrders,
  fetchReferenceNfts,
  lovelaceOf,
  MARKET_BUFFER,
  marketNftName,
  positionName,
  positionsIn,
  unit,
  type MarketView,
} from "../src/index.js";
import { landingQuestion, makeWorld, metadata, submit, type World } from "./helpers.js";

const ADA = 1_000_000n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let w: World;
let marketId: string;
let closeTime: number;

async function market(): Promise<MarketView> {
  const all = await fetchMarkets(w.operator.lucid, w.contracts);
  const m = all.find((x) => x.datum.marketId === marketId);
  if (!m) throw new Error("market not found");
  return m;
}

async function balanceOf(actor: World["alice"], u: string): Promise<bigint> {
  const utxos = await actor.lucid.wallet().getUtxos();
  return utxos.reduce((acc, x) => acc + (x.assets[u] ?? 0n), 0n);
}

describe("market lifecycle on the emulator", () => {
  beforeAll(async () => {
    w = await makeWorld();
  });

  it("operator creates a seeded market with CIP-68 metadata", async () => {
    const now = w.emulator.now();
    closeTime = now + 2 * HOUR;
    const { tx, marketId: id } = await buildCreateMarket(w.operator.lucid, w.contracts, {
      question: landingQuestion(now + 3 * HOUR),
      pools: [7n * ADA, 3n * ADA],
      closeTime,
      resolveDeadline: closeTime + 2 * DAY,
      claimDeadline: closeTime + 2 * DAY + 31 * DAY,
      feeBps: 300n,
      maxTotal: 1_000_000n * ADA,
      metadata: metadata(2),
      now,
    });
    marketId = id;
    await submit(tx, w.emulator);
    const m = await market();
    expect(m.datum.pools).toEqual([7n * ADA, 3n * ADA]);
    expect(m.datum.state).toEqual({ kind: "open" });
    expect(m.datum.question).toEqual(landingQuestion(now + 3 * HOUR));
    expect(lovelaceOf(m.utxo)).toBe(10n * ADA + MARKET_BUFFER);
    // the operator holds the seed positions
    expect(await balanceOf(w.operator, unit(w.contracts.marketHash, positionName(marketId, 0)))).toBe(7n * ADA);
    expect(await fetchReferenceNfts(w.operator.lucid, w.contracts, marketId)).toHaveLength(2);
  });

  it("bob bets 5 ADA on NO directly", async () => {
    await submit(await buildBet(w.bob.lucid, w.contracts, await market(), 1, 5n * ADA, w.emulator.now()), w.emulator);
    expect((await market()).datum.pools).toEqual([7n * ADA, 8n * ADA]);
    expect(await balanceOf(w.bob, unit(w.contracts.marketHash, positionName(marketId, 1)))).toBe(5n * ADA);
  });

  it("orders from alice and bob are batched in one transaction", async () => {
    const m = await market();
    await submit(await buildBetOrder(w.alice.lucid, w.contracts, m, 0, 2n * ADA, w.emulator.now()), w.emulator);
    await submit(await buildBetOrder(w.bob.lucid, w.contracts, m, 1, 1n * ADA, w.emulator.now()), w.emulator);
    const orders = await fetchOrders(w.batcher.lucid, w.contracts);
    expect(orders).toHaveLength(2);
    const batcherBefore = await w.batcher.lucid.wallet().getUtxos();
    await submit(await buildBatch(w.batcher.lucid, w.contracts, await market(), orders, w.emulator.now()), w.emulator);
    expect((await market()).datum.pools).toEqual([9n * ADA, 9n * ADA]);
    expect(await balanceOf(w.alice, unit(w.contracts.marketHash, positionName(marketId, 0)))).toBe(2n * ADA);
    expect(await balanceOf(w.bob, unit(w.contracts.marketHash, positionName(marketId, 1)))).toBe(6n * ADA);
    expect(await fetchOrders(w.batcher.lucid, w.contracts)).toHaveLength(0);
    const sum = (us: typeof batcherBefore) => us.reduce((a, u) => a + lovelaceOf(u), 0n);
    // Fees of 2 x 0.4 ADA roughly cover the network fee.
    expect(sum(await w.batcher.lucid.wallet().getUtxos()) - sum(batcherBefore)).toBeGreaterThan(-1n * ADA);
  });

  it("a cancelled order returns everything to its owner", async () => {
    const before = await w.alice.lucid.wallet().getUtxos();
    await submit(await buildBetOrder(w.alice.lucid, w.contracts, await market(), 0, 3n * ADA, w.emulator.now()), w.emulator);
    const [order] = await fetchOrders(w.alice.lucid, w.contracts);
    await submit(await buildCancelOrder(w.alice.lucid, w.contracts, order!), w.emulator);
    const after = await w.alice.lucid.wallet().getUtxos();
    const sum = (us: typeof before) => us.reduce((a, u) => a + lovelaceOf(u), 0n);
    expect(sum(before) - sum(after)).toBeLessThan(1n * ADA); // only network fees
  });

  it("mallory cannot cancel someone else's order", async () => {
    await submit(await buildBetOrder(w.alice.lucid, w.contracts, await market(), 0, 1n * ADA, w.emulator.now()), w.emulator);
    const [order] = await fetchOrders(w.mallory.lucid, w.contracts);
    await expect(buildCancelOrder(w.mallory.lucid, w.contracts, order!).then((tx) => submit(tx, w.emulator))).rejects.toThrow();
    // Alice takes it back for the next tests.
    await submit(await buildCancelOrder(w.alice.lucid, w.contracts, order!), w.emulator);
  });

  it("mallory cannot mint positions without paying", async () => {
    const m = await market();
    const { encodeMarketDatum, MintRedeemer, SpendRedeemer } = await import("../src/index.js");
    const attempt = w.mallory.lucid
      .newTx()
      .collectFrom([m.utxo], SpendRedeemer.bet())
      .attach.SpendingValidator(w.contracts.market)
      .mintAssets({ [unit(w.contracts.marketHash, positionName(marketId, 0))]: 100n * ADA }, MintRedeemer.mintOrBurn())
      .pay.ToContract(
        m.utxo.address,
        { kind: "inline", value: encodeMarketDatum({ ...m.datum, pools: [m.datum.pools[0]! + 100n * ADA, m.datum.pools[1]!] }) },
        { lovelace: lovelaceOf(m.utxo) + 1n * ADA, [unit(w.contracts.marketHash, marketNftName(marketId))]: 1n },
      )
      .validTo(w.emulator.now() + 60_000)
      .complete();
    await expect(attempt).rejects.toThrow();
  });

  it("mallory cannot resolve the market", async () => {
    const m = await market();
    const { encodeMarketDatum, SpendRedeemer } = await import("../src/index.js");
    const attempt = w.mallory.lucid
      .newTx()
      .collectFrom([m.utxo], SpendRedeemer.resolve(1))
      .attach.SpendingValidator(w.contracts.market)
      .pay.ToContract(
        m.utxo.address,
        { kind: "inline", value: encodeMarketDatum({ ...m.datum, state: { kind: "resolved", winner: 1 } }) },
        { lovelace: lovelaceOf(m.utxo), [unit(w.contracts.marketHash, marketNftName(marketId))]: 1n },
      )
      .complete();
    await expect(attempt).rejects.toThrow();
  });

  it("an order left after close is refunded by the batcher", async () => {
    await submit(await buildBetOrder(w.bob.lucid, w.contracts, await market(), 1, 4n * ADA, w.emulator.now()), w.emulator);
    // time passes beyond close
    w.emulator.awaitSlot(Math.ceil((closeTime - w.emulator.now()) / 1000) + 30);
    await expect(buildBet(w.alice.lucid, w.contracts, await market(), 0, 1n * ADA, w.emulator.now())).rejects.toThrow("market_closed");
    const orders = await fetchOrders(w.batcher.lucid, w.contracts);
    expect(orders).toHaveLength(1);
    const bobBefore = (await w.bob.lucid.wallet().getUtxos()).reduce((a, u) => a + lovelaceOf(u), 0n);
    await submit(await buildRefunds(w.batcher.lucid, w.contracts, orders, w.emulator.now()), w.emulator);
    const bobAfter = (await w.bob.lucid.wallet().getUtxos()).reduce((a, u) => a + lovelaceOf(u), 0n);
    expect(bobAfter - bobBefore).toBe(4n * ADA + 2n * ADA); // stake + deposit, minus nothing but the batcher fee
  });

  it("the oracle resolves YES and takes the fee from the NO pool", async () => {
    const before = await market();
    await submit(await buildResolve(w.operator.lucid, w.contracts, before, 0), w.emulator);
    const m = await market();
    expect(m.datum.state).toEqual({ kind: "resolved", winner: 0 });
    const fee = parimutuel.fee([9n * ADA, 9n * ADA], 0, 300n);
    expect(fee).toBe(270_000n);
    expect(lovelaceOf(m.utxo)).toBe(lovelaceOf(before.utxo) - fee);
  });

  it("alice claims through a claim order, the operator claims directly", async () => {
    const m = await market();
    const aliceToken = unit(w.contracts.marketHash, positionName(marketId, 0));
    const alicePositions = { [aliceToken]: 2n * ADA };
    await submit(await buildClaimOrder(w.alice.lucid, w.contracts, m, alicePositions), w.emulator);
    const aliceBefore = (await w.alice.lucid.wallet().getUtxos()).reduce((a, u) => a + lovelaceOf(u), 0n);
    const orders = await fetchOrders(w.batcher.lucid, w.contracts);
    await submit(await buildBatch(w.batcher.lucid, w.contracts, await market(), orders, w.emulator.now()), w.emulator);
    const aliceAfter = (await w.alice.lucid.wallet().getUtxos()).reduce((a, u) => a + lovelaceOf(u), 0n);
    const due = parimutuel.winnerPayout([9n * ADA, 9n * ADA], 0, 300n, 2n * ADA);
    expect(due).toBe(3_940_000n); // 2 ADA stake + 2/9 of (9 ADA * 0.97)
    expect(aliceAfter - aliceBefore).toBe(due + 2n * ADA); // payout + returned deposit
    expect(await balanceOf(w.alice, aliceToken)).toBe(0n);

    const opPositions = positionsIn(w.contracts, Object.assign({}, ...(await w.operator.lucid.wallet().getUtxos()).map((u) => u.assets)), marketId);
    expect(opPositions.get(0)).toBe(7n * ADA);
    const m2 = await market();
    const expected = claimValue(m2.datum, opPositions);
    await submit(await buildClaim(w.operator.lucid, w.contracts, m2, opPositions), w.emulator);
    const m3 = await market();
    expect(lovelaceOf(m3.utxo)).toBe(lovelaceOf(m2.utxo) - expected);
    // Everything owed to YES holders is paid; only the buffer and rounding dust remain.
    expect(lovelaceOf(m3.utxo) - MARKET_BUFFER).toBeLessThan(10n);
  });

  it("losing tokens pay nothing", async () => {
    const m = await market();
    const bobPositions = positionsIn(w.contracts, Object.assign({}, ...(await w.bob.lucid.wallet().getUtxos()).map((u) => u.assets)), marketId);
    expect(claimValue(m.datum, bobPositions)).toBe(0n);
  });

  it("the operator closes the market after the claim deadline", async () => {
    const m = await market();
    await expect(buildClose(w.operator.lucid, w.contracts, m, [], w.emulator.now()).then((tx) => submit(tx, w.emulator))).rejects.toThrow();
    w.emulator.awaitSlot(Math.ceil((Number(m.datum.claimDeadline) - w.emulator.now()) / 1000) + 30);
    const refs = await fetchReferenceNfts(w.operator.lucid, w.contracts, marketId);
    await submit(await buildClose(w.operator.lucid, w.contracts, m, refs, w.emulator.now()), w.emulator);
    expect(await fetchMarkets(w.operator.lucid, w.contracts)).toHaveLength(0);
    expect(await fetchReferenceNfts(w.operator.lucid, w.contracts, marketId)).toHaveLength(0);
  });
});

describe("force void when the oracle disappears", () => {
  it("anyone voids after the resolve deadline and stakes are refunded 1:1", async () => {
    const world = await makeWorld();
    const now = world.emulator.now();
    const close = now + HOUR;
    const { tx, marketId: id } = await buildCreateMarket(world.operator.lucid, world.contracts, {
      question: landingQuestion(now + 2 * HOUR),
      pools: [2n * ADA, 2n * ADA],
      closeTime: close,
      resolveDeadline: close + 2 * HOUR,
      claimDeadline: close + 2 * HOUR + 31 * DAY,
      feeBps: 300n,
      maxTotal: 1_000n * ADA,
      metadata: metadata(2),
      now,
    });
    await submit(tx, world.emulator);
    const get = async () => (await fetchMarkets(world.alice.lucid, world.contracts)).find((m) => m.datum.marketId === id)!;
    await submit(await buildBet(world.alice.lucid, world.contracts, await get(), 1, 10n * ADA, world.emulator.now()), world.emulator);
    await expect(buildForceVoid(world.mallory.lucid, world.contracts, await get(), world.emulator.now()).then((t) => submit(t, world.emulator))).rejects.toThrow();
    world.emulator.awaitSlot(Math.ceil((close + 2 * HOUR - world.emulator.now()) / 1000) + 30);
    await submit(await buildForceVoid(world.mallory.lucid, world.contracts, await get(), world.emulator.now()), world.emulator);
    const voided = await get();
    expect(voided.datum.state).toEqual({ kind: "resolved", winner: null });
    const positions = positionsIn(world.contracts, Object.assign({}, ...(await world.alice.lucid.wallet().getUtxos()).map((u) => u.assets)), id);
    expect(claimValue(voided.datum, positions)).toBe(10n * ADA);
    await submit(await buildClaim(world.alice.lucid, world.contracts, voided, positions), world.emulator);
    expect(lovelaceOf((await get()).utxo)).toBe(4n * ADA + MARKET_BUFFER);
  });
});
