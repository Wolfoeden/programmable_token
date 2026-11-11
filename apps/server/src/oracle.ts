/**
 * Settles markets. For each open market it gathers what is known about the
 * flights (ADS-B track, schedule status), runs the pure `judge` rules from
 * @flightradar/core and, once final, signs a Resolve transaction. The full
 * evidence is stored for audit.
 */
import { airportByIcao, flightKey, flightsOf, flyingElsewhere, judge, type FlightStatus, type Observation, type Verdict } from "@flightradar/core";
import { buildClose, buildResolve, fetchReferenceNfts, type MarketView } from "@flightradar/chain";
import type { ChainContext } from "./chain.js";
import type { ScheduleProvider } from "./schedule.js";
import type { Store } from "./store.js";
import type { Tracker } from "./tracker.js";
import { log, TtlCache } from "./util.js";

/** Void a little before the on-chain force-void deadline. */
const GIVE_UP_MARGIN_MS = 30 * 60_000;

export class Oracle {
  private inflight = new Map<string, number>();
  private scheduleCache = new TtlCache<Promise<{ cancelled: boolean; departed: boolean } | null>>(5 * 60_000);

  constructor(
    private ctx: ChainContext,
    private tracker: Tracker,
    private schedule: ScheduleProvider | undefined,
    private store: Store,
  ) {}

  private scheduleStatus(m: MarketView) {
    const q = m.datum.question;
    if (q.kind !== "cancellation" || !this.schedule) return Promise.resolve(null);
    const key = m.datum.marketId;
    const hit = this.scheduleCache.get(key);
    if (hit) return hit;
    const p = this.schedule
      .status(q.flight.flightNumber, q.flight.origin, q.scheduledDeparture)
      .then((f) => (f ? { cancelled: f.status === "cancelled", departed: ["departed", "arrived", "diverted"].includes(f.status) } : null))
      .catch(() => null);
    this.scheduleCache.set(key, p);
    return p;
  }

  /**
   * Close markets whose claim deadline has passed: burns the market and
   * reference NFTs and returns deposits and unclaimed funds to the operator.
   */
  async sweep(markets: MarketView[]): Promise<void> {
    const now = this.ctx.now();
    for (const m of markets) {
      if (Number(m.datum.claimDeadline) + 60_000 > now || this.inflight.has(m.datum.marketId)) continue;
      this.inflight.set(m.datum.marketId, Date.now() + 5 * 60_000);
      try {
        const refs = await fetchReferenceNfts(this.ctx.operator.lucid, this.ctx.contracts, m.datum.marketId);
        const txHash = await this.ctx.operator.run((walletUtxos) =>
          buildClose(this.ctx.operator.lucid, this.ctx.contracts, m, refs, now, { walletUtxos }),
        );
        log.info("market closed", { marketId: m.datum.marketId, txHash });
      } catch (e) {
        log.warn("close failed", { marketId: m.datum.marketId, error: String(e) });
      }
    }
  }

  async tick(markets: MarketView[]): Promise<void> {
    const now = Date.now();
    for (const [id, until] of this.inflight) if (until < now) this.inflight.delete(id);
    for (const m of markets) {
      if (m.datum.state.kind !== "open" || this.inflight.has(m.datum.marketId)) continue;
      const q = m.datum.question;
      const statuses: Record<string, FlightStatus> = {};
      const observations: Record<string, Observation[]> = {};
      for (const f of flightsOf(q)) {
        this.tracker.watch(f, Number(m.datum.resolveDeadline));
        const s = this.tracker.status(f, now);
        if (q.kind === "cancellation") {
          const sched = await this.scheduleStatus(m);
          if (sched?.cancelled) s.cancelled = true;
          if (sched?.departed) s.departed = true;
        }
        statuses[flightKey(f)] = s;
        observations[flightKey(f)] = this.tracker.observations(f);
      }
      let verdict: Verdict = judge(q, statuses, now, Number(m.datum.resolveDeadline) - GIVE_UP_MARGIN_MS);
      // Route data can be wrong (reused flight numbers): void as soon as the
      // aircraft is clearly flying somewhere else, not only after it lands there.
      if (verdict.status !== "final" && (q.kind === "landing_before" || q.kind === "delay")) {
        const elsewhere = flyingElsewhere(observations[flightKey(q.flight)] ?? [], airportByIcao(q.flight.origin), airportByIcao(q.flight.destination), now);
        if (elsewhere) verdict = { status: "final", winner: null, reason: elsewhere };
      }
      if (verdict.status !== "final") continue;
      await this.settle(m, verdict, { statuses, observations });
    }
  }

  /** Void a market at once (operator decision); all stakes are refunded 1:1. */
  async voidNow(m: MarketView, reason: string): Promise<string> {
    if (m.datum.state.kind !== "open") throw new Error("market_not_open");
    const txHash = await this.settle(m, { status: "final", winner: null, reason: `voided by the operator: ${reason}` }, {});
    if (!txHash) throw new Error("void_failed");
    return txHash;
  }

  private async settle(
    m: MarketView,
    verdict: Extract<Verdict, { status: "final" }>,
    data: { statuses?: Record<string, FlightStatus>; observations?: Record<string, Observation[]> },
  ): Promise<string | null> {
    const now = Date.now();
    this.inflight.set(m.datum.marketId, now + 5 * 60_000);
    try {
      const txHash = await this.ctx.operator.run((walletUtxos) =>
        buildResolve(this.ctx.operator.lucid, this.ctx.contracts, m, verdict.winner, { walletUtxos }),
      );
      this.store.putEvidence({ marketId: m.datum.marketId, verdict, decidedAt: now, txHash, statuses: data.statuses ?? {}, observations: data.observations ?? {} });
      log.info("market resolved", { marketId: m.datum.marketId, winner: verdict.winner, reason: verdict.reason, txHash });
      return txHash;
    } catch (e) {
      this.inflight.delete(m.datum.marketId);
      log.warn("resolve failed", { marketId: m.datum.marketId, error: String(e) });
      return null;
    }
  }
}
