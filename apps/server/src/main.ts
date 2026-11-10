/** Entry point: wires data sources, chain, oracle, batcher and HTTP API. */
import { AdsbClient } from "./adsb.js";
import { buildApi } from "./api.js";
import { Batcher } from "./batcher.js";
import { createChain } from "./chain.js";
import { ChainIndex } from "./chainIndex.js";
import { loadConfig } from "./config.js";
import { MarketMaker } from "./marketMaker.js";
import { Oracle } from "./oracle.js";
import { RouteClient } from "./routes.js";
import { AeroDataBox, SimulatedSchedule, type ScheduleProvider } from "./schedule.js";
import { Store } from "./store.js";
import { Tracker } from "./tracker.js";
import { CamTraffic } from "./traffic.js";
import { log } from "./util.js";

async function main() {
  const cfg = loadConfig();
  const ctx = await createChain(cfg);
  const adsb = new AdsbClient(cfg.ADSB_BASE_URL, cfg.ADSB_FALLBACK_URL);
  const routes = new RouteClient(cfg.ROUTE_BASE_URL);
  const schedule: ScheduleProvider | undefined = cfg.AERODATABOX_KEY
    ? new AeroDataBox(cfg.AERODATABOX_KEY, cfg.AERODATABOX_HOST)
    : cfg.DEMO
      ? new SimulatedSchedule()
      : undefined;
  const store = new Store(cfg.DATA_DIR);
  const tracker = new Tracker(adsb);
  const traffic = new CamTraffic(adsb, routes);
  const index = new ChainIndex(ctx);
  const maker = new MarketMaker(cfg, ctx, index, adsb, routes, schedule, store, tracker, traffic);
  const oracle = new Oracle(ctx, tracker, schedule, store);
  const batcher = new Batcher(ctx);

  await index.refresh();
  const app = await buildApi({ cfg, ctx, index, adsb, routes, schedule, store, maker, traffic, tracker });
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
  loop("index", 5000, () => index.refresh());
  loop("traffic", 1500, () => traffic.step());
  loop("tracker", 10_000, () => tracker.poll());
  loop("tracker-final", 2000, () => tracker.pollFinal());
  loop("oracle", 15_000, () => oracle.tick(index.live));
  loop("batcher", 10_000, () => batcher.tick(index.live, index.orders));
  loop("sweeper", 10 * 60_000, () => oracle.sweep(index.live));

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
