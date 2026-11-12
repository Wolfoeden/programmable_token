import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEBCAMS as webcams, webcamFor } from "@flightradar/core/webcams";
import { CLOSE_LEAD_MIN } from "@flightradar/core/eta";
import { api } from "./api";
import { betState } from "./betState";
import { AboutDialog } from "./components/AboutDialog";
import { AircraftPanel } from "./components/AircraftPanel";
import { AirportPanel } from "./components/AirportPanel";
import { FlightSwitcher } from "./components/FlightSwitcher";
import { INFO_PAGES, InfoDialog, type InfoPage } from "./components/InfoPages";
import { MarketCard, type PreparedBet } from "./components/MarketCard";
import { PortfolioPanel } from "./components/PortfolioPanel";
import { SiteMenu } from "./components/SiteMenu";
import { UpcomingList } from "./components/UpcomingList";
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
const ADMIN_KEY = "frf.operator";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable: operator mode lasts for this page only
  }
}

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
  const { data: jackpot } = usePoll(api.jackpot, 60_000, []);
  const markets = usePoll(api.markets, 5000, []);
  const marketList = markets.data?.markets ?? [];
  const [selection, setSelection] = useState<Selection>(null);
  const [detail, setDetail] = useState<AircraftDetail | null>(null);
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
  /** Operator mode (house): admin token entered via #operator. */
  const [operator, setOperator] = useState<string | null>(() => stored(ADMIN_KEY));
  /** "Preprod ADA" etc.: what the site's stakes are, shown at the wallet. */
  const netLabel = health ? (health.demo ? "Play money" : `${health.network} ADA`) : null;

  const toast = useCallback((kind: Toast["kind"], text: string, detail?: string) => {
    const id = ++toastId.current;
    setToasts((xs) => [...xs.slice(-3), { id, kind, text, ...(detail ? { detail } : {}) }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 9000 : 6000);
  }, []);

  const selectedHex = selection?.kind === "aircraft" ? selection.hex : null;
  selectionRef.current = selection;

  useEffect(() => {
    const onHash = () => {
      setInfoPage(pageFromHash());
      if (window.location.hash === "#operator") void enterOperator();
    };
    if (window.location.hash === "#operator") void enterOperator();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  async function enterOperator() {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    const token = window.prompt("Operator mode: paste the admin token (ADMIN_TOKEN from Render).");
    if (!token) return;
    try {
      await api.adminCheck(token.trim());
      store(ADMIN_KEY, token.trim());
      setOperator(token.trim());
      toast("ok", "Operator mode on. Open markets show a void button.");
    } catch (e) {
      toast("error", errorText(e));
    }
  }

  const onVoid = async (m: MarketDto) => {
    if (!operator) return;
    const reason = window.prompt(`Void "${m.title.en}"?\nEveryone gets their stake back 1:1. Reason (shown to players):`, "Route data was wrong");
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await api.voidMarket(operator, m.id, reason.trim());
      toast("ok", "Market voided. Stakes can be claimed back 1:1.", r.txHash);
      markets.reload();
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

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

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || walletDialog || about || infoPage) return;
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [walletDialog, about, infoPage]);

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
        if (w.networkId !== expected) {
          toast("error", t.wrongNetworkFor(health.network));
          return;
        }
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
  const onPrepare = async (m: MarketDto, outcome: number, stake: bigint, side = false): Promise<PreparedBet | null> => {
    if (!wallet) {
      setWalletDialog(true);
      return null;
    }
    setBusy(true);
    try {
      // A first bet creates the market with exactly the line shown in the preview.
      const line = m.question.kind === "landing_before" ? Number(m.question.threshold) : undefined;
      const res = await api.betTx(await wallet.payload(), m.id, outcome, stake, side, line);
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

  // The connected wallet's stakes per market and outcome (positions plus orders not booked yet).
  const { data: portfolio } = usePoll(async () => (wallet ? api.portfolio(await wallet.payload()) : null), 30_000, [wallet?.id], !!wallet);
  const mine = useMemo(() => {
    const out = new Map<string, Map<number, bigint>>();
    const add = (id: string, o: number, v: bigint) => {
      const m = out.get(id) ?? new Map<number, bigint>();
      m.set(o, (m.get(o) ?? 0n) + v);
      out.set(id, m);
    };
    for (const pos of portfolio?.positions ?? []) for (const h of pos.holdings) add(pos.marketId, h.outcome, BigInt(h.quantity));
    for (const o of portfolio?.orders ?? []) if (o.order.kind === "bet") add(o.marketId, o.order.outcome, BigInt(o.order.stake));
    return out;
  }, [portfolio]);
  /** Flights (hex) the wallet has a bet on. */
  const myHexes = useMemo(() => {
    const set = new Set<string>();
    for (const m of marketList) if (mine.has(m.id)) for (const h of m.icao24) set.add(h);
    return set;
  }, [mine, marketList]);

  // Operator wallet connected: deposits of decided markets it can take back.
  const [deposits, setDeposits] = useState<{ count: number; lovelace: string } | null>(null);
  const loadDeposits = useCallback(async () => {
    if (!wallet || wallet.kind !== "cip30") return setDeposits(null);
    try {
      const r = await api.operatorDeposits((await wallet.payload()).address);
      setDeposits(r.isOperator ? { count: r.count, lovelace: r.lovelace } : null);
    } catch {
      setDeposits(null);
    }
  }, [wallet]);
  useEffect(() => {
    void loadDeposits();
    const id = setInterval(loadDeposits, 60_000);
    return () => clearInterval(id);
  }, [loadDeposits]);

  const onWithdrawDeposits = () =>
    withWallet(async (w) => {
      const hash = await signAndSubmit(w, (p) => api.reclaimDepositsTx(p));
      toast("ok", "Deposits withdrawn to the operator wallet.", hash);
      setTimeout(() => void loadDeposits(), 30_000);
    });

  const onBurnLost = () =>
    withWallet(async (w) => {
      const hash = await signAndSubmit(w, (p) => api.burnTx(p));
      toast("ok", "Lost tickets removed.", hash);
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
  const selectedHasMapPosition = aircraftRef.current.some(a => a.hex === selectedHex && now - a.timestamp <= 120_000);
  const selectedDetailIsFresh = detail?.aircraft.hex === selectedHex && now - detail.aircraft.timestamp <= 120_000;
  const held = selState && selState.kind !== "approaching" && !(selState.kind === "unknown" && (selectedHasMapPosition || selectedDetailIsFresh)) && liveSelected ? { name: flightName(liveSelected), text: stateText(selState, now) } : null;


  return (
    <div className={`app${selection ? " panel-open" : ""}`}>
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
        <UpcomingList
          flights={flights}
          status={data.status}
          selectedHex={selectedHex}
          stateOf={(a) => betState(a, now)}
          onSelect={(a) => (setNotice(null), selectFlight(a))}
          markets={marketList}
          myHexes={myHexes}
          onOpenMarket={(m) => {
            // A live flight opens its flight panel; otherwise the market card alone.
            const live = aircraftRef.current.find((a) => m.icao24.includes(a.hex));
            if (live) selectFlight(live);
            else setSelection({ kind: "market", id: m.id });
          }}
        />
        {!wallet && (
          <button type="button" className="btn primary" onClick={() => setWalletDialog(true)} title={health && !health.demo ? `Only ${health.network} wallets can connect right now` : undefined}>
            <span className="label-wide">Connect</span>Wallet
          </button>
        )}
        <SiteMenu
          wallet={wallet}
          netLabel={netLabel}
          onConnect={() => setWalletDialog(true)}
          onDisconnect={() => {
            setWallet(null);
            remember(null);
          }}
          onMyBets={() => setSelection({ kind: "portfolio" })}
          onAbout={() => setAbout(true)}
          operator={!!operator}
          deposits={deposits}
          jackpot={jackpot?.lovelace ?? null}
          onWithdrawDeposits={onWithdrawDeposits}
          onLeaveOperator={() => {
            store(ADMIN_KEY, null);
            setOperator(null);
          }}
        />
      </header>

      {health?.demo && (
        <div className="banner">
          <span className="label-wide">{health.demo ? t.demoBanner : health.network !== "Mainnet" ? t.testnetBanner(health.network) : ""}</span>
          <span className="label-narrow">{health.demo ? t.demoBannerShort : health.network !== "Mainnet" ? t.testnetBannerShort(health.network) : ""}</span>
        </div>
      )}
      <FlightSwitcher
          flights={flights}
          selectedHex={selectedHex}
          selectedAircraft={liveSelected?.hex === selectedHex ? liveSelected : detail?.aircraft}
          status={data.status}
          notice={notice}
          held={held}
          onSelect={(a) => (setNotice(null), selectFlight(a))}
          stateOf={(a) => betState(a, now)}
        />


      {selection?.kind === "aircraft" && (
        <AircraftPanel
          hex={selection.hex}
          wallet={wallet}
          operator={operator}
          onConnect={() => setWalletDialog(true)}
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
          {...(operator ? { onVoid } : {})}
          onClose={() => setSelection(null)}
          position={{ index: flights.findIndex((f) => f.hex === selection.hex), count: flights.length }}
          mine={mine}
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
            <MarketCard market={selectedMarket} highlight busy={busy} onPrepare={onPrepare} onConfirm={onConfirm} {...(operator ? { onVoid } : {})} />
          </div>
        </aside>
      )}
      {selection?.kind === "portfolio" && wallet && (
        <PortfolioPanel
          wallet={wallet}
          markets={marketList}
          busy={busy}
          onClaim={onClaim}
          onCancel={onCancel}
          onBurnLost={onBurnLost}
          onOpenMarket={(m) => {
            const hex = m.icao24[0];
            if (hex) setSelection({ kind: "aircraft", hex });
            else setSelection({ kind: "market", id: m.id });
          }}
          onClose={() => setSelection(null)}
        />
      )}

      <div className="top-left">
        <a className="brand-logo" href="/" aria-label="flightradar.fun home">
          <img className="logo-wide" src="/logo-wordmark.png" alt="flightradar.fun" />
          <img className="logo-narrow" src="/logo-icon.png" alt="flightradar.fun" />
        </a>
        <div className="legend" aria-hidden>
          <span>
            <span className="dot" style={{ background: "var(--yes)" }} />
            <span className="label-wide">Landing within 1 h</span>
            <span className="label-narrow">≤ 1 h</span>
          </span>
          <span>
            <span className="ring" style={{ borderColor: "var(--accent)", background: "#0b0d10" }} />
            <span className="label-wide">Live-stream airport</span>
            <span className="label-narrow">Live cam</span>
          </span>
          <span>
            <span className="diamond" />
            <span className="label-wide">Departure airport</span>
            <span className="label-narrow">Departure</span>
          </span>
        </div>
      </div>
      <Toasts items={toasts} onDismiss={(id) => setToasts((xs) => xs.filter((x) => x.id !== id))} />
      {walletDialog && <WalletDialog demo={!!health?.demo} network={health?.network ?? null} onPick={pickWallet} onClose={() => setWalletDialog(false)} />}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {infoPage && <InfoDialog page={infoPage} onClose={closeInfo} />}
    </div>
  );
}
