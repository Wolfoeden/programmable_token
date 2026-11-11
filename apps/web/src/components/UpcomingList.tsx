import { useEffect, useRef, useState } from "react";
import { airportByIcao } from "@flightradar/core/airports";
import { ada, countdown, utcClock } from "../format";
import { useNow } from "../hooks";
import { betLabel, type BetState } from "../betState";
import type { AircraftDto, DataStatus, MarketDto } from "../types";

export interface UpcomingListProps {
  flights: AircraftDto[];
  status: DataStatus;
  selectedHex: string | null;
  stateOf: (a: AircraftDto) => BetState;
  onSelect: (a: AircraftDto) => void;
  /** All prediction pools, for the Pools tab. */
  markets: MarketDto[];
  onOpenMarket: (m: MarketDto) => void;
}

const ORDER: Record<string, number> = { creating: 0, open: 0, closed: 1, resolved: 2, void: 2 };

function PoolRow({ m, now, onOpen }: { m: MarketDto; now: number; onOpen: () => void }) {
  const yes = m.probabilities[0] ?? 0;
  const status =
    m.phase === "open" || m.phase === "creating"
      ? m.closeTime > now
        ? `Open · closes in ${countdown(m.closeTime - now)}`
        : "Betting closed"
      : m.phase === "closed"
        ? "Betting closed · waiting for the landing"
        : m.phase === "void"
          ? "Void · stakes refunded 1:1"
          : `Result: ${m.labels.en[m.winner ?? 0] ?? "?"}`;
  return (
    <button type="button" className="pool-row" onClick={onOpen}>
      <span className="pool-title">{m.title.en}</span>
      <span className={`pool-status ${m.phase}`}>{status}</span>
      <span className="pool-split" aria-hidden>
        <span style={{ width: `${yes * 100}%` }} className="pool-yes" />
        <span style={{ width: `${(1 - yes) * 100}%` }} className="pool-no" />
      </span>
      <span className="pool-nums num">
        <span>
          {m.labels.en[0]} {Math.round(yes * 100)} %
        </span>
        <span>Pool {ada(m.total, 0)}</span>
        <span>
          {m.labels.en[1]} {Math.round((1 - yes) * 100)} %
        </span>
      </span>
    </button>
  );
}

const iata = (icao?: string) => (icao ? airportByIcao(icao)?.iata || icao : "–");

/**
 * "Live flights": every flight we follow that lands at a live-stream airport
 * within the hour, soonest first, with arrival estimate and whether it
 * still takes predictions. Same button opens and closes it.
 */
export function UpcomingList(p: UpcomingListProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"flights" | "pools">("flights");
  const now = useNow(tab === "pools" ? 1000 : 15_000);
  const pools = [...p.markets].sort(
    (a, b) => (ORDER[a.phase] ?? 3) - (ORDER[b.phase] ?? 3) || (a.phase === "resolved" || a.phase === "void" ? b.closeTime - a.closeTime : a.closeTime - b.closeTime),
  );
  // Flights open for betting or opening later; closed ones drop out of the list.
  const openFlights = p.flights.filter((f) => p.stateOf(f).kind !== "closed");
  const openPools = p.markets.filter((m) => (m.phase === "open" || m.phase === "creating") && m.closeTime > now).length;
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
        <span className="count num">{openFlights.length}</span>
        {openPools > 0 && <span className="count open num">{openPools} open</span>}
      </button>
      {open && (
        <div className="upcoming-list" role="dialog" aria-label="Live flights">
          <div className="up-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "flights"} className={tab === "flights" ? "active" : ""} onClick={() => setTab("flights")}>
              Live flights <span className="num">{openFlights.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "pools"} className={tab === "pools" ? "active" : ""} onClick={() => setTab("pools")}>
              Pools <span className="num">{p.markets.length}</span>
            </button>
          </div>
          {tab === "pools" && (
            <>
              {pools.length === 0 && <div className="upcoming-empty">No pools yet. Open a flight and press “Predict this landing”.</div>}
              <ul>
                {pools.map((m) => (
                  <li key={m.id}>
                    <PoolRow
                      m={m}
                      now={now}
                      onOpen={() => {
                        setOpen(false);
                        p.onOpenMarket(m);
                      }}
                    />
                  </li>
                ))}
              </ul>
              <div className="upcoming-foot">Percentages are each side’s share of the pool (market-based, not a probability).</div>
            </>
          )}
          {tab === "flights" && <div className="upcoming-head">Open for betting · from cruise altitude</div>}
          {tab === "flights" && openFlights.length === 0 && (
            <div className="upcoming-empty">
              {p.status === "loading" ? "Loading flights …" : p.status === "ok" ? "No flight is open for betting right now." : "Flight data is not reachable right now."}
            </div>
          )}
          {tab === "flights" && (
          <ul>
            {openFlights.map((f) => {
              const min = f.etaMs ? Math.max(0, Math.round((f.etaMs - now) / 60_000)) : null;
              const bs = p.stateOf(f);
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
                    <span className={`bet-tag ${bs.kind}`}>{betLabel(bs, true)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          )}
          {tab === "flights" && <div className="upcoming-foot">Arrival times are estimates from position and speed. Betting closes at least 20 min before landing.</div>}
        </div>
      )}
    </div>
  );
}
