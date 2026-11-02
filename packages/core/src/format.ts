/** Display helpers. */

const LOVELACE = 1_000_000n;

export function lovelaceToAda(lovelace: bigint): number {
  return Number(lovelace) / Number(LOVELACE);
}

export function adaToLovelace(ada: number): bigint {
  return BigInt(Math.round(ada * 1_000_000));
}

export function formatAda(lovelace: bigint, locale = "de-DE", digits = 2): string {
  return `${lovelaceToAda(lovelace).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₳`;
}

export function formatPercent(p: number, locale = "de-DE"): string {
  const digits = p < 0.1 || p > 0.9 ? 1 : 0;
  return `${(p * 100).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

export function formatOdds(x: number, locale = "de-DE"): string {
  if (!Number.isFinite(x)) return "–";
  return x.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
