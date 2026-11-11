import { useEffect, useMemo, useState } from "react";
import { webcamAirports } from "@flightradar/core/webcams";
import { distanceKm } from "@flightradar/core/geo";
import { api } from "../api";
import { flightName, flightState, type FlightState } from "../arrivals";
import { useNow } from "../hooks";
import type { AircraftDto, Arrival, MarketDto, TrackPoint } from "../types";
import { ApproachRadar } from "./ApproachRadar";
import { MarketCard, type MarketCardProps } from "./MarketCard";

export const RACE_COLORS = ["#5aa9ff", "#ff8a3d", "#c084fc", "#3ddc97"];
export const MAX_RACE = 3;

export interface RacePanelProps {
  hexes: string[];
  marketId: string | null;
  flights: AircraftDto[];
  arrivals: Arrival[];
  markets: MarketDto[];
  busy: boolean;
  onChange: (hexes: string[]) => void;
  onCreate: () => void;
  onPrepare: MarketCardProps["onPrepare"];
  onConfirm: MarketCardProps["onConfirm"];
  onClose: () => void;
  /** Recorded paths, for the map. */
  onTracks: (tracks: Record<string, TrackPoint[]>) => void;
}

/** Pairs at the same airport whose arrivals are close: the best races. */
export function suggestRace(flights: AircraftDto[]): AircraftDto[] | null {
  let best: { pair: AircraftDto[]; gap: number } | null = null;
  for (let i = 0; i < flights.length; i++) {
    for (let j = i + 1; j < flights.length; j++) {
      const a = flights[i]!;
      const b = flights[j]!;
      if (a.airport !== b.airport || !a.etaMs || !b.etaMs) continue;
      // The first arrival must be far enough out for the market to open.
      if (Math.min(a.etaMs, b.etaMs) - Date.now() < 12 * 60_000) continue;
      const gap = Math.abs(a.etaMs - b.etaMs);
      if (gap <= 8 * 60_000 && (!best || gap < best.gap)) best = { pair: [a, b], gap };
    }
  }
  return best?.pair ?? null;
}

function rowText(s: FlightState, now: number): string {
  switch (s.kind) {
    case "approaching": {
      const m = s.flight.etaMs ? Math.round((s.flight.etaMs - now) / 60_000) : null;
      return m === null ? "on approach" : m >= 1 ? `≈ ${m} min to go (model)` : "any moment";
    }
    case "final":
      return "short final or go-around, waiting for ground report";
    case "landed":
      return `landed ${new Date(s.arrival.landedAt!).toISOString().slice(11, 19)} UTC`;
    case "lost":
      return "signal lost, landing not confirmed";
    default:
      return "no current data";
  }
}

/**
 * "Who lands first?" as an event: pick two or three arriving flights, see
 * them in their colours on the map and here, predict, follow the approach
 * and get the observed order, then the settled result.
 */
export function RacePanel(p: RacePanelProps) {
  const now = useNow(1000);
  const market = p.marketId ? p.markets.find((m) => m.id === p.marketId) : undefined;
  const picking = !p.marketId;
  const [tracks, setTracks] = useState<Record<string, TrackPoint[]>>({});
  const [lastSeen, setLastSeen] = useState<Record<string, AircraftDto | Arrival>>({});

  const states = p.hexes.map((h) => flightState(h, p.flights, p.arrivals));
  useEffect(() => {
    setLastSeen((prev) => {
      const next = { ...prev };
      states.forEach((s, i) => {
        if (s.kind === "approaching") next[p.hexes[i]!] = s.flight;
        else if (s.kind !== "unknown") next[p.hexes[i]!] = s.arrival;
      });
      return next;
    });
  }, [p.flights, p.arrivals, p.hexes.join(",")]);

  useEffect(() => {
    if (p.hexes.length === 0) return;
    let alive = true;
    const load = () =>
      api
        .tracks(p.hexes)
        .then((r) => {
          if (!alive) return;
          setTracks(r.tracks);
          p.onTracks(r.tracks);
        })
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [p.hexes.join(",")]);

  const toggle = (hex: string) =>
    p.onChange(p.hexes.includes(hex) ? p.hexes.filter((h) => h !== hex) : p.hexes.length >= MAX_RACE ? p.hexes : [...p.hexes, hex]);
  const suggestion = picking ? suggestRace(p.flights) : null;

  // Observed order of touchdowns (data), separate from the settled result (oracle, on chain).
  const landed = states
    .map((s, i) => ({ s, i }))
    .filter((x): x is { s: Extract<FlightState, { kind: "landed" }>; i: number } => x.s.kind === "landed")
    .sort((a, b) => a.s.arrival.landedAt! - b.s.arrival.landedAt!);
  const airports = new Set(p.hexes.map((h) => lastSeen[h]?.airport).filter(Boolean));
  const radarAirport = airports.size === 1 ? webcamAirports().find((a) => a.icao === [...airports][0]) : undefined;
  const winnerHex = market?.phase === "resolved" && market.winner !== null ? market.question.kind === "race" ? market.question.flights[market.winner]?.icao24 : undefined : undefined;
  const start = useMemo(() => {
    const out: Record<string, number> = {};
    for (const h of p.hexes) {
      const first = tracks[h]?.[0];
      const ap = webcamAirports().find((a) => a.icao === lastSeen[h]?.airport);
      if (first && ap) out[h] = distanceKm({ lon: first[0], lat: first[1] }, ap);
    }
    return out;
  }, [tracks, p.hexes.join(","), Object.keys(lastSeen).join(",")]);

  return (
    <aside className="panel race-panel" aria-label="Who lands first?">
      <div className="panel-head">
        <div>
          <h2>Who lands first?</h2>
          <div className="sub">{picking ? `Pick 2 or ${MAX_RACE} arriving flights, here or on the map` : "Race in progress"}</div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Close race">
          ✕
        </button>
      </div>
      <div className="panel-body">
        {p.hexes.length > 0 && (
          <ol className="race-rows">
            {p.hexes.map((h, i) => {
              const f = lastSeen[h];
              const s = states[i]!;
              const ap = webcamAirports().find((a) => a.icao === f?.airport);
              const togo = f && ap ? distanceKm(f, ap) : null;
              const startKm = start[h];
              const pct = s.kind === "landed" ? 1 : togo !== null && startKm ? Math.min(1, Math.max(0, 1 - togo / startKm)) : 0;
              const place = landed.findIndex((x) => x.i === i);
              return (
                <li key={h} className={`race-row ${s.kind}`} style={{ "--c": RACE_COLORS[i] } as React.CSSProperties}>
                  <span className="race-dot" aria-hidden />
                  <div className="race-main">
                    <div>
                      <strong>{f ? flightName(f) : h.toUpperCase()}</strong> <span className="muted">→ {f?.airport ?? "?"}</span>
                      {place >= 0 && <span className="badge">{place === 0 ? "1st down" : `${place + 1}.`}</span>}
                      {winnerHex === h && <span className="badge accent">Winner (settled)</span>}
                    </div>
                    <div className="race-bar" aria-hidden>
                      <div style={{ width: `${pct * 100}%` }} />
                    </div>
                    <div className="pool-note num">
                      {rowText(s, now)}
                      {togo !== null && s.kind === "approaching" ? ` · ${Math.round(togo)} km out` : ""}
                    </div>
                  </div>
                  {picking && (
                    <button type="button" className="icon-btn" onClick={() => toggle(h)} aria-label={`Remove ${f ? flightName(f) : h}`}>
                      ✕
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {picking && (
          <>
            {suggestion && !suggestion.every((f) => p.hexes.includes(f.hex)) && (
              <button type="button" className="btn flat race-suggest" onClick={() => p.onChange(suggestion.map((f) => f.hex))}>
                Close finish: {flightName(suggestion[0]!)} vs {flightName(suggestion[1]!)} at {suggestion[0]!.airport}, estimated{" "}
                {Math.max(1, Math.round(Math.abs(suggestion[0]!.etaMs! - suggestion[1]!.etaMs!) / 60_000))} min apart
              </button>
            )}
            <div className="section-title">Arriving within the hour</div>
            {p.flights.length === 0 && <div className="muted">No flights are landing at a live-stream airport right now.</div>}
            <ul className="race-pick">
              {p.flights.map((f) => {
                const i = p.hexes.indexOf(f.hex);
                return (
                  <li key={f.hex}>
                    <label>
                      <input type="checkbox" checked={i >= 0} disabled={i < 0 && p.hexes.length >= MAX_RACE} onChange={() => toggle(f.hex)} />
                      <span className="race-dot" style={{ background: i >= 0 ? RACE_COLORS[i] : "transparent" }} aria-hidden />
                      <strong>{flightName(f)}</strong> → {f.airport}
                      <span className="muted num">{f.etaMs ? ` · ≈ ${Math.max(0, Math.round((f.etaMs - now) / 60_000))} min` : ""}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="btn primary" disabled={p.hexes.length < 2 || p.busy} onClick={p.onCreate}>
              Start the race (demo prediction)
            </button>
            <div className="pool-note">
              The first flight must still be at least about 10 minutes out, because predictions close before the first estimated landing.
            </div>
          </>
        )}

        {!picking && radarAirport && (
          <ApproachRadar
            airport={radarAirport}
            items={p.hexes.flatMap((h, i) => {
              const f = lastSeen[h];
              if (!f) return [];
              const live = states[i]!.kind === "approaching" ? (f as AircraftDto) : null;
              return [
                {
                  hex: h,
                  label: flightName(f),
                  color: RACE_COLORS[i]!,
                  lat: f.lat,
                  lon: f.lon,
                  ...(live?.trackDeg !== undefined ? { trackDeg: live.trackDeg } : {}),
                  trail: tracks[h] ?? [],
                  stale: !live,
                },
              ];
            })}
          />
        )}
        {!picking && !radarAirport && <div className="pool-note">The flights land at different airports: follow the coloured paths on the map.</div>}

        {!picking && (
          <div className="race-result" role="status">
            <div className="k">Observed (ADS-B)</div>
            <div>
              {landed.length === 0
                ? "No touchdown reported yet."
                : `${flightName(lastSeen[p.hexes[landed[0]!.i]!]!)} touched down first, at ${new Date(landed[0]!.s.arrival.landedAt!).toISOString().slice(11, 19)} UTC (first ground report).`}
            </div>
            <div className="k">Settled result</div>
            <div>
              {!market
                ? "Waiting for the market to be created …"
                : market.phase === "resolved"
                  ? `Settled by the oracle: ${market.labels.en[market.winner ?? 0] ?? "?"}. ${market.resolution?.reason ?? ""}`
                  : market.phase === "void"
                    ? "Void: all stakes are refunded 1:1."
                    : "Not settled yet. The oracle decides from its own ADS-B observations; this can differ from the observed line above."}
            </div>
          </div>
        )}

        {market && <MarketCard market={market} highlight busy={p.busy} onPrepare={p.onPrepare} onConfirm={p.onConfirm} />}
      </div>
    </aside>
  );
}
