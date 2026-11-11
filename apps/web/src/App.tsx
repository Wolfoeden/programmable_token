import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEBCAMS as webcams, webcamFor } from "@flightradar/core/webcams";
import { api } from "./api";
import { AboutDialog } from "./components/AboutDialog";
import { AircraftPanel } from "./components/AircraftPanel";
import { AirportPanel } from "./components/AirportPanel";
import { FlightSwitcher } from "./components/FlightSwitcher";
import { INFO_PAGES, InfoDialog, type InfoPage } from "./components/InfoPages";
import { MarketCard, type PreparedBet } from "./components/MarketCard";
import { PortfolioPanel } from "./components/PortfolioPanel";
import { Toasts, type Toast } from "./components/Toasts";
import { WalletDialog } from "./components/WalletDialog";
import { usePoll } from "./hooks";
import { errorText, t } from "./i18n";
import { MapView } from "./map/MapView";
import type { AircraftDetail, AircraftDto, DataStatus, MarketDto } from "./types";
import { connectBrowserWallet, demoWallet, signAndSubmit, signBuilt, type AppWallet, type WalletOption } from "./wallet";

type Selection = { kind: "aircraft"; hex: string } | { kind: "airport"; icao: string } | { kind: "market"; id: string } | { kind: "portfolio" } | null;

const WALLET_KEY = "frf.wallet";

/** Flights the switcher offers: landing soon at a live-stream airport, by arrival. */
function bettableFlights(list: AircraftDto[]): AircraftDto[] {
  return list.filter((a) => a.airport && a.etaMs && webcamFor(a.airport)).sort((x, y) => x.etaMs! - y.etaMs!);
}

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
  const [raceHexes, setRaceHexes] = useState<string[]>([]);
  const [wallet, setWallet] = useState<AppWallet | null>(null);
  const [walletDialog, setWalletDialog] = useState(false);
  const [about, setAbout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flyTo, setFlyTo] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null);
  const [search, setSearch] = useState("");
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

  // Reconnect a remembered demo wallet.
  useEffect(() => {
    const id = remembered();
    if (health?.demo && id?.startsWith("demo:") && !wallet) setWallet(demoWallet(id.slice(5)));
  }, [health?.demo]);

  // Escape closes the panel or leaves race mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || walletDialog || about) return;
      if (raceHexes.length > 0) setRaceHexes([]);
      else setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [raceHexes.length, walletDialog, about]);

  const onAircraftUpdate = useCallback(
    (list: AircraftDto[]) => {
      aircraftRef.current = list;
      const prev = flightsRef.current;
      const next = bettableFlights(list);
      flightsRef.current = next;
      setFlights(next);
      const sel = selectionRef.current;
      if (sel?.kind !== "aircraft") return;
      const live = list.find((a) => a.hex === sel.hex);
      const wasListed = prev.findIndex((f) => f.hex === sel.hex);
      // Keep the selection while the flight is listed; if it drops out, move on
      // to the flight that followed it (or the first one) and say so.
      if (wasListed >= 0 && !next.some((f) => f.hex === sel.hex)) {
        const gone = prev[wasListed]!;
        const name = gone.flightNumber || gone.callsign || gone.hex;
        const successor = prev.slice(wasListed + 1).find((f) => next.some((n) => n.hex === f.hex)) ?? next[0];
        const replacement = successor ? next.find((n) => n.hex === successor.hex)! : undefined;
        if (replacement) {
          setNotice(`${name} is no longer in the list (landed, or out of data range). Now showing ${replacement.flightNumber || replacement.callsign}.`);
          selectFlight(replacement);
        } else {
          setNotice(`${name} is no longer in the list (landed, or out of data range). No other flight is landing soon.`);
          setLiveSelected(live);
        }
        return;
      }
      setLiveSelected(live);
    },
    [selectFlight],
  );

  const onAircraftClick = useCallback(
    (hex: string) => {
      if (raceHexes.length > 0) {
        setRaceHexes((xs) => (xs.includes(hex) ? xs.filter((x) => x !== hex) : xs.length >= 4 ? xs : [...xs, hex]));
        return;
      }
      setNotice(null);
      setSelection({ kind: "aircraft", hex });
      setLiveSelected(aircraftRef.current.find((a) => a.hex === hex));
    },
    [raceHexes.length],
  );

  const pickWallet = async (opt: WalletOption) => {
    setWalletDialog(false);
    try {
      const w = opt.kind === "demo" ? demoWallet(opt.name) : await connectBrowserWallet(opt.id);
      if (w.kind === "cip30" && health) {
        const expected = health.network === "Mainnet" ? 1 : 0;
        if (health.demo || w.networkId !== expected) toast("error", t.wrongNetwork);
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

  const onSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim().toUpperCase().replace(/\s+/g, "");
    if (!q) return;
    const hit = aircraftRef.current.find((a) => a.callsign?.toUpperCase() === q || a.hex.toUpperCase() === q || a.registration?.replace("-", "") === q.replace("-", ""));
    if (hit) {
      setSelection({ kind: "aircraft", hex: hit.hex });
      setFlyTo({ lat: hit.lat, lon: hit.lon, zoom: 8, key: Date.now() });
      return;
    }
    if (/^[0-9A-F]{6}$/.test(q)) {
      try {
        const d = await api.aircraftDetail(q.toLowerCase());
        setSelection({ kind: "aircraft", hex: d.aircraft.hex });
        setFlyTo({ lat: d.aircraft.lat, lon: d.aircraft.lon, zoom: 8, key: Date.now() });
        return;
      } catch {
        // fall through to the toast below
      }
    }
    toast("info", `${q} is not on the map right now.`);
  };

  const aircraftMarkets = useMemo(() => (selectedHex ? marketList.filter((m) => m.icao24.includes(selectedHex)) : []), [marketList, selectedHex]);
  const selectedMarket = selection?.kind === "market" ? marketList.find((m) => m.id === selection.id) : undefined;
  const openCount = marketList.filter((m) => m.phase === "open").length;

  return (
    <div className="app">
      <MapView
        selectedHex={selectedHex}
        raceHexes={raceHexes}
        destination={detail?.destination ?? null}
        onAircraftClick={onAircraftClick}
        onAirportClick={(icao) => {
          // Live-stream airports open their stream; there are no departure-board markets.
          const cam = webcams.find((w) => w.icao === icao);
          if (raceHexes.length === 0 && cam) window.open(cam.url, "_blank", "noopener,noreferrer");
        }}
        onBackgroundClick={() => raceHexes.length === 0 && setSelection(null)}
        onAircraftUpdate={onAircraftUpdate}
        onStatus={(s) => setData((d) => (d.status === s.status && d.updatedAt === s.updatedAt ? d : { status: s.status, updatedAt: s.updatedAt }))}
        flyTo={flyTo}
      />

      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden>
            <circle cx="32" cy="32" r="26" fill="none" stroke="#2a3340" strokeWidth="4" />
            <circle cx="32" cy="32" r="14" fill="none" stroke="#2a3340" strokeWidth="4" />
            <path d="M32 32 L52 16" stroke="#ffc53d" strokeWidth="5" strokeLinecap="round" />
            <circle cx="32" cy="32" r="5" fill="#ffc53d" />
          </svg>
          <strong>
            flightradar<span className="fun">.fun</span>
          </strong>
          {health && <span className="badge">{health.demo ? "Demo" : health.network}</span>}
          {openCount > 0 && <span className="badge accent num">{openCount} open</span>}
        </div>
        <form className="search" onSubmit={onSearch}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.search} aria-label={t.search} />
        </form>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setAbout(true)} aria-label={t.aboutTitle}>
          ?
        </button>
        {wallet && (
          <button type="button" className="btn" onClick={() => setSelection({ kind: "portfolio" })}>
            <span className="label-wide">{t.myBets}</span>
            <span aria-hidden>🎟</span>
          </button>
        )}
        <button
          type="button"
          className={`btn${wallet ? "" : " primary"}`}
          onClick={() => {
            if (wallet) {
              setWallet(null);
              remember(null);
            } else setWalletDialog(true);
          }}
          title={wallet ? t.disconnect : undefined}
        >
          {wallet?.icon && <img src={wallet.icon} alt="" />}
          {wallet ? (
            wallet.name
          ) : (
            <>
              <span className="label-wide">Connect</span>Wallet
            </>
          )}
        </button>
      </header>

      {health && raceHexes.length === 0 && (
        <div className="banner">
          <span className="label-wide">{health.demo ? t.demoBanner : health.network !== "Mainnet" ? t.testnetBanner(health.network) : ""}</span>
          <span className="label-narrow">{health.demo ? t.demoBannerShort : health.network !== "Mainnet" ? t.testnetBannerShort(health.network) : ""}</span>
        </div>
      )}
      {raceHexes.length > 0 && (
        <div className="banner" style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text)" }}>
          <span>{t.raceBanner(raceHexes.length)}</span>
          <button
            type="button"
            className="btn small primary"
            disabled={raceHexes.length < 2 || busy}
            onClick={async () => {
              const r = await onCreate({ kind: "race", hexes: raceHexes });
              if (r) {
                setSelection({ kind: "aircraft", hex: raceHexes[0]! });
                setRaceHexes([]);
              }
            }}
          >
            {t.raceGo}
          </button>
          <button type="button" className="btn small flat" onClick={() => setRaceHexes([])}>
            {t.cancel}
          </button>
        </div>
      )}

      <FlightSwitcher flights={flights} selectedHex={selectedHex} status={data.status} notice={notice} onSelect={(a) => (setNotice(null), selectFlight(a))} />

      {selection?.kind === "aircraft" && (
        <AircraftPanel
          hex={selection.hex}
          live={liveSelected}
          detail={detail}
          markets={aircraftMarkets}
          scheduleAvailable={!!health?.schedule}
          busy={busy}
          dataUpdatedAt={data.updatedAt}
          onPrepare={onPrepare}
          onConfirm={onConfirm}
          onCreate={onCreate}
          onStartRace={() => setRaceHexes([selection.hex])}
          onClose={() => setSelection(null)}
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
      <footer className="attribution">
        <nav className="legal-links" aria-label="Site information">
          {INFO_PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`}>
              {p.label}
            </a>
          ))}
        </nav>
        <span>{t.attribution}</span>
      </footer>
      <Toasts items={toasts} onDismiss={(id) => setToasts((xs) => xs.filter((x) => x.id !== id))} />
      {walletDialog && <WalletDialog demo={!!health?.demo} onPick={pickWallet} onClose={() => setWalletDialog(false)} />}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {infoPage && <InfoDialog page={infoPage} onClose={closeInfo} />}
    </div>
  );
}
