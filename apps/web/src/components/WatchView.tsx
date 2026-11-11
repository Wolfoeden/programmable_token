import { useEffect, useMemo, useState } from "react";
import { webcamAirports, webcamFor } from "@flightradar/core/webcams";
import { distanceKm } from "@flightradar/core/geo";
import { api } from "../api";
import { ended, flightName, flightState, stateText } from "../arrivals";
import { bothZones, feet, knots } from "../format";
import { useNow } from "../hooks";
import type { AircraftDto, Arrival, DataStatus, TrackPoint } from "../types";
import { ApproachRadar } from "./ApproachRadar";
import { LiveStream } from "./LiveStream";

export interface WatchViewProps {
  hex: string | null;
  flights: AircraftDto[];
  arrivals: Arrival[];
  status: DataStatus;
  onWatch: (hex: string) => void;
  onPredict: (hex: string) => void;
  onClose: () => void;
}

/** Next flight worth watching: the soonest arrival other than `except`. */
export function nextApproach(flights: AircraftDto[], except?: string | null): AircraftDto | undefined {
  return flights.find((f) => f.hex !== except);
}

function shownAirport(flights: AircraftDto[], except: string | null, icao: string | undefined): AircraftDto | undefined {
  return icao ? flights.find((f) => f.hex !== except && f.airport === icao) : undefined;
}

/**
 * "Now landing": the destination's live stream large, next to a small
 * approach map and the flight's numbers. Stays on the flight until the
 * landing is confirmed by data (or the signal is lost) or the viewer
 * switches; it then offers the next approach instead of jumping there.
 */
export function WatchView(p: WatchViewProps) {
  const now = useNow(1000);
  const state = p.hex ? flightState(p.hex, p.flights, p.arrivals) : { kind: "unknown" as const };
  // Keep the last known flight data so the view does not go blank on landing.
  const [last, setLast] = useState<AircraftDto | Arrival | null>(null);
  const cur = state.kind === "approaching" ? state.flight : state.kind === "unknown" ? null : state.arrival;
  useEffect(() => {
    if (cur) setLast(cur);
  }, [cur?.hex, cur && "timestamp" in cur ? cur.timestamp : cur?.lastSeenAt]);
  const shown = cur ?? (last?.hex === p.hex ? last : null);
  const icao = shown?.airport;
  const airport = useMemo(() => webcamAirports().find((a) => a.icao === icao), [icao]);
  const cam = webcamFor(icao);

  const [trail, setTrail] = useState<TrackPoint[]>([]);
  useEffect(() => {
    setTrail([]);
    if (!p.hex) return;
    let alive = true;
    const load = () =>
      api
        .tracks([p.hex!])
        .then((r) => alive && setTrail(r.tracks[p.hex!] ?? []))
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [p.hex]);

  const idx = p.flights.findIndex((f) => f.hex === p.hex);
  const step = (d: number) => {
    if (p.flights.length === 0) return;
    const i = idx < 0 ? (d > 0 ? 0 : p.flights.length - 1) : (idx + d + p.flights.length) % p.flights.length;
    p.onWatch(p.flights[i]!.hex);
  };
  const next = nextApproach(p.flights, p.hex);
  const nextHere = shownAirport(p.flights, p.hex, cur?.airport ?? last?.airport);
  const done = ended(state);
  const live = state.kind === "approaching" ? state.flight : null;
  const eta = live?.etaMs;

  return (
    <div className="watch" role="dialog" aria-modal="true" aria-label="Now landing">
      <div className="watch-head">
        <div>
          <span className="badge accent">Now landing</span>{" "}
          <span className="num">{p.flights.length > 0 ? (idx >= 0 ? `Approach ${idx + 1} of ${p.flights.length}` : `${p.flights.length} approaches in the next hour`) : ""}</span>
        </div>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={p.flights.length === 0 || (p.flights.length === 1 && idx === 0)} aria-label="Previous approach">
          ‹
        </button>
        <button type="button" className="icon-btn" onClick={() => step(1)} disabled={p.flights.length === 0 || (p.flights.length === 1 && idx === 0)} aria-label="Next approach">
          ›
        </button>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Close watch mode">
          ✕
        </button>
      </div>

      {!shown ? (
        <div className="watch-empty">
          {p.status === "loading"
            ? "Loading flight data …"
            : p.status === "error" || p.status === "unavailable"
              ? "Flight data is not reachable right now. Retrying …"
              : "No short flight is landing at a live-stream airport within the hour. This view picks one up as soon as there is one."}
          {next && (
            <button type="button" className="btn primary" onClick={() => p.onWatch(next.hex)}>
              Watch {flightName(next)} → {next.airport}
            </button>
          )}
        </div>
      ) : (
        <div className="watch-body">
          <div className="watch-stream">{icao && cam ? <LiveStream icao={icao} /> : <div className="stream stream-fallback">No live stream for this airport.</div>}</div>
          <div className="watch-side">
            <div className="watch-title">
              <h2>{flightName(shown)}</h2>
              <div className="sub">
                {[shown.callsign, shown.type, shown.origin ? `${shown.origin} → ${shown.airport}` : `→ ${shown.airport}`].filter(Boolean).join(" · ")}
              </div>
            </div>

            <div className={`watch-state ${state.kind}`} role="status" aria-live="polite">
              {stateText(state, now)}
            </div>

            {live && (
              <div className="stats">
                <div className="stat">
                  <div className="k">Touchdown in</div>
                  <div className="v num">{eta ? (eta - now > 30_000 ? `≈ ${Math.round((eta - now) / 60_000)} min` : "any moment") : "–"}</div>
                </div>
                <div className="stat">
                  <div className="k">Distance</div>
                  <div className="v num">{airport ? `${Math.round(distanceKm(live, airport))} km` : "–"}</div>
                </div>
                <div className="stat">
                  <div className="k">Altitude</div>
                  <div className="v num">{feet(live.altitudeFt)}</div>
                </div>
                <div className="stat">
                  <div className="k">Speed</div>
                  <div className="v num">{knots(live.groundSpeedKt)}</div>
                </div>
              </div>
            )}
            {eta && (
              <div className="pool-note num">
                Estimated touchdown {bothZones(eta).utc}
                {live?.etaSigmaMs ? ` ± ${Math.round(live.etaSigmaMs / 60000)} min` : ""}, from position and speed (not a timetable).
              </div>
            )}

            {airport && (
              <ApproachRadar
                airport={airport}
                items={[
                  {
                    hex: shown.hex,
                    label: flightName(shown),
                    color: "var(--accent)",
                    lat: shown.lat,
                    lon: shown.lon,
                    ...(live?.trackDeg !== undefined ? { trackDeg: live.trackDeg } : {}),
                    trail,
                    stale: !live,
                  },
                ]}
              />
            )}

            {live && (
              <button type="button" className="btn" onClick={() => p.onPredict(live.hex)}>
                Prediction on this flight
              </button>
            )}

            {done && (
              <div className="watch-next">
                {next ? (
                  <>
                    <div className="k">Next approach</div>
                    <div className="num">
                      <strong>{flightName(next)}</strong> → {next.airport}
                      {next.etaMs ? ` · in about ${Math.max(1, Math.round((next.etaMs - now) / 60_000))} min` : ""}
                      {next.airport === icao ? " · same camera" : ""}
                    </div>
                    <button type="button" className="btn primary" onClick={() => p.onWatch(next.hex)}>
                      Watch next approach
                    </button>
                    {nextHere && nextHere.hex !== next.hex && (
                      <button type="button" className="btn" onClick={() => p.onWatch(nextHere.hex)}>
                        Stay on this camera: {flightName(nextHere)}
                        {nextHere.etaMs ? ` in about ${Math.max(1, Math.round((nextHere.etaMs - now) / 60_000))} min` : ""}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="muted">No other flight is landing at a live-stream airport within the hour.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
