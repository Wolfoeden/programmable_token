/**
 * Shadow log: what the model said about every listed flight, what really
 * happened, and every bet that was built. Append-only JSON lines in
 * DATA_DIR/shadow, one file per kind and UTC day. Used to calibrate the
 * model and to decide margin, betting close and limits before odds are
 * fixed (see shadowReport.ts). Wallet addresses are stored only as a
 * salted hash.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ShadowSample {
  /** Position time, unix ms. */
  t: number;
  distKm: number;
  altFt?: number;
  gsKt?: number;
  vrFpm?: number;
  /** Model estimate at this time. */
  etaMs: number;
  sigmaMs: number;
}

export interface ShadowFlight {
  v: 1;
  hex: string;
  callsign?: string;
  flightNumber?: string;
  type?: string;
  airport: string;
  origin?: string;
  firstListedAt: number;
  /** About one sample per 30 s while listed. */
  samples: ShadowSample[];
  outcome: { status: "landed" | "lost" | "gave_up"; landedAt?: number; lastSeenAt: number };
}

export interface ShadowBet {
  v: 1;
  kind: "bet";
  /** Hash of the unsigned transaction; equals the submitted tx hash. */
  txHash: string;
  at: number;
  marketId: string;
  question: string;
  hex?: string;
  /** landing_before: the threshold, unix ms. */
  threshold?: number;
  outcome: number;
  stake: string;
  /** Salted hash of the wallet address. */
  wallet: string;
  closeTime: number;
  pools: string[];
  multiplier: number;
  /** Model at the time of the bet, if the flight was listed. */
  model: { etaMs: number; sigmaMs: number; pYes: number } | null;
}

export interface ShadowSubmit {
  v: 1;
  kind: "submitted";
  txHash: string;
  at: number;
}

const FILE = /^(flights|bets)-\d{4}-\d{2}-\d{2}\.jsonl$/;

export class ShadowLog {
  private dir: string;
  private salt: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "shadow");
    mkdirSync(this.dir, { recursive: true });
    const saltFile = join(this.dir, ".salt");
    if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString("hex"));
    this.salt = readFileSync(saltFile, "utf8").trim();
  }

  walletId(address: string): string {
    return createHash("sha256").update(this.salt + address).digest("hex").slice(0, 16);
  }

  flight(f: ShadowFlight): void {
    this.append("flights", f.outcome.lastSeenAt, f);
  }

  bet(b: ShadowBet): void {
    this.append("bets", b.at, b);
  }

  submitted(txHash: string, at = Date.now()): void {
    const rec: ShadowSubmit = { v: 1, kind: "submitted", txHash, at };
    this.append("bets", at, rec);
  }

  files(): Array<{ name: string; bytes: number }> {
    return readdirSync(this.dir)
      .filter((f) => FILE.test(f))
      .sort()
      .map((name) => ({ name, bytes: statSync(join(this.dir, name)).size }));
  }

  read(name: string): string | null {
    if (!FILE.test(name) || !existsSync(join(this.dir, name))) return null;
    return readFileSync(join(this.dir, name), "utf8");
  }

  private append(kind: string, at: number, rec: unknown): void {
    const day = new Date(at).toISOString().slice(0, 10);
    try {
      appendFileSync(join(this.dir, `${kind}-${day}.jsonl`), `${JSON.stringify(rec)}\n`);
    } catch {
      // a full disk must not take the site down; the record is lost
    }
  }
}
