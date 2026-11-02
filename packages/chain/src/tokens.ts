/**
 * Asset names, mirroring onchain/lib/flightradar/tokens.ak.
 *
 * | Token         | Asset name                                    |
 * |---------------|-----------------------------------------------|
 * | Market NFT    | "MKT_" ++ market_id                           |
 * | Position (FT) | CIP-68 label 333 ++ market_id ++ outcome byte |
 * | Reference NFT | CIP-68 label 100 ++ market_id ++ outcome byte |
 */
import { blake2b } from "@noble/hashes/blake2b";

export const MARKET_ID_BYTES = 27;
export const MARKET_NFT_PREFIX = "4d4b545f";
export const CIP68_FT_PREFIX = "0014df10";
export const CIP68_REF_PREFIX = "000643b0";

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 27 bytes of blake2b-256(tx id ++ output index as 2 bytes big-endian). */
export function marketIdFromSeed(txHash: string, outputIndex: number): string {
  if (outputIndex < 0 || outputIndex > 0xffff) throw new RangeError("output index out of range");
  const tx = hexToBytes(txHash);
  const msg = new Uint8Array(tx.length + 2);
  msg.set(tx);
  msg[tx.length] = (outputIndex >> 8) & 0xff;
  msg[tx.length + 1] = outputIndex & 0xff;
  return bytesToHex(blake2b(msg, { dkLen: 32 }).slice(0, MARKET_ID_BYTES));
}

const outcomeByte = (outcome: number) => {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 255) throw new RangeError("bad outcome");
  return outcome.toString(16).padStart(2, "0");
};

export const marketNftName = (marketId: string) => MARKET_NFT_PREFIX + marketId;
export const positionName = (marketId: string, outcome: number) => CIP68_FT_PREFIX + marketId + outcomeByte(outcome);
export const referenceName = (marketId: string, outcome: number) => CIP68_REF_PREFIX + marketId + outcomeByte(outcome);

/** Decode a position token name into market id and outcome. */
export function parsePositionName(assetName: string): { marketId: string; outcome: number } | null {
  if (assetName.length !== 64 || !assetName.startsWith(CIP68_FT_PREFIX)) return null;
  return {
    marketId: assetName.slice(8, 8 + MARKET_ID_BYTES * 2),
    outcome: parseInt(assetName.slice(62, 64), 16),
  };
}

export function utf8ToHex(text: string): string {
  return bytesToHex(new TextEncoder().encode(text));
}

export function hexToUtf8(hex: string): string {
  return new TextDecoder().decode(hexToBytes(hex));
}
