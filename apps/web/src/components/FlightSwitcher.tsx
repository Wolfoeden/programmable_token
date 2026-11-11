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
}

/** "Flight 2 of 8" with previous / next, over the bettable flights sorted by arrival. */
export function FlightSwitcher({ flights, selectedHex, status, onSelect, notice, held }: FlightSwitcherProps) {
  const idx = flights.findIndex((f) => f.hex === selectedHex);
  const cur = idx >= 0 ? flights[idx] : undefined;
  const step = (d: number) => {
    if (flights.length === 0) return;
    const next = idx < 0 ? (d > 0 ? 0 : flights.length - 1) : (idx + d + flights.length) % flights.length;
    onSelect(flights[next]!);
  };

  let message: string | null = null;
  if (flights.length === 0) {
    if (status === "loading") message = "Loading flight data …";
    else if (status === "error") message = "Flight data is not reachable right now. Retrying …";
    else if (status === "unavailable") message = "The flight data source is not responding right now. Retrying …";
    else message = "No matching flights right now: none of the live-stream airports has a short flight landing within the hour.";
  }

  return (
    <div className="switcher" role="group" aria-label="Choose a flight">
      {message ? (
        <div className={`switcher-msg${status === "error" || status === "unavailable" ? " warn" : ""}`} role="status">
          {message}
        </div>
      ) : (
        <>
          <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="Previous flight" disabled={flights.length < 2 && idx >= 0}>
            ‹
          </button>
          <button type="button" className="switcher-main" onClick={() => (cur ? onSelect(cur) : step(1))}>
            <span className="switcher-count num">
              {cur
                ? `Flight ${idx + 1} of ${flights.length}`
                : held
                  ? `Following ${held.name} · ${flights.length} other flight${flights.length === 1 ? "" : "s"} landing soon`
                  : `${flights.length} flight${flights.length === 1 ? "" : "s"} landing soon`}
            </span>
            <span className="switcher-what num">
              {cur ? (
                <>
                  <strong>{cur.flightNumber || cur.callsign}</strong> → {cur.airport}
                  {cur.etaMs ? ` · ETA ${bothZones(cur.etaMs).utc}` : ""}
                </>
              ) : held ? (
                "Next: show the soonest arrival"
              ) : (
                "Show the next arrival"
              )}
            </span>
          </button>
          <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="Next flight" disabled={flights.length < 2 && idx >= 0}>
            ›
          </button>
        </>
      )}
      {(status === "error" || status === "unavailable") && flights.length > 0 && (
        <div className="switcher-msg warn small">
          {status === "error"
            ? "The site's server is not reachable: showing the last known list, which may be out of date."
            : "The flight data source is not responding: this list may be out of date."}
        </div>
      )}
      {held && <div className="switcher-msg small" role="status">{held.text}</div>}
      {notice && !held && <div className="switcher-msg small">{notice}</div>}
    </div>
  );
}
