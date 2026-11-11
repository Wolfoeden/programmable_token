import { formatAda, formatOdds, formatPercent } from "@flightradar/core/format";

export { formatAda, formatOdds, formatPercent };

export const ada = (lovelace: string | bigint, digits = 2) => formatAda(BigInt(lovelace), "en-US", digits);

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** "20:14 UTC" plus the viewer's local time with its zone, e.g. "21:14 CET". */
export function bothZones(ms: number): { utc: string; local: string } {
  const local = new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  return { utc: utcClock(ms), local };
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function utcClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function feet(ft: number | undefined): string {
  return ft === undefined ? "–" : `${Math.round(ft).toLocaleString("en-US")} ft`;
}

export function knots(kt: number | undefined): string {
  return kt === undefined ? "–" : `${Math.round(kt)} kt`;
}

export function fpm(v: number | undefined): string {
  if (v === undefined) return "–";
  const r = Math.round(v / 50) * 50;
  return `${r > 0 ? "+" : ""}${r.toLocaleString("en-US")} ft/min`;
}
