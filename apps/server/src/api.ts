/** HTTP API. */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { addressFromHexOrBech32, getAddressDetails, Lucid, type Assets } from "@lucid-evolution/lucid";
import {
  webcamFor,
  normalCdf,
  airportByIcao,
  parimutuel,
  proposeCancellation,
  proposeDelayScheduled,
  type FlightRef,
} from "@flightradar/core";
import {
  buildBet,
  buildBetOrder,
  buildCancelOrder,
  DEFAULT_BATCHER_FEE,
  ORDER_DEPOSIT,
  buildClaim,
  buildClaimOrder,
  claimValue,
  MarketError,
  parsePositionName,
  positionName,
  positionsIn,
  unit,
} from "@flightradar/chain";
import type { AdsbSource } from "./adsb.js";
import { decodeUtxo, encodeUtxo, type ChainContext } from "./chain.js";
import type { ChainIndex } from "./chainIndex.js";
import type { Config } from "./config.js";
import { aircraftDto, marketDto, pendingMarketDto } from "./dto.js";
import type { MarketMaker } from "./marketMaker.js";
import type { RouteSource } from "./routes.js";
import type { ScheduleProvider } from "./schedule.js";
import type { Store } from "./store.js";
import type { Tracker } from "./tracker.js";
import type { ShadowLog } from "./shadow.js";
import type { CamTraffic } from "./traffic.js";
import { HttpError, RateLimiter, toJson } from "./util.js";

export interface Services {
  cfg: Config;
  ctx: ChainContext;
  index: ChainIndex;
  adsb: AdsbSource;
  routes: RouteSource;
  schedule: ScheduleProvider | undefined;
  store: Store;
  maker: MarketMaker;
  traffic: CamTraffic;
  tracker: Tracker;
  /** Shadow log of model, outcomes and bets (optional in tests). */
  shadow?: ShadowLog;
}

const Hex = z.string().regex(/^[0-9a-fA-F]+$/);
const MarketId = z.string().regex(/^[0-9a-f]{54}$/);
const WalletBody = z.object({ address: z.string().min(10), utxos: z.array(Hex).max(500) });

function bech32(address: string): string {
  return addressFromHexOrBech32(address).to_bech32(undefined);
}

export async function buildApi(s: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024, trustProxy: s.cfg.TRUST_PROXY });
  await app.register(cors, { origin: true });
  const marketRequests = new RateLimiter(s.cfg.MARKET_REQUESTS_PER_HOUR, 3600_000);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof MarketError) return reply.status(422).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "bad_request", message: err.issues.map((i) => i.message).join("; ") });
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: "internal", message: message.slice(0, 500) });
  });

  const now = () => s.ctx.now();
  const allMarketDtos = () => {
    const live = s.index.markets.map((m) => marketDto(m, now(), s.index.orders, s.store.getMeta(m.datum.marketId), s.store.getEvidence(m.datum.marketId)));
    const pending = s.maker.pending().map(pendingMarketDto);
    return [...pending, ...live];
  };
  const openMarketsByHex = () => {
    const counts = new Map<string, number>();
    for (const m of s.index.markets) {
      if (m.datum.state.kind !== "open") continue;
      for (const f of (m.datum.question.kind === "race" ? m.datum.question.flights : [m.datum.question.flight]) as FlightRef[]) {
        if (f.icao24) counts.set(f.icao24, (counts.get(f.icao24) ?? 0) + 1);
      }
    }
    for (const m of s.maker.pending()) for (const hex of pendingMarketDto(m).icao24) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    return counts;
  };

  // ## Info

  app.get("/api/health", async () =>
    toJson({
      ok: true,
      network: s.ctx.network,
      demo: s.cfg.DEMO,
      now: now(),
      contracts: { market: s.ctx.contracts.marketHash, order: s.ctx.contracts.orderHash, metadata: s.ctx.contracts.metadataHash },
      operator: s.ctx.operator.address,
      schedule: s.schedule ? { name: s.schedule.name, simulated: s.schedule.simulated } : null,
      markets: s.index.markets.length,
      indexedAt: s.index.updatedAt,
    }),
  );

  // ## Live traffic

  /**
   * Map traffic: aircraft landing at or taking off from webcam airports,
   * plus every flight that has a market. Same answer for all clients.
   */
  app.get("/api/aircraft", async () => {
    s.traffic.touch();
    const counts = openMarketsByHex();
    const out = new Map<string, ReturnType<typeof aircraftDto>>();
    for (const a of s.tracker.allLatest()) out.set(a.hex, aircraftDto(a, counts.get(a.hex) ?? 0));
    for (const x of s.traffic.list()) {
      const prev = out.get(x.aircraft.hex);
      const ac = prev && prev.timestamp > x.aircraft.timestamp ? { ...x.aircraft, ...prev } : x.aircraft;
      const { aircraft: _a, ...movement } = x;
      out.set(ac.hex, aircraftDto(ac, counts.get(ac.hex) ?? 0, movement));
    }
    return {
      now: Date.now(),
      status: s.traffic.status(),
      updatedAt: s.traffic.updatedAt || null,
      aircraft: [...out.values()],
      arrivals: s.traffic.arrivalList().filter((a) => a.status !== "approaching"),
    };
  });

  /** Recorded paths (lon, lat, ms) of up to four listed flights, for race and watch views. */
  app.get("/api/tracks", async (req) => {
    const { hex } = z.object({ hex: z.string().regex(/^[0-9a-f]{6}(,[0-9a-f]{6}){0,3}$/i) }).parse(req.query);
    const tracks: Record<string, ReturnType<typeof s.traffic.track>> = {};
    for (const h of hex.toLowerCase().split(",")) tracks[h] = s.traffic.track(h);
    return { tracks };
  });

  app.get("/api/aircraft/:hex", async (req) => {
    const { hex } = z.object({ hex: z.string().regex(/^[0-9a-f]{6}$/i) }).parse(req.params);
    const [ac] = await s.adsb.byHex([hex]);
    if (!ac) throw new HttpError(404, "aircraft_not_found");
    const route = ac.callsign ? await s.routes.lookup(ac.callsign) : null;
    const markets = allMarketDtos().filter((m) => m.icao24.includes(ac.hex));
    const shown = s.traffic.list().find((x) => x.aircraft.hex === ac.hex);
    const { aircraft: _a, ...movement } = shown ?? { aircraft: ac };
    return toJson({
      aircraft: aircraftDto(ac, markets.length, shown ? (movement as Parameters<typeof aircraftDto>[2]) : undefined),
      route,
      origin: route ? airportByIcao(route.origin) ?? null : null,
      destination: route ? airportByIcao(route.destination) ?? null : null,
      markets,
    });
  });

  // ## Live streams

  /**
   * Whether a live-stream airport's video can be embedded. Uses YouTube's
   * oEmbed endpoint: 200 = embeddable video, 401/403 = embedding disabled,
   * 404 = removed or private. It cannot tell whether a live broadcast is on
   * air right now; the player shows that itself.
   */
  const streamChecks = new Map<string, { at: number; value: { icao: string; url: string; videoId: string | null; embeddable: boolean; checkedAt: number; reason?: string } }>();
  app.get("/api/streams/:icao", async (req) => {
    const { icao } = z.object({ icao: z.string().length(4) }).parse(req.params);
    const cam = webcamFor(icao);
    if (!cam) throw new HttpError(404, "no_stream", "No live stream for this airport");
    const hit = streamChecks.get(cam.icao);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const videoId = /[?&]v=([A-Za-z0-9_-]{11})/.exec(cam.url)?.[1] ?? null;
    let embeddable = false;
    let reason: string | undefined;
    if (!videoId) reason = "The source is a channel page, not a single video, so it cannot be embedded.";
    else {
      try {
        const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, {
          signal: AbortSignal.timeout(8000),
        });
        embeddable = res.ok;
        if (!res.ok) reason = res.status === 404 ? "The video was removed or is private." : "The owner does not allow embedding.";
      } catch {
        reason = "The stream could not be checked right now.";
      }
    }
    const value = { icao: cam.icao, url: cam.url, videoId, embeddable, checkedAt: Date.now(), ...(reason ? { reason } : {}) };
    streamChecks.set(cam.icao, { at: Date.now(), value });
    return value;
  });

  // ## Markets

  app.get("/api/markets", async (req) => {
    const q = z.object({ hex: z.string().optional(), phase: z.string().optional() }).parse(req.query);
    let list = allMarketDtos();
    if (q.hex) list = list.filter((m) => m.icao24.includes(q.hex!.toLowerCase()));
    if (q.phase) list = list.filter((m) => q.phase!.split(",").includes(m.phase));
    return toJson({ now: now(), markets: list });
  });

  app.get("/api/markets/:id", async (req) => {
    const { id } = z.object({ id: MarketId }).parse(req.params);
    const m = s.index.market(id);
    if (!m) {
      const pending = s.maker.pending().find((x) => x.marketId === id);
      if (pending) return toJson({ market: pendingMarketDto(pending) });
      throw new HttpError(404, "market_not_found");
    }
    return toJson({ market: marketDto(m, now(), s.index.orders, s.store.getMeta(id), s.store.getEvidence(id)), evidence: s.store.getEvidence(id) ?? null });
  });

  app.post("/api/markets", async (req: FastifyRequest) => {
    if (!marketRequests.allow(req.ip)) throw new HttpError(429, "rate_limited", "Too many new markets, please try again later");
    const body = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("landing_before"), hex: z.string() }),
        z.object({ kind: z.literal("delay"), hex: z.string(), minutes: z.number().int().min(15).max(180).default(15) }),
        z.object({
          kind: z.literal("scheduled"),
          market: z.enum(["cancellation", "delay"]),
          flightNumber: z.string().min(2).max(10),
          origin: z.string().length(4),
          scheduledDeparture: z.number().int(),
          minutes: z.number().int().min(15).max(180).default(15),
        }),
      ])
      .parse(req.body);
    let created;
    switch (body.kind) {
      case "landing_before":
        created = await s.maker.landing(body.hex.toLowerCase());
        break;
      case "delay":
        created = await s.maker.delayAirborne(body.hex.toLowerCase(), body.minutes);
        break;
      case "scheduled":
        created = await s.maker.scheduled(body.market, body.flightNumber.toUpperCase(), body.origin.toUpperCase(), body.scheduledDeparture, body.minutes);
        break;
    }
    return created;
  });

  app.get("/api/airports/:icao/departures", async (req) => {
    const { icao } = z.object({ icao: z.string().length(4) }).parse(req.params);
    const airport = airportByIcao(icao);
    if (!airport) throw new HttpError(404, "airport_not_found");
    if (!s.schedule) throw new HttpError(501, "schedule_unavailable", "No schedule provider configured (AERODATABOX_KEY)");
    const t = Date.now();
    const flights = await s.schedule.departures(airport.icao, t, t + 12 * 3600_000);
    const markets = allMarketDtos();
    return toJson({
      airport,
      provider: { name: s.schedule.name, simulated: s.schedule.simulated },
      departures: flights.map((f) => {
        const ref: FlightRef = { callsign: f.callsign ?? "", flightNumber: f.flightNumber, icao24: "", origin: f.origin, destination: f.destination };
        const cancel = proposeCancellation(ref, f.scheduledDeparture, now());
        const delay = proposeDelayScheduled(ref, f.scheduledDeparture, f.scheduledArrival, 15, now());
        const related = markets.filter(
          (m) =>
            (m.question.kind === "cancellation" || m.question.kind === "delay") &&
            m.question.flight.flightNumber === f.flightNumber &&
            m.question.flight.origin === f.origin,
        );
        return {
          ...f,
          quotes: {
            cancellation: cancel.ok ? cancel.proposal.probabilities[0] : null,
            delay: delay.ok && f.callsign ? delay.proposal.probabilities[0] : null,
          },
          markets: related.map((m) => ({ id: m.id, kind: m.kind, phase: m.phase })),
        };
      }),
    });
  });

  // ## Wallet transactions (unsigned CBOR for CIP-30 wallets)

  /**
   * The user's wallet for building a transaction. Rejects wallets whose coins
   * cannot exist on this server's chain, with a message saying why, instead
   * of failing later at submission ("UTxO does not exist").
   */
  const walletLucid = async (body: z.infer<typeof WalletBody>) => {
    const addr = bech32(body.address);
    if (s.cfg.DEMO) {
      if (!s.ctx.demoWallets.some((d) => d.account.address === addr)) {
        throw new HttpError(
          409,
          "demo_real_wallet",
          "This site runs in demo mode on a simulated blockchain. Coins from a real wallet (Preview, Preprod or Mainnet) do not exist there. Please use a demo wallet.",
        );
      }
      return s.ctx.userLucid(addr, body.utxos);
    }
    const mainnetAddr = addr.startsWith("addr1") || addr.startsWith("stake1");
    if (mainnetAddr !== (s.ctx.network === "Mainnet")) {
      throw new HttpError(409, "wrong_network", `Your wallet is on ${mainnetAddr ? "Mainnet" : "a testnet"}, this site runs on ${s.ctx.network}.`);
    }
    // Preview and Preprod addresses look the same: check that the coins exist here.
    const known = new Set((await s.ctx.provider.getUtxos(addr)).map((u) => `${u.txHash}#${u.outputIndex}`));
    const mine = body.utxos.filter((cbor) => {
      const u = decodeUtxo(cbor);
      return known.has(`${u.txHash}#${u.outputIndex}`);
    });
    if (body.utxos.length > 0 && mine.length === 0) {
      throw new HttpError(
        409,
        "wallet_other_network",
        `None of your wallet's coins exist on ${s.ctx.network}. Switch the wallet to ${s.ctx.network} (Preview and Preprod are separate testnets) and get test ADA from the ${s.ctx.network} faucet.`,
      );
    }
    return s.ctx.userLucid(addr, mine);
  };
  const requireMarket = (id: string, forDirectUse = false) => {
    const m = s.index.market(id);
    if (!m) throw new HttpError(404, "market_not_found", "Market not confirmed yet or unknown");
    if (forDirectUse && s.index.isStale(id)) throw new HttpError(409, "market_updating", "Market is updating, please try again shortly");
    return m;
  };

  app.post("/api/tx/bet", async (req) => {
    const body = WalletBody.extend({
      marketId: MarketId,
      outcome: z.number().int().min(0).max(7),
      stake: z.string().regex(/^\d+$/),
      mode: z.enum(["order", "direct"]).default("order"),
    }).parse(req.body);
    const stake = BigInt(body.stake);
    if (stake < 1_000_000n) throw new HttpError(422, "stake_too_small", "Minimum stake is 1 ADA");
    const lucid = await walletLucid(body);
    const m = requireMarket(body.marketId, body.mode === "direct");
    const tx =
      body.mode === "direct"
        ? await buildBet(lucid, s.ctx.contracts, m, body.outcome, stake, now())
        : await buildBetOrder(lucid, s.ctx.contracts, m, body.outcome, stake, now());
    const quote = parimutuel.quote(m.datum.pools, body.outcome, m.datum.feeBps, stake);
    const networkFee = BigInt(tx.toTransaction().body().fee());
    if (s.shadow) {
      const q = m.datum.question;
      const hex = q.kind === "race" ? undefined : q.flight.icao24 || undefined;
      const est = hex ? s.traffic.estimate(hex) : undefined;
      const threshold = q.kind === "landing_before" ? Number(q.threshold) : undefined;
      s.shadow.bet({
        v: 1,
        kind: "bet",
        txHash: tx.toHash(),
        at: Date.now(),
        marketId: m.datum.marketId,
        question: q.kind,
        ...(hex ? { hex } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        outcome: body.outcome,
        stake: stake.toString(),
        wallet: s.shadow.walletId(bech32(body.address)),
        closeTime: Number(m.datum.closeTime),
        pools: m.datum.pools.map(String),
        multiplier: quote.multiplier,
        model: est && threshold !== undefined ? { ...est, pYes: normalCdf((threshold - est.etaMs) / est.sigmaMs) } : null,
      });
    }
    return toJson({
      tx: tx.toCBOR(),
      quote: { payout: quote.payout, multiplier: quote.multiplier, probabilityAfter: quote.probabilityAfter },
      costs: {
        stake,
        networkFee,
        batcherFee: body.mode === "direct" ? 0n : DEFAULT_BATCHER_FEE,
        deposit: body.mode === "direct" ? 0n : ORDER_DEPOSIT,
        feeBps: m.datum.feeBps,
        closeTime: Number(m.datum.closeTime),
      },
    });
  });

  app.post("/api/tx/claim", async (req) => {
    const body = WalletBody.extend({ marketId: MarketId, mode: z.enum(["order", "direct"]).default("order") }).parse(req.body);
    const m = requireMarket(body.marketId, body.mode === "direct");
    const lucid = await walletLucid(body);
    const utxos = await lucid.wallet().getUtxos();
    const holdings: Assets = {};
    for (const u of utxos) for (const [k, v] of Object.entries(u.assets)) holdings[k] = (holdings[k] ?? 0n) + v;
    const positions = positionsIn(s.ctx.contracts, holdings, m.datum.marketId);
    if (positions.size === 0) throw new HttpError(422, "nothing_to_claim", "No positions in this market");
    if (body.mode === "direct") return toJson({ tx: (await buildClaim(lucid, s.ctx.contracts, m, positions)).toCBOR(), value: claimValue(m.datum, positions) });
    const tokens: Assets = {};
    for (const [outcome, q] of positions) tokens[unit(s.ctx.contracts.marketHash, positionName(m.datum.marketId, outcome))] = q;
    return toJson({ tx: (await buildClaimOrder(lucid, s.ctx.contracts, m, tokens)).toCBOR(), value: claimValue(m.datum, positions) });
  });

  app.post("/api/tx/cancel", async (req) => {
    const body = WalletBody.extend({ order: z.string().regex(/^[0-9a-f]{64}#\d+$/) }).parse(req.body);
    const o = s.index.orders.find((x) => `${x.utxo.txHash}#${x.utxo.outputIndex}` === body.order);
    if (!o) throw new HttpError(404, "order_not_found");
    const lucid = await walletLucid(body);
    return { tx: (await buildCancelOrder(lucid, s.ctx.contracts, o)).toCBOR() };
  });

  app.post("/api/tx/submit", async (req) => {
    const body = z.object({ tx: Hex, witness: Hex }).parse(req.body);
    const lucid = await s.ctx.newLucid();
    // Lucid submits through the selected wallet; an address-only wallet
    // forwards to the provider without holding any key.
    lucid.selectWallet.fromAddress(s.ctx.operator.address, []);
    const signed = await lucid.fromTx(body.tx).assemble([body.witness]).complete();
    const txHash = await signed.submit().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist or was already spent|BadInputsUTxO/i.test(msg)) {
        throw new HttpError(
          409,
          "utxo_spent",
          s.cfg.DEMO
            ? "A coin in this transaction does not exist on the simulated demo chain. Use a demo wallet; real wallets do not work in demo mode."
            : `A coin in this transaction was already spent or does not exist on ${s.ctx.network}. Wait a moment and try again.`,
        );
      }
      throw e;
    });
    s.shadow?.submitted(txHash);
    setTimeout(() => void s.index.refresh(), 1500);
    return { txHash };
  });

  /** Positions and open orders of a wallet. */
  app.post("/api/portfolio", async (req) => {
    const body = WalletBody.parse(req.body);
    const lucid = await walletLucid(body);
    const utxos = await lucid.wallet().getUtxos();
    const holdings: Assets = {};
    for (const u of utxos) for (const [k, v] of Object.entries(u.assets)) holdings[k] = (holdings[k] ?? 0n) + v;
    const byMarket = new Map<string, Map<number, bigint>>();
    for (const [u, q] of Object.entries(holdings)) {
      if (u === "lovelace" || !u.startsWith(s.ctx.contracts.marketHash)) continue;
      const p = parsePositionName(u.slice(56));
      if (!p) continue;
      const m = byMarket.get(p.marketId) ?? new Map<number, bigint>();
      m.set(p.outcome, (m.get(p.outcome) ?? 0n) + q);
      byMarket.set(p.marketId, m);
    }
    const keyHash = getAddressDetails(bech32(body.address)).paymentCredential?.hash;
    const positions = [...byMarket].map(([marketId, pos]) => {
      const m = s.index.market(marketId);
      const holdingsByOutcome = [...pos].map(([outcome, quantity]) => ({ outcome, quantity }));
      if (!m) return { marketId, holdings: holdingsByOutcome, market: null, claimable: "0", ifWins: [] as string[] };
      const ifWins = m.datum.pools.map((_, i) => {
        const q = pos.get(i) ?? 0n;
        return q === 0n ? 0n : parimutuel.winnerPayout(m.datum.pools, i, m.datum.feeBps, q);
      });
      return {
        marketId,
        holdings: holdingsByOutcome,
        market: marketDto(m, now(), s.index.orders, s.store.getMeta(marketId), s.store.getEvidence(marketId)),
        claimable: m.datum.state.kind === "resolved" ? claimValue(m.datum, pos) : 0n,
        ifWins,
      };
    });
    const orders = s.index.orders
      .filter((o) => o.datum.ownerKey === keyHash)
      .map((o) => ({
        ref: `${o.utxo.txHash}#${o.utxo.outputIndex}`,
        marketId: o.datum.marketId,
        order: o.datum.order,
        lovelace: o.utxo.assets.lovelace ?? 0n,
        deadline: Number(o.datum.deadline),
      }));
    return toJson({ lovelace: holdings.lovelace ?? 0n, positions, orders });
  });

  // ## Admin: shadow log download (only with ADMIN_TOKEN)

  if (s.cfg.ADMIN_TOKEN && s.shadow) {
    const shadow = s.shadow;
    const token = s.cfg.ADMIN_TOKEN;
    const auth = (req: FastifyRequest) => {
      if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, "unauthorized");
    };
    app.get("/api/admin/shadow", async (req) => {
      auth(req);
      return { files: shadow.files() };
    });
    app.get("/api/admin/shadow/:file", async (req, reply) => {
      auth(req);
      const { file } = z.object({ file: z.string() }).parse(req.params);
      const text = shadow.read(file);
      if (text === null) throw new HttpError(404, "not_found");
      return reply.type("application/x-ndjson").send(text);
    });
  }

  // ## Demo wallets (demo mode only)

  if (s.cfg.DEMO) {
    const demo = (name: string) => {
      const w = s.ctx.demoWallets.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (!w) throw new HttpError(404, "wallet_not_found");
      return w;
    };
    app.get("/api/demo/wallets", async () => {
      const out = [];
      for (const w of s.ctx.demoWallets) {
        const utxos = await s.ctx.provider.getUtxos(w.account.address);
        out.push({ name: w.name, address: w.account.address, lovelace: utxos.reduce((a, u) => a + (u.assets.lovelace ?? 0n), 0n) });
      }
      return toJson({ wallets: out });
    });
    app.get("/api/demo/wallets/:name/utxos", async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const w = demo(name);
      const utxos = await s.ctx.provider.getUtxos(w.account.address);
      return { address: w.account.address, utxos: utxos.map(encodeUtxo) };
    });
    app.post("/api/demo/wallets/:name/sign", async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const { tx } = z.object({ tx: Hex }).parse(req.body);
      const w = demo(name);
      const lucid = await Lucid(s.ctx.provider, s.ctx.network);
      lucid.selectWallet.fromSeed(w.account.seedPhrase);
      return { witness: await lucid.fromTx(tx).partialSign.withWallet() };
    });
  }

  // ## Web app

  if (s.cfg.WEB_DIST) {
    const root = resolve(s.cfg.WEB_DIST);
    if (existsSync(root)) {
      await app.register(fastifyStatic, { root, prefix: "/" });
      app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.status(404).send({ error: "not_found" }) : reply.sendFile("index.html")));
    }
  }

  return app;
}
