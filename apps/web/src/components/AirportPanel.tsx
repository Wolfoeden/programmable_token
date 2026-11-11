import { api } from "../api";
import { clock, formatPercent } from "../format";
import { usePoll } from "../hooks";
import { errorText, t } from "../i18n";
import type { MarketDto } from "../types";
import { CamLink } from "./CamLink";
import { MarketCard, type MarketCardProps } from "./MarketCard";

export interface AirportPanelProps {
  icao: string;
  markets: MarketDto[];
  busy: boolean;
  onPrepare: MarketCardProps["onPrepare"];
  onConfirm: MarketCardProps["onConfirm"];
  onCreate: (body: unknown) => void;
  onClose: () => void;
}

const STATUS: Record<string, string> = {
  scheduled: "scheduled",
  delayed: "delayed",
  boarding: "Boarding",
  departed: "departed",
  arrived: "arrived",
  cancelled: "cancelled",
  diverted: "diverted",
  unknown: "",
};

export function AirportPanel(p: AirportPanelProps) {
  const { data, error } = usePoll(() => api.departures(p.icao), 60_000, [p.icao]);
  const related = p.markets.filter(
    (m) => (m.question.kind === "cancellation" || m.question.kind === "delay") && m.question.flight.origin === p.icao,
  );

  return (
    <aside className="panel" aria-label="Airport">
      <div className="panel-head">
        <div>
          <h2>{data?.airport.iata || p.icao}</h2>
          <div className="sub">{data?.airport.name ?? p.icao}</div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t.close}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        <CamLink icao={p.icao} />
        {related.length > 0 && <div className="section-title">{t.markets}</div>}
        {related.map((m) => (
          <MarketCard key={m.id} market={m} busy={p.busy} onPrepare={p.onPrepare} onConfirm={p.onConfirm} />
        ))}
        <div className="section-title">
          <span>{t.departures}</span>
          {data?.provider.simulated && <span className="badge">{t.simulated}</span>}
        </div>
        {error !== null && <div className="muted">{(error as { code?: string }).code === "schedule_unavailable" ? t.noSchedule : errorText(error)}</div>}
        <div className="list">
          {data?.departures.map((d) => {
            const has = (kind: string) => d.markets.some((m) => m.kind === kind);
            return (
              <div className="row" key={`${d.flightNumber}-${d.scheduledDeparture}`}>
                <span className="time num">{clock(d.scheduledDeparture)}</span>
                <div className="what">
                  <div className="t">
                    {d.flightNumber} → {d.destination}
                  </div>
                  <div className="s">{[d.airline, STATUS[d.status]].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="row-actions">
                  {d.quotes.cancellation !== null && !has("cancellation") && (
                    <button
                      type="button"
                      className="btn small flat"
                      disabled={p.busy}
                      title="Market: will this flight be cancelled?"
                      onClick={() =>
                        p.onCreate({ kind: "scheduled", market: "cancellation", flightNumber: d.flightNumber, origin: d.origin, scheduledDeparture: d.scheduledDeparture })
                      }
                    >
                      {t.cancellationQ} <span className="num muted">{formatPercent(d.quotes.cancellation, "en-US")}</span>
                    </button>
                  )}
                  {d.quotes.delay !== null && !has("delay") && !d.simulated && (
                    <button
                      type="button"
                      className="btn small flat"
                      disabled={p.busy}
                      title="Market: will this flight land more than 15 minutes late?"
                      onClick={() =>
                        p.onCreate({ kind: "scheduled", market: "delay", flightNumber: d.flightNumber, origin: d.origin, scheduledDeparture: d.scheduledDeparture })
                      }
                    >
                      {t.delayQ} <span className="num muted">{formatPercent(d.quotes.delay, "en-US")}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
