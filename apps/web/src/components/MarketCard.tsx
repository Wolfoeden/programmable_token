import { useMemo, useState } from "react";
import { quote } from "@flightradar/core/parimutuel";
import { ada, countdown, formatOdds, formatPercent, utcClock } from "../format";
import { useNow } from "../hooks";
import { t } from "../i18n";
import type { BetCosts, MarketDto } from "../types";
import { airportByIcao } from "@flightradar/core/airports";
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
  onPrepare: (market: MarketDto, outcome: number, stakeLovelace: bigint, side?: boolean) => Promise<PreparedBet | null>;
  onConfirm: (bet: PreparedBet) => Promise<boolean>;
  /** Operator mode: void the market (refund everyone). */
  onVoid?: (market: MarketDto) => void;
  /** Called when the user picks an outcome (e.g. to expand a bottom sheet). */
  onEngage?: () => void;
  /** The connected wallet's stake per outcome in this market (lovelace). */
  mine?: Map<number, bigint> | null;
}

/** "Will BA851 land at LHR before" + "08:25" for the big-time layout. */
function questionParts(m: MarketDto): { lead: string; time: string } | null {
  const q = m.question;
  if (q.kind !== "landing_before") return null;
  const f = q.flight;
  const dest = airportByIcao(f.destination)?.iata || f.destination;
  return { lead: `Will ${f.flightNumber || f.callsign} land at ${dest} before`, time: new Date(Number(q.threshold)).toISOString().slice(11, 16) };
}

function SimpleStatus({ m, now }: { m: MarketDto; now: number }) {
  if ((m.phase === "open" || m.phase === "preview") && m.closeTime > now) return <span className="closes mono">Closes in {countdown(m.closeTime - now)}</span>;
  if (m.phase === "creating") return <span className="closes mono">Confirming on chain</span>;
  if (m.phase === "resolved") return <span className="closes mono done">Result: {m.labels.en[m.winner ?? 0]}</span>;
  if (m.phase === "void") return <span className="closes mono done">Void · refunded</span>;
  return <span className="closes mono done">Betting closed</span>;
}

function colorFor(m: MarketDto, i: number) {
  return m.kind === "race" ? RACE_COLORS[i % RACE_COLORS.length] : OUTCOME_COLORS[i] ?? "var(--info)";
}

function PhaseLine({ m, now }: { m: MarketDto; now: number }) {
  switch (m.phase) {
    case "preview":
      return (
        <span className="badge accent num">
          New · {t.closesIn} {countdown(m.closeTime - now)}
        </span>
      );
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
  const side = BigInt(c.side ?? "0");
  const upfront = BigInt(c.stake) + BigInt(c.batcherFee) + BigInt(c.networkFee) + BigInt(c.deposit) + side;
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
          {side > 0n && (
            <tr>
              <td>Side bet into the jackpot</td>
              <td>{ada(side)}</td>
            </tr>
          )}
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

export function MarketCard({ market: m, highlight, simple, busy, onPrepare, onConfirm, onVoid, onEngage, mine }: MarketCardProps) {
  const now = useNow(1000);
  const [outcome, setOutcome] = useState<number | null>(null);
  const [stakeAda, setStakeAda] = useState("10");
  const [sideBet, setSideBet] = useState(false);
  const [prepared, setPrepared] = useState<PreparedBet | null>(null);
  // A market still being confirmed already takes bets (as orders the batcher books once it is on chain).
  const open = (m.phase === "open" || m.phase === "preview" || (m.phase === "creating" && (m.closeTime === 0 || m.closeTime > now))) && (m.closeTime === 0 || m.closeTime > now);
  const pools = useMemo(() => m.pools.map((p) => BigInt(p)), [m.pools.join(",")]);
  const stake = BigInt(Math.max(0, Math.round((Number(stakeAda.replace(",", ".")) || 0) * 1_000_000)));
  const q = outcome !== null && stake > 0n ? quote(pools, outcome, BigInt(m.feeBps), stake) : null;

  const parts = simple ? questionParts(m) : null;
  const myTotal = mine ? [...mine.values()].reduce((a, b) => a + b, 0n) : 0n;
  return (
    <div className={`market${highlight ? " highlight" : ""}${simple ? " simple pcard" : ""}`} id={`market-${m.id}`}>
      {simple ? (
        <>
          <div className="pcard-head">
            <span className="eyebrow">
              <span className="eyebrow-dot" aria-hidden /> {m.kind === "landing_before" ? "Landing prediction" : "Prediction"}
            </span>
            <SimpleStatus m={m} now={now} />
          </div>
          {parts ? (
            <h3 className="pq">
              {parts.lead}
              <span className="pq-time">
                <span className="num">{parts.time}</span> <small>UTC?</small>
              </span>
            </h3>
          ) : (
            <h3 className="pq">{m.title.en}</h3>
          )}
          {myTotal > 0n && (
            <div className="my-bet num">
              Your bet:{" "}
              {[...mine!.entries()]
                .filter(([, v]) => v > 0n)
                .map(([o, v]) => `${ada(v)} on ${m.labels.en[o] ?? `#${o}`}`)
                .join(" · ")}
            </div>
          )}
        </>
      ) : null}
      {!simple && (
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
      )}
      {!simple && <div className="pool-note">Pool share · odds if betting closed now. Market-based, not a probability of the event.</div>}
      {simple ? (
        <div className="opts" role="radiogroup" aria-label={m.title.en}>
          {m.labels.en.map((label, i) => {
            const p = m.probabilities[i] ?? 0;
            const won = m.phase === "resolved" && m.winner === i;
            return (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={outcome === i}
                className={`opt side-${i}${outcome === i ? " selected" : ""}${won ? " winner" : ""}`}
                disabled={!open || !!prepared}
                onClick={() => {
                  setOutcome(i);
                  onEngage?.();
                }}
              >
                <span className="opt-text">
                  <span className="opt-label">{label}</span>
                  <span className="opt-pct num">{Math.round(p * 100)}%</span>
                </span>
                <span className="opt-radio" aria-hidden />
              </button>
            );
          })}
        </div>
      ) : null}
      {simple && <div className="pool-note">Share of the current pool · not the probability of an outcome</div>}
      {simple && open && outcome === null && !prepared && <div className="choose-hint">Choose an answer to continue.</div>}
      {!simple && (
      <div className="outcomes" role="radiogroup" aria-label={m.title.en}>
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
              onClick={() => {
                setOutcome(i);
                onEngage?.();
              }}
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
      )}
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
              onClick={async () => setPrepared(await onPrepare(m, outcome, stake, sideBet))}
            >
              Review bet
            </button>
          </div>
          <label className="side-bet">
            <input type="checkbox" checked={sideBet} onChange={(e) => setSideBet(e.target.checked)} />
            <span>
              Side bet <strong>+1 ₳</strong> into the jackpot <span className="muted">(optional; the jackpot is shown in the menu)</span>
            </span>
          </label>
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
      {!simple && <RulesPanel m={m} />}
      {onVoid && (m.phase === "open" || m.phase === "closed") && (
        <button type="button" className="btn small flat operator-void" disabled={busy} onClick={() => onVoid(m)}>
          Operator: void market (refund everyone)
        </button>
      )}
      {!simple && m.seed && (
        <div className="pool-note">
          {t.seedModel}: {m.seed.probabilities.map((p) => formatPercent(p, "en-US")).join(" / ")} from the model ({m.seed.model}).
        </div>
      )}
      {m.resolution && <div className="pool-note">Result reason: {m.resolution.reason}</div>}
    </div>
  );
}
