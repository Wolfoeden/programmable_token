import { useRef, useState } from "react";
import { estimateEta } from "@flightradar/core/eta";
import { distanceKm } from "@flightradar/core/geo";
import { webcamFor } from "@flightradar/core/webcams";
import { ago, bothZones, feet, fpm, knots } from "../format";
import { useNow } from "../hooks";
import { t } from "../i18n";
import type { AircraftDetail, AircraftDto, MarketDto } from "../types";
import { LegalLinks } from "./InfoPages";
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
  onStartRace: () => void;
  onClose: () => void;
}

export function AircraftPanel(p: AircraftPanelProps) {
  const now = useNow(5000);
  const [collapsed, setCollapsed] = useState(false);
  const marketsRef = useRef<HTMLDivElement>(null);
  // Use the detail only if it belongs to this aircraft (it loads asynchronously).
  const detail = p.detail?.aircraft.hex === p.hex ? p.detail : null;
  const a = p.live ?? detail?.aircraft;
  const route = detail?.route ?? null;
  const origin = detail?.origin ?? null;
  const dest = detail?.destination ?? null;
  const destIcao = a?.airport ?? route?.destination;
  // Same estimate as the flight list when the server has it.
  const etaMs = a?.etaMs ?? (a && dest ? estimateEta(a, dest, Date.now())?.etaMs : undefined);
  const sigmaMin = a?.etaSigmaMs ? Math.round(a.etaSigmaMs / 60000) : undefined;
  const zones = etaMs ? bothZones(etaMs) : null;
  const progress = a && origin && dest ? Math.min(1, Math.max(0, 1 - distanceKm(a, dest) / Math.max(1, distanceKm(origin, dest)))) : null;
  const landingMarket = p.markets.find((m) => m.kind === "landing_before" && (m.phase === "open" || m.phase === "creating"));
  const sorted = [...p.markets].sort((x, y) => (x.phase === "open" ? -1 : 0) - (y.phase === "open" ? -1 : 0));
  const hasCam = !!webcamFor(destIcao);

  const openPrediction = async () => {
    if (!landingMarket) await p.onCreate({ kind: "landing_before", hex: p.hex });
    setCollapsed(false);
    setTimeout(() => marketsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  return (
    <aside className={`panel${collapsed ? " collapsed" : ""}`} aria-label="Flight details">
      <div className="panel-head">
        <div>
          <h2>{a?.flightNumber || route?.flightNumber || a?.callsign || p.hex.toUpperCase()}</h2>
          <div className="sub">
            {[a?.callsign, route?.airline, a?.registration, a?.type].filter(Boolean).join(" · ") || t.unknownRoute}
          </div>
        </div>
        <button type="button" className="icon-btn collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand details" : "Collapse details"}>
          {collapsed ? "▴" : "▾"}
        </button>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t.close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {(route || destIcao) && (
          <div className="route">
            <div>
              <div className="code">{origin?.iata || route?.origin || a?.origin || "–"}</div>
              <div className="name">{origin?.city || origin?.name || "Origin"}</div>
            </div>
            <div className="muted">✈</div>
            <div className="end">
              <div className="code">{dest?.iata || destIcao}</div>
              <div className="name">{dest?.name || dest?.city || "Destination"}</div>
            </div>
            {progress !== null && (
              <div className="progress" aria-hidden>
                <div style={{ width: `${progress * 100}%` }} />
              </div>
            )}
          </div>
        )}

        <div className="arrival">
          <div className="k">Expected arrival at {dest?.iata || destIcao || "destination"}</div>
          {zones ? (
            <div className="v num">
              {zones.utc}
              {sigmaMin !== undefined ? ` ± ${sigmaMin} min` : ""} <span className="muted">· your time {zones.local}</span>
            </div>
          ) : (
            <div className="v muted">No estimate available</div>
          )}
          <div className="k">Estimate from position and speed, not an airline timetable.</div>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="k">{t.altitude}</div>
            <div className="v num">{a?.onGround ? t.onGround : feet(a?.altitudeFt)}</div>
          </div>
          <div className="stat">
            <div className="k">{t.speed}</div>
            <div className="v num">{knots(a?.groundSpeedKt)}</div>
          </div>
          <div className="stat">
            <div className="k">{t.vertical}</div>
            <div className="v num">{fpm(a?.verticalRateFpm)}</div>
          </div>
          <div className="stat">
            <div className="k">Position</div>
            <div className="v num">{a ? ago(a.timestamp, now) : "–"}</div>
          </div>
        </div>
        <div className="pool-note num">
          {a ? `Last position report ${new Date(a.timestamp).toISOString().slice(11, 19)} UTC` : ""}
          {p.dataUpdatedAt ? ` · flight list updated ${ago(p.dataUpdatedAt, now)}` : ""}
        </div>

        {hasCam && destIcao && <LiveStream icao={destIcao} />}

        <button type="button" className="btn primary" disabled={p.busy || !a?.airport} onClick={openPrediction}>
          {landingMarket ? "Open demo prediction" : "Create demo prediction for this flight"}
        </button>
        {!a?.airport && <div className="pool-note">Predictions are only offered while this flight is in the list of flights landing soon.</div>}

        <div className="section-title" ref={marketsRef}>
          {t.markets}
        </div>
        {sorted.length === 0 && <div className="muted">{t.noMarkets}</div>}
        {sorted.map((m) => (
          <MarketCard key={m.id} market={m} busy={p.busy} highlight={m.id === landingMarket?.id} onPrepare={p.onPrepare} onConfirm={p.onConfirm} />
        ))}
        <div className="actions">
          {p.scheduleAvailable && (
            <button type="button" className="btn flat" disabled={p.busy || !a?.airport} onClick={() => p.onCreate({ kind: "delay", hex: p.hex, minutes: 15 })}>
              {t.openDelay}
            </button>
          )}
          <button type="button" className="btn flat" disabled={!a?.airport} onClick={p.onStartRace}>
            {t.startRace}
          </button>
        </div>
        <LegalLinks className="legal-links panel-legal" />
      </div>
    </aside>
  );
}
