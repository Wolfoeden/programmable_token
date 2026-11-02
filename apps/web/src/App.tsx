import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { AboutDialog } from "./components/AboutDialog";
import { AircraftPanel } from "./components/AircraftPanel";
import { AirportPanel } from "./components/AirportPanel";
import { MarketCard } from "./components/MarketCard";
import { PortfolioPanel } from "./components/PortfolioPanel";
import { Toasts, type Toast } from "./components/Toasts";
import { WalletDialog } from "./components/WalletDialog";
import { usePoll } from "./hooks";
import { errorText, t } from "./i18n";
import { MapView } from "./map/MapView";
import type { AircraftDetail, AircraftDto, MarketDto } from "./types";
import { connectBrowserWallet, demoWallet, signAndSubmit, type AppWallet, type WalletOption } from "./wallet";

type Selection = { kind: "aircraft"; hex: string } | { kind: "airport"; icao: string } | { kind: "market"; id: string } | { kind: "portfolio" } | null;

const WALLET_KEY = "frf.wallet";

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
  const [zoomHint, setZoomHint] = useState(false);
  const [flyTo, setFlyTo] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null);
  const [search, setSearch] = useState("");
  const aircraftRef = useRef<AircraftDto[]>([]);
  const [liveSelected, setLiveSelected] = useState<AircraftDto | undefined>();
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string, detail?: string) => {
    const id = ++toastId.current;
    setToasts((xs) => [...xs.slice(-3), { id, kind, text, ...(detail ? { detail } : {}) }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 9000 : 6000);
  }, []);

  const selectedHex = selection?.kind === "aircraft" ? selection.hex : null;

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
      if (selectedHex) setLiveSelected(list.find((a) => a.hex === selectedHex));
    },
    [selectedHex],
  );

  const onAircraftClick = useCallback(
    (hex: string) => {
      if (raceHexes.length > 0) {
        setRaceHexes((xs) => (xs.includes(hex) ? xs.filter((x) => x !== hex) : xs.length >= 4 ? xs : [...xs, hex]));
        return;
      }
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
      toast("ok", `${w.name} verbunden`);
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

  const onBet = (m: MarketDto, outcome: number, stake: bigint) =>
    withWallet(async (w) => {
      const hash = await signAndSubmit(w, (p) => api.betTx(p, m.id, outcome, stake));
      toast("ok", t.betPlaced, hash);
    });

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
    toast("info", `${q} ist im sichtbaren Bereich nicht zu finden.`);
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
        onAirportClick={(icao) => raceHexes.length === 0 && setSelection({ kind: "airport", icao })}
        onBackgroundClick={() => raceHexes.length === 0 && setSelection(null)}
        onAircraftUpdate={onAircraftUpdate}
        onZoomHint={setZoomHint}
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
          {openCount > 0 && <span className="badge accent num">{openCount} offen</span>}
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
              Wallet<span className="label-wide">verbinden</span>
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
      {zoomHint && <div className="hint">{t.zoomHint}</div>}

      {selection?.kind === "aircraft" && (
        <AircraftPanel
          hex={selection.hex}
          live={liveSelected}
          detail={detail}
          markets={aircraftMarkets}
          scheduleAvailable={!!health?.schedule}
          busy={busy}
          onBet={onBet}
          onCreate={onCreate}
          onStartRace={() => setRaceHexes([selection.hex])}
          onClose={() => setSelection(null)}
        />
      )}
      {selection?.kind === "airport" && (
        <AirportPanel icao={selection.icao} markets={marketList} busy={busy} onBet={onBet} onCreate={onCreate} onClose={() => setSelection(null)} />
      )}
      {selection?.kind === "market" && selectedMarket && (
        <aside className="panel">
          <div className="panel-head">
            <div>
              <h2>Markt</h2>
              <div className="sub">{selectedMarket.kind}</div>
            </div>
            <button type="button" className="icon-btn" onClick={() => setSelection(null)} aria-label={t.close}>
              ✕
            </button>
          </div>
          <div className="panel-body">
            <MarketCard market={selectedMarket} highlight busy={busy} onBet={onBet} />
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
        <span>0 ft</span>
        <span className="scale" />
        <span>40.000 ft</span>
        <span>
          <span className="ring" />
          Markt offen
        </span>
      </div>
      <div className="attribution">{t.attribution}</div>
      <Toasts items={toasts} onDismiss={(id) => setToasts((xs) => xs.filter((x) => x.id !== id))} />
      {walletDialog && <WalletDialog demo={!!health?.demo} onPick={pickWallet} onClose={() => setWalletDialog(false)} />}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </div>
  );
}
