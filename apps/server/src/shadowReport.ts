/**
 * Evaluation of the shadow log: how good is the arrival model, which
 * margin would fixed odds need, and what would the house have made or lost
 * on the bets real players placed. Pure functions; the CLI is
 * shadowReportCli.ts.
 *
 * The simulated product is the one the market maker offers: "lands before
 * T", T = estimated arrival rounded to 5 minutes when the market opens,
 * betting closes 20 minutes before the estimate. The house would quote
 * fixed odds 1 / (p × (1 + margin)) from the model probability p.
 */
import { CLOSE_LEAD_MIN, normalCdf } from "@flightradar/core";
import type { ShadowBet, ShadowFlight, ShadowSample, ShadowSubmit } from "./shadow.js";

const MIN = 60_000;
export const MARGINS = [0, 0.05, 0.1, 0.15, 0.2, 0.25];
export const LEADS = [45, 30, 20, 10, 5];
/** Information lead of the simulated better-informed player, minutes. */
export const AHEAD = [5, 10, 15];

export interface SimMarket {
  hex: string;
  airport: string;
  threshold: number;
  closeTime: number;
  /** Model probability of "yes, before T" at the close. */
  pClose: number;
  /**
   * What the model said 5, 10 and 15 minutes after the close: the view of a
   * player who, at the close, already knows that much more than our model
   * (e.g. from the approach sequence, holding stacks or ATC audio).
   */
  pAhead: Record<number, number>;
  yes: boolean;
}

function nearest(samples: ShadowSample[], t: number, maxGapMs: number): ShadowSample | undefined {
  let best: ShadowSample | undefined;
  for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best && Math.abs(best.t - t) <= maxGapMs ? best : undefined;
}

/** Last sample at or before t. */
function asOf(samples: ShadowSample[], t: number): ShadowSample | undefined {
  let best: ShadowSample | undefined;
  for (const s of samples) if (s.t <= t) best = s;
  return best;
}

const pBefore = (s: ShadowSample, threshold: number) => normalCdf((threshold - s.etaMs) / s.sigmaMs);

/** The "lands before T" market the site would have offered on this flight, if any. */
export function simulateMarket(f: ShadowFlight): SimMarket | null {
  if (f.outcome.status !== "landed" || f.outcome.landedAt === undefined) return null;
  const open = f.samples.find((s) => s.etaMs - s.t >= (CLOSE_LEAD_MIN + 5) * MIN);
  if (!open) return null;
  const remainingMin = (open.etaMs - open.t) / MIN;
  const threshold = Math.round(open.etaMs / (5 * MIN)) * 5 * MIN;
  const closeTime = Math.floor((open.etaMs - Math.max(CLOSE_LEAD_MIN * MIN, 0.3 * remainingMin * MIN)) / MIN) * MIN;
  const atClose = asOf(f.samples, closeTime);
  if (!atClose) return null;
  const pAhead: Record<number, number> = {};
  for (const a of AHEAD) pAhead[a] = pBefore(asOf(f.samples, closeTime + a * MIN) ?? atClose, threshold);
  return {
    hex: f.hex,
    airport: f.airport,
    threshold,
    closeTime,
    pClose: pBefore(atClose, threshold),
    pAhead,
    yes: f.outcome.landedAt < threshold,
  };
}

/** Decimal odds with the house margin. */
export const fixedOdds = (p: number, margin: number) => 1 / (Math.max(0.01, Math.min(0.99, p)) * (1 + margin));

/**
 * Return per unit staked for a player who bets at the close price whenever
 * the later view says that side has value. Positive = the house loses.
 */
export function informedReturn(markets: SimMarket[], margin: number, ahead = 5): { bets: number; perUnit: number } {
  let staked = 0;
  let back = 0;
  for (const m of markets) {
    const later = m.pAhead[ahead] ?? m.pClose;
    const oddsYes = fixedOdds(m.pClose, margin);
    const oddsNo = fixedOdds(1 - m.pClose, margin);
    if (later * oddsYes > 1) {
      staked += 1;
      if (m.yes) back += oddsYes;
    } else if ((1 - later) * oddsNo > 1) {
      staked += 1;
      if (!m.yes) back += oddsNo;
    }
  }
  return { bets: staked, perUnit: staked ? back / staked - 1 : 0 };
}

export interface Bucket {
  from: number;
  to: number;
  n: number;
  meanP: number;
  freq: number;
}

export function calibration(markets: SimMarket[], edges = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001]): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const inB = markets.filter((m) => m.pClose >= edges[i]! && m.pClose < edges[i + 1]!);
    out.push({
      from: edges[i]!,
      to: Math.min(1, edges[i + 1]!),
      n: inB.length,
      meanP: inB.length ? inB.reduce((a, m) => a + m.pClose, 0) / inB.length : NaN,
      freq: inB.length ? inB.filter((m) => m.yes).length / inB.length : NaN,
    });
  }
  return out;
}

/**
 * Smallest margin at which no bucket (with at least `minN` markets) offers
 * a side with positive expected value: max(f/p, (1-f)/(1-p)) - 1.
 */
export function neededMargin(buckets: Bucket[], minN = 20): number | null {
  const ok = buckets.filter((b) => b.n >= minN);
  if (ok.length === 0) return null;
  return Math.max(0, ...ok.map((b) => Math.max(b.freq / b.meanP, (1 - b.freq) / (1 - b.meanP)) - 1));
}

export interface LeadStats {
  lead: number;
  n: number;
  biasMin: number;
  medianAbsMin: number;
  within1: number;
  within2: number;
}

/** Arrival-time error at fixed lead times before the real touchdown. */
export function etaErrors(flights: ShadowFlight[], leads = LEADS): LeadStats[] {
  return leads.map((lead) => {
    const errs: number[] = [];
    const zs: number[] = [];
    for (const f of flights) {
      const landed = f.outcome.landedAt;
      if (f.outcome.status !== "landed" || landed === undefined) continue;
      const s = nearest(f.samples, landed - lead * MIN, 90_000);
      if (!s) continue;
      errs.push((landed - s.etaMs) / MIN);
      zs.push((landed - s.etaMs) / s.sigmaMs);
    }
    const abs = errs.map(Math.abs).sort((a, b) => a - b);
    return {
      lead,
      n: errs.length,
      biasMin: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN,
      medianAbsMin: abs.length ? abs[Math.floor(abs.length / 2)]! : NaN,
      within1: zs.length ? zs.filter((z) => Math.abs(z) <= 1).length / zs.length : NaN,
      within2: zs.length ? zs.filter((z) => Math.abs(z) <= 2).length / zs.length : NaN,
    };
  });
}

export interface BetResult {
  margin: number;
  bets: number;
  staked: number;
  /** House result in ADA if these bets had been at fixed model odds. */
  houseAda: number;
}

/** Real players' bets (submitted, on decided flights) priced at fixed model odds. */
export function playerBets(flights: ShadowFlight[], records: Array<ShadowBet | ShadowSubmit>, margins = MARGINS) {
  const submitted = new Set(records.filter((r): r is ShadowSubmit => r.kind === "submitted").map((r) => r.txHash));
  const landed = new Map(flights.filter((f) => f.outcome.status === "landed").map((f) => [f.hex, f.outcome.landedAt!]));
  const bets = records.filter((r): r is ShadowBet => r.kind === "bet" && submitted.has(r.txHash));
  const priced = bets.filter((b) => b.model && b.threshold !== undefined && b.hex && landed.has(b.hex));
  const leadMin = bets.map((b) => (b.closeTime - b.at) / MIN).sort((a, b) => a - b);
  const results: BetResult[] = margins.map((margin) => {
    let staked = 0;
    let house = 0;
    for (const b of priced) {
      const stake = Number(b.stake) / 1e6;
      const p = b.outcome === 0 ? b.model!.pYes : 1 - b.model!.pYes;
      const won = (landed.get(b.hex!)! < b.threshold!) === (b.outcome === 0);
      staked += stake;
      house += stake - (won ? stake * fixedOdds(p, margin) : 0);
    }
    return { margin, bets: priced.length, staked, houseAda: house };
  });
  return {
    built: records.filter((r) => r.kind === "bet").length,
    submitted: bets.length,
    priced: priced.length,
    wallets: new Set(bets.map((b) => b.wallet)).size,
    minutesBeforeClose: leadMin.length ? { min: leadMin[0]!, median: leadMin[Math.floor(leadMin.length / 2)]!, max: leadMin[leadMin.length - 1]! } : null,
    results,
  };
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)} %` : "–");
const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");

export function report(flights: ShadowFlight[], betRecords: Array<ShadowBet | ShadowSubmit>): string {
  const landed = flights.filter((f) => f.outcome.status === "landed");
  const lost = flights.filter((f) => f.outcome.status === "lost").length;
  const gaveUp = flights.filter((f) => f.outcome.status === "gave_up").length;
  const markets = flights.map(simulateMarket).filter((m): m is SimMarket => m !== null);
  const buckets = calibration(markets);
  const need = neededMargin(buckets);
  const brier = markets.length ? markets.reduce((a, m) => a + (m.pClose - (m.yes ? 1 : 0)) ** 2, 0) / markets.length : NaN;
  const lines: string[] = [];
  lines.push("# Shadow report", "");
  lines.push(`Flights followed: ${flights.length} · landed with ground report: ${landed.length} · signal lost: ${lost} · gave up: ${gaveUp}`);
  lines.push(`Simulated "lands before T" markets: ${markets.length}`, "");
  lines.push("## Arrival-time error by lead time", "", "| Minutes before touchdown | n | Bias (min, + = later than model) | Median abs. error (min) | within ±1σ (target 68 %) | within ±2σ (target 95 %) |", "|---|---|---|---|---|---|");
  for (const l of etaErrors(flights)) lines.push(`| ${l.lead} | ${l.n} | ${num(l.biasMin)} | ${num(l.medianAbsMin)} | ${pct(l.within1)} | ${pct(l.within2)} |`);
  lines.push("", "## Calibration at the betting close", "", "| Model p (yes) | n | mean p | observed |", "|---|---|---|---|");
  for (const b of buckets) lines.push(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${pct(b.meanP)} | ${pct(b.freq)} |`);
  lines.push("", `Brier score: ${num(brier, 3)} (0.25 = coin flip, lower is better)`);
  lines.push(`Margin needed so that no bucket with n ≥ 20 offers a profitable side: ${need === null ? "not enough data" : pct(need)}`, "");
  lines.push(
    "## Better-informed player",
    "",
    "Bets at the closing price whenever the model's view N minutes after the close shows value, i.e. a player who knows N minutes more than our model. Return per 1 ₳ staked; positive = the house loses. If this stays positive at every margin, the close is too late or the stakes too high.",
    "",
    `| Margin | ${AHEAD.map((a) => `${a} min ahead: bets / return`).join(" | ")} |`,
    `|---|${AHEAD.map(() => "---").join("|")}|`,
  );
  for (const m of MARGINS) {
    const cells = AHEAD.map((a) => {
      const r = informedReturn(markets, m, a);
      return r.bets ? `${r.bets} / ${pct(r.perUnit)}` : "0 / –";
    });
    lines.push(`| ${pct(m)} | ${cells.join(" | ")} |`);
  }
  const p = playerBets(flights, betRecords);
  lines.push("", "## Real players", "", `Bets built: ${p.built} · submitted: ${p.submitted} · wallets: ${p.wallets} · priced (flight decided, model known): ${p.priced}`);
  if (p.minutesBeforeClose) lines.push(`Minutes before close at bet time: min ${num(p.minutesBeforeClose.min)}, median ${num(p.minutesBeforeClose.median)}, max ${num(p.minutesBeforeClose.max)}`);
  lines.push("", "House result if these bets had been at fixed model odds:", "", "| Margin | Bets | Staked (₳) | House (₳) | House / staked |", "|---|---|---|---|---|");
  for (const r of p.results) lines.push(`| ${pct(r.margin)} | ${r.bets} | ${num(r.staked)} | ${num(r.houseAda)} | ${r.staked ? pct(r.houseAda / r.staked) : "–"} |`);
  lines.push("", "Small samples swing widely: judge margins only from a few hundred markets per airport.");
  return lines.join("\n");
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}
