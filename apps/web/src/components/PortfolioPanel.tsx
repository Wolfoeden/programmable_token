import { api } from "../api";
import { ada } from "../format";
import { usePoll } from "../hooks";
import { errorText, t } from "../i18n";
import type { MarketDto } from "../types";
import type { AppWallet } from "../wallet";

export interface PortfolioPanelProps {
  wallet: AppWallet;
  busy: boolean;
  onClaim: (marketId: string) => void;
  onCancel: (orderRef: string) => void;
  /** Burn worthless tickets (lost bets). */
  onBurnLost: () => void;
  onOpenMarket: (m: MarketDto) => void;
  onClose: () => void;
  /** All markets, to name the market of an open order. */
  markets?: MarketDto[];
}

export function PortfolioPanel(p: PortfolioPanelProps) {
  const { data, error } = usePoll(async () => api.portfolio(await p.wallet.payload()), 10_000, [p.wallet.id]);
  return (
    <aside className="panel" aria-label={t.portfolio}>
      <div className="panel-head">
        <div>
          <h2>{t.portfolio}</h2>
          <div className="sub num">
            {p.wallet.name}
            {data && ` · ${t.balance} ${ada(data.lovelace)}`}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t.close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {error !== null && <div className="muted">{errorText(error)}</div>}
        {data && data.positions.length === 0 && data.orders.length === 0 && <div className="muted">{t.noPositions}</div>}
        {(() => {
          const lost = (data?.positions ?? []).filter((pos) => pos.market?.phase === "resolved" && BigInt(pos.claimable) === 0n).length;
          return lost > 0 ? (
            <div className="lost-box">
              <div>
                {lost === 1 ? "1 lost bet" : `${lost} lost bets`} still in your wallet as tickets. They pay nothing; removing them returns the ₳ they hold.
              </div>
              <button type="button" className="btn small primary" disabled={p.busy} onClick={p.onBurnLost}>
                Remove lost tickets
              </button>
            </div>
          ) : null;
        })()}
        {data?.positions.map((pos) => {
          const m = pos.market;
          const claimable = BigInt(pos.claimable);
          return (
            <div className="market" key={pos.marketId}>
              <div className="market-head">
                <h3>{m ? m.title.en : pos.marketId.slice(0, 12)}</h3>
                <div className="list">
                  {pos.holdings.map((h) => (
                    <div key={h.outcome} className="quote">
                      <span>
                        {m?.labels.en[h.outcome] ?? `#${h.outcome}`} · <span className="num">{ada(h.quantity)}</span>
                      </span>
                      {m?.phase === "open" || m?.phase === "closed" ? (
                        <span className="num muted">
                          {t.ifWins} {ada(pos.ifWins[h.outcome] ?? "0")}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className="actions">
                  {m && (
                    <button type="button" className="btn small flat" onClick={() => p.onOpenMarket(m)}>
                      Open market
                    </button>
                  )}
                  {m && (m.phase === "resolved" || m.phase === "void") && claimable > 0n && (
                    <button type="button" className="btn small primary" disabled={p.busy} onClick={() => p.onClaim(pos.marketId)}>
                      {m.phase === "void" ? `Refund ${ada(claimable)}` : `${t.claim} ${ada(claimable)}`}
                    </button>
                  )}
                  {m?.phase === "void" && <span className="badge">Void: {m.resolution?.reason ?? "stakes refunded 1:1"}</span>}
                  {m && m.phase === "resolved" && claimable === 0n && <span className="badge no">{t.lost}</span>}
                </div>
              </div>
            </div>
          );
        })}
        {data && data.orders.length > 0 && <div className="section-title">{t.openOrders}</div>}
        <div className="list">
          {data?.orders.map((o) => {
            const m = p.markets?.find((x) => x.id === o.marketId);
            const dead = m && (m.phase === "void" || m.phase === "resolved" || m.phase === "closed");
            return (
              <div className="row" key={o.ref}>
                <span className="time">{o.order.kind === "bet" ? "Bet" : "Claim"}</span>
                <div className="what">
                  <div className="t num">
                    {o.order.kind === "bet" ? `${ada(o.order.stake)} on ${m?.labels.en[o.order.outcome] ?? `#${o.order.outcome}`}` : "Positions submitted"}
                  </div>
                  <div className="s">{m ? m.title.en : `${o.marketId.slice(0, 12)}…`}</div>
                  <div className="s">
                    {dead
                      ? `Not booked: the market is ${m!.phase === "void" ? "void" : m!.phase}. Cancel to get ${ada(o.lovelace)} back.`
                      : "Waiting to be booked into the pool. You can cancel it until then."}
                  </div>
                </div>
                <button type="button" className={`btn small${dead ? " primary" : " flat"}`} disabled={p.busy} onClick={() => p.onCancel(o.ref)}>
                  {dead ? `Get ${ada(o.lovelace)} back` : t.cancelOrder}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
