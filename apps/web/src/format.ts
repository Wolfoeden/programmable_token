import { formatAda, formatOdds, formatPercent } from "@flightradar/core/format";

export { formatAda, formatOdds, formatPercent };

export const ada = (lovelace: string | bigint, digits = 2) => formatAda(BigInt(lovelace), "de-DE", digits);

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
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
  return ft === undefined ? "–" : `${Math.round(ft).toLocaleString("de-DE")} ft`;
}

export function knots(kt: number | undefined): string {
  return kt === undefined ? "–" : `${Math.round(kt)} kt`;
}

export function fpm(v: number | undefined): string {
  if (v === undefined) return "–";
  const r = Math.round(v / 50) * 50;
  return `${r > 0 ? "+" : ""}${r.toLocaleString("de-DE")} ft/min`;
}
