import { useState } from "react";
import { CLOSE_LEAD_MIN, estimateEta } from "@flightradar/core/eta";
import { distanceKm } from "@flightradar/core/geo";
import { webcamFor } from "@flightradar/core/webcams";
import { useNow } from "../hooks";
import { t } from "../i18n";
import type { AircraftDetail, AircraftDto, MarketDto } from "../types";
import { LiveStream } from "./LiveStream";
import { MarketCard, type MarketCardProps } from "./MarketCard";

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
  /** Set when the flight has left the list: what happened since. */
  arrivalNote?: string | null;
  onClose: () => void;
  /** Position in the list of flights landing soon, and switching. */
  position?: { index: number; count: number } | null;
  onStep?: (dir: -1 | 1) => void;
}

/** A flight: where from, where to, the airport's stream and its prediction. */
export function AircraftPanel(p: AircraftPanelProps) {
  const now = useNow(5000);
  const [collapsed, setCollapsed] = useState(false);
  // Use the detail only if it belongs to this aircraft (it loads asynchronously).
  const detail = p.detail?.aircraft.hex === p.hex ? p.detail : null;
  const a = p.live ?? detail?.aircraft;
  const route = detail?.route ?? null;
  const origin = detail?.origin ?? null;
  const dest = detail?.destination ?? null;
  const destIcao = a?.airport ?? route?.destination;
  const etaMs = a?.etaMs ?? (a && dest ? estimateEta(a, dest, Date.now())?.etaMs : undefined);
  const progress = a && origin && dest ? Math.min(1, Math.max(0, 1 - distanceKm(a, dest) / Math.max(1, distanceKm(origin, dest)))) : null;
  const landingMarket = p.markets.find((m) => m.kind === "landing_before" && (m.phase === "open" || m.phase === "creating"));
  const sorted = [...p.markets].sort((x, y) => (x.phase === "open" ? -1 : 0) - (y.phase === "open" ? -1 : 0));
  const hasCam = !!webcamFor(destIcao);
  // A new market needs its close (ETA − 20 min) at least 5 minutes ahead.
  const tooClose = !!etaMs && etaMs - now < (CLOSE_LEAD_MIN + 5) * 60_000;

  return (
    <aside className={`panel simple${collapsed ? " collapsed" : ""}`} aria-label="Flight">
      <div className="panel-head">
        {p.onStep && (
          <button type="button" className="icon-btn step-btn" onClick={() => p.onStep!(-1)} disabled={!p.position || p.position.count < 2} aria-label="Previous flight">
            ‹
          </button>
        )}
        <div className="panel-title">
          <h2>{a?.flightNumber || route?.flightNumber || a?.callsign || p.hex.toUpperCase()}</h2>
          <div className="sub num">
            {[p.position && p.position.index >= 0 ? `Flight ${p.position.index + 1} of ${p.position.count}` : null, route?.airline].filter(Boolean).join(" · ")}
          </div>
        </div>
        {p.onStep && (
          <button type="button" className="icon-btn step-btn" onClick={() => p.onStep!(1)} disabled={!p.position || p.position.count === 0 || (p.position.count === 1 && p.position.index === 0)} aria-label="Next flight">
            ›
          </button>
        )}
        <button type="button" className="icon-btn collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? "▴" : "▾"}
        </button>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t.close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        <div className="route">
          <div>
            <div className="code">{origin?.iata || route?.origin || a?.origin || "–"}</div>
            <div className="name">{origin?.city || origin?.name || "Origin"}</div>
          </div>
          <div className="muted">✈</div>
          <div className="end">
            <div className="code">{dest?.iata || destIcao || "–"}</div>
            <div className="name">{dest?.city || dest?.name || "Destination"}</div>
          </div>
          {progress !== null && (
            <div className="progress" aria-hidden>
              <div style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>

        {p.arrivalNote && (
          <div className="watch-state held" role="status">
            {p.arrivalNote}
          </div>
        )}

        {sorted.map((m) => (
          <MarketCard key={m.id} market={m} busy={p.busy} simple onPrepare={p.onPrepare} onConfirm={p.onConfirm} />
        ))}
        {!landingMarket &&
          (a?.airport && !tooClose ? (
            <button type="button" className="btn primary" disabled={p.busy} onClick={() => p.onCreate({ kind: "landing_before", hex: p.hex })}>
              Predict this landing
            </button>
          ) : sorted.length === 0 ? (
            <div className="pool-note">
              {a?.airport ? `Predictions close ${CLOSE_LEAD_MIN} minutes before landing; this flight is too close.` : "No prediction for this flight."}
            </div>
          ) : null)}

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
