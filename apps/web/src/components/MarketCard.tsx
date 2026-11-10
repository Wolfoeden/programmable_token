import { useMemo, useState } from "react";
import { quote } from "@flightradar/core/parimutuel";
import { ada, countdown, formatOdds, formatPercent, utcClock } from "../format";
import { useNow } from "../hooks";
import { t } from "../i18n";
import type { MarketDto } from "../types";

const OUTCOME_COLORS = ["var(--yes)", "var(--no)"];
const RACE_COLORS = ["var(--race-0)", "var(--race-1)", "var(--race-2)", "var(--race-3)"];
const PRESETS = [5, 10, 25, 50];

export interface MarketCardProps {
  market: MarketDto;
  highlight?: boolean;
  busy?: boolean;
  onBet: (market: MarketDto, outcome: number, stakeLovelace: bigint) => void;
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

export function MarketCard({ market: m, highlight, busy, onBet }: MarketCardProps) {
  const now = useNow(1000);
  const [outcome, setOutcome] = useState<number | null>(null);
  const [stakeAda, setStakeAda] = useState("10");
  const open = m.phase === "open" && m.closeTime > now;
  const pools = useMemo(() => m.pools.map((p) => BigInt(p)), [m.pools.join(",")]);
  const stake = BigInt(Math.max(0, Math.round((Number(stakeAda.replace(",", ".")) || 0) * 1_000_000)));
  const q = outcome !== null && stake > 0n ? quote(pools, outcome, BigInt(m.feeBps), stake) : null;

  return (
    <div className={`market${highlight ? " highlight" : ""}`}>
      <div className="market-head">
        <h3>{m.title.en}</h3>
        <div className="market-meta">
          <PhaseLine m={m} now={now} />
          <span className="num">
            {t.pool} {ada(m.total, 0)}
          </span>
          {m.pending.orders > 0 && <span>· {t.pendingOrders(m.pending.orders)}</span>}
          {m.simulated && <span className="badge">{t.simulated}</span>}
        </div>
      </div>
      <div className="outcomes" role="radiogroup" aria-label={m.title.en}>
        {m.labels.en.map((label, i) => {
          const p = m.probabilities[i] ?? 0;
          const won = (m.phase === "resolved" && m.winner === i);
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={outcome === i}
              className={`outcome${outcome === i ? " selected" : ""}${won ? " winner" : ""}`}
              disabled={!open}
              onClick={() => setOutcome(i)}
            >
              <div className="bar" style={{ width: `${Math.max(2, p * 100)}%`, background: colorFor(m, i) }} />
              <span className="label" style={{ color: colorFor(m, i) }}>
                {label}
              </span>
              <span className="prob num">{formatPercent(p, "en-US")}</span>
              <span className="odds num">×{formatOdds(m.odds[i] ?? NaN, "en-US")}</span>
            </button>
          );
        })}
      </div>
      {open && outcome !== null && (
        <div className="betbox">
          <div className="stake-row">
            <label className="stake-input">
              <span className="muted">{t.stake}</span>
              <input
                inputMode="decimal"
                value={stakeAda}
                onChange={(e) => setStakeAda(e.target.value.replace(/[^0-9.,]/g, ""))}
                aria-label={`${t.stake} in ADA`}
              />
              <span className="muted">₳</span>
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || stake < 1_000_000n}
              onClick={() => onBet(m, outcome, stake)}
            >
              {t.placeBet}
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
              <span className="muted">{t.payoutIfWin}</span>
              <span className="big num">
                {ada(q.payout)} <span className="muted">×{formatOdds(q.multiplier, "en-US")}</span>
              </span>
            </div>
          )}
          <div className="note">{t.quoteNote}</div>
          <div className="note">{t.costNote}</div>
        </div>
      )}
      <details className="rules">
        <summary>
          {t.rules} · {t.fee(m.feeBps)}
        </summary>
        <p>{m.rules.en}</p>
        {m.seed && (
          <p>
            {t.seedModel}: {m.seed.probabilities.map((p) => formatPercent(p, "en-US")).join(" / ")} ({m.seed.model})
          </p>
        )}
        {m.phase !== "creating" && m.closeTime > 0 && <p className="num">Betting closes {utcClock(m.closeTime)} · resolved by {utcClock(m.resolveDeadline)} at the latest</p>}
        {m.resolution && <p>Reason: {m.resolution.reason}</p>}
      </details>
    </div>
  );
}
