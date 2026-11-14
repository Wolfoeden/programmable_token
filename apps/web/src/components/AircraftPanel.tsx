import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { CLOSE_LEAD_MIN, estimateEta } from "@flightradar/core/eta";
import { distanceKm } from "@flightradar/core/geo";
import { webcamFor } from "@flightradar/core/webcams";
import { airportByIcao } from "@flightradar/core/airports";
import { useNow } from "../hooks";
import { t } from "../i18n";
import type { AircraftDetail, AircraftDto, MarketDto } from "../types";
import { LiveStream } from "./LiveStream";
import { MarketCard, type MarketCardProps } from "./MarketCard";
import { RulesPanel } from "./RulesPanel";

export interface AircraftPanelProps {
  hex: string;
  live: AircraftDto | undefined;
  detail: AircraftDetail | null;
  markets: MarketDto[];
  scheduleAvailable: boolean;
  busy: boolean;
  dataUpdatedAt: number | null;
  onPrepare: MarketCardProps["onPrepare"];
  onConfirm: MarketCardProps["onConfirm"];
  onCreate: (body: unknown) => Promise<unknown>;
  onVoid?: MarketCardProps["onVoid"];
  /** Set when the flight has left the list: what happened since. */
  arrivalNote?: string | null;
  onClose: () => void;
  /** Position in the list of flights landing soon, and switching. */
  position?: { index: number; count: number } | null;
  onStep?: (dir: -1 | 1) => void;
  /** The soonest other flight that still takes predictions. */
  nextOpen?: AircraftDto | null;
  onSelectFlight?: (a: AircraftDto) => void;
  /** The connected wallet's stakes: market id → outcome → lovelace. */
  mine?: Map<string, Map<number, bigint>>;
}

type Sheet = "min" | "peek" | "full";

/** A flight: where from, where to, the airport's stream and its prediction. */
export function AircraftPanel(p: AircraftPanelProps) {
  const now = useNow(5000);
  // Mobile bottom sheet: head only, head + prediction (default), or full height.
  const [sheet, setSheet] = useState<Sheet>("peek");
  const drag = useRef<{ y: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { y: e.clientY };
    // Keep receiving the pointer when the finger leaves the head while dragging.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (Math.abs(dy) < 8) setSheet((s) => (s === "full" ? "peek" : "full")); // tap
    else if (dy < -30) setSheet((s) => (s === "min" ? "peek" : "full"));
    else if (dy > 30) setSheet((s) => (s === "full" ? "peek" : "min"));
  };
  // Use the detail only if it belongs to this aircraft (it loads asynchronously).
  const detail = p.detail?.aircraft.hex === p.hex ? p.detail : null;
  // Never show the live data of a previously selected aircraft.
  const a = p.live?.hex === p.hex ? p.live : detail?.aircraft;
  const route = detail?.route ?? null;
  const origin = detail?.origin ?? airportByIcao(route?.origin ?? a?.origin) ?? null;
  const dest = detail?.destination ?? airportByIcao(route?.destination ?? a?.airport) ?? null;
  const destIcao = a?.airport ?? route?.destination;
  const etaMs = a?.etaMs ?? (a && dest ? estimateEta(a, dest, Date.now())?.etaMs : undefined);
  const progress = a && origin && dest ? Math.min(1, Math.max(0, 1 - distanceKm(a, dest) / Math.max(1, distanceKm(origin, dest)))) : null;
  const landingMarket = p.markets.find((m) => m.kind === "landing_before" && (m.phase === "open" || m.phase === "creating"));
  const sorted = [...p.markets].sort((x, y) => (x.phase === "open" ? -1 : 0) - (y.phase === "open" ? -1 : 0));
  const hasCam = !!webcamFor(destIcao);
  // A new market needs its close (ETA − 20 min) at least 5 minutes ahead.
  const tooClose = !!etaMs && etaMs - now < (CLOSE_LEAD_MIN + 5) * 60_000;
  const unconfirmed = a?.confirmed === false;

  // No market yet: show the one a first bet would create (Yes/No right away).
  const [preview, setPreview] = useState<MarketDto | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // While the user works with the preview card (stake, confirmation), keep it
  // even when the market it created shows up in the list.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => setEngaged(false), [p.hex]);
  const wantPreview = (!landingMarket || engaged) && !!a?.airport && !tooClose;
  useEffect(() => {
    if (!wantPreview) {
      setPreview(null);
      return;
    }
    let alive = true;
    const load = () => {
      setPreviewLoading(true);
      api
        .preview(p.hex)
        .then((r) => alive && setPreview(r.market))
        .catch(() => alive && setPreview(null))
        .finally(() => alive && setPreviewLoading(false));
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [p.hex, wantPreview]);
  const showPreview = !!preview && (engaged || !landingMarket);

  return (
    <aside className={`panel simple sheet-${sheet}`} aria-label="Flight">
      <div className="panel-head" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (drag.current = null)}>
        <span className="sheet-handle" aria-hidden />
        {p.onStep && (
          <button type="button" className="icon-btn step-btn" onClick={() => p.onStep!(-1)} disabled={!p.position || p.position.count < 2} aria-label="Previous flight">
            ‹
          </button>
        )}
        <div className="panel-title">
          {p.position && p.position.index >= 0 && (
            <div className="eyebrow num">
              Flight {p.position.index + 1} of {p.position.count}
            </div>
          )}
          <h2>{a?.flightNumber || route?.flightNumber || a?.callsign || p.hex.toUpperCase()}</h2>
          <div className="sub">{[route?.airline, a?.registration].filter(Boolean).join(" · ")}</div>
        </div>
        {p.onStep && (
          <button type="button" className="icon-btn step-btn" onClick={() => p.onStep!(1)} disabled={!p.position || p.position.count === 0 || (p.position.count === 1 && p.position.index === 0)} aria-label="Next flight">
            ›
          </button>
        )}
        <button
          type="button"
          className="icon-btn collapse-btn"
          onClick={() => setSheet((s) => (s === "min" ? "peek" : s === "peek" ? "full" : "min"))}
          aria-label={sheet === "full" ? "Minimise" : "Show more"}
        >
          {sheet === "full" ? "▾" : "▴"}
        </button>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t.close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        <div className="route2">
          <div className="route2-codes">
            <span className="code">{origin?.iata || route?.origin || a?.origin || "–"}</span>
            <span className="route2-line" aria-hidden>
              <span className="route2-dot" />
              <span className="route2-done" style={{ width: `${(progress ?? 0) * 100}%` }} />
              <span className="route2-plane" style={{ left: `${(progress ?? 0) * 100}%` }}>
                ✈
              </span>
            </span>
            <span className="code">{dest?.iata || destIcao || "–"}</span>
          </div>
          <div className="route2-names">
            <span>{origin?.city || origin?.name || "Origin"}</span>
            <span>{dest?.city || dest?.name || "Destination"}</span>
          </div>
        </div>

        {unconfirmed && (
          <div className="info-note">
            <span className="info-icon" aria-hidden>
              i
            </span>
            <span>Destination unconfirmed. If it lands elsewhere, the market is void and stakes are refunded.</span>
          </div>
        )}

        {p.arrivalNote && (
          <div className="watch-state held" role="status">
            {p.arrivalNote}
          </div>
        )}

        {sorted.filter((m) => !(showPreview && m.kind === "landing_before")).map((m) => (
          <MarketCard
            key={m.id}
            market={m}
            busy={p.busy}
            simple
            onPrepare={p.onPrepare}
            onConfirm={p.onConfirm}
            onEngage={() => setSheet("full")}
            mine={p.mine?.get(m.id) ?? null}
            {...(p.onVoid ? { onVoid: p.onVoid } : {})}
          />
        ))}
        {showPreview && preview ? (
          <MarketCard
            market={preview}
            busy={p.busy}
            simple
            onPrepare={p.onPrepare}
            onConfirm={async (bet) => {
              const ok = await p.onConfirm(bet);
              if (ok) setEngaged(false);
              return ok;
            }}
            onEngage={() => {
              setEngaged(true);
              setSheet("full");
            }}
          />
        ) : null}
        {!landingMarket && !showPreview &&
          (a?.airport && !tooClose && previewLoading ? (
            <div className="pool-note">Loading the prediction …</div>
          ) : sorted.length === 0 ? (
            <div className="closed-box">
              <div>{a?.airport ? "Betting is closed" : "No prediction for this flight."}</div>
              {p.nextOpen && p.onSelectFlight && (
                <button type="button" className="btn primary" onClick={() => p.onSelectFlight!(p.nextOpen!)}>
                  Bet on {p.nextOpen.flightNumber || p.nextOpen.callsign} → {p.nextOpen.airport}
                </button>
              )}
            </div>
          ) : null)}

        {(showPreview ? preview : (landingMarket ?? sorted[0])) && <RulesPanel m={(showPreview ? preview : (landingMarket ?? sorted[0]))!} />}

        {hasCam && destIcao && <LiveStream icao={destIcao} />}

        {p.scheduleAvailable && (
          <button type="button" className="btn flat" disabled={p.busy || !a?.airport} onClick={() => p.onCreate({ kind: "delay", hex: p.hex, minutes: 15 })}>
            {t.openDelay}
          </button>
        )}
      </div>
    </aside>
  );
}
