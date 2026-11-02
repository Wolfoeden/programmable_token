/**
 * Off-chain records: how each market was priced, and the evidence behind
 * every resolution. Kept as JSON files so the oracle's decisions can be
 * audited and replayed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FlightStatus, Observation, Question, Verdict } from "@flightradar/core";
import { jsonReplacer } from "./util.js";

export interface MarketMeta {
  marketId: string;
  question: Question;
  createdAt: number;
  txHash: string;
  /** Status-quo probabilities the pools were seeded with. */
  probabilities: number[];
  model: string;
  seedLovelace: string[];
  simulated?: boolean;
}

export interface Evidence {
  marketId: string;
  verdict: Verdict;
  decidedAt: number;
  txHash?: string;
  statuses: Record<string, FlightStatus>;
  observations: Record<string, Observation[]>;
}

export class Store {
  private meta = new Map<string, MarketMeta>();
  private dirty = false;

  constructor(private dir: string) {
    mkdirSync(join(dir, "evidence"), { recursive: true });
    const file = join(dir, "markets.json");
    if (existsSync(file)) {
      for (const m of JSON.parse(readFileSync(file, "utf8")) as MarketMeta[]) this.meta.set(m.marketId, m);
    }
    setInterval(() => this.flush(), 5000).unref();
  }

  putMeta(m: MarketMeta): void {
    this.meta.set(m.marketId, m);
    this.dirty = true;
  }

  getMeta(id: string): MarketMeta | undefined {
    return this.meta.get(id);
  }

  allMeta(): MarketMeta[] {
    return [...this.meta.values()];
  }

  putEvidence(e: Evidence): void {
    writeFileSync(join(this.dir, "evidence", `${e.marketId}.json`), JSON.stringify(e, jsonReplacer, 1));
  }

  getEvidence(id: string): Evidence | undefined {
    if (!/^[0-9a-f]{54}$/.test(id)) return undefined;
    const file = join(this.dir, "evidence", `${id}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Evidence) : undefined;
  }

  flush(): void {
    if (!this.dirty) return;
    writeFileSync(join(this.dir, "markets.json"), JSON.stringify(this.allMeta(), jsonReplacer));
    this.dirty = false;
  }
}
