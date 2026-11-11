import { useMemo, useState } from "react";
import { quote } from "@flightradar/core/parimutuel";
import { ada, countdown, formatOdds, formatPercent, utcClock } from "../format";
import { useNow } from "../hooks";
import { t } from "../i18n";
import type { BetCosts, MarketDto } from "../types";
import { RulesPanel } from "./RulesPanel";

const OUTCOME_COLORS = ["var(--yes)", "var(--no)"];
const RACE_COLORS = ["var(--race-0)", "var(--race-1)", "var(--race-2)", "var(--race-3)"];
const PRESETS = [5, 10, 25, 50];

/** A built, unsigned bet transaction plus everything the user confirms. */
export interface PreparedBet {
  market: MarketDto;
  outcome: number;
  tx: string;
  costs: BetCosts;
  payout: string;
  multiplier: number;
}

export interface MarketCardProps {
  market: MarketDto;
  highlight?: boolean;
  /** Question, two coloured buttons with the pool shares; details folded away. */
  simple?: boolean;
  busy?: boolean;
  onPrepare: (market: MarketDto, outcome: number, stakeLovelace: bigint) => Promise<PreparedBet | null>;
  onConfirm: (bet: PreparedBet) => Promise<boolean>;
}

function colorFor(m: MarketDto, i: number) {
  return m.kind === "race" ? RACE_COLORS[i % RACE_COLORS.length] : OUTCOME_COLORS[i] ?? "var(--info)";
}

function PhaseLine({ m, now }: { m: MarketDto; now: number }) {
  switch (m.phase) {
    case "creating":
      return <span className="badge">{t.creating}</span>;
    case "open":
      return (
        <span className="badge accent num">
          {t.closesIn} {countdown(m.closeTime - now)}
        </span>
      );
    case "closed":
      return <span className="badge">{t.closed}</span>;
    case "resolved":
      return <span className="badge yes">{t.resolved(m.labels.en[m.winner ?? 0] ?? "")}</span>;
    case "void":
      return <span className="badge no">{t.voided}</span>;
  }
}

function Confirm({ bet, busy, onBack, onConfirm }: { bet: PreparedBet; busy?: boolean; onBack: () => void; onConfirm: () => void }) {
  const c = bet.costs;
  const now = useNow(1000);
  const upfront = BigInt(c.stake) + BigInt(c.batcherFee) + BigInt(c.networkFee) + BigInt(c.deposit);
  const expired = c.closeTime - now < 60_000;
  return (
    <div className="confirm" role="region" aria-label="Confirm demo bet">
      <div className="confirm-title">Confirm demo bet: {bet.market.labels.en[bet.outcome]}</div>
      <table className="costs num">
        <tbody>
          <tr>
            <td>Stake</td>
            <td>{ada(c.stake)}</td>
          </tr>
          <tr>
            <td>Batcher fee</td>
            <td>{ada(c.batcherFee)}</td>
          </tr>
          <tr>
            <td>Network fee</td>
            <td>{ada(c.networkFee)}</td>
          </tr>
          <tr>
            <td>Deposit, returned with your tokens</td>
            <td>{ada(c.deposit)}</td>
          </tr>
          <tr className="total">
            <td>Leaves your demo wallet now</td>
            <td>{ada(upfront)}</td>
          </tr>
        </tbody>
      </table>
      <div className="note">
        <strong>Not a guaranteed payout.</strong> If betting closed right now and this outcome won, you would receive about {ada(bet.payout)} (×
        {formatOdds(bet.multiplier, "en-US")}), after the {Number(c.feeBps) / 100} % fee on the losing pools. Later bets change this until{" "}
        {utcClock(c.closeTime)}. If the outcome loses, the stake is gone.
      </div>
      {expired && <div className="note warn">Less than a minute to close: the batcher may not book this order; it would be returned minus the batcher fee.</div>}
      <div className="stake-row">
        <button type="button" className="btn flat" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn primary" onClick={onConfirm} disabled={busy}>
          Confirm demo bet
        </button>
      </div>
    </div>
  );
}

export function MarketCard({ market: m, highlight, simple, busy, onPrepare, onConfirm }: MarketCardProps) {
  const now = useNow(1000);
  const [outcome, setOutcome] = useState<number | null>(null);
  const [stakeAda, setStakeAda] = useState("10");
  const [prepared, setPrepared] = useState<PreparedBet | null>(null);
  // A market still being confirmed already takes bets (as orders the batcher books once it is on chain).
  const open = (m.phase === "open" || m.phase === "creating") && m.closeTime > now;
  const pools = useMemo(() => m.pools.map((p) => BigInt(p)), [m.pools.join(",")]);
  const stake = BigInt(Math.max(0, Math.round((Number(stakeAda.replace(",", ".")) || 0) * 1_000_000)));
  const q = outcome !== null && stake > 0n ? quote(pools, outcome, BigInt(m.feeBps), stake) : null;

  return (
    <div className={`market${highlight ? " highlight" : ""}${simple ? " simple" : ""}`} id={`market-${m.id}`}>
      <div className="market-head">
        <h3>{m.title.en}</h3>
        <div className="market-meta">
          <PhaseLine m={m} now={now} />
          {!simple && (
            <span className="num">
              {t.pool} {ada(m.total, 0)}
            </span>
          )}
          {!simple && m.pending.orders > 0 && <span>· {t.pendingOrders(m.pending.orders)}</span>}
          {m.simulated && <span className="badge">{t.simulated}</span>}
        </div>
      </div>
      {!simple && <div className="pool-note">Pool share · odds if betting closed now. Market-based, not a probability of the event.</div>}
      <div className={`outcomes${simple ? " duo" : ""}`} role="radiogroup" aria-label={m.title.en}>
        {m.labels.en.map((label, i) => {
          const p = m.probabilities[i] ?? 0;
          const won = m.phase === "resolved" && m.winner === i;
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={outcome === i}
              className={`outcome${outcome === i ? " selected" : ""}${won ? " winner" : ""}${simple ? ` side-${i}` : ""}`}
              title="Share of all stakes on this outcome (market-based, not a probability of the event)"
              disabled={!open || !!prepared}
              onClick={() => setOutcome(i)}
            >
              <div className="bar" style={{ width: `${Math.max(2, p * 100)}%`, background: colorFor(m, i) }} />
              <span className="label" style={{ color: colorFor(m, i) }}>
                {label}
              </span>
              <span className="prob num" title="Share of all stakes on this outcome">
                {formatPercent(p, "en-US")}
              </span>
              {!simple && <span className="odds num">×{formatOdds(m.odds[i] ?? NaN, "en-US")}</span>}
            </button>
          );
        })}
      </div>
      {open && outcome !== null && !prepared && (
        <div className="betbox">
          <div className="stake-row">
            <label className="stake-input">
              <span className="muted">{t.stake}</span>
              <input inputMode="decimal" value={stakeAda} onChange={(e) => setStakeAda(e.target.value.replace(/[^0-9.,]/g, ""))} aria-label={`${t.stake} in ADA`} />
              <span className="muted">₳</span>
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || stake < 1_000_000n}
              onClick={async () => setPrepared(await onPrepare(m, outcome, stake))}
            >
              Review bet
            </button>
          </div>
          <div className="chips">
            {PRESETS.map((v) => (
              <button key={v} type="button" className={`chip${stakeAda === String(v) ? " active" : ""}`} onClick={() => setStakeAda(String(v))}>
                {v} ₳
              </button>
            ))}
          </div>
          {q && (
            <div className="quote">
              <span className="muted">If betting closed now and it wins</span>
              <span className="big num">
                ≈ {ada(q.payout)} <span className="muted">×{formatOdds(q.multiplier, "en-US")}</span>
              </span>
            </div>
          )}
          {!simple && <div className="note">{t.quoteNote}</div>}
        </div>
      )}
      {prepared && (
        <Confirm
          bet={prepared}
          busy={busy}
          onBack={() => setPrepared(null)}
          onConfirm={async () => {
            if (await onConfirm(prepared)) {
              setPrepared(null);
              setOutcome(null);
            }
          }}
        />
      )}
      {simple && <div className="pool-note duo-note">Pool shares, market-based · not a probability</div>}
      <RulesPanel m={m} />
      {!simple && m.seed && (
        <div className="pool-note">
          {t.seedModel}: {m.seed.probabilities.map((p) => formatPercent(p, "en-US")).join(" / ")} from the model ({m.seed.model}).
        </div>
      )}
      {m.resolution && <div className="pool-note">Result reason: {m.resolution.reason}</div>}
    </div>
  );
}
