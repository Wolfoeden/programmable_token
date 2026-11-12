/**
 * Transaction builders. Each returns an unsigned transaction (TxSignBuilder)
 * built against the wallet selected on `lucid`, so the same code serves the
 * operator, the batcher and CIP-30 browser wallets (via selectWallet.fromAddress).
 */
import type { Assets, LucidEvolution, TxSignBuilder, UTxO } from "@lucid-evolution/lucid";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { outcomeCount, parimutuel, type Question } from "@flightradar/core";
import {
  encodeCip68Ft,
  encodeMarketDatum,
  encodeOrderDatum,
  MintRedeemer,
  OrderRedeemer,
  outRefTag,
  SpendRedeemer,
  type FtMetadata,
  type MarketDatum,
  type OrderDatum,
} from "./codec.js";
import { unit, type Contracts } from "./contracts.js";
import { marketIdFromSeed, marketNftName, parsePositionName, positionName, referenceName } from "./tokens.js";
import type { MarketView, OrderView } from "./indexer.js";

/** Lovelace kept in the market UTxO on top of the pools (min-ADA buffer). */
export const MARKET_BUFFER = 3_000_000n;
/** Lovelace locked with each CIP-68 reference NFT. */
export const REFERENCE_DEPOSIT = 2_000_000n;
/** Lovelace an order carries for the return payment (refunded). */
export const ORDER_DEPOSIT = 2_000_000n;
export const DEFAULT_BATCHER_FEE = 400_000n;
/** Opt-in side bet into the jackpot. */
export const SIDE_BET = 1_000_000n;
/** Width of validity windows. */
const WINDOW_MS = 5 * 60_000;

/** Options shared by all builders. */
export interface BuildOptions {
  /** Wallet UTxOs to select from instead of querying the wallet (lets a
   * server run several transactions from one wallet without collisions). */
  walletUtxos?: UTxO[];
}

const completeWith = (opts: BuildOptions) => (opts.walletUtxos ? { presetWalletInputs: opts.walletUtxos } : {});

export class MarketError extends Error {
  constructor(
    readonly code: "market_closed" | "market_not_open" | "market_not_resolved" | "bad_outcome" | "bad_stake" | "cap_reached" | "no_seed_utxo" | "nothing_to_claim" | "nothing_to_burn",
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Lovelace held by a UTxO. */
export const lovelaceOf = (u: UTxO): bigint => u.assets.lovelace ?? 0n;

export function keyHashOf(address: string): string {
  const pc = getAddressDetails(address).paymentCredential;
  if (!pc || pc.type !== "Key") throw new Error("expected a key address");
  return pc.hash;
}

// ## Create

export interface CreateMarketParams {
  question: Question;
  pools: bigint[];
  closeTime: number;
  resolveDeadline: number;
  claimDeadline: number;
  feeBps: bigint;
  maxTotal: bigint;
  /** CIP-68 metadata per outcome, or a function of the market id. */
  metadata: FtMetadata[] | ((marketId: string) => FtMetadata[]);
  now: number;
}

export async function buildCreateMarket(
  lucid: LucidEvolution,
  c: Contracts,
  p: CreateMarketParams,
  opts: BuildOptions = {},
): Promise<{ tx: TxSignBuilder; marketId: string; datum: MarketDatum }> {
  const n = outcomeCount(p.question);
  const operatorAddress = await lucid.wallet().address();
  const utxos = opts.walletUtxos ?? (await lucid.wallet().getUtxos());
  const seed = utxos.find((u) => Object.keys(u.assets).length === 1 && lovelaceOf(u) >= 5_000_000n) ?? utxos[0];
  if (!seed) throw new MarketError("no_seed_utxo");
  const marketId = marketIdFromSeed(seed.txHash, seed.outputIndex);
  const metadata = typeof p.metadata === "function" ? p.metadata(marketId) : p.metadata;
  if (p.pools.length !== n || metadata.length !== n) throw new MarketError("bad_outcome", "pools and metadata must match the outcomes");
  const nft = unit(c.marketHash, marketNftName(marketId));
  const datum: MarketDatum = {
    marketId,
    question: p.question,
    pools: p.pools,
    closeTime: BigInt(p.closeTime),
    resolveDeadline: BigInt(p.resolveDeadline),
    claimDeadline: BigInt(p.claimDeadline),
    feeBps: p.feeBps,
    maxTotal: p.maxTotal,
    state: { kind: "open" },
  };
  const mint: Assets = { [nft]: 1n };
  p.pools.forEach((pool, i) => {
    mint[unit(c.marketHash, positionName(marketId, i))] = pool;
    mint[unit(c.marketHash, referenceName(marketId, i))] = 1n;
  });
  let tx = lucid
    .newTx()
    .collectFrom([seed])
    .mintAssets(mint, MintRedeemer.create(seed.txHash, seed.outputIndex))
    .attach.MintingPolicy(c.market)
    .pay.ToContract(
      c.marketAddress,
      { kind: "inline", value: encodeMarketDatum(datum) },
      { lovelace: parimutuel.total(p.pools) + MARKET_BUFFER, [nft]: 1n },
    );
  metadata.forEach((meta, i) => {
    tx = tx.pay.ToContract(
      c.metadataAddress,
      { kind: "inline", value: encodeCip68Ft(meta) },
      { lovelace: REFERENCE_DEPOSIT, [unit(c.marketHash, referenceName(marketId, i))]: 1n },
    );
  });
  const built = await tx
    .addSigner(operatorAddress)
    .validTo(Math.min(p.now + WINDOW_MS, p.closeTime - 1000))
    .complete({ presetWalletInputs: utxos });
  return { tx: built, marketId, datum };
}

// ## Bets

function assertBettable(m: MarketView, outcome: number, stake: bigint, now: number) {
  if (m.datum.state.kind !== "open") throw new MarketError("market_not_open");
  if (now >= Number(m.datum.closeTime) - 2000) throw new MarketError("market_closed");
  if (!Number.isInteger(outcome) || outcome < 0 || outcome >= m.datum.pools.length) throw new MarketError("bad_outcome");
  if (stake <= 0n) throw new MarketError("bad_stake");
}

function continuing(c: Contracts, m: MarketView, datum: MarketDatum, lovelace: bigint) {
  return [m.utxo.address, { kind: "inline" as const, value: encodeMarketDatum(datum) }, { lovelace, [unit(c.marketHash, marketNftName(m.datum.marketId))]: 1n }] as const;
}

/** Bet directly against the market UTxO (one bettor per block per market). */
export async function buildBet(
  lucid: LucidEvolution,
  c: Contracts,
  m: MarketView,
  outcome: number,
  stake: bigint,
  now: number,
  opts: BuildOptions = {},
): Promise<TxSignBuilder> {
  assertBettable(m, outcome, stake, now);
  const pools = m.datum.pools.map((p, i) => (i === outcome ? p + stake : p));
  if (parimutuel.total(pools) > m.datum.maxTotal) throw new MarketError("cap_reached");
  return lucid
    .newTx()
    .collectFrom([m.utxo], SpendRedeemer.bet())
    .attach.SpendingValidator(c.market)
    .mintAssets({ [unit(c.marketHash, positionName(m.datum.marketId, outcome))]: stake }, MintRedeemer.mintOrBurn())
    .pay.ToContract(...continuing(c, m, { ...m.datum, pools }, lovelaceOf(m.utxo) + stake))
    .validTo(Math.min(now + WINDOW_MS, Number(m.datum.closeTime) - 1000))
    .complete(completeWith(opts));
}

/** Lock a bet order for the batcher. No contention: does not touch the market UTxO. */
export async function buildBetOrder(
  lucid: LucidEvolution,
  c: Contracts,
  m: MarketView,
  outcome: number,
  stake: bigint,
  now: number,
  batcherFee = DEFAULT_BATCHER_FEE,
  opts: BuildOptions = {},
  side = 0n,
): Promise<TxSignBuilder> {
  assertBettable(m, outcome, stake, now);
  if (side !== 0n && side < SIDE_BET) throw new MarketError("bad_stake", "A side bet is at least 1 ADA");
  const owner = await lucid.wallet().address();
  const datum: OrderDatum = {
    owner,
    ownerKey: keyHashOf(owner),
    marketId: m.datum.marketId,
    order: { kind: "bet", outcome, stake, side },
    batcherFee,
    deadline: m.datum.closeTime,
  };
  return lucid
    .newTx()
    .pay.ToContract(c.orderAddress, { kind: "inline", value: encodeOrderDatum(datum) }, { lovelace: stake + batcherFee + ORDER_DEPOSIT + side })
    .complete(completeWith(opts));
}

/** Lock position tokens in a claim order for the batcher. */
export async function buildClaimOrder(
  lucid: LucidEvolution,
  c: Contracts,
  m: MarketView,
  positions: Assets,
  batcherFee = DEFAULT_BATCHER_FEE,
  opts: BuildOptions = {},
): Promise<TxSignBuilder> {
  if (m.datum.state.kind !== "resolved") throw new MarketError("market_not_resolved");
  const owner = await lucid.wallet().address();
  const datum: OrderDatum = {
    owner,
    ownerKey: keyHashOf(owner),
    marketId: m.datum.marketId,
    order: { kind: "claim" },
    batcherFee,
    // Claim orders can always be refunded by anyone after this time.
    deadline: m.datum.claimDeadline,
  };
  return lucid
    .newTx()
    .pay.ToContract(c.orderAddress, { kind: "inline", value: encodeOrderDatum(datum) }, { ...positions, lovelace: batcherFee + ORDER_DEPOSIT })
    .complete(completeWith(opts));
}

export async function buildCancelOrder(lucid: LucidEvolution, c: Contracts, o: OrderView, opts: BuildOptions = {}): Promise<TxSignBuilder> {
  return lucid
    .newTx()
    .collectFrom([o.utxo], OrderRedeemer.cancel())
    .attach.SpendingValidator(c.order)
    .addSignerKey(o.datum.ownerKey)
    .complete(completeWith(opts));
}

// ## Batching

/** Position tokens of `marketId` inside an asset bundle, by outcome. */
export function positionsIn(c: Contracts, assets: Assets, marketId: string): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const [u, q] of Object.entries(assets)) {
    if (u === "lovelace" || !u.startsWith(c.marketHash)) continue;
    const parsed = parsePositionName(u.slice(56));
    if (parsed && parsed.marketId === marketId) out.set(parsed.outcome, (out.get(parsed.outcome) ?? 0n) + q);
  }
  return out;
}

/** What `positions` pay out in a resolved market (floor per order, like the validator). */
export function claimValue(datum: MarketDatum, positions: Map<number, bigint>): bigint {
  if (datum.state.kind !== "resolved") return 0n;
  const winner = datum.state.winner;
  if (winner === null) return [...positions.values()].reduce((a, b) => a + b, 0n);
  const burned = positions.get(winner) ?? 0n;
  return burned === 0n ? 0n : parimutuel.winnerPayout(datum.pools, winner, datum.feeBps, burned);
}

function withoutMarketTokens(c: Contracts, assets: Assets, marketId: string): Assets {
  const out: Assets = {};
  for (const [u, q] of Object.entries(assets)) {
    if (u === "lovelace") continue;
    const parsed = u.startsWith(c.marketHash) ? parsePositionName(u.slice(56)) : null;
    if (parsed && parsed.marketId === marketId) continue;
    out[u] = q;
  }
  return out;
}

/**
 * Execute bet orders (market open) or claim orders (market resolved) in one
 * transaction. The batcher keeps the batcher fees and pays the network fee.
 */
export async function buildBatch(
  lucid: LucidEvolution,
  c: Contracts,
  m: MarketView,
  orders: OrderView[],
  now: number,
  opts: BuildOptions = {},
): Promise<TxSignBuilder> {
  const id = m.datum.marketId;
  const mine = orders.filter((o) => o.datum.marketId === id);
  if (mine.length === 0) throw new Error("no orders for this market");
  let tx = lucid.newTx().attach.SpendingValidator(c.market).attach.SpendingValidator(c.order);

  if (m.datum.state.kind === "open") {
    const bets = mine.filter((o) => o.datum.order.kind === "bet");
    const pools = [...m.datum.pools];
    const mint: Assets = {};
    for (const o of bets) {
      if (o.datum.order.kind !== "bet") continue;
      const { outcome, stake } = o.datum.order;
      if (outcome >= pools.length) continue;
      pools[outcome] = (pools[outcome] ?? 0n) + stake;
      const u = unit(c.marketHash, positionName(id, outcome));
      mint[u] = (mint[u] ?? 0n) + stake;
    }
    const staked = parimutuel.total(pools) - parimutuel.total(m.datum.pools);
    if (parimutuel.total(pools) > m.datum.maxTotal) throw new MarketError("cap_reached");
    tx = tx
      .collectFrom([m.utxo], SpendRedeemer.bet())
      .collectFrom(bets.map((o) => o.utxo), OrderRedeemer.fill())
      .mintAssets(mint, MintRedeemer.mintOrBurn())
      .pay.ToContract(...continuing(c, m, { ...m.datum, pools }, lovelaceOf(m.utxo) + staked));
    let sides = 0n;
    for (const o of bets) {
      if (o.datum.order.kind !== "bet") continue;
      const { outcome, stake } = o.datum.order;
      const side = o.datum.order.side ?? 0n;
      sides += side;
      tx = tx.pay.ToAddressWithData(
        o.datum.owner,
        { kind: "inline", value: outRefTag(o.utxo.txHash, o.utxo.outputIndex) },
        {
          ...withoutMarketTokens(c, o.utxo.assets, "__none__"),
          lovelace: lovelaceOf(o.utxo) - stake - o.datum.batcherFee - side,
          [unit(c.marketHash, positionName(id, outcome))]: stake,
        },
      );
    }
    // Side bets go into the jackpot as one new output; the order validator
    // checks that the jackpot grows by their sum.
    if (sides > 0n) tx = tx.pay.ToAddress(c.jackpotAddress, { lovelace: sides });
    return tx.validTo(Math.min(now + WINDOW_MS, Number(m.datum.closeTime) - 1000)).complete(completeWith(opts));
  }

  // Resolved: claim orders.
  const claims = mine.filter((o) => o.datum.order.kind === "claim");
  const burn: Assets = {};
  let paid = 0n;
  tx = tx.collectFrom([m.utxo], SpendRedeemer.claim()).collectFrom(claims.map((o) => o.utxo), OrderRedeemer.fill());
  for (const o of claims) {
    const positions = positionsIn(c, o.utxo.assets, id);
    for (const [outcome, q] of positions) {
      const u = unit(c.marketHash, positionName(id, outcome));
      burn[u] = (burn[u] ?? 0n) - q;
    }
    const due = claimValue(m.datum, positions);
    paid += due;
    tx = tx.pay.ToAddressWithData(
      o.datum.owner,
      { kind: "inline", value: outRefTag(o.utxo.txHash, o.utxo.outputIndex) },
      { ...withoutMarketTokens(c, o.utxo.assets, id), lovelace: lovelaceOf(o.utxo) - o.datum.batcherFee + due },
    );
  }
  if (Object.keys(burn).length > 0) tx = tx.mintAssets(burn, MintRedeemer.mintOrBurn());
  return tx.pay.ToContract(...continuing(c, m, m.datum, lovelaceOf(m.utxo) - paid)).complete(completeWith(opts));
}

/** Return expired orders to their owners. Anyone may do this after the deadline. */
export async function buildRefunds(lucid: LucidEvolution, c: Contracts, orders: OrderView[], now: number, opts: BuildOptions = {}): Promise<TxSignBuilder> {
  const due = orders.filter((o) => Number(o.datum.deadline) < now - 2000);
  if (due.length === 0) throw new Error("no expired orders");
  let tx = lucid.newTx().attach.SpendingValidator(c.order).collectFrom(due.map((o) => o.utxo), OrderRedeemer.refund());
  for (const o of due) {
    tx = tx.pay.ToAddressWithData(
      o.datum.owner,
      { kind: "inline", value: outRefTag(o.utxo.txHash, o.utxo.outputIndex) },
      { ...o.utxo.assets, lovelace: lovelaceOf(o.utxo) - o.datum.batcherFee },
    );
  }
  const latestDeadline = Math.max(...due.map((o) => Number(o.datum.deadline)));
  return tx.validFrom(Math.max(latestDeadline + 1000, now - 60_000)).complete(completeWith(opts));
}

// ## Resolution and claims

export async function buildResolve(lucid: LucidEvolution, c: Contracts, m: MarketView, winner: number | null, opts: BuildOptions = {}): Promise<TxSignBuilder> {
  if (m.datum.state.kind !== "open") throw new MarketError("market_not_open");
  if (winner !== null && (winner < 0 || winner >= m.datum.pools.length)) throw new MarketError("bad_outcome");
  const fee = winner === null ? 0n : parimutuel.fee(m.datum.pools, winner, m.datum.feeBps);
  const operator = await lucid.wallet().address();
  return lucid
    .newTx()
    .collectFrom([m.utxo], SpendRedeemer.resolve(winner))
    .attach.SpendingValidator(c.market)
    .pay.ToContract(...continuing(c, m, { ...m.datum, state: { kind: "resolved", winner } }, lovelaceOf(m.utxo) - fee))
    .addSigner(operator)
    .complete(completeWith(opts));
}

export async function buildForceVoid(lucid: LucidEvolution, c: Contracts, m: MarketView, now: number, opts: BuildOptions = {}): Promise<TxSignBuilder> {
  if (m.datum.state.kind !== "open") throw new MarketError("market_not_open");
  return lucid
    .newTx()
    .collectFrom([m.utxo], SpendRedeemer.forceVoid())
    .attach.SpendingValidator(c.market)
    .pay.ToContract(...continuing(c, m, { ...m.datum, state: { kind: "resolved", winner: null } }, lovelaceOf(m.utxo)))
    .validFrom(Math.max(Number(m.datum.resolveDeadline) + 1000, now - 60_000))
    .complete(completeWith(opts));
}

/** Claim directly: burn the wallet's position tokens of this market and withdraw. */
export async function buildClaim(
  lucid: LucidEvolution,
  c: Contracts,
  m: MarketView,
  positions: Map<number, bigint>,
  opts: BuildOptions = {},
): Promise<TxSignBuilder> {
  if (m.datum.state.kind !== "resolved") throw new MarketError("market_not_resolved");
  const burn: Assets = {};
  for (const [outcome, q] of positions) burn[unit(c.marketHash, positionName(m.datum.marketId, outcome))] = -q;
  if (Object.keys(burn).length === 0) throw new MarketError("nothing_to_claim");
  const due = claimValue(m.datum, positions);
  return lucid
    .newTx()
    .collectFrom([m.utxo], SpendRedeemer.claim())
    .attach.SpendingValidator(c.market)
    .mintAssets(burn, MintRedeemer.mintOrBurn())
    .pay.ToContract(...continuing(c, m, m.datum, lovelaceOf(m.utxo) - due))
    .complete(completeWith(opts));
}

/**
 * Burn position tokens that pay nothing (the losing side of a resolved
 * market). The minting policy allows any burn, so the market is not
 * touched; the wallet gets back the ADA the tokens were holding.
 */
export async function buildBurnWorthless(lucid: LucidEvolution, c: Contracts, markets: MarketView[], holdings: Assets, opts: BuildOptions = {}): Promise<{ tx: TxSignBuilder; burned: number }> {
  const burn: Assets = {};
  for (const m of markets) {
    if (m.datum.state.kind !== "resolved" || m.datum.state.winner === null) continue;
    const winner = m.datum.state.winner;
    for (const [outcome, q] of positionsIn(c, holdings, m.datum.marketId)) {
      if (outcome === winner || q <= 0n) continue;
      burn[unit(c.marketHash, positionName(m.datum.marketId, outcome))] = -q;
    }
  }
  const burned = Object.keys(burn).length;
  if (burned === 0) throw new MarketError("nothing_to_burn");
  const tx = await lucid.newTx().mintAssets(burn, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.market).complete(completeWith(opts));
  return { tx, burned };
}

/**
 * Operator: take back the deposits of CIP-68 reference NFTs (about 2 ADA
 * each) by burning them. The metadata store only needs the operator's
 * signature; burning is always allowed by the market policy. Wallets then
 * show the market's tickets without name and ticker, so do this only for
 * decided markets. Close works without them.
 */
export async function buildReclaimReferences(lucid: LucidEvolution, c: Contracts, references: UTxO[], opts: BuildOptions = {}): Promise<TxSignBuilder> {
  if (references.length === 0) throw new MarketError("nothing_to_burn");
  const operator = await lucid.wallet().address();
  const burn: Assets = {};
  for (const r of references) for (const u of Object.keys(r.assets)) if (u.startsWith(c.marketHash)) burn[u] = (burn[u] ?? 0n) - (r.assets[u] ?? 0n);
  return lucid
    .newTx()
    .collectFrom(references, SpendRedeemer.close())
    .attach.SpendingValidator(c.metadata)
    .mintAssets(burn, MintRedeemer.mintOrBurn())
    .attach.MintingPolicy(c.market)
    .addSigner(operator)
    .complete(completeWith(opts));
}

/** Operator closes a market after the claim deadline and burns its NFTs. */
export async function buildClose(
  lucid: LucidEvolution,
  c: Contracts,
  m: MarketView,
  references: UTxO[],
  now: number,
  opts: BuildOptions = {},
): Promise<TxSignBuilder> {
  const operator = await lucid.wallet().address();
  const burn: Assets = { [unit(c.marketHash, marketNftName(m.datum.marketId))]: -1n };
  let tx = lucid.newTx().collectFrom([m.utxo], SpendRedeemer.close()).attach.SpendingValidator(c.market);
  if (references.length > 0) {
    tx = tx.collectFrom(references, SpendRedeemer.close()).attach.SpendingValidator(c.metadata);
    for (const r of references) {
      for (const u of Object.keys(r.assets)) if (u.startsWith(c.marketHash)) burn[u] = (burn[u] ?? 0n) - (r.assets[u] ?? 0n);
    }
  }
  return tx
    .mintAssets(burn, MintRedeemer.mintOrBurn())
    .addSigner(operator)
    .validFrom(Math.max(Number(m.datum.claimDeadline) + 1000, now - 60_000))
    .complete(completeWith(opts));
}
