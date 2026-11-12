import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSafeCreate, buildSafeFreeze, buildSafeVerify, fetchSafeMarkets, loadSafeContracts, type SafeContracts, type SafeMarket } from "@flightradar/chain";
import { SAFE_ODDS, safeCapacity, type SafeOutcome } from "@flightradar/core/safePassage";
import { deathZoneAt } from "@flightradar/core/deathzones";
import type { ChainContext } from "./chain.js";
import type { Config } from "./config.js";
import type { AdsbSource } from "./adsb.js";
import { HttpError, Mutex } from "./util.js";

export const SAFE_CRITERION = "safe-passage-v1: NO only for independently verified crash or shoot-down inside LBN/SYR/IRQ/YEM/IRN/AFG during this passage; landing, turn-back and signal loss alone are not NO; no timed-exit condition";
export interface SafeEvidence {
  marketId: string; action: "freeze" | "verify"; reason: string; sources: string[];
  reviewedAt: number; criterion: string; winner?: SafeOutcome | null;
  incidentAt?: number; incidentZone?: string;
}
interface Journal {
  blocked: string[];
  evidence: Record<string, SafeEvidence>;
  pending: Record<string, { action: "create" | "freeze" | "verify"; txHash: string; at: number; flight: string }>;
}

/** Chain UTxOs are the accounting authority. The journal is a durable,
 * fail-closed operational gate and evidence archive, never a money balance.
 */
export class SafePassageService {
  readonly contracts: SafeContracts;
  private cache: SafeMarket[] = [];
  private refreshedAt = 0;
  private refreshing?: Promise<void>;
  private lock = new Mutex();
  private journal: Journal;
  private file: string;
  constructor(readonly cfg: Config, private ctx: ChainContext, private adsb: AdsbSource) {
    this.contracts = loadSafeContracts(ctx.network, ctx.operator.keyHash);
    mkdirSync(cfg.DATA_DIR, { recursive: true });
    this.file = join(cfg.DATA_DIR, "safe-passage.json");
    this.journal = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as Journal : { blocked: [], evidence: {}, pending: {} };
    if (!Array.isArray(this.journal.blocked) || !this.journal.evidence || !this.journal.pending) throw new Error("Invalid Safe Passage journal; refusing to reset it");
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.journal));
    renameSync(this.file + ".tmp", this.file);
  }
  private archive(record: SafeEvidence) {
    const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    this.journal.evidence[hash] = record; this.save(); return hash;
  }
  evidence(hash: string) { return this.journal.evidence[hash] ?? null; }
  async refresh(force = false) {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.refreshedAt < 8000) return;
    this.refreshing = (async () => {
      const lucid = await this.ctx.newLucid();
      this.cache = await fetchSafeMarkets(lucid, this.contracts);
      this.refreshedAt = Date.now();
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
    if (bet && (m.datum.state.kind !== "open" || this.journal.blocked.includes(id))) throw new HttpError(409, "market_frozen", "Betting is suspended");
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
    const phase = pending ? "updating" : d.state.kind === "open" && this.journal.blocked.includes(d.marketId) ? "frozen" : d.state.kind;
    const cap = ([0, 1] as const).map(i => phase === "open" ? safeCapacity(d, i) : 0n);
    const perBet = BigInt(this.cfg.SAFE_PASSAGE_MAX_STAKE_ADA) * 1_000_000n;
    return {
      id: d.marketId, hex: d.flight, zone: d.zone, openedAt: d.openedAt, phase, chainState: d.state.kind, odds: SAFE_ODDS,
      reserve: d.reserve.toString(), stakes: [d.yes.toString(), d.no.toString()],
      limits: cap.map(v => (v < perBet ? v : perBet).toString()),
      minStake: "1000000", winner: d.state.kind === "resolved" ? d.state.winner : null,
      evidenceHash: d.state.kind === "open" ? null : d.state.evidence,
      evidence: d.state.kind === "open" ? null : this.evidence(d.state.evidence),
      claimDeadline: d.state.kind === "resolved" ? d.state.settledAt + 90 * 24 * 3600_000 : null,
      criterion: SAFE_CRITERION,
    };
  }
  /** Funding is an explicit operator action, never a side effect of a view. */
  fund(hex: string) {
    return this.lock.run(async () => {
      if (!this.cfg.SAFE_PASSAGE_ENABLED) throw new HttpError(409, "safe_disabled");
      await this.refresh(true);
      if (this.cache.some(m => m.datum.flight === hex && m.datum.state.kind !== "resolved") || Object.values(this.journal.pending).some(p => p.flight === hex)) throw new HttpError(409, "market_exists", "This passage already has a market or pending transaction");
      const open = this.cache.filter(m => m.datum.state.kind !== "resolved").length;
      const creating = Object.values(this.journal.pending).filter(p => p.action === "create").length;
      if (open + creating >= this.cfg.SAFE_PASSAGE_MAX_OPEN) throw new HttpError(409, "cap_reached");
      const { zone } = await this.eligible(hex);
      let id = "";
      const txHash = await this.ctx.operator.run(async inputs => {
        const result = await buildSafeCreate(this.ctx.operator.lucid, this.contracts, hex, zone, BigInt(this.cfg.SAFE_PASSAGE_RESERVE_ADA) * 1_000_000n, this.ctx.now(), inputs);
        id = result.datum.marketId; return result.tx;
      });
      this.journal.pending[id] = { action: "create", txHash, at: Date.now(), flight: hex }; this.save();
      return { marketId: id, txHash };
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
      const txHash = await this.ctx.operator.run(inputs => buildSafeFreeze(this.ctx.operator.lucid, this.contracts, m, evidence, this.ctx.now(), inputs));
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
      const txHash = await this.ctx.operator.run(inputs => buildSafeVerify(this.ctx.operator.lucid, this.contracts, m, winner, evidence, this.ctx.now(), inputs));
      this.journal.pending[id] = { action: "verify", txHash, at: Date.now(), flight: m.datum.flight }; this.save();
      return { txHash, evidenceHash: evidence };
    });
  }
}
