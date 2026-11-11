import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEBCAMS as webcams, webcamFor } from "@flightradar/core/webcams";
import { CLOSE_LEAD_MIN } from "@flightradar/core/eta";
import { api } from "./api";
import { AboutDialog } from "./components/AboutDialog";
import { AircraftPanel } from "./components/AircraftPanel";
import { AirportPanel } from "./components/AirportPanel";
import { FlightSwitcher } from "./components/FlightSwitcher";
import { INFO_PAGES, InfoDialog, type InfoPage } from "./components/InfoPages";
import { MarketCard, type PreparedBet } from "./components/MarketCard";
import { PortfolioPanel } from "./components/PortfolioPanel";
import { SiteMenu } from "./components/SiteMenu";
import { nextApproach, WatchView } from "./components/WatchView";
import { flightName, flightState, stateText } from "./arrivals";
import { useNow } from "./hooks";
import { Toasts, type Toast } from "./components/Toasts";
import { WalletDialog } from "./components/WalletDialog";
import { usePoll } from "./hooks";
import { errorText, t } from "./i18n";
import { MapView } from "./map/MapView";
import type { AircraftDetail, AircraftDto, Arrival, DataStatus, MarketDto } from "./types";
import { connectBrowserWallet, demoWallet, signAndSubmit, signBuilt, type AppWallet, type WalletOption } from "./wallet";

type Selection = { kind: "aircraft"; hex: string } | { kind: "airport"; icao: string } | { kind: "market"; id: string } | { kind: "portfolio" } | null;

const WALLET_KEY = "frf.wallet";

/** Flights the switcher offers: landing soon at a live-stream airport, by arrival. */
function bettableFlights(list: AircraftDto[]): AircraftDto[] {
  return list.filter((a) => a.airport && a.etaMs && webcamFor(a.airport)).sort((x, y) => x.etaMs! - y.etaMs!);
}

/** Still takes a new prediction: closes 20 min before landing, needs 5 min of betting. */
const bettable = (a: AircraftDto, now: number) => !!a.etaMs && a.etaMs - now >= (CLOSE_LEAD_MIN + 5) * 60_000;

const pageFromHash = (): InfoPage | null => {
  const h = window.location.hash.replace("#", "");
  return INFO_PAGES.some((p) => p.id === h) ? (h as InfoPage) : null;
};

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(WALLET_KEY, id);
    else localStorage.removeItem(WALLET_KEY);
  } catch {
    // storage unavailable (private mode): nothing to remember
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(WALLET_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const { data: health } = usePoll(api.health, 30_000, []);
  const markets = usePoll(api.markets, 5000, []);
  const marketList = markets.data?.markets ?? [];
  const [selection, setSelection] = useState<Selection>(null);
  const [detail, setDetail] = useState<AircraftDetail | null>(null);
  const [watch, setWatch] = useState<{ hex: string | null } | null>(null);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const now = useNow(5000);
  const [wallet, setWallet] = useState<AppWallet | null>(null);
  const [walletDialog, setWalletDialog] = useState(false);
  const [about, setAbout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flyTo, setFlyTo] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null);
  const aircraftRef = useRef<AircraftDto[]>([]);
  const [liveSelected, setLiveSelected] = useState<AircraftDto | undefined>();
  const [flights, setFlights] = useState<AircraftDto[]>([]);
  const flightsRef = useRef<AircraftDto[]>([]);
  const [data, setData] = useState<{ status: DataStatus; updatedAt: number | null }>({ status: "loading", updatedAt: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [infoPage, setInfoPage] = useState<InfoPage | null>(pageFromHash);
  const selectionRef = useRef<Selection>(null);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string, detail?: string) => {
    const id = ++toastId.current;
    setToasts((xs) => [...xs.slice(-3), { id, kind, text, ...(detail ? { detail } : {}) }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 9000 : 6000);
  }, []);

  const selectedHex = selection?.kind === "aircraft" ? selection.hex : null;
  selectionRef.current = selection;

  useEffect(() => {
    const onHash = () => setInfoPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const closeInfo = () => {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    setInfoPage(null);
  };

  /** Select a flight from the list: same flight for list, map, panel, stream and prediction. */
  const selectFlight = useCallback((a: AircraftDto, fly = true) => {
    setSelection({ kind: "aircraft", hex: a.hex });
    setLiveSelected(a);
    if (fly) setFlyTo({ lat: a.lat, lon: a.lon, zoom: 7, key: Date.now() });
  }, []);

  // Route and markets of the selected aircraft.
  useEffect(() => {
    setDetail(null);
    if (!selectedHex) return;
    let alive = true;
    const load = () =>
      api
        .aircraftDetail(selectedHex)
        .then((d) => alive && setDetail(d))
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selectedHex]);

  // A real wallet cannot bet on the simulated demo chain.
  useEffect(() => {
    if (health?.demo && wallet?.kind === "cip30") {
      setWallet(null);
      remember(null);
      toast("info", "Demo mode: real wallets don't work on the simulated chain. Choose a demo wallet.");
    }
  }, [health?.demo, wallet?.kind]);

  // Reconnect a remembered demo wallet.
  useEffect(() => {
    const id = remembered();
    if (health?.demo && id?.startsWith("demo:") && !wallet) setWallet(demoWallet(id.slice(5)));
  }, [health?.demo]);

  // Escape closes watch mode or the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || walletDialog || about || infoPage) return;
      if (watch) setWatch(null);
      else setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [watch, walletDialog, about, infoPage]);

  const onAircraftUpdate = useCallback((list: AircraftDto[], arr: Arrival[]) => {
    aircraftRef.current = list;
    const prev = flightsRef.current;
    const next = bettableFlights(list);
    flightsRef.current = next;
    setFlights(next);
    setArrivals(arr);
    const sel = selectionRef.current;
    if (sel?.kind !== "aircraft") return;
    const live = list.find((a) => a.hex === sel.hex);
    const gone = prev.find((f) => f.hex === sel.hex);
    // A flight that drops out of the list is usually about to touch down:
    // stay on it (panel, stream, map) and say so; the viewer moves on.
    if (gone && !next.some((f) => f.hex === sel.hex)) {
      setNotice(`${flightName(gone)} left the list of approaching flights. The view stays on it until a ground report arrives or you switch.`);
    }
    // Keep what the list knew (flight number, origin) when only a bare
    // position remains, e.g. from the oracle's tracker after landing.
    if (live) setLiveSelected((prev) => (prev?.hex === live.hex && !live.etaMs ? { ...prev, ...live, ...(prev.flightNumber ? { flightNumber: prev.flightNumber } : {}), ...(prev.origin ? { origin: prev.origin } : {}) } : live));
  }, []);

  const onAircraftClick = useCallback(
    (hex: string) => {
      setNotice(null);
      setSelection({ kind: "aircraft", hex });
      setLiveSelected(aircraftRef.current.find((a) => a.hex === hex));
    },
    [],
  );

  const pickWallet = async (opt: WalletOption) => {
    setWalletDialog(false);
    try {
      const w = opt.kind === "demo" ? demoWallet(opt.name) : await connectBrowserWallet(opt.id);
      if (w.kind === "cip30" && health) {
        const expected = health.network === "Mainnet" ? 1 : 0;
        if (w.networkId !== expected) toast("error", t.wrongNetwork);
      }
      setWallet(w);
      remember(w.id);
      toast("ok", `${w.name} connected`);
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  const withWallet = async (fn: (w: AppWallet) => Promise<void>) => {
    if (!wallet) {
      setWalletDialog(true);
      return;
    }
    setBusy(true);
    try {
      await fn(wallet);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
      markets.reload();
    }
  };

  /** Build the bet so the user sees the real costs before signing. */
  const onPrepare = async (m: MarketDto, outcome: number, stake: bigint): Promise<PreparedBet | null> => {
    if (!wallet) {
      setWalletDialog(true);
      return null;
    }
    setBusy(true);
    try {
      const res = await api.betTx(await wallet.payload(), m.id, outcome, stake);
      return { market: m, outcome, tx: res.tx, costs: res.costs, payout: res.quote.payout, multiplier: res.quote.multiplier };
    } catch (e) {
      toast("error", errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async (bet: PreparedBet): Promise<boolean> => {
    if (!wallet) return false;
    setBusy(true);
    try {
      const hash = await signBuilt(wallet, bet.tx);
      toast("ok", t.betPlaced, hash);
      return true;
    } catch (e) {
      toast("error", errorText(e));
      return false;
    } finally {
      setBusy(false);
      markets.reload();
    }
  };

  const onClaim = (marketId: string) =>
    withWallet(async (w) => {
      const hash = await signAndSubmit(w, (p) => api.claimTx(p, marketId));
      toast("ok", t.submitted, hash);
    });

  const onCancel = (ref: string) =>
    withWallet(async (w) => {
      const hash = await signAndSubmit(w, (p) => api.cancelTx(p, ref));
      toast("ok", t.submitted, hash);
    });

  const onCreate = async (body: unknown) => {
    setBusy(true);
    try {
      const r = await api.createMarket(body);
      toast("ok", r.existing ? t.marketExists : t.marketRequested);
      markets.reload();
      return r;
    } catch (e) {
      toast("error", errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const aircraftMarkets = useMemo(() => (selectedHex ? marketList.filter((m) => m.icao24.includes(selectedHex)) : []), [marketList, selectedHex]);
  const selectedMarket = selection?.kind === "market" ? marketList.find((m) => m.id === selection.id) : undefined;
  const selState = selectedHex ? flightState(selectedHex, flights, arrivals) : null;
  const held = selState && selState.kind !== "approaching" && liveSelected ? { name: flightName(liveSelected), text: stateText(selState, now) } : null;

  const openWatch = () => {
    setNotice(null);
    const start = selectedHex && flights.some((f) => f.hex === selectedHex) ? selectedHex : (nextApproach(flights)?.hex ?? null);
    setWatch({ hex: start });
  };

  return (
    <div className={`app${selection?.kind === "aircraft" ? " flight-open" : ""}`}>
      <MapView
        selectedHex={selectedHex}
        destination={detail?.destination ?? null}
        onAircraftClick={onAircraftClick}
        onAirportClick={(icao) => {
          // Live-stream airports open their stream; there are no departure-board markets.
          const cam = webcams.find((w) => w.icao === icao);
          if (cam) window.open(cam.url, "_blank", "noopener,noreferrer");
        }}
        onBackgroundClick={() => setSelection(null)}
        onAircraftUpdate={onAircraftUpdate}
        onStatus={(s) => setData((d) => (d.status === s.status && d.updatedAt === s.updatedAt ? d : { status: s.status, updatedAt: s.updatedAt }))}
        flyTo={flyTo}
      />

      <header className="topbar">
        <span className="spacer" />
        <button type="button" className="btn accent-btn watch-btn" onClick={openWatch} title="Live stream, approach map and countdown for the next landing">
          <span aria-hidden>▶</span> <span className="label-wide">Now landing</span>
          <span className="label-narrow">Live</span>
        </button>
        {!wallet && (
          <button type="button" className="btn primary" onClick={() => setWalletDialog(true)}>
            <span className="label-wide">Connect</span>Wallet
          </button>
        )}
        <SiteMenu
          wallet={wallet}
          onConnect={() => setWalletDialog(true)}
          onDisconnect={() => {
            setWallet(null);
            remember(null);
          }}
          onMyBets={() => setSelection({ kind: "portfolio" })}
          onAbout={() => setAbout(true)}
        />
      </header>

      {health && (
        <div className="banner">
          <span className="label-wide">{health.demo ? t.demoBanner : health.network !== "Mainnet" ? t.testnetBanner(health.network) : ""}</span>
          <span className="label-narrow">{health.demo ? t.demoBannerShort : health.network !== "Mainnet" ? t.testnetBannerShort(health.network) : ""}</span>
        </div>
      )}
      <FlightSwitcher
          flights={flights}
          selectedHex={selectedHex}
          status={data.status}
          notice={notice}
          held={held}
          onSelect={(a) => (setNotice(null), selectFlight(a))}
          isOpen={(a) => bettable(a, now) || !!a.markets}
        />


      {selection?.kind === "aircraft" && (
        <AircraftPanel
          hex={selection.hex}
          live={liveSelected}
          detail={detail}
          markets={aircraftMarkets}
          scheduleAvailable={!!health?.schedule && !health.schedule.simulated}
          busy={busy}
          dataUpdatedAt={data.updatedAt}
          arrivalNote={held?.text ?? null}
          onPrepare={onPrepare}
          onConfirm={onConfirm}
          onCreate={onCreate}
          onClose={() => setSelection(null)}
          position={{ index: flights.findIndex((f) => f.hex === selection.hex), count: flights.length }}
          nextOpen={flights.find((f) => f.hex !== selection.hex && (bettable(f, now) || !!f.markets)) ?? null}
          onSelectFlight={(f) => (setNotice(null), selectFlight(f))}
          onStep={(dir) => {
            if (flights.length === 0) return;
            const i = flights.findIndex((f) => f.hex === selection.hex);
            const next = i < 0 ? (dir > 0 ? 0 : flights.length - 1) : (i + dir + flights.length) % flights.length;
            setNotice(null);
            selectFlight(flights[next]!);
          }}
        />
      )}
      {selection?.kind === "airport" && (
        <AirportPanel icao={selection.icao} markets={marketList} busy={busy} onPrepare={onPrepare} onConfirm={onConfirm} onCreate={onCreate} onClose={() => setSelection(null)} />
      )}
      {selection?.kind === "market" && selectedMarket && (
        <aside className="panel">
          <div className="panel-head">
            <div>
              <h2>Market</h2>
              <div className="sub">{selectedMarket.kind}</div>
            </div>
            <button type="button" className="icon-btn" onClick={() => setSelection(null)} aria-label={t.close}>
              ✕
            </button>
          </div>
          <div className="panel-body">
            <MarketCard market={selectedMarket} highlight busy={busy} onPrepare={onPrepare} onConfirm={onConfirm} />
          </div>
        </aside>
      )}
      {selection?.kind === "portfolio" && wallet && (
        <PortfolioPanel
          wallet={wallet}
          busy={busy}
          onClaim={onClaim}
          onCancel={onCancel}
          onOpenMarket={(m) => {
            const hex = m.icao24[0];
            if (hex) setSelection({ kind: "aircraft", hex });
            else setSelection({ kind: "market", id: m.id });
          }}
          onClose={() => setSelection(null)}
        />
      )}

      <div className="legend" aria-hidden>
        <span>
          <span className="dot" style={{ background: "var(--yes)" }} />
          Landing within 1 h
        </span>
        <span>
          <span className="ring" style={{ borderColor: "var(--accent)", background: "#0b0d10" }} />
          Live-stream airport
        </span>
        <span>
          <span className="diamond" />
          Departure airport
        </span>
        <span>
          <span className="ring" />
          Open market
        </span>
      </div>
      {watch && (
        <WatchView
          hex={watch.hex}
          flights={flights}
          arrivals={arrivals}
          status={data.status}
          onWatch={(hex) => setWatch({ hex })}
          onPredict={(hex) => {
            const f = flights.find((x) => x.hex === hex);
            setWatch(null);
            if (f) selectFlight(f);
          }}
          onClose={() => setWatch(null)}
        />
      )}
      <Toasts items={toasts} onDismiss={(id) => setToasts((xs) => xs.filter((x) => x.id !== id))} />
      {walletDialog && <WalletDialog demo={!!health?.demo} onPick={pickWallet} onClose={() => setWalletDialog(false)} />}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {infoPage && <InfoDialog page={infoPage} onClose={closeInfo} />}
    </div>
  );
}
