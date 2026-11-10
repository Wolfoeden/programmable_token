/** JSON shapes returned by the API. All lovelace amounts are strings. */
import {
  flightsOf,
  outcomeLabels,
  parimutuel,
  questionRules,
  questionTitle,
  type Aircraft,
  type Question,
} from "@flightradar/core";
import type { MarketView, OrderView } from "@flightradar/chain";
import type { Evidence, MarketMeta } from "./store.js";

export type MarketPhase = "creating" | "open" | "closed" | "resolved" | "void";

export interface MarketDto {
  id: string;
  kind: Question["kind"];
  question: Question;
  title: { de: string; en: string };
  labels: { de: string[]; en: string[] };
  rules: { de: string; en: string };
  pools: string[];
  total: string;
  probabilities: number[];
  odds: number[];
  pending: { orders: number; stakes: string[] };
  closeTime: number;
  resolveDeadline: number;
  claimDeadline: number;
  feeBps: number;
  maxTotal: string;
  phase: MarketPhase;
  winner: number | null;
  icao24: string[];
  seed?: { probabilities: number[]; model: string };
  resolution?: { reason: string; decidedAt: number; txHash?: string };
  simulated: boolean;
  utxo?: string;
}

function texts(q: Question) {
  return {
    title: { de: questionTitle(q, "de"), en: questionTitle(q, "en") },
    labels: { de: outcomeLabels(q, "de"), en: outcomeLabels(q, "en") },
    rules: { de: questionRules(q, "de"), en: questionRules(q, "en") },
  };
}

export function marketDto(m: MarketView, now: number, orders: OrderView[], meta?: MarketMeta, evidence?: Evidence): MarketDto {
  const d = m.datum;
  const q = d.question;
  const pendingStakes = d.pools.map(() => 0n);
  let pendingOrders = 0;
  for (const o of orders) {
    if (o.datum.marketId !== d.marketId || o.datum.order.kind !== "bet") continue;
    pendingOrders += 1;
    const i = o.datum.order.outcome;
    if (i < pendingStakes.length) pendingStakes[i] = (pendingStakes[i] ?? 0n) + o.datum.order.stake;
  }
  const phase: MarketPhase =
    d.state.kind === "resolved" ? (d.state.winner === null ? "void" : "resolved") : now >= Number(d.closeTime) ? "closed" : "open";
  const dto: MarketDto = {
    id: d.marketId,
    kind: q.kind,
    question: q,
    ...texts(q),
    pools: d.pools.map(String),
    total: String(parimutuel.total(d.pools)),
    probabilities: parimutuel.impliedProbabilities(d.pools),
    odds: parimutuel.marginalOdds(d.pools, d.feeBps),
    pending: { orders: pendingOrders, stakes: pendingStakes.map(String) },
    closeTime: Number(d.closeTime),
    resolveDeadline: Number(d.resolveDeadline),
    claimDeadline: Number(d.claimDeadline),
    feeBps: Number(d.feeBps),
    maxTotal: String(d.maxTotal),
    phase,
    winner: d.state.kind === "resolved" ? d.state.winner : null,
    icao24: flightsOf(q).map((f) => f.icao24).filter(Boolean),
    simulated: meta?.simulated ?? false,
    utxo: `${m.utxo.txHash}#${m.utxo.outputIndex}`,
  };
  if (meta) dto.seed = { probabilities: meta.probabilities, model: meta.model };
  if (evidence && evidence.verdict.status === "final") {
    dto.resolution = { reason: evidence.verdict.reason, decidedAt: evidence.decidedAt };
    if (evidence.txHash) dto.resolution.txHash = evidence.txHash;
  }
  return dto;
}

/** A market whose creation transaction is not confirmed yet. */
export function pendingMarketDto(meta: MarketMeta): MarketDto {
  const pools = meta.seedLovelace.map((x) => BigInt(x));
  const q = meta.question;
  return {
    id: meta.marketId,
    kind: q.kind,
    question: q,
    ...texts(q),
    pools: meta.seedLovelace,
    total: String(parimutuel.total(pools)),
    probabilities: parimutuel.impliedProbabilities(pools),
    odds: parimutuel.marginalOdds(pools, 300n),
    pending: { orders: 0, stakes: pools.map(() => "0") },
    closeTime: 0,
    resolveDeadline: 0,
    claimDeadline: 0,
    feeBps: 0,
    maxTotal: "0",
    phase: "creating",
    winner: null,
    icao24: flightsOf(q).map((f) => f.icao24).filter(Boolean),
    seed: { probabilities: meta.probabilities, model: meta.model },
    simulated: meta.simulated ?? false,
  };
}

export interface AircraftDto {
  hex: string;
  callsign?: string;
  registration?: string;
  type?: string;
  lat: number;
  lon: number;
  altitudeFt?: number;
  onGround: boolean;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  timestamp: number;
  markets?: number;
  /** Landing at or taking off from `airport` (a webcam airport). */
  phase?: "landing" | "takeoff";
  airport?: string;
}

export function aircraftDto(a: Aircraft, marketCount: number, movement?: { phase: "landing" | "takeoff"; airport: string }): AircraftDto {
  const { squawk: _s, category: _c, ...rest } = a;
  return { ...rest, ...(marketCount > 0 ? { markets: marketCount } : {}), ...(movement ?? {}) };
}
