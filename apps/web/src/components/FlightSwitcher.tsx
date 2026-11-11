import { bothZones } from "../format";
import type { AircraftDto, DataStatus } from "../types";

export interface FlightSwitcherProps {
  flights: AircraftDto[];
  selectedHex: string | null;
  status: DataStatus;
  onSelect: (a: AircraftDto) => void;
  notice: string | null;
  /** The selected flight is no longer listed: its name and what is known. */
  held?: { name: string; text: string } | null;
  /** Whether a flight still takes predictions. */
  isOpen?: (a: AircraftDto) => boolean;
}

/**
 * Desktop: a bar at the top centre ("Flight 2 of 8", flight, ETA) with
 * previous / next. Mobile: a round button at the bottom that opens the betting panel for the
 * current flight, with arrows to the previous and next flight landing soon
 * (sorted by arrival).
 */
export function FlightSwitcher({ flights, selectedHex, status, onSelect, notice, held, isOpen }: FlightSwitcherProps) {
  const idx = flights.findIndex((f) => f.hex === selectedHex);
  const cur = idx >= 0 ? flights[idx] : undefined;
  const target = cur ?? flights.find((f) => isOpen?.(f)) ?? flights[0];
  const step = (d: number) => {
    if (flights.length === 0) return;
    const next = idx < 0 ? (d > 0 ? 0 : flights.length - 1) : (idx + d + flights.length) % flights.length;
    onSelect(flights[next]!);
  };

  let message: string | null = null;
  if (flights.length === 0) {
    if (status === "loading") message = "Loading flights …";
    else if (status === "error") message = "Flight data not reachable. Retrying …";
    else if (status === "unavailable") message = "Flight data source not responding. Retrying …";
    else message = "No flight is landing at a live-stream airport within the hour.";
  } else if (status === "error" || status === "unavailable") {
    message = "Flight data may be out of date.";
  }
  const warn = status === "error" || status === "unavailable";
  const open = target && isOpen ? isOpen(target) : undefined;

  const prev = (
    <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="Previous flight" disabled={flights.length === 0 || (flights.length === 1 && idx === 0)}>
      ‹
    </button>
  );
  const next = (
    <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="Next flight" disabled={flights.length === 0 || (flights.length === 1 && idx === 0)}>
      ›
    </button>
  );
  const tag = (a: AircraftDto) => isOpen && <span className={`bet-tag${isOpen(a) ? " open" : ""}`}>{isOpen(a) ? "betting open" : "betting closed"}</span>;
  const status_ = (message || held || notice) && (
    <div className={`switcher-msg${warn ? " warn" : ""}`} role="status">
      {held?.text ?? message ?? notice}
    </div>
  );

  return (
    <div className="switcher" role="group" aria-label="Choose a flight">
      <div className="sw-bar">
        {flights.length > 0 && (
          <div className="sw-bar-row">
            {prev}
            <button type="button" className="switcher-main" onClick={() => (cur ? onSelect(cur) : step(1))}>
              <span className="switcher-count num">
                {cur
                  ? `Flight ${idx + 1} of ${flights.length}`
                  : held
                    ? `Following ${held.name} · ${flights.length} other flight${flights.length === 1 ? "" : "s"}`
                    : `${flights.length} flight${flights.length === 1 ? "" : "s"} landing soon`}
              </span>
              <span className="sw-bar-what num">
                {cur ? (
                  <>
                    <strong>{cur.flightNumber || cur.callsign}</strong> → {cur.airport}
                    {cur.etaMs ? ` · ETA ${bothZones(cur.etaMs).utc}` : ""}
                    {tag(cur)}
                  </>
                ) : (
                  "Show the next arrival"
                )}
              </span>
            </button>
            {next}
          </div>
        )}
        {status_}
      </div>

      <div className="sw-round">
        {status_}
        <div className="switcher-row">
          {prev}
          <button
            type="button"
            className={`bet-round${open ? " open" : ""}`}
            disabled={!target}
            onClick={() => target && onSelect(target)}
            aria-label={target ? `Bet on ${target.flightNumber || target.callsign}` : "No flight"}
          >
            <span className="bet-round-label">Bet</span>
            <span className="bet-round-count num">{flights.length ? (idx >= 0 ? `${idx + 1}/${flights.length}` : `${flights.length}`) : "–"}</span>
          </button>
          {next}
        </div>
        {target && (
          <div className="switcher-what num">
            <strong>{target.flightNumber || target.callsign}</strong> → {target.airport}
            {open !== undefined && <span className={`bet-tag${open ? " open" : ""}`}>{open ? "open" : "closed"}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
