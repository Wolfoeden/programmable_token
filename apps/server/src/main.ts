/** Entry point: wires data sources, chain, oracle, batcher and HTTP API. */
import { DeathZoneTraffic } from "./deathZoneTraffic.js";
import { SafePassageService } from "./safePassage.js";
import { AdsbClient } from "./adsb.js";
import { buildApi } from "./api.js";
import { Batcher } from "./batcher.js";
import { createChain, keepOperatorSplit } from "./chain.js";
import { ChainIndex } from "./chainIndex.js";
import { loadConfig } from "./config.js";
import { MarketMaker } from "./marketMaker.js";
import { Oracle } from "./oracle.js";
import { RouteClient } from "./routes.js";
import { AeroDataBox, SimulatedSchedule, type ScheduleProvider } from "./schedule.js";
import { Store } from "./store.js";
import { Tracker } from "./tracker.js";
import { ShadowLog } from "./shadow.js";
import { CamTraffic } from "./traffic.js";
import { log } from "./util.js";

async function main() {
  const cfg = loadConfig();
  // The chain service may be briefly unavailable or rate-limited at start:
  // retry for about five minutes instead of failing the deploy at once.
  let ctx: Awaited<ReturnType<typeof createChain>> | undefined;
  for (let attempt = 1; !ctx; attempt++) {
    try {
      ctx = await createChain(cfg);
    } catch (e) {
      if (attempt >= 20) throw e;
      log.warn("chain not reachable yet, retrying in 15 s", { attempt, error: String(e).slice(0, 200) });
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  const adsb = new AdsbClient(cfg.ADSB_BASE_URL, cfg.ADSB_FALLBACK_URL);
  const deathZoneTraffic = new DeathZoneTraffic(adsb);
  const safePassage = new SafePassageService(cfg, ctx, adsb);
  const routes = new RouteClient(cfg.ROUTE_BASE_URL);
  const schedule: ScheduleProvider | undefined = cfg.AERODATABOX_KEY
    ? new AeroDataBox(cfg.AERODATABOX_KEY, cfg.AERODATABOX_HOST)
    : cfg.DEMO
      ? new SimulatedSchedule()
      : undefined;
  const store = new Store(cfg.DATA_DIR);
  const tracker = new Tracker(adsb);
  const traffic = new CamTraffic(adsb, routes);
  const shadow = new ShadowLog(cfg.DATA_DIR);
  traffic.onFinished = (f) => shadow.flight(f);
  traffic.alwaysOn = cfg.SHADOW_ALWAYS_ON;
  const index = new ChainIndex(ctx);
  const maker = new MarketMaker(cfg, ctx, index, adsb, routes, schedule, store, tracker, traffic);
  const oracle = new Oracle(ctx, tracker, schedule, store);
  const batcher = new Batcher(ctx);

  await index.refresh();
  const app = await buildApi({ cfg, ctx, index, adsb, routes, schedule, store, maker, traffic, tracker, shadow, oracle, deathZoneTraffic, safePassage });
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  log.info(`listening on http://${cfg.HOST}:${cfg.PORT}`, { demo: cfg.DEMO, network: ctx.network, schedule: schedule?.name ?? "none" });

  // Background loops. Each runs sequentially so a slow upstream never
  // stacks up overlapping work.
  const loop = (name: string, everyMs: number, fn: () => Promise<void>) => {
    const run = async () => {
      try {
        await fn();
      } catch (e) {
        log.warn(`${name} failed`, { error: String(e) });
      }
      setTimeout(run, everyMs).unref();
    };
    setTimeout(run, everyMs).unref();
  };
  loop("index", 4000, () => index.maybeRefresh());
  loop("deathzone-traffic", 2500, () => deathZoneTraffic.step());
  loop("traffic", 1500, () => traffic.step());
  loop("traffic-far", 1500, () => traffic.stepFar());
  loop("tracker", 10_000, () => tracker.poll());
  loop("tracker-final", 2000, () => tracker.pollFinal());
  loop("oracle", 15_000, () => oracle.tick(index.live));
  loop("safe-passage-batcher", 10_000, () => safePassage.tick());
  loop("batcher", 10_000, () => batcher.tick(index.live, index.orders));
  loop("sweeper", 10 * 60_000, () => oracle.sweep(index.live));
  loop("seed-reclaim", 2 * 60_000, () => oracle.reclaimSeeds(index.live, (id) => index.isStale(id)));
  if (!cfg.DEMO) {
    const op = ctx.operator;
    setTimeout(() => void keepOperatorSplit(op).catch((e) => log.warn("operator split failed", { error: String(e) })), 20_000).unref();
    loop("operator-split", 30 * 60_000, () => keepOperatorSplit(op));
  }

  const shutdown = async () => {
    store.flush();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
