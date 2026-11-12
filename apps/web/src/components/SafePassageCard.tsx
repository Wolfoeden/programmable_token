import { useEffect, useState } from "react";
import { deathZoneAt } from "@flightradar/core/deathzones";
import { api } from "../api";
import { ada } from "../format";
import { useNow, usePoll } from "../hooks";
import { errorText } from "../i18n";
import type { AircraftDto, SafeMarketDto, SafeQuote } from "../types";
import { signBuilt, signAndSubmit, type AppWallet } from "../wallet";

const gross = (n: string) => `${(Number(n) / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 6 })} ADA`;
function parseStake(text: string): bigint | null {
  const s = text.trim().replace(",", ".");
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return null;
  const [whole, part = ""] = s.split("."); return BigInt(whole!) * 1_000_000n + BigInt(part.padEnd(6, "0"));
}

export function SafePassageCard(p: { hex: string; aircraft?: AircraftDto; wallet: AppWallet | null; operator: string | null; onConnect: () => void }) {
  const poll = usePoll(() => api.safeFlight(p.hex), 8000, [p.hex]);
  const [outcome, setOutcome] = useState<0 | 1>(0);
  const [stakeText, setStake] = useState("1");
  const [quote, setQuote] = useState<SafeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const now = useNow(1000);
  const m = poll.data?.market;
  useEffect(() => { setQuote(null); }, [p.hex, p.wallet?.id, outcome, stakeText, m?.phase]);
  const inZone = p.aircraft && deathZoneAt(p.aircraft.lon, p.aircraft.lat);
  if (!m && !inZone) return null;
  if (!poll.data) return <div className="pool-note">{poll.error ? "Safe-Passage-Daten nicht erreichbar." : "Safe Passage wird geladen …"}</div>;
  if (!poll.data.enabled) return p.operator ? <div className="pool-note">Safe Passage ist deaktiviert. Aktivierung über SAFE_PASSAGE_ENABLED.</div> : null;
  const stake = parseStake(stakeText);
  const limit = m ? BigInt(m.limits[outcome]) : 0n;
  const available = !!m && m.phase === "open" && !!stake && stake >= BigInt(m.minStake) && stake <= limit && !poll.error;
  async function review() {
    if (!p.wallet) return p.onConnect();
    if (!m || !available || !stake) return;
    setBusy(true); setMessage(null); setQuote(null);
    try { setQuote(await api.safeQuote(await p.wallet.payload(), m.id, outcome, stake.toString())); }
    catch (e) { setMessage(errorText(e)); poll.reload(); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!p.wallet || !quote || quote.marketId !== m?.id || m.phase !== "open" || now >= quote.expiresAt) return;
    setBusy(true); setMessage(null);
    try { const hash = await signBuilt(p.wallet, quote.tx); setQuote(null); setMessage(`Wette gesendet. Bestätigung abwarten. ${hash.slice(0, 12)}…`); poll.reload(); }
    catch (e) { setQuote(null); setMessage(errorText(e)); }
    finally { setBusy(false); }
  }
  async function fund() {
    if (!p.operator || !window.confirm(`${gross(poll.data?.reservePerMarket ?? "0")} aus dem Betreiberwallet als Deckung sperren? Netzwerkgebühren kommen hinzu.`)) return;
    setBusy(true); setMessage(null);
    try { await api.safeFund(p.operator, p.hex); setMessage("Deckung gesendet. Auf Blockchain-Bestätigung warten."); poll.reload(); }
    catch (e) { setMessage(errorText(e)); }
    finally { setBusy(false); }
  }
  return <section className="market safe-passage" aria-label="Safe Passage">
    <div className="market-head"><span className="badge">SAFE PASSAGE · {m?.zone ?? inZone}</span><h3>Kommt dieser Flug sicher durch die rote Zone?</h3></div>
    <p className="pool-note">Ohne Zeitlimit. Landung und Umkehr zählen als JA. NEIN gilt nur bei verifiziertem Absturz oder Abschuss innerhalb einer roten Zone.</p>
    {!m ? <div className="closed-box"><p>Noch kein gedeckter Markt für diesen Flug.</p>{p.operator && <button className="btn primary" disabled={busy} onClick={fund}>Markt mit {gross(poll.data.reservePerMarket ?? "0")} decken</button>}</div> : <>
      <div className="safe-choices">
        <button type="button" className={`safe-choice yes${outcome === 0 ? " chosen" : ""}`} aria-pressed={outcome === 0} disabled={m.phase !== "open" || busy} onClick={() => setOutcome(0)}>JA<strong>1,0001×</strong></button>
        <button type="button" className={`safe-choice no${outcome === 1 ? " chosen" : ""}`} aria-pressed={outcome === 1} disabled={m.phase !== "open" || busy} onClick={() => setOutcome(1)}>NEIN<strong>1.000×</strong></button>
      </div>
      {m.phase === "open" ? <>
        <label className="safe-stake">Einsatz in ADA<input aria-label="Safe Passage Einsatz in ADA" inputMode="decimal" value={stakeText} disabled={busy} onChange={e => setStake(e.target.value)} /></label>
        <div className="pool-note">Gedecktes Einsatzlimit für {outcome === 0 ? "JA" : "NEIN"}: {gross(m.limits[outcome])}. Mindestens {gross(m.minStake)}.</div>
        {poll.error && <p role="alert">Daten nicht aktuell. Wetten vorübergehend gesperrt.</p>}
        {quote && quote.marketId === m.id ? <div className="safe-review">
          <div>Feste Gesamt-Auszahlung bei Gewinn: <strong>{gross(quote.payout)}</strong></div>
          <div>Einsatz: {gross(quote.stake)} · Netzwerkgebühr jetzt: {gross(quote.fee)}</div>
          <p className="pool-note">Auszahlung enthält den Einsatz. Die spätere Abholung kostet zusätzlich eine Netzwerkgebühr. Bei JA können Gebühren den Gewinn übersteigen.</p>
          <button className="btn primary" disabled={busy || now >= quote.expiresAt} onClick={confirm}>{now >= quote.expiresAt ? "Angebot abgelaufen – neu prüfen" : "Wette im Wallet bestätigen"}</button>
          <button className="btn flat small" disabled={busy} onClick={() => setQuote(null)}>Zurück</button>
        </div> : <button className="btn primary" disabled={busy || (!!p.wallet && !available)} onClick={review}>{busy ? "Wird geprüft …" : p.wallet ? "Wette prüfen" : "Wallet verbinden"}</button>}
      </> : <div className="closed-box" role="status">{m.recoveryHold ? "NEUSTART-PRÜFUNG · Offener Markt bis zur Betreiberprüfung gesperrt." : m.phase === "frozen" ? "EINGEFROREN · Verdachtsfall in Prüfung. Wetten und Auszahlungen sind gesperrt." : m.phase === "updating" ? "Blockchain-Bestätigung ausstehend. Wetten sind gesperrt." : m.winner === null ? "Annulliert – Einsätze können im Portfolio abgeholt werden." : `Verifiziert: ${m.winner === 0 ? "JA" : "NEIN"}. Auszahlung im Portfolio abholen.`}</div>}
      {m.evidenceHash && !m.evidence && <p className="pool-note">Belege aktuell nicht abrufbar. Der bestätigte Marktstatus bleibt auf der Blockchain erhalten.</p>}
      {m.evidence && <details><summary>Verifikation und Belege</summary><p>{m.evidence.reason}</p>{m.evidence.sources.map(s => <p key={s}><a href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a></p>)}<small>Beleg-Hash: {m.evidenceHash}</small></details>}
      {p.operator && m.phase !== "resolved" && <SafeOperator market={m} token={p.operator} reload={poll.reload} />}
    </>}
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
      setMessage("Gesendet. Blockchain-Bestätigung abwarten."); p.reload();
    } catch (e) { setMessage(errorText(e)); }
    finally { setBusy(false); }
  }
  return <details className="safe-admin"><summary>Betreiber: Verdacht und Verifikation</summary>
    {p.market.recoveryHold && <div className="closed-box"><p>Nach Verlust des lokalen Caches muss ein Betreiber den offenen Markt prüfen. Freigabe nur, wenn kein ungeklärter Verdacht besteht.</p><label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> Markt und mögliche Verdachtsmeldungen nach dem Neustart geprüft.</label><button type="button" className="btn small" disabled={busy || !reviewed || reason.trim().length < 10} onClick={async () => {
      setBusy(true); setMessage(""); try { await api.safeResume(p.token, p.market.id, reason); setMessage("Neustart-Prüfung bestätigt."); p.reload(); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
    }}>Nach Neustart freigeben</button></div>}
    <p className="pool-note">Begründung und Quellen werden bei bestätigtem Freeze oder Abschluss öffentlich auf der Blockchain gespeichert.</p>
    <label>Begründung<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    <label>HTTPS-Quellen, eine pro Zeile<textarea value={sources} onChange={e => setSources(e.target.value)} /></label>
    {p.market.chainState === "frozen" && <>
      <label>Verifiziertes Ergebnis<select value={winner} onChange={e => setWinner(e.target.value)}><option value="0">JA – erfolgreich, gelandet oder umgekehrt</option><option value="1">NEIN – bestätigter Absturz / Abschuss in roter Zone</option><option value="refund">Ungeklärt – Einsätze erstatten</option></select></label>
      {winner === "1" && <><label>Vorfallszeitpunkt (lokale Zeit)<input type="datetime-local" value={incidentAt} onChange={e => setAt(e.target.value)} /></label><label>Land des Vorfalls<select value={zone} onChange={e => setZone(e.target.value)}>{["LBN", "SYR", "IRQ", "YEM", "IRN", "AFG"].map(c => <option key={c}>{c}</option>)}</select></label><label><input type="checkbox" checked={independent} onChange={e => setIndependent(e.target.checked)} /> Zwei unabhängige Quellen geprüft; Identität, Zeitpunkt und Ort des Vorfalls bestätigt.</label></>}
      <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> Belege persönlich geprüft. Die Abrechnung ist endgültig.</label>
    </>}
    <button className="btn small" disabled={busy || p.market.phase === "updating" || reason.trim().length < 10 || (p.market.chainState === "frozen" && (!reviewed || (winner === "1" && !independent)))} onClick={act}>{p.market.chainState === "open" ? "Bei Verdacht einfrieren" : "Verifiziert abrechnen"}</button>
    {message && <p role="status">{message}</p>}
  </details>;
}

export function SafePassagePositions(p: { wallet: AppWallet }) {
  const poll = usePoll(async () => api.safePortfolio(await p.wallet.payload()), 10000, [p.wallet.id]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  async function claim(id: string) {
    setBusy(true); setMessage("");
    try { await signAndSubmit(p.wallet, w => api.safeClaim(w, id)); setMessage("Abholung gesendet. Bestätigung abwarten."); poll.reload(); }
    catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  return <>{poll.error && <p className="pool-note">Safe-Passage-Positionen nicht erreichbar. Erneuter Abruf folgt.</p>}{poll.data?.positions.map(pos => <section className="market safe-passage" key={pos.market.id}>
    <h3>Safe Passage · {pos.market.hex.toUpperCase()} · {pos.market.zone}</h3>
    <p>JA: {ada(pos.yes)} · NEIN: {ada(pos.no)}</p>
    {pos.market.phase === "resolved" ? <button className="btn primary small" disabled={busy || !!poll.error} onClick={() => claim(pos.market.id)}>{BigInt(pos.claimable) > 0n ? `${gross(pos.claimable)} abholen` : "Verlorene Tickets entfernen"}</button> : <p className="pool-note">{pos.market.phase === "frozen" ? "Eingefroren – Verifikation ausstehend." : pos.market.phase === "updating" ? "Blockchain-Bestätigung ausstehend." : "Ausgang noch offen. Feste Quoten: JA 1,0001× / NEIN 1.000×."}</p>}
    {pos.market.claimDeadline && <p className="pool-note">Abholfrist: {new Date(pos.market.claimDeadline).toLocaleString()}</p>}
  </section>)}{message && <p role="status">{message}</p>}</>;
}
