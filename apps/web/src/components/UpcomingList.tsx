import { useEffect, useRef, useState } from "react";
import { airportByIcao } from "@flightradar/core/airports";
import { utcClock } from "../format";
import { useNow } from "../hooks";
import type { AircraftDto, DataStatus } from "../types";

export interface UpcomingListProps {
  flights: AircraftDto[];
  status: DataStatus;
  selectedHex: string | null;
  isOpen: (a: AircraftDto) => boolean;
  onSelect: (a: AircraftDto) => void;
}

const iata = (icao?: string) => (icao ? airportByIcao(icao)?.iata || icao : "–");

/**
 * "Live flights": every flight we follow that lands at a live-stream airport
 * within the hour, soonest first, with arrival estimate and whether it
 * still takes predictions. Same button opens and closes it.
 */
export function UpcomingList(p: UpcomingListProps) {
  const [open, setOpen] = useState(false);
  const now = useNow(15_000);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="upcoming" ref={ref}>
      <button type="button" className={`btn${open ? " active" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Live flights">
        <span className="label-wide">Live flights</span>
        <span className="label-narrow" aria-hidden>
          ✈
        </span>
        <span className="count num">{p.flights.length}</span>
      </button>
      {open && (
        <div className="upcoming-list" role="dialog" aria-label="Live flights">
          <div className="upcoming-head">Live flights · landing within the hour</div>
          {p.flights.length === 0 && (
            <div className="upcoming-empty">
              {p.status === "loading" ? "Loading flights …" : p.status === "ok" ? "No flight is landing at a live-stream airport within the hour." : "Flight data is not reachable right now."}
            </div>
          )}
          <ul>
            {p.flights.map((f) => {
              const min = f.etaMs ? Math.max(0, Math.round((f.etaMs - now) / 60_000)) : null;
              const betOpen = p.isOpen(f);
              return (
                <li key={f.hex}>
                  <button
                    type="button"
                    className={`upcoming-row${f.hex === p.selectedHex ? " selected" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      p.onSelect(f);
                    }}
                  >
                    <span className="up-flight">
                      <strong>{f.flightNumber || f.callsign}</strong>
                      <span className="muted">
                        {iata(f.origin)} → {iata(f.airport)}
                      </span>
                    </span>
                    <span className="up-eta num">
                      {f.etaMs ? utcClock(f.etaMs) : "–"}
                      <span className="muted">{min !== null ? (min < 1 ? "now" : `in ${min} min`) : ""}</span>
                    </span>
                    <span className={`bet-tag${betOpen ? " open" : ""}`}>{betOpen ? "open" : "closed"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="upcoming-foot">Arrival times are estimates from position and speed. Betting closes 20 min before landing.</div>
        </div>
      )}
    </div>
  );
}
