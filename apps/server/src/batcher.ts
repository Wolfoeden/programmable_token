/**
 * Executes orders. Up to 20 orders per transaction (measured limit with
 * inline scripts: 24). Bet orders are filled while the market is open,
 * claim orders once it is resolved, and expired orders are refunded.
 */
import { buildBatch, buildRefunds, type MarketView, type OrderView } from "@flightradar/chain";
import type { ChainContext } from "./chain.js";
import { log } from "./util.js";

const MAX_BATCH = 20;
const ref = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

export class Batcher {
  /** Market and order UTxOs spent by transactions not yet seen on chain. */
  private inflight = new Map<string, number>();

  constructor(private ctx: ChainContext) {}

  private busy(r: string): boolean {
    const until = this.inflight.get(r);
    return until !== undefined && until > Date.now();
  }

  private mark(refs: string[]) {
    const until = Date.now() + 5 * 60_000;
    for (const r of refs) this.inflight.set(r, until);
  }

  async tick(markets: MarketView[], orders: OrderView[]): Promise<void> {
    const now = this.ctx.now();
    for (const [r, until] of this.inflight) if (until < Date.now()) this.inflight.delete(r);
    const free = orders.filter((o) => !this.busy(ref(o.utxo)));
    const byMarket = new Map<string, OrderView[]>();
    for (const o of free) byMarket.set(o.datum.marketId, [...(byMarket.get(o.datum.marketId) ?? []), o]);

    const refundable: OrderView[] = [];
    for (const [marketId, list] of byMarket) {
      const m = markets.find((x) => x.datum.marketId === marketId);
      const expired = list.filter((o) => Number(o.datum.deadline) < now - 60_000);
      if (!m) {
        refundable.push(...expired);
        continue;
      }
      if (this.busy(ref(m.utxo))) continue;
      const open = m.datum.state.kind === "open" && now < Number(m.datum.closeTime) - 60_000;
      const fillable = list.filter((o) =>
        open
          ? o.datum.order.kind === "bet" && o.datum.order.outcome < m.datum.pools.length && o.datum.order.stake > 0n
          : m.datum.state.kind === "resolved" && o.datum.order.kind === "claim",
      );
      if (fillable.length > 0) {
        const batch = fillable.slice(0, MAX_BATCH);
        try {
          const hash = await this.ctx.operator.run((walletUtxos) => buildBatch(this.ctx.operator.lucid, this.ctx.contracts, m, batch, now, { walletUtxos }));
          this.mark([ref(m.utxo), ...batch.map((o) => ref(o.utxo))]);
          log.info("batch submitted", { marketId, orders: batch.length, txHash: hash });
        } catch (e) {
          log.warn("batch failed", { marketId, error: String(e) });
        }
      }
      refundable.push(...expired.filter((o) => !fillable.includes(o)));
    }

    if (refundable.length > 0) {
      const batch = refundable.slice(0, MAX_BATCH);
      try {
        const hash = await this.ctx.operator.run((walletUtxos) => buildRefunds(this.ctx.operator.lucid, this.ctx.contracts, batch, now, { walletUtxos }));
        this.mark(batch.map((o) => ref(o.utxo)));
        log.info("refunds submitted", { orders: batch.length, txHash: hash });
      } catch (e) {
        log.warn("refund failed", { error: String(e) });
      }
    }
  }
}
