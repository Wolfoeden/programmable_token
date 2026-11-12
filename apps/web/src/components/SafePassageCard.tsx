import { useEffect, useState } from "react";
import { deathZoneAt } from "@flightradar/core/deathzones";
import { api } from "../api";
import { ada } from "../format";
import { useNow, usePoll } from "../hooks";
import { errorText } from "../i18n";
import type { AircraftDto, SafeMarketDto, SafeQuote } from "../types";
import { signBuilt, signAndSubmit, type AppWallet } from "../wallet";

const gross = (n: string | bigint) => `${(Number(n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} ADA`;
function parseStake(text: string): bigint | null {
  const s = text.trim().replace(",", ".");
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return null;
  const [whole, part = ""] = s.split("."); return BigInt(whole!) * 1_000_000n + BigInt(part.padEnd(6, "0"));
}

export function SafePassageCard(p: { hex: string; aircraft?: AircraftDto; wallet: AppWallet | null; operator: string | null; onConnect: () => void }) {
  const poll = usePoll(() => api.safeFlight(p.hex), 8000, [p.hex]);
  const [outcome, setOutcome] = useState<0 | 1 | null>(null);
  const [stakeText, setStake] = useState("1");
  const [quote, setQuote] = useState<SafeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const now = useNow(1000);
  // Never use the previous flight's poll result while a new selection loads.
  const m = poll.data?.market?.hex === p.hex ? poll.data.market : null;
  useEffect(() => { setQuote(null); setOutcome(null); setStake("1"); setMessage(null); }, [p.hex, p.wallet?.id]);
  useEffect(() => { setQuote(null); }, [outcome, stakeText]);
  const inZone = p.aircraft?.hex === p.hex && deathZoneAt(p.aircraft.lon, p.aircraft.lat);
  if (!m && !inZone) return null;
  if (!poll.data) return <div className="pool-note">{poll.error ? "Safe Passage data unavailable." : "Loading Safe Passage…"}</div>;
  if (!poll.data.enabled) return p.operator ? <div className="pool-note">Safe Passage is disabled. Set SAFE_PASSAGE_ENABLED=1.</div> : null;
  const stake = parseStake(stakeText);
  const limit = outcome === null ? 0n : BigInt(m?.limits[outcome] ?? poll.data.previewLimits?.[outcome] ?? "0");
  const open = !m || m.phase === "open";
  const available = open && !!stake && stake >= 1_000_000n && stake <= limit && !poll.error && !!inZone && outcome !== null;
  const payout = stake && outcome !== null ? outcome === 0 ? stake * 10001n / 10000n : stake * 1000n : 0n;
  async function review() {
    if (!p.wallet) return p.onConnect();
    if (!available || !stake || outcome === null) return;
    const hex = p.hex;
    setBusy(true); setMessage(null); setQuote(null);
    try { const q = await api.safeQuote(await p.wallet.payload(), m?.id, outcome, stake.toString(), hex); setQuote(q); poll.reload(); }
    catch (e) { setMessage(errorText(e)); poll.reload(); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!p.wallet || !quote || quote.hex !== p.hex || (m && (m.id !== quote.marketId || (m.phase !== "open" && m.phase !== "updating"))) || now >= quote.expiresAt) return;
    setBusy(true); setMessage(null);
    try { const hash = await signBuilt(p.wallet, quote.tx); setQuote(null); setOutcome(null); setMessage(`Order submitted · ${hash.slice(0, 12)}… The batcher books covered bets and returns the deposit with your tokens. Track or cancel pending orders in My bets.`); poll.reload(); }
    catch (e) { setQuote(null); setMessage(errorText(e)); }
    finally { setBusy(false); }
  }
  const reviewed = quote?.hex === p.hex && (!m || m.id === quote.marketId) ? quote : null;
  return <section className="market simple pcard" aria-label="Safe Passage">
    <div className="pcard-head"><span className="eyebrow"><span className="eyebrow-dot" aria-hidden /> Safe Passage · {m?.zone ?? inZone}</span><span className="closes mono">{m?.phase === "resolved" ? "Verified result" : m?.phase === "frozen" ? "Under review" : m?.phase === "updating" ? "Confirming on chain" : "Fixed payout"}</span></div>
    <h3 className="pq">Will {p.aircraft?.callsign?.trim() || p.hex.toUpperCase()} pass safely through the red zone?</h3>
    <div className="opts" role="radiogroup" aria-label="Safe Passage outcome">
      {([0, 1] as const).map(i => <button key={i} type="button" role="radio" aria-checked={outcome === i} className={`opt side-${i}${outcome === i ? " selected" : ""}`} disabled={!open || busy || !!reviewed} onClick={() => setOutcome(i)}><span className="opt-text"><span className="opt-label">{i === 0 ? "Yes" : "No"}</span><span className="opt-pct num">{i === 0 ? "1.0001×" : "1000×"}</span></span><span className="opt-radio" aria-hidden /></button>)}
    </div>
    <div className="pool-note">Fixed gross payout · includes your stake</div>
    {open && outcome === null && !reviewed && <div className="choose-hint">Choose an answer to continue.</div>}
    {open && outcome !== null && !reviewed && <div className="bet-form">
      <div className="stake-row"><label className="stake"><span>Stake</span><input aria-label="Safe Passage stake in ADA" inputMode="decimal" value={stakeText} disabled={busy} onChange={e => setStake(e.target.value.replace(/[^0-9.,]/g, ""))} /><span className="muted">₳</span></label><button className="btn primary" disabled={busy || (!!p.wallet && !available)} onClick={review}>{busy ? "Preparing…" : p.wallet ? "Review bet" : "Connect wallet"}</button></div>
      <div className="chips">{[1, 5, 10, 25, 50].map(v => <button type="button" key={v} disabled={busy || BigInt(v) * 1_000_000n > limit} className={`chip${stakeText === String(v) ? " active" : ""}`} onClick={() => setStake(String(v))}>{v} ₳</button>)}</div>
      <div className="quote"><span className="muted">Payout if it wins</span><span className="big num">{gross(payout)} <span className="muted">×{outcome === 0 ? "1.0001" : "1000"}</span></span></div>
      <div className="pool-note">Covered stake limit: {gross(limit)} · minimum 1 ADA. Coverage is checked again when the batcher books your order.</div>
    </div>}
    {reviewed && <div className="confirm" role="region" aria-label="Confirm Safe Passage bet">
      <div className="confirm-title">Confirm bet: {reviewed.outcome === 0 ? "Yes" : "No"}</div>
      <table className="costs num"><tbody>
        <tr><td>Stake</td><td>{gross(reviewed.stake)}</td></tr>
        <tr><td>Batcher fee</td><td>{gross(reviewed.batcherFee)}</td></tr>
        <tr><td>Network fee</td><td>{gross(reviewed.fee)}</td></tr>
        <tr><td>Deposit, returned with your tokens</td><td>{gross(reviewed.deposit)}</td></tr>
        <tr className="total"><td>Leaves your wallet now</td><td>{gross(BigInt(reviewed.stake) + BigInt(reviewed.batcherFee) + BigInt(reviewed.deposit) + BigInt(reviewed.fee))}</td></tr>
      </tbody></table>
      <div className="note">Fixed gross payout if accepted and winning: <strong>{gross(reviewed.payout)}</strong>. Your stake is locked only after you sign and submit. Unfilled orders can be canceled in My bets or refunded after expiry, minus the batcher fee. Claims cost a separate network fee. Fees can exceed the profit on Yes.</div>
      <div className="stake-row"><button className="btn flat" disabled={busy} onClick={() => setQuote(null)}>Back</button><button className="btn primary" disabled={busy || now >= reviewed.expiresAt || m?.phase === "frozen" || m?.phase === "resolved"} onClick={confirm}>{now >= reviewed.expiresAt ? "Quote expired · review again" : "Confirm bet"}</button></div>
    </div>}
    {m && !open && !reviewed && <div className="closed-box" role="status">{m.recoveryHold ? "Restart review · betting suspended until operator review." : m.phase === "frozen" ? "Frozen · suspected incident under review. Betting and payouts are blocked." : m.phase === "updating" ? "Waiting for blockchain confirmation." : m.winner === null ? "Voided · claim your stake in My bets." : `Verified: ${m.winner === 0 ? "Yes" : "No"}. Claim in My bets.`}</div>}
    {!!poll.error && <p className="pool-note" role="alert">Data unavailable. Betting temporarily suspended.</p>}
    <details className="rules-panel"><summary>Rules &amp; settlement</summary><div className="note">No timed-exit condition. Landing and turning back count as Yes. No requires a verified crash or shoot-down inside a red zone during this passage. Signal loss alone never means No. Suspected incidents freeze the market until operator verification.</div>{m?.evidence && <><p>{m.evidence.reason}</p>{m.evidence.sources.map(s => <p key={s}><a href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a></p>)}<small>Evidence hash: {m.evidenceHash}</small></>}</details>
    {m && p.operator && m.phase !== "resolved" && <SafeOperator market={m} token={p.operator} reload={poll.reload} />}
    {message && <p className="pool-note" role="status">{message}</p>}
  </section>;
}

function SafeOperator(p: { market: SafeMarketDto; token: string; reload: () => void }) {
  const [reason, setReason] = useState(""); const [sources, setSources] = useState("");
  const [winner, setWinner] = useState("0"); const [incidentAt, setAt] = useState(""); const [zone, setZone] = useState(p.market.zone);
  const [reviewed, setReviewed] = useState(false); const [independent, setIndependent] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { setReviewed(false); setIndependent(false); }, [p.market.id, p.market.chainState, p.market.evidenceHash, p.market.recoveryHold]);
  async function act() {
    setBusy(true); setMessage("");
    try {
      const urls = sources.split(/\s+/).map(s => s.trim()).filter(Boolean);
      if (p.market.chainState === "open") await api.safeFreeze(p.token, p.market.id, reason, urls);
      else await api.safeVerify(p.token, p.market.id, { winner: winner === "refund" ? null : Number(winner), reason, sources: urls, reviewed, independentSourcesConfirmed: independent,
        ...(winner === "1" ? { incidentAt: new Date(incidentAt).getTime(), incidentZone: zone } : {}) });
      setMessage("Submitted. Waiting for blockchain confirmation."); p.reload();
    } catch (e) { setMessage(errorText(e)); }
    finally { setBusy(false); }
  }
  return <details className="rules-panel"><summary>Operator: suspicion and verification</summary>
    {p.market.recoveryHold && <div className="closed-box"><p>After cache loss, an operator must review the open market. Resume only if no unresolved suspicion remains.</p><label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> Reviewed the market and potential incident reports after restart.</label><button type="button" className="btn small" disabled={busy || !reviewed || reason.trim().length < 10} onClick={async () => {
      setBusy(true); setMessage(""); try { await api.safeResume(p.token, p.market.id, reason); setMessage("Restart review confirmed."); p.reload(); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
    }}>Resume after restart review</button></div>}
    <p className="pool-note">Reasons and sources are stored publicly on chain when freezing or verifying.</p>
    <label>Reason<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    <label>HTTPS sources, one per line<textarea value={sources} onChange={e => setSources(e.target.value)} /></label>
    {p.market.chainState === "frozen" && <>
      <label>Verified outcome<select value={winner} onChange={e => setWinner(e.target.value)}><option value="0">Yes — safe passage, landed or turned back</option><option value="1">No — verified crash / shoot-down inside a red zone</option><option value="refund">Inconclusive — refund stakes</option></select></label>
      {winner === "1" && <><label>Incident time (local time)<input type="datetime-local" value={incidentAt} onChange={e => setAt(e.target.value)} /></label><label>Incident country<select value={zone} onChange={e => setZone(e.target.value)}>{["LBN", "SYR", "IRQ", "YEM", "IRN", "AFG"].map(c => <option key={c}>{c}</option>)}</select></label><label><input type="checkbox" checked={independent} onChange={e => setIndependent(e.target.checked)} /> Reviewed two independent sources; confirmed flight identity, incident time and location.</label></>}
      <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> Personally reviewed the evidence. Settlement is final.</label>
    </>}
    <button className="btn small" disabled={busy || p.market.phase === "updating" || reason.trim().length < 10 || (p.market.chainState === "frozen" && (!reviewed || (winner === "1" && !independent)))} onClick={act}>{p.market.chainState === "open" ? "Freeze on suspicion" : "Settle verified outcome"}</button>
    {message && <p role="status">{message}</p>}
  </details>;
}

export function SafePassagePositions(p: { wallet: AppWallet; onEmpty?: (empty: boolean) => void }) {
  const poll = usePoll(async () => api.safePortfolio(await p.wallet.payload()), 10000, [p.wallet.id]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { p.onEmpty?.(!!poll.data && !poll.error && poll.data.positions.length === 0 && (poll.data.orders?.length ?? 0) === 0); }, [poll.data, poll.error, p.onEmpty]);
  async function claim(id: string) {
    setBusy(true); setMessage("");
    try { await signAndSubmit(p.wallet, w => api.safeClaim(w, id)); setMessage("Claim submitted. Waiting for confirmation."); poll.reload(); }
    catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function cancel(txHash: string, outputIndex: number) {
    setBusy(true); setMessage("");
    try { await signAndSubmit(p.wallet, w => api.safeCancel(w, txHash, outputIndex)); setMessage("Cancellation submitted. Waiting for confirmation."); poll.reload(); }
    catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  return <>{poll.data?.orders?.map(o => <section className="market" key={`${o.txHash}:${o.outputIndex}`}><h3>Safe Passage · order pending</h3><p>{gross(o.stake)} on {o.outcome === 0 ? "Yes" : "No"} · refundable after {new Date(o.deadline).toLocaleTimeString("en-US")}</p><button type="button" className="btn small flat" disabled={busy} onClick={() => cancel(o.txHash, o.outputIndex)}>Cancel order</button></section>)}{!!poll.error && <p className="pool-note">Safe Passage positions unavailable. Retrying.</p>}{poll.data?.positions.map(pos => <section className="market" key={pos.market.id}>
    <h3>Safe Passage · {pos.market.hex.toUpperCase()} · {pos.market.zone}</h3>
    <p>Yes: {ada(pos.yes)} · No: {ada(pos.no)}</p>
    {pos.market.phase === "resolved" ? <button className="btn primary small" disabled={busy || !!poll.error} onClick={() => claim(pos.market.id)}>{BigInt(pos.claimable) > 0n ? `${gross(pos.claimable)} claim` : "Remove losing receipts"}</button> : <p className="pool-note">{pos.market.phase === "frozen" ? "Frozen — verification pending." : pos.market.phase === "updating" ? "Waiting for blockchain confirmation." : "Outcome pending. Fixed payouts: Yes 1.0001× / No 1000×."}</p>}
    {pos.market.claimDeadline && <p className="pool-note">Claim deadline: {new Date(pos.market.claimDeadline).toLocaleString("en-US")}</p>}
  </section>)}{message && <p role="status">{message}</p>}</>;
}
