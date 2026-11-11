/**
 * Shadow report from a local directory or a running server.
 *
 *   npm run shadow:report -w @flightradar/server -- data/shadow
 *   npm run shadow:report -w @flightradar/server -- https://flightradar.fun <ADMIN_TOKEN>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonl, report } from "./shadowReport.js";
import type { ShadowBet, ShadowFlight, ShadowSubmit } from "./shadow.js";

async function load(src: string, token?: string): Promise<Array<{ name: string; text: string }>> {
  if (!/^https?:\/\//.test(src)) {
    return readdirSync(src)
      .filter((f) => f.endsWith(".jsonl"))
      .map((name) => ({ name, text: readFileSync(join(src, name), "utf8") }));
  }
  const headers = { authorization: `Bearer ${token ?? ""}` };
  const base = src.replace(/\/$/, "");
  const list = (await (await fetch(`${base}/api/admin/shadow`, { headers })).json()) as { files?: Array<{ name: string }> };
  if (!list.files) throw new Error("admin API refused (check ADMIN_TOKEN)");
  const out = [];
  for (const f of list.files) out.push({ name: f.name, text: await (await fetch(`${base}/api/admin/shadow/${f.name}`, { headers })).text() });
  return out;
}

const [src = "data/shadow", token] = process.argv.slice(2);
const files = await load(src, token);
const flights = files.filter((f) => f.name.startsWith("flights-")).flatMap((f) => parseJsonl<ShadowFlight>(f.text));
const bets = files.filter((f) => f.name.startsWith("bets-")).flatMap((f) => parseJsonl<ShadowBet | ShadowSubmit>(f.text));
console.log(report(flights, bets));
