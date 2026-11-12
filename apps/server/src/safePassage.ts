import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSafeCreate, buildSafeFreeze, buildSafeVerify, fetchSafeMarkets, loadSafeContracts, encodeSafeEvidence, fetchSafeEvidence, type SafeContracts, type SafeMarket, safeOrderContracts, fetchOrders, buildSafeBatch, buildRefunds, type Contracts, type OrderView } from "@flightradar/chain";
import { SAFE_ODDS, safeCapacity, type SafeOutcome, type SafeDatum } from "@flightradar/core/safePassage";
import { deathZoneAt } from "@flightradar/core/deathzones";
import type { ChainContext } from "./chain.js";
import type { Config } from "./config.js";
import type { AdsbSource } from "./adsb.js";
import { z } from "zod";
import { HttpError, Mutex, log } from "./util.js";

export const SAFE_CRITERION = "safe-passage-v1: NO only for independently verified crash or shoot-down inside LBN/SYR/IRQ/YEM/IRN/AFG during this passage; landing, turn-back and signal loss alone are not NO; no timed-exit condition";
export interface SafeEvidence {
  marketId: string; action: "freeze" | "verify"; reason: string; sources: string[];
  reviewedAt: number; criterion: string; winner?: SafeOutcome | null;
  incidentAt?: number; incidentZone?: string;
}
const EvidenceSchema = z.object({
  marketId: z.string().regex(/^[a-f0-9]{54}$/), action: z.enum(["freeze", "verify"]),
  reason: z.string().min(1).max(4000), sources: z.array(z.url().refine(s => new URL(s).protocol === "https:")).max(10),
  reviewedAt: z.number().int().positive(), criterion: z.literal(SAFE_CRITERION),
  winner: z.union([z.literal(0), z.literal(1), z.null()]).optional(), incidentAt: z.number().int().positive().optional(), incidentZone: z.string().optional(),
});
interface Journal {
  blocked: string[];
  recoveryHeld?: string[];
  evidence: Record<string, SafeEvidence>;
  pending: Record<string, { action: "create" | "freeze" | "verify"; txHash: string; at: number; flight: string; zone?: string; reserve?: string; openedAt?: number }>;
}

/** Chain UTxOs hold money, confirmed states and evidence. The local file is
 * a disposable cache. Cache loss quarantines old open markets for review. */
export class SafePassageService {
  readonly contracts: SafeContracts;
  readonly orders: Contracts;
  private inflight = new Map<string, number>();
  private cache: SafeMarket[] = [];
  private refreshedAt = 0;
  private refreshing?: Promise<void>;
  private lock = new Mutex();
  private journal: Journal;
  private file: string;
  private needsRecoveryReview = false;
  private recoveryCutoff: number;
  private releasedAfterRecovery = new Set<string>();
  private locallyCreated = new Set<string>();
  private evidenceRetryAt = 0;
  constructor(readonly cfg: Config, private ctx: ChainContext, private adsb: AdsbSource) {
    this.contracts = loadSafeContracts(ctx.network, ctx.operator.keyHash);
    this.orders = safeOrderContracts(ctx.contracts, this.contracts);
    mkdirSync(cfg.DATA_DIR, { recursive: true });
    this.file = join(cfg.DATA_DIR, "safe-passage.json");
    this.recoveryCutoff = ctx.now();
    try {
      if (!existsSync(this.file)) throw new Error("Cache absent");
      this.journal = JSON.parse(readFileSync(this.file, "utf8")) as Journal;
      if (!Array.isArray(this.journal.blocked) || !this.journal.evidence || !this.journal.pending || (this.journal.recoveryHeld !== undefined && !Array.isArray(this.journal.recoveryHeld))) throw new Error("Cache invalid");
      this.journal.recoveryHeld ??= [];
    } catch {
      this.journal = { blocked: [], recoveryHeld: [], evidence: {}, pending: {} };
      this.needsRecoveryReview = true;
      log.info("Safe Passage cache will be rebuilt from chain; existing open markets require operator review");
    }
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.journal));
    renameSync(this.file + ".tmp", this.file);
  }
  private archive(record: SafeEvidence) {
    const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    this.journal.evidence[hash] = record; this.save(); return hash;
  }
  evidence(hash: string) {
    const record = this.journal.evidence[hash];
    return record && createHash("sha256").update(JSON.stringify(record)).digest("hex") === hash ? record : null;
  }
  private archiveOutput(hash: string) {
    const record = this.evidence(hash);
    if (!record) throw new HttpError(409, "evidence_missing");
    return { address: this.ctx.contracts.metadataAddress, datum: encodeSafeEvidence(hash, JSON.stringify(record)) };
  }
  private async recoverEvidence(lucid: Awaited<ReturnType<ChainContext["newLucid"]>>) {
    const missing = new Map<string, SafeMarket>();
    for (const m of this.cache) if (m.datum.state.kind !== "open") {
      const hash = m.datum.state.evidence;
      if (this.evidence(hash)?.marketId !== m.datum.marketId) missing.set(hash, m);
    }
    if (!missing.size || Date.now() < this.evidenceRetryAt) return;
    this.evidenceRetryAt = Date.now() + 60_000;
    try {
      for (const row of await fetchSafeEvidence(lucid, this.ctx.contracts.metadataAddress, new Set(missing.keys()))) {
        if (createHash("sha256").update(row.json).digest("hex") !== row.hash) continue;
        const result = EvidenceSchema.safeParse(JSON.parse(row.json));
        const m = missing.get(row.hash);
        if (!result.success || !m || result.data.marketId !== m.datum.marketId) continue;
        const record = JSON.parse(row.json) as SafeEvidence;
        const st = m.datum.state;
        if (st.kind === "frozen" && record.action !== "freeze") continue;
        if (st.kind === "resolved" && (record.action !== "verify" || record.winner !== st.winner)) continue;
        this.journal.evidence[row.hash] = record;
      }
    } catch (e) { log.warn("Safe Passage evidence recovery will retry", { error: String(e).slice(0, 180) }); }
  }
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.refreshedAt < 8000) return;
    this.refreshing = (async () => {
      const lucid = await this.ctx.newLucid();
      this.cache = await fetchSafeMarkets(lucid, this.contracts);
      this.refreshedAt = Date.now();
      for (const m of this.cache) {
        const id = m.datum.marketId;
        if (m.datum.state.kind === "open" && this.needsRecoveryReview && m.datum.openedAt <= this.recoveryCutoff && !this.releasedAfterRecovery.has(id) && !this.locallyCreated.has(id) && !this.journal.recoveryHeld!.includes(id)) this.journal.recoveryHeld!.push(id);
        if (m.datum.state.kind !== "open") this.journal.recoveryHeld = this.journal.recoveryHeld!.filter(x => x !== id);
      }
      await this.recoverEvidence(lucid);
      for (const m of this.cache) {
        const p = this.journal.pending[m.datum.marketId];
        if (p && (p.action === "create" || (p.action === "freeze" && m.datum.state.kind !== "open") || (p.action === "verify" && m.datum.state.kind === "resolved"))) delete this.journal.pending[m.datum.marketId];
      }
      // Every submitted transaction has a <=4 minute validity window.
      // After six minutes it cannot newly confirm; permit a controlled retry.
      // The durable suspicion block remains even when a freeze submission expires.
      for (const [id, p] of Object.entries(this.journal.pending)) {
        if (Date.now() - p.at > 360_000) delete this.journal.pending[id];
      }
      this.save();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  all() { return this.cache; }
  forFlight(hex: string) { return this.cache.filter(m => m.datum.flight === hex).sort((a, b) => b.datum.openedAt - a.datum.openedAt)[0]; }
  async require(id: string, bet = false) {
    if (!this.cfg.SAFE_PASSAGE_ENABLED) throw new HttpError(409, "safe_disabled", "Safe Passage is not enabled");
    await this.refresh(true);
    const m = this.cache.find(m => m.datum.marketId === id);
    if (!m) throw new HttpError(404, "market_not_found", "Market not confirmed yet or unknown");
    if (this.journal.pending[id]) throw new HttpError(409, "market_updating", "Waiting for chain confirmation");
    if (bet && (m.datum.state.kind !== "open" || (this.journal.blocked.includes(id) || this.journal.recoveryHeld!.includes(id)))) throw new HttpError(409, "market_frozen", "Betting is suspended");
    return m;
  }
  async eligible(hex: string) {
    const a = (await this.adsb.byHex([hex])).find(a => a.hex === hex);
    const now = Date.now();
    if (!a || a.onGround || now - a.timestamp > 30_000 || a.timestamp > now + 30_000) throw new HttpError(409, "position_unavailable", "A fresh airborne position is required");
    const zone = deathZoneAt(a.lon, a.lat);
    if (!zone) throw new HttpError(409, "outside_zone", "Aircraft is not currently inside a red zone");
    return { a, zone };
  }
  dto(m: SafeMarket) {
    const d = m.datum;
    const pending = this.journal.pending[d.marketId];
    const recoveryHold = d.state.kind === "open" && this.journal.recoveryHeld!.includes(d.marketId);
    const phase = pending ? "updating" : d.state.kind === "open" && (this.journal.blocked.includes(d.marketId) || recoveryHold) ? "frozen" : d.state.kind;
    const cap = ([0, 1] as const).map(i => phase === "open" ? safeCapacity(d, i) : 0n);
    const perBet = BigInt(this.cfg.SAFE_PASSAGE_MAX_STAKE_ADA) * 1_000_000n;
    return {
      id: d.marketId, hex: d.flight, zone: d.zone, openedAt: d.openedAt, phase, recoveryHold, chainState: d.state.kind, odds: SAFE_ODDS,
      reserve: d.reserve.toString(), stakes: [d.yes.toString(), d.no.toString()],
      limits: cap.map(v => (v < perBet ? v : perBet).toString()),
      minStake: "1000000", winner: d.state.kind === "resolved" ? d.state.winner : null,
      evidenceHash: d.state.kind === "open" ? null : d.state.evidence,
      evidence: d.state.kind === "open" ? null : this.evidence(d.state.evidence),
      claimDeadline: d.state.kind === "resolved" ? d.state.settledAt + 90 * 24 * 3600_000 : null,
      criterion: SAFE_CRITERION,
    };
  }
  resumeAfterRestart(id: string, reason: string) {
    return this.lock.run(async () => {
      const m = await this.require(id);
      if (m.datum.state.kind !== "open" || !this.journal.recoveryHeld!.includes(id)) throw new HttpError(409, "no_recovery_hold");
      if (this.journal.blocked.includes(id)) throw new HttpError(409, "suspicion_requires_freeze", "A recorded suspicion must be frozen and verified first");
      this.releasedAfterRecovery.add(id);
      this.journal.recoveryHeld = this.journal.recoveryHeld!.filter(x => x !== id);
      this.save();
      log.info("Safe Passage restart review acknowledged by operator", { marketId: id, reason });
      return { ok: true };
    });
  }
  /** Fund on first bet review (like MarketMaker), or explicit admin request; never on GET. */
  fund(hex: string, reuse = false) {
    return this.lock.run(async () => {
      if (!this.cfg.SAFE_PASSAGE_ENABLED) throw new HttpError(409, "safe_disabled");
      await this.refresh(true);
      if (reuse) {
        const existing = this.forFlight(hex);
        if (existing) return { marketId: existing.datum.marketId, txHash: existing.utxo.txHash };
        const pending = Object.entries(this.journal.pending).find(([, p]) => p.flight === hex && p.action === "create");
        if (pending) return { marketId: pending[0], txHash: pending[1].txHash };
      }
      if (this.cache.some(m => m.datum.flight === hex && m.datum.state.kind !== "resolved") || Object.values(this.journal.pending).some(p => p.flight === hex)) throw new HttpError(409, "market_exists", "This passage already has a market or pending transaction");
      const open = this.cache.filter(m => m.datum.state.kind !== "resolved").length;
      const creating = Object.values(this.journal.pending).filter(p => p.action === "create").length;
      if (open + creating >= this.cfg.SAFE_PASSAGE_MAX_OPEN) throw new HttpError(409, "cap_reached");
      const { zone } = await this.eligible(hex);
      let id = ""; let openedAt = 0;
      const txHash = await this.ctx.operator.run(async inputs => {
        const result = await buildSafeCreate(this.ctx.operator.lucid, this.contracts, hex, zone, BigInt(this.cfg.SAFE_PASSAGE_RESERVE_ADA) * 1_000_000n, this.ctx.now(), inputs);
        id = result.datum.marketId; openedAt = result.datum.openedAt; return result.tx;
      });
      this.locallyCreated.add(id);
      this.journal.recoveryHeld = this.journal.recoveryHeld!.filter(x => x !== id);
      this.journal.pending[id] = { action: "create", txHash, at: Date.now(), flight: hex, zone, reserve: String(BigInt(this.cfg.SAFE_PASSAGE_RESERVE_ADA) * 1_000_000n), openedAt }; this.save();
      return { marketId: id, txHash };
    });
  }
  pendingDatum(id: string): SafeDatum | undefined {
    const p = this.journal.pending[id];
    if (p?.action !== "create" || !p.zone || !p.reserve || !p.openedAt) return undefined;
    return { marketId: id, flight: p.flight, zone: p.zone, reserve: BigInt(p.reserve), openedAt: p.openedAt,
      yes: 0n, no: 0n, claimedYes: 0n, claimedNo: 0n, state: { kind: "open" } };
  }
  async quoteDatum(id: string) {
    await this.refresh(true);
    if (this.journal.blocked.includes(id) || this.journal.recoveryHeld!.includes(id)) throw new HttpError(409, "market_frozen", "Betting is suspended");
    const pending = this.pendingDatum(id);
    if (pending) return pending;
    return (await this.require(id, true)).datum;
  }
  async openOrders(): Promise<OrderView[]> {
    return fetchOrders(await this.ctx.newLucid(), this.orders);
  }
  /** Same owner-tagged order fills/refunds as normal bets, with fixed-payout coverage. */
  async tick() {
    if (!this.cfg.SAFE_PASSAGE_ENABLED) return;
    return this.lock.run(async () => {
      await this.refresh(true);
      const now = this.ctx.now();
      const ref = (o: { txHash: string; outputIndex: number }) => `${o.txHash}#${o.outputIndex}`;
      for (const [key, until] of this.inflight) if (until < now) this.inflight.delete(key);
      const orders = (await this.openOrders()).filter(o => !this.inflight.has(ref(o.utxo)));
      const mark = (rows: OrderView[], m?: SafeMarket) => {
        for (const o of rows) this.inflight.set(ref(o.utxo), now + 300_000);
        if (m) this.inflight.set(ref(m.utxo), now + 300_000);
      };
      for (const m of this.cache) {
        if (this.dto(m).phase !== "open" || this.inflight.has(ref(m.utxo))) continue;
        const waiting = orders.filter(o => o.datum.marketId === m.datum.marketId && Number(o.datum.deadline) > now + 5000);
        if (!waiting.length) continue;
        try { await this.eligible(m.datum.flight); } catch { continue; }
        let d = { ...m.datum }; const batch: OrderView[] = [];
        for (const o of waiting) {
          const b = o.datum.order;
          if (b.kind !== "bet" || (b.outcome !== 0 && b.outcome !== 1) || (b.side ?? 0n) !== 0n || b.stake < 1_000_000n || b.stake > BigInt(this.cfg.SAFE_PASSAGE_MAX_STAKE_ADA) * 1_000_000n || b.stake > safeCapacity(d, b.outcome)) continue;
          d = { ...d, yes: d.yes + (b.outcome === 0 ? b.stake : 0n), no: d.no + (b.outcome === 1 ? b.stake : 0n) };
          batch.push(o); if (batch.length === 10) break;
        }
        if (batch.length) {
          await this.ctx.operator.run(inputs => buildSafeBatch(this.ctx.operator.lucid, this.contracts, this.orders, m, batch, now, inputs));
          mark(batch, m);
        }
      }
      const expired = orders.filter(o => !this.inflight.has(ref(o.utxo)) && Number(o.datum.deadline) < now - 60_000).slice(0, 20);
      if (expired.length) {
        await this.ctx.operator.run(inputs => buildRefunds(this.ctx.operator.lucid, this.orders, expired, now, { walletUtxos: inputs }));
        mark(expired);
      }
    });
  }
  freeze(id: string, reason: string, sources: string[]) {
    return this.lock.run(async () => {
      // Write before submission: even a failed/timed-out freeze closes the API
      // to new bets, and a restart never silently reopens it.
      if (!this.journal.blocked.includes(id)) this.journal.blocked.push(id);
      this.save();
      const m = await this.require(id);
      if (m.datum.state.kind !== "open") throw new HttpError(409, "market_not_open");
      const evidence = this.archive({ marketId: id, action: "freeze", reason, sources, reviewedAt: Date.now(), criterion: SAFE_CRITERION });
      const txHash = await this.ctx.operator.run(inputs => buildSafeFreeze(this.ctx.operator.lucid, this.contracts, m, evidence, this.ctx.now(), inputs, this.archiveOutput(evidence)));
      this.journal.pending[id] = { action: "freeze", txHash, at: Date.now(), flight: m.datum.flight }; this.save();
      return { txHash, evidenceHash: evidence };
    });
  }
  verify(id: string, winner: SafeOutcome | null, reason: string, sources: string[], incident?: { at: number; zone: string }) {
    return this.lock.run(async () => {
      const m = await this.require(id);
      if (m.datum.state.kind !== "frozen") throw new HttpError(409, "freeze_required");
      const hosts = new Set(sources.map(s => new URL(s).hostname.toLowerCase().replace(/^www\./, "")));
      if (winner === 1 && (hosts.size < 2 || !incident || incident.at < m.datum.openedAt || incident.at > Date.now() || !["LBN", "SYR", "IRQ", "YEM", "IRN", "AFG"].includes(incident.zone))) throw new HttpError(422, "verification_incomplete", "NO requires two independently reviewed sources and an incident time/location within this passage");
      const record: SafeEvidence = { marketId: id, action: "verify", winner, reason, sources, reviewedAt: Date.now(), criterion: SAFE_CRITERION,
        ...(incident ? { incidentAt: incident.at, incidentZone: incident.zone } : {}) };
      const evidence = this.archive(record);
      const txHash = await this.ctx.operator.run(inputs => buildSafeVerify(this.ctx.operator.lucid, this.contracts, m, winner, evidence, this.ctx.now(), inputs, this.archiveOutput(evidence)));
      this.journal.pending[id] = { action: "verify", txHash, at: Date.now(), flight: m.datum.flight }; this.save();
      return { txHash, evidenceHash: evidence };
    });
  }
}
