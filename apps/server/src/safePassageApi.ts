import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { z } from "zod";
import { buildSafeBet, buildSafeClaim, buildSafeClose, safePositions } from "@flightradar/chain";
import { safeCapacity, safeClaim, safePayout } from "@flightradar/core/safePassage";
import type { ChainContext } from "./chain.js";
import type { SafePassageService } from "./safePassage.js";
import { HttpError, RateLimiter } from "./util.js";

const Id = z.string().regex(/^[a-f0-9]{54}$/);
const Hex = z.string().regex(/^[a-f0-9]{6}$/);
const Wallet = z.object({ address: z.string().min(10), utxos: z.array(z.string().regex(/^[a-f0-9]+$/i)).max(500) });
const Sources = z.array(z.url().refine(s => new URL(s).protocol === "https:", "Use HTTPS evidence sources")).max(10);

export function registerSafePassageApi(app: FastifyInstance, service: SafePassageService | undefined,
  walletLucid: (body: { address: string; utxos: string[] }, opts?: { verify?: boolean }) => Promise<LucidEvolution>,
  auth: (req: FastifyRequest) => void, ctx: ChainContext) {
  const rate = new RateLimiter(30, 3600_000);
  const enabled = () => {
    if (!service?.cfg.SAFE_PASSAGE_ENABLED) throw new HttpError(409, "safe_disabled", "Safe Passage is not enabled");
    return service;
  };
  const limit = (req: FastifyRequest) => { if (!rate.allow(req.ip)) throw new HttpError(429, "rate_limited"); };

  app.get("/api/safe-passage/flight/:hex", async req => {
    const { hex } = z.object({ hex: Hex }).parse(req.params);
    if (!service?.cfg.SAFE_PASSAGE_ENABLED) return { enabled: false, market: null };
    await service.refresh();
    const m = service.forFlight(hex);
    return { enabled: true, market: m ? service.dto(m) : null, reservePerMarket: String(BigInt(service.cfg.SAFE_PASSAGE_RESERVE_ADA) * 1_000_000n) };
  });

  app.get("/api/safe-passage/markets", async () => {
    const s = enabled(); await s.refresh(); return { markets: s.all().map(m => s.dto(m)) };
  });

  app.post("/api/safe-passage/quote", async req => {
    limit(req); const s = enabled();
    const body = Wallet.extend({ marketId: Id, outcome: z.union([z.literal(0), z.literal(1)]), stake: z.string().regex(/^[0-9]{1,18}$/) }).parse(req.body);
    const stake = BigInt(body.stake);
    if (stake < 1_000_000n || stake > BigInt(s.cfg.SAFE_PASSAGE_MAX_STAKE_ADA) * 1_000_000n) throw new HttpError(422, "bad_stake", "Stake is outside the per-bet limits");
    const m = await s.require(body.marketId, true);
    await s.eligible(m.datum.flight);
    if (stake > safeCapacity(m.datum, body.outcome)) throw new HttpError(409, "cap_reached", "The requested payout is not fully covered");
    const lucid = await walletLucid(body);
    const tx = await buildSafeBet(lucid, s.contracts, m, body.outcome, stake, ctx.now());
    return { tx: tx.toCBOR(), payout: safePayout(body.outcome, stake).toString(), stake: body.stake,
      fee: tx.toTransaction().body().fee().toString(), outcome: body.outcome, marketId: body.marketId,
      expiresAt: ctx.now() + 60_000 };
  });

  app.post("/api/safe-passage/portfolio", async req => {
    const body = Wallet.parse(req.body);
    if (!service?.cfg.SAFE_PASSAGE_ENABLED) return { positions: [] };
    await service.refresh();
    const lucid = await walletLucid(body, { verify: false });
    const inputs = await lucid.wallet().getUtxos();
    const positions = service.all().map(m => {
      const pos = safePositions(service.contracts, inputs, m.datum.marketId);
      return { market: service.dto(m), yes: pos.yes.toString(), no: pos.no.toString(), claimable: safeClaim(m.datum, pos.yes, pos.no).toString() };
    }).filter(p => BigInt(p.yes) + BigInt(p.no) > 0n);
    return { positions };
  });

  app.post("/api/safe-passage/claim", async req => {
    limit(req); const s = enabled(); const body = Wallet.extend({ marketId: Id }).parse(req.body);
    const m = await s.require(body.marketId);
    if (m.datum.state.kind !== "resolved") throw new HttpError(409, "not_verified", "Payout is blocked until verification");
    const lucid = await walletLucid(body);
    const tx = await buildSafeClaim(lucid, s.contracts, m, ctx.now());
    return { tx: tx.toCBOR() };
  });

  app.post("/api/admin/safe-passage/fund", async req => {
    auth(req); limit(req); const { hex, confirmReserve } = z.object({ hex: Hex, confirmReserve: z.literal(true) }).parse(req.body);
    return enabled().fund(hex);
  });
  app.post("/api/admin/safe-passage/:id/freeze", async req => {
    auth(req); const { id } = z.object({ id: Id }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(10).max(2000), sources: Sources.default([]) }).parse(req.body);
    return enabled().freeze(id, body.reason, body.sources);
  });
  app.post("/api/admin/safe-passage/:id/resume-after-restart", async req => {
    auth(req); const { id } = z.object({ id: Id }).parse(req.params);
    const { reviewed, reason } = z.object({ reviewed: z.literal(true), reason: z.string().trim().min(10).max(2000) }).parse(req.body);
    return enabled().resumeAfterRestart(id, reason);
  });
  app.post("/api/admin/safe-passage/:id/verify", async req => {
    auth(req); const { id } = z.object({ id: Id }).parse(req.params);
    const body = z.object({ winner: z.union([z.literal(0), z.literal(1), z.null()]),
      reason: z.string().trim().min(20).max(4000), sources: Sources.min(1), reviewed: z.literal(true),
      independentSourcesConfirmed: z.boolean().default(false), incidentAt: z.number().int().positive().optional(),
      incidentZone: z.enum(["LBN", "SYR", "IRQ", "YEM", "IRN", "AFG"]).optional() }).parse(req.body);
    if (body.winner === 1 && !body.independentSourcesConfirmed) throw new HttpError(422, "independent_review_required");
    return enabled().verify(id, body.winner, body.reason, body.sources,
      body.incidentAt && body.incidentZone ? { at: body.incidentAt, zone: body.incidentZone } : undefined);
  });
  app.post("/api/admin/safe-passage/:id/close", async req => {
    auth(req); const s = enabled(); const { id } = z.object({ id: Id }).parse(req.params);
    const m = await s.require(id);
    const txHash = await ctx.operator.run(inputs => buildSafeClose(ctx.operator.lucid, s.contracts, m, ctx.now(), inputs));
    return { txHash };
  });
}
