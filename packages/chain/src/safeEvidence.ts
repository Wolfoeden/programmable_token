import { Constr, Data, type LucidEvolution } from "@lucid-evolution/lucid";
import { hexToUtf8, utf8ToHex } from "./tokens.js";

const MAGIC = utf8ToHex("flightradar.safe-evidence.v1");
export const SAFE_EVIDENCE_MAX_BYTES = 8192;

/** Recoverable inline-datum archive at the existing operator-controlled
 * metadata store. Records are bound to market state by its evidence SHA-256,
 * not by trusting arbitrary outputs deposited at the address.
 */
export function encodeSafeEvidence(hash: string, json: string): string {
  const payload = utf8ToHex(json);
  if (!/^[a-f0-9]{64}$/.test(hash) || payload.length / 2 > SAFE_EVIDENCE_MAX_BYTES) throw new Error("Evidence must fit in 8192 UTF-8 bytes");
  return Data.to(new Constr(7, [MAGIC, hash, payload]));
}

export function decodeSafeEvidence(cbor: string): { hash: string; json: string } | null {
  try {
    const d = Data.from(cbor);
    if (!(d instanceof Constr) || d.index !== 7 || d.fields.length !== 3 || d.fields[0] !== MAGIC) return null;
    const [_, hash, payload] = d.fields;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || typeof payload !== "string" || payload.length / 2 > SAFE_EVIDENCE_MAX_BYTES) return null;
    return { hash, json: hexToUtf8(payload) };
  } catch { return null; }
}

export async function fetchSafeEvidence(lucid: LucidEvolution, address: string, required: Set<string>) {
  const records: Array<{ hash: string; json: string }> = [];
  for (const u of await lucid.utxosAt(address)) {
    if (!u.datum) continue;
    const record = decodeSafeEvidence(u.datum);
    if (record && required.has(record.hash)) records.push(record);
  }
  return records;
}
