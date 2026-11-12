/** Fixed gross payout, including stake. All arithmetic is integer lovelace. */
export const SAFE_ODDS = ["1.0001", "1000"] as const;
export const SAFE_BUFFER = 3_000_000n;
export const SAFE_CLAIM_WINDOW = 90 * 24 * 3600_000;
export type SafeOutcome = 0 | 1;
export type SafeState = { kind: "open" } | { kind: "frozen"; evidence: string } |
  { kind: "resolved"; winner: SafeOutcome | null; evidence: string; settledAt: number };
export interface SafeDatum {
  marketId: string; flight: string; zone: string; openedAt: number;
  reserve: bigint; yes: bigint; no: bigint; claimedYes: bigint; claimedNo: bigint; state: SafeState;
}
export const safePayout = (outcome: SafeOutcome, stake: bigint) => {
  if (stake < 0n) throw new RangeError("negative stake");
  return outcome === 0 ? stake * 10001n / 10000n : stake * 1000n;
};
export function safeCovered(d: Pick<SafeDatum, "reserve" | "yes" | "no">): boolean {
  const cash = d.reserve + d.yes + d.no;
  return d.reserve > 0n && d.yes >= 0n && d.no >= 0n && safePayout(0, d.yes) <= cash && safePayout(1, d.no) <= cash;
}
/** Strictly collateralised capacity including the incoming stake itself.
 * Floor payout permits up to denominator-1 additional lovelace of slack.
 */
export function safeCapacity(d: Pick<SafeDatum, "reserve" | "yes" | "no">, outcome: SafeOutcome): bigint {
  const cash = d.reserve + d.yes + d.no;
  const result = outcome === 0 ? (cash * 10000n - d.yes * 10001n + 9999n) : (cash - d.no * 1000n) / 999n;
  return result > 0n ? result : 0n;
}
export function safeClaim(d: SafeDatum, yes: bigint, no: bigint): bigint {
  if (d.state.kind !== "resolved") return 0n;
  if (d.state.winner === null) return yes + no;
  return safePayout(d.state.winner, d.state.winner === 0 ? yes : no);
}
