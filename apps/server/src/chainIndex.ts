/**
 * One shared, periodically refreshed view of markets and orders on chain.
 *
 * A market UTxO that is being spent (bet, batch, resolve) can briefly vanish
 * from provider queries before its successor is confirmed (the emulator
 * marks inputs spent at submission). The index keeps the last known state
 * for a grace period and flags it as stale so nobody builds on it.
 */
import { fetchMarkets, fetchOrders, type MarketView, type OrderView } from "@flightradar/chain";
import type { ChainContext } from "./chain.js";
import { log } from "./util.js";

const GRACE_MS = 90_000;

export class ChainIndex {
  markets: MarketView[] = [];
  orders: OrderView[] = [];
  updatedAt = 0;
  private fastUntil = 0;
  private lastSeen = new Map<string, { view: MarketView; seenAt: number }>();
  private staleIds = new Set<string>();
  private refreshing: Promise<void> | null = null;

  constructor(private ctx: ChainContext) {}

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const lucid = this.ctx.operator.lucid;
        const [fresh, orders] = await Promise.all([fetchMarkets(lucid, this.ctx.contracts), fetchOrders(lucid, this.ctx.contracts)]);
        const now = Date.now();
        const ids = new Set(fresh.map((m) => m.datum.marketId));
        for (const m of fresh) this.lastSeen.set(m.datum.marketId, { view: m, seenAt: now });
        const kept: MarketView[] = [];
        this.staleIds = new Set();
        for (const [id, e] of this.lastSeen) {
          if (ids.has(id)) continue;
          if (now - e.seenAt < GRACE_MS) {
            kept.push(e.view);
            this.staleIds.add(id);
          } else {
            this.lastSeen.delete(id);
          }
        }
        this.markets = [...fresh, ...kept];
        this.orders = orders;
        this.updatedAt = now;
      } catch (e) {
        log.warn("index refresh failed", { error: String(e) });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * Chain queries are rationed (the public Koios tier allows 5,000 a day):
   * every 60 s when nothing is going on, every 8 s while something is in
   * flight (orders waiting, a market being confirmed, a recent submission).
   */
  hurry(ms = 3 * 60_000): void {
    this.fastUntil = Math.max(this.fastUntil, Date.now() + ms);
  }

  private busy(): boolean {
    return Date.now() < this.fastUntil || this.orders.length > 0 || this.staleIds.size > 0;
  }

  /** Refresh if due; call often. */
  async maybeRefresh(): Promise<void> {
    const every = this.busy() ? 8_000 : 60_000;
    if (Date.now() - this.updatedAt >= every) await this.refresh();
  }

  /** Markets whose current UTxO is known to be confirmed. */
  get live(): MarketView[] {
    return this.markets.filter((m) => !this.staleIds.has(m.datum.marketId));
  }

  isStale(id: string): boolean {
    return this.staleIds.has(id);
  }

  market(id: string): MarketView | undefined {
    return this.markets.find((m) => m.datum.marketId === id);
  }
}
