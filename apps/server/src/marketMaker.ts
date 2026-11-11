/**
 * Creates markets on request. The operator seeds every market with the
 * status-quo probabilities from the proposal, so the first price a bettor
 * sees is the model's fair price. Seeds are bets like any other: the
 * operator holds the seed's position tokens and can win or lose them.
 */
import {
  airportByIcao,
  flightKey,
  isWithinRange,
  onRoute,
  landingWithinHour,
  webcamFor,
  flightsOf,
  outcomeLabels,
  parimutuel,
  proposeCancellation,
  proposeDelayAirborne,
  proposeDelayScheduled,
  proposeLandingBefore,
  proposeRace,
  questionTitle,
  tokenLabel,
  type FlightRef,
  type Proposal,
  type ProposalResult,
  type Question,
} from "@flightradar/core";
import { buildCreateMarket, type FtMetadata, type MarketDatum, type MarketView } from "@flightradar/chain";
import type { AdsbSource } from "./adsb.js";
import type { ChainContext } from "./chain.js";
import type { ChainIndex } from "./chainIndex.js";
import type { Config } from "./config.js";
import type { RouteSource } from "./routes.js";
import type { ScheduleProvider } from "./schedule.js";
import type { MarketMeta, Store } from "./store.js";
import type { Tracker } from "./tracker.js";
import type { CamTraffic } from "./traffic.js";
import { HttpError, log } from "./util.js";

const ADA = 1_000_000n;
const DAY = 86_400_000;

export interface CreatedMarket {
  marketId: string;
  txHash?: string;
  existing: boolean;
}

function sameFlights(a: Question, b: Question): boolean {
  if (a.kind !== b.kind) return false;
  const ka = flightsOf(a).map(flightKey).sort().join(",");
  const kb = flightsOf(b).map(flightKey).sort().join(",");
  if (ka !== kb) return false;
  if (a.kind === "delay" && b.kind === "delay") return a.minutes === b.minutes;
  return true;
}

function ticker(q: Question, outcome: number): string {
  const name = (f: FlightRef) => (f.flightNumber || f.callsign).slice(0, 7);
  if (q.kind === "race") return name(q.flights[outcome]!).slice(0, 9);
  return `${name(flightsOf(q)[0]!)}${outcome === 0 ? "Y" : "N"}`.slice(0, 9);
}

export class MarketMaker {
  private creating = new Map<string, MarketMeta>();
  /** Datum of each market being created, so bets can go in as orders before it is confirmed. */
  private creatingViews = new Map<string, MarketView>();
  /** Departure-board markets (cancellation, pre-departure delay). Off by default. */
  allowScheduled = false;

  /** Tests can switch these back on. */
  allowRaces = false;
  allowSimulatedSchedule = false;

  constructor(
    private cfg: Config,
    private ctx: ChainContext,
    private index: ChainIndex,
    private adsb: AdsbSource,
    private routes: RouteSource,
    private schedule: ScheduleProvider | undefined,
    private store: Store,
    private tracker: Tracker,
    private traffic?: CamTraffic,
  ) {}

  /** Markets submitted but not yet visible in the chain index. */
  pending(): MarketMeta[] {
    for (const id of this.creating.keys()) if (this.index.market(id)) this.drop(id);
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, m] of this.creating) if (m.createdAt < cutoff) this.drop(id);
    return [...this.creating.values()];
  }

  /**
   * A market submitted but not yet in the index, as the order builder needs
   * it. An order only names the market id and deadline, so it can be placed
   * at once; the batcher books it as soon as the market is confirmed.
   */
  pendingView(id: string): MarketView | undefined {
    return this.index.market(id) ? undefined : this.creatingViews.get(id);
  }

  private drop(id: string): void {
    this.creating.delete(id);
    this.creatingViews.delete(id);
  }

  private findExisting(q: Question): string | undefined {
    const now = this.ctx.now();
    const open = this.index.markets.find(
      (m) => m.datum.state.kind === "open" && Number(m.datum.closeTime) > now && sameFlights(m.datum.question, q),
    );
    if (open) return open.datum.marketId;
    return [...this.creating.values()].find((m) => sameFlights(m.question, q))?.marketId;
  }

  async flightFor(hex: string): Promise<{ flight: FlightRef; ac: Awaited<ReturnType<AdsbSource["byHex"]>>[number] }> {
    const ac = this.traffic?.find(hex) ?? (await this.adsb.byHex([hex]))[0];
    if (!ac) throw new HttpError(404, "aircraft_not_found", "Aircraft not visible right now");
    if (!ac.callsign) throw new HttpError(422, "no_callsign", "No callsign received");
    const route = await this.routes.lookup(ac.callsign);
    if (!route) throw new HttpError(422, "unknown_route", "Route unknown");
    // Only flights of up to about three hours into a live-stream airport, landing within the hour, are bettable.
    const dest = airportByIcao(route.destination);
    if (!webcamFor(route.destination) || !dest || !isWithinRange(route.origin, route.destination) || !onRoute(ac, route.origin, route.destination) || !landingWithinHour(ac, dest, this.ctx.now())) {
      throw new HttpError(422, "not_eligible", "Markets are only offered on short flights landing at a live-stream airport within the next hour");
    }
    return {
      ac,
      flight: { callsign: ac.callsign, flightNumber: route.flightNumber, icao24: ac.hex, origin: route.origin, destination: route.destination },
    };
  }

  private unwrap(r: ProposalResult): Proposal {
    if (!r.ok) throw new HttpError(422, r.error);
    return r.proposal;
  }

  async landing(hex: string): Promise<CreatedMarket> {
    const { ac, flight } = await this.flightFor(hex);
    const proposal = this.unwrap(proposeLandingBefore(ac, flight, this.ctx.now()));
    this.tracker.ingest(flight, ac);
    return this.create(proposal, BigInt(this.cfg.SEED_ADA) * ADA, BigInt(this.cfg.MAX_TOTAL_ADA) * ADA, false);
  }

  async race(hexes: string[]): Promise<CreatedMarket> {
    // Races are switched off: players would pick exactly the pairs the model gets wrong.
    if (!this.allowRaces) throw new HttpError(422, "not_offered", "Races are not offered");
    if (hexes.length < 2 || hexes.length > 4) throw new HttpError(422, "race_size", "A race needs 2 to 4 flights");
    const entries = [];
    for (const hex of hexes) entries.push(await this.flightFor(hex));
    const proposal = this.unwrap(proposeRace(entries, this.ctx.now()));
    entries.forEach((e) => this.tracker.ingest(e.flight, e.ac));
    return this.create(proposal, BigInt(this.cfg.SEED_ADA) * ADA, BigInt(this.cfg.MAX_TOTAL_ADA) * ADA, false);
  }

  async delayAirborne(hex: string, minutes: number): Promise<CreatedMarket> {
    if (!this.schedule) throw new HttpError(501, "schedule_unavailable", "No schedule provider configured");
    // A simulated timetable would mean an invented scheduled arrival.
    if (this.schedule.simulated && !this.allowSimulatedSchedule) throw new HttpError(422, "not_offered", "Delay predictions need a real timetable");
    const { ac, flight } = await this.flightFor(hex);
    const sched = await this.schedule.airborne(flight, this.ctx.now(), ac);
    if (!sched) throw new HttpError(422, "schedule_not_found", "Schedule for this flight not found");
    const proposal = this.unwrap(proposeDelayAirborne(ac, flight, sched.scheduledArrival, minutes, this.ctx.now()));
    this.tracker.ingest(flight, ac);
    return this.create(proposal, BigInt(this.cfg.SEED_ADA) * ADA, BigInt(this.cfg.MAX_TOTAL_ADA) * ADA, this.schedule.simulated);
  }

  async scheduled(kind: "cancellation" | "delay", flightNumber: string, origin: string, scheduledDeparture: number, minutes = 15): Promise<CreatedMarket> {
    // Pre-departure markets are switched off: only flights landing at a
    // live-stream airport within the hour are bettable.
    if (!this.allowScheduled) throw new HttpError(422, "not_eligible", "Markets are only offered on flights landing at a live-stream airport within the next hour");
    if (!this.schedule) throw new HttpError(501, "schedule_unavailable", "No schedule provider configured");
    const f = await this.schedule.status(flightNumber, origin, scheduledDeparture);
    if (!f) throw new HttpError(404, "flight_not_found", "Flight not in the schedule");
    if (f.status !== "scheduled" && f.status !== "delayed") throw new HttpError(422, "already_departed", "Flight is no longer scheduled on the ground");
    const flight: FlightRef = {
      callsign: f.callsign ?? "",
      flightNumber: f.flightNumber,
      icao24: "",
      origin: f.origin,
      destination: f.destination,
    };
    const now = this.ctx.now();
    if (kind === "cancellation") {
      const proposal = this.unwrap(proposeCancellation(flight, f.scheduledDeparture, now));
      return this.create(proposal, BigInt(this.cfg.SEED_ADA_CANCELLATION) * ADA, BigInt(this.cfg.MAX_TOTAL_ADA_CANCELLATION) * ADA, this.schedule.simulated);
    }
    if (!flight.callsign) throw new HttpError(422, "no_callsign", "Without a callsign the landing cannot be tracked");
    const proposal = this.unwrap(proposeDelayScheduled(flight, f.scheduledDeparture, f.scheduledArrival, minutes, now));
    return this.create(proposal, BigInt(this.cfg.SEED_ADA) * ADA, BigInt(this.cfg.MAX_TOTAL_ADA) * ADA, this.schedule.simulated);
  }

  private async create(proposal: Proposal, seed: bigint, maxTotal: bigint, simulated: boolean): Promise<CreatedMarket> {
    const existing = this.findExisting(proposal.question);
    if (existing) return { marketId: existing, existing: true };
    const open = this.index.markets.filter((m) => m.datum.state.kind === "open").length + this.creating.size;
    if (open >= this.cfg.MAX_OPEN_MARKETS) throw new HttpError(429, "too_many_markets", "Too many open markets right now");

    const q = proposal.question;
    const pools = parimutuel.seedPools(proposal.probabilities, seed, ADA);
    const claimDeadline = proposal.resolveDeadline + this.cfg.CLAIM_WINDOW_DAYS * DAY;
    const metadata = (marketId: string): FtMetadata[] =>
      outcomeLabels(q, "en").map((label, i) => ({
        name: tokenLabel(q, i),
        description: `${questionTitle(q, "en")} | ${label}`,
        ticker: ticker(q, i),
        url: `${this.cfg.PUBLIC_URL}/?market=${marketId}`,
        decimals: 6,
      }));
    let marketId = "";
    let datum: MarketDatum | undefined;
    const txHash = await this.ctx.operator.run(async (walletUtxos) => {
      const built = await buildCreateMarket(
        this.ctx.operator.lucid,
        this.ctx.contracts,
        {
          question: q,
          pools,
          closeTime: proposal.closeTime,
          resolveDeadline: proposal.resolveDeadline,
          claimDeadline,
          feeBps: BigInt(this.cfg.FEE_BPS),
          maxTotal,
          metadata,
          now: this.ctx.now(),
        },
        { walletUtxos },
      );
      marketId = built.marketId;
      datum = built.datum;
      return built.tx;
    });
    const meta: MarketMeta = {
      marketId,
      question: q,
      createdAt: Date.now(),
      txHash,
      probabilities: proposal.probabilities,
      model: proposal.model,
      seedLovelace: pools.map(String),
      ...(simulated ? { simulated } : {}),
    };
    this.store.putMeta(meta);
    this.creating.set(marketId, meta);
    this.index.hurry();
    if (datum) this.creatingViews.set(marketId, { utxo: { txHash, outputIndex: 0, address: this.ctx.contracts.marketAddress, assets: {} }, datum });
    for (const f of flightsOf(q)) this.tracker.watch(f, proposal.resolveDeadline);
    log.info("market created", { marketId, kind: q.kind, txHash, probabilities: proposal.probabilities.map((p) => p.toFixed(3)) });
    return { marketId, txHash, existing: false };
  }
}
