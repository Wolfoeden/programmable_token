import { estimateEta } from "@flightradar/core/eta";
import { distanceKm } from "@flightradar/core/geo";
import { clock, feet, fpm, knots } from "../format";
import { t } from "../i18n";
import type { AircraftDetail, AircraftDto, MarketDto } from "../types";
import { CamLink } from "./CamLink";
import { MarketCard } from "./MarketCard";

export interface AircraftPanelProps {
  hex: string;
  live: AircraftDto | undefined;
  detail: AircraftDetail | null;
  markets: MarketDto[];
  scheduleAvailable: boolean;
  busy: boolean;
  onBet: (m: MarketDto, outcome: number, stake: bigint) => void;
  onCreate: (body: unknown) => void;
  onStartRace: () => void;
  onClose: () => void;
}

export function AircraftPanel(p: AircraftPanelProps) {
  const a = p.live ?? p.detail?.aircraft;
  const route = p.detail?.route ?? null;
  const origin = p.detail?.origin ?? null;
  const dest = p.detail?.destination ?? null;
  const eta = a && dest ? estimateEta({ ...a, onGround: a.onGround }, dest, Date.now()) : null;
  const progress =
    a && origin && dest ? Math.min(1, Math.max(0, 1 - distanceKm(a, dest) / Math.max(1, distanceKm(origin, dest)))) : null;
  const openLanding = p.markets.some((m) => m.kind === "landing_before" && (m.phase === "open" || m.phase === "creating"));
  const sorted = [...p.markets].sort((x, y) => (x.phase === "open" ? -1 : 0) - (y.phase === "open" ? -1 : 0));

  return (
    <aside className="panel" aria-label="Flight details">
      <div className="panel-head">
        <div>
          <h2>{a?.callsign ?? p.hex.toUpperCase()}</h2>
          <div className="sub">
            {[route?.flightNumber, route?.airline, a?.registration, a?.type].filter(Boolean).join(" · ") || t.unknownRoute}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t.close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {route && (
          <div className="route">
            <div>
              <div className="code">{origin?.iata || route.origin}</div>
              <div className="name">{origin?.city || origin?.name || route.origin}</div>
            </div>
            <div className="muted">✈</div>
            <div className="end">
              <div className="code">{dest?.iata || route.destination}</div>
              <div className="name">{dest?.city || dest?.name || route.destination}</div>
            </div>
            {progress !== null && (
              <div className="progress" aria-hidden>
                <div style={{ width: `${progress * 100}%` }} />
              </div>
            )}
          </div>
        )}
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
            <div className="k">{t.eta}</div>
            <div className="v num">{eta ? `${clock(eta.etaMs)} ±${Math.round(eta.sigmaMs / 60000)}′` : "–"}</div>
          </div>
        </div>

        {a?.phase && a.airport && (
          <>
            <span className={`badge ${a.phase === "landing" ? "yes" : "accent"}`} style={{ alignSelf: "flex-start" }}>
              {a.phase === "landing" ? t.landingAt(a.airport) : t.takeoffFrom(a.airport)}
            </span>
            <CamLink icao={a.airport} />
          </>
        )}

        <div className="section-title">{t.markets}</div>
        {sorted.length === 0 && <div className="muted">{t.noMarkets}</div>}
        {sorted.map((m) => (
          <MarketCard key={m.id} market={m} busy={p.busy} onBet={p.onBet} />
        ))}
        <div className="actions">
          {!openLanding && (
            <button type="button" className="btn flat" disabled={p.busy || !route} onClick={() => p.onCreate({ kind: "landing_before", hex: p.hex })}>
              {t.openLanding}
            </button>
          )}
          {p.scheduleAvailable && (
            <button type="button" className="btn flat" disabled={p.busy || !route} onClick={() => p.onCreate({ kind: "delay", hex: p.hex, minutes: 15 })}>
              {t.openDelay}
            </button>
          )}
          <button type="button" className="btn flat" disabled={!route} onClick={p.onStartRace}>
            {t.startRace}
          </button>
        </div>
      </div>
    </aside>
  );
}
