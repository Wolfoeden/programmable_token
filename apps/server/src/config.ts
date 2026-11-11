import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  /** Set when running behind a reverse proxy so rate limits see client IPs. */
  TRUST_PROXY: bool,
  HOST: z.string().default("0.0.0.0"),
  /** Run against an in-memory Cardano emulator with demo wallets. */
  DEMO: bool,
  NETWORK: z.enum(["Preprod", "Preview", "Mainnet"]).default("Preprod"),
  /** Real-money markets are gambling; see README before enabling. */
  ALLOW_MAINNET: bool,
  BLOCKFROST_PROJECT_ID: z.string().optional(),
  BLOCKFROST_URL: z.string().optional(),
  KOIOS_URL: z.string().optional(),
  /** Free Koios API token (koios.rest): 50,000 instead of 5,000 requests a day. */
  KOIOS_TOKEN: z.string().optional(),
  /** 24-word mnemonic of the operator wallet (creates, seeds and resolves markets). */
  OPERATOR_SEED: z.string().optional(),
  PUBLIC_URL: z.string().default("https://flightradar.fun"),
  ADSB_BASE_URL: z.string().default("https://api.adsb.lol"),
  /** Optional second readsb-compatible API used by the flight tracker when the first fails. */
  ADSB_FALLBACK_URL: z.string().optional(),
  ROUTE_BASE_URL: z.string().default("https://api.adsbdb.com"),
  AERODATABOX_KEY: z.string().optional(),
  AERODATABOX_HOST: z.string().default("aerodatabox.p.rapidapi.com"),
  SEED_ADA: z.coerce.number().default(20),
  SEED_ADA_CANCELLATION: z.coerce.number().default(100),
  FEE_BPS: z.coerce.number().int().min(0).max(1000).default(300),
  MAX_TOTAL_ADA: z.coerce.number().default(50_000),
  MAX_TOTAL_ADA_CANCELLATION: z.coerce.number().default(5_000),
  MAX_OPEN_MARKETS: z.coerce.number().default(200),
  MARKET_REQUESTS_PER_HOUR: z.coerce.number().default(30),
  CLAIM_WINDOW_DAYS: z.coerce.number().min(31).default(90),
  DATA_DIR: z.string().default("data"),
  /** Shadow log: keep following flights without viewers (model calibration). */
  SHADOW_ALWAYS_ON: bool,
  /** Bearer token for /api/admin/* (shadow log download). Unset = admin API off. */
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Directory of the built web app to serve, e.g. ../web/dist */
  WEB_DIST: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (!cfg.DEMO && cfg.NETWORK === "Mainnet" && !cfg.ALLOW_MAINNET) {
    throw new Error("NETWORK=Mainnet needs ALLOW_MAINNET=1. Real-money betting requires a gambling licence in most jurisdictions.");
  }
  if (!cfg.DEMO && !cfg.OPERATOR_SEED) throw new Error("OPERATOR_SEED is required outside demo mode");
  return cfg;
}
