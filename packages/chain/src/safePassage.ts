import { applyDoubleCborEncoding, applyParamsToScript, Constr, Data, validatorToAddress, validatorToScriptHash,
  type Assets, type LucidEvolution, type Network, type Script, type UTxO } from "@lucid-evolution/lucid";
import { SAFE_BUFFER, SAFE_CLAIM_WINDOW, safeClaim, safeCovered, type SafeDatum, type SafeOutcome } from "@flightradar/core/safePassage";
import blueprint from "../../../onchain/plutus.json" with { type: "json" };
import { MintRedeemer, optionInt } from "./codec.js";
import { marketIdFromSeed, marketNftName, positionName, parsePositionName, utf8ToHex, hexToUtf8 } from "./tokens.js";

export interface SafeEvidenceOutput { address: string; datum: string }

export interface SafeContracts { script: Script; policy: string; address: string; operatorKeyHash: string }
export interface SafeMarket { datum: SafeDatum; utxo: UTxO }
export function loadSafeContracts(network: Network, operatorKeyHash: string): SafeContracts {
  const v = blueprint.validators.find(v => v.title === "safe_passage.safe_market.spend");
  if (!v) throw new Error("Safe Passage validator missing; rebuild onchain/plutus.json");
  const script: Script = { type: "PlutusV3", script: applyDoubleCborEncoding(applyParamsToScript(v.compiledCode, [operatorKeyHash])) };
  return { script, policy: validatorToScriptHash(script), address: validatorToAddress(network, script), operatorKeyHash };
}
export function encodeSafeDatum(d: SafeDatum): string {
  const state = d.state.kind === "open" ? new Constr(0, []) : d.state.kind === "frozen" ? new Constr(1, [d.state.evidence]) :
    new Constr(2, [optionInt(d.state.winner), d.state.evidence, BigInt(d.state.settledAt)]);
  return Data.to(new Constr(0, [d.marketId, d.flight, utf8ToHex(d.zone), BigInt(d.openedAt), d.reserve, d.yes, d.no, d.claimedYes, d.claimedNo, state]));
}
export function decodeSafeDatum(cbor: string): SafeDatum {
  const raw = Data.from(cbor); if (!(raw instanceof Constr) || raw.index !== 0 || raw.fields.length !== 10) throw new Error("Invalid Safe Passage datum");
  const f = raw.fields; const s = f[9]; if (!(s instanceof Constr)) throw new Error("Invalid state");
  const integer = (i: number) => { if (typeof f[i] !== "bigint") throw new Error("Expected integer"); return f[i] as bigint; };
  const bytes = (i: number) => { if (typeof f[i] !== "string") throw new Error("Expected bytes"); return f[i] as string; };
  let state: SafeDatum["state"];
  if (s.index === 0) state = { kind: "open" };
  else if (s.index === 1 && typeof s.fields[0] === "string") state = { kind: "frozen", evidence: s.fields[0] };
  else if (s.index === 2 && s.fields[0] instanceof Constr && typeof s.fields[1] === "string" && typeof s.fields[2] === "bigint") {
    const option = s.fields[0]; const winner = option.index === 1 ? null : Number(option.fields[0]);
    if (winner !== null && winner !== 0 && winner !== 1) throw new Error("Invalid winner");
    state = { kind: "resolved", winner, evidence: s.fields[1], settledAt: Number(s.fields[2]) };
  } else throw new Error("Invalid state");
  return { marketId: bytes(0), flight: bytes(1), zone: hexToUtf8(bytes(2)), openedAt: Number(integer(3)), reserve: integer(4), yes: integer(5), no: integer(6), claimedYes: integer(7), claimedNo: integer(8), state };
}
export async function fetchSafeMarkets(lucid: LucidEvolution, c: SafeContracts): Promise<SafeMarket[]> {
  const result: SafeMarket[] = [];
  for (const utxo of await lucid.utxosAt(c.address)) try {
    if (!utxo.datum) continue;
    const datum = decodeSafeDatum(utxo.datum);
    if (utxo.assets[c.policy + marketNftName(datum.marketId)] === 1n) result.push({ utxo, datum });
  } catch { /* ignore unauthenticated junk outputs */ }
  return result;
}
const action = (i: number, fields: Data[] = []) => Data.to(new Constr(i, fields));
const value = (m: SafeMarket) => m.utxo.assets.lovelace ?? 0n;
function continuation(c: SafeContracts, m: SafeMarket, datum: SafeDatum, cash: bigint) {
  return [c.address, { kind: "inline" as const, value: encodeSafeDatum(datum) }, { lovelace: cash, [c.policy + marketNftName(datum.marketId)]: 1n }] as const;
}
export async function buildSafeCreate(lucid: LucidEvolution, c: SafeContracts, flight: string, zone: string, reserve: bigint, now: number, walletUtxos?: UTxO[]) {

  if (!/^[a-f0-9]{6}$/.test(flight) || !["LBN", "SYR", "IRQ", "YEM", "IRN", "AFG"].includes(zone) || reserve <= 0n) throw new Error("Invalid market parameters");
  const inputs = walletUtxos ?? await lucid.wallet().getUtxos();
  const seed = inputs.find(u => Object.keys(u.assets).length === 1); if (!seed) throw new Error("No funding input");
  const marketId = marketIdFromSeed(seed.txHash, seed.outputIndex);
  const datum: SafeDatum = { marketId, flight, zone, openedAt: now, reserve, yes: 0n, no: 0n, claimedYes: 0n, claimedNo: 0n, state: { kind: "open" } };
  const nft = c.policy + marketNftName(marketId);
  const tx = await lucid.newTx().collectFrom([seed]).mintAssets({ [nft]: 1n }, MintRedeemer.create(seed.txHash, seed.outputIndex))
    .attach.MintingPolicy(c.script).pay.ToContract(c.address, { kind: "inline", value: encodeSafeDatum(datum) }, { lovelace: reserve + SAFE_BUFFER, [nft]: 1n })
    .addSignerKey(c.operatorKeyHash).validFrom(now).validTo(now + 240_000).complete({ presetWalletInputs: inputs });
  return { tx, datum };
}
export async function buildSafeBet(lucid: LucidEvolution, c: SafeContracts, m: SafeMarket, outcome: SafeOutcome, stake: bigint, now: number) {
  if (m.datum.state.kind !== "open" || stake <= 0n || (outcome !== 0 && outcome !== 1)) throw new Error("Market unavailable or invalid stake");
  const d = { ...m.datum, yes: m.datum.yes + (outcome === 0 ? stake : 0n), no: m.datum.no + (outcome === 1 ? stake : 0n) };
  if (!safeCovered(d)) throw new Error("Covered stake limit exceeded");
  const receipt = c.policy + positionName(d.marketId, outcome);
  const owner = await lucid.wallet().address();
  return lucid.newTx().collectFrom([m.utxo], action(0)).attach.SpendingValidator(c.script)
    .mintAssets({ [receipt]: stake }, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.script)
    .pay.ToContract(...continuation(c, m, d, value(m) + stake)).pay.ToAddress(owner, { [receipt]: stake })
    .validFrom(now).validTo(now + 60_000).complete();
}
export async function buildSafeFreeze(lucid: LucidEvolution, c: SafeContracts, m: SafeMarket, evidence: string, now: number, walletUtxos?: UTxO[], archive?: SafeEvidenceOutput) {
  if (m.datum.state.kind !== "open" || !/^[a-f0-9]{64}$/.test(evidence)) throw new Error("Invalid freeze");
  const d: SafeDatum = { ...m.datum, state: { kind: "frozen", evidence } };
  let tx = lucid.newTx().collectFrom([m.utxo], action(1, [evidence])).attach.SpendingValidator(c.script)
    .pay.ToContract(...continuation(c, m, d, value(m))).addSignerKey(c.operatorKeyHash)
    .validFrom(now).validTo(now + 60_000);
  if (archive) tx = tx.pay.ToContract(archive.address, { kind: "inline", value: archive.datum }, { lovelace: 2_000_000n });
  return tx.complete(walletUtxos ? { presetWalletInputs: walletUtxos } : {});
}
export async function buildSafeVerify(lucid: LucidEvolution, c: SafeContracts, m: SafeMarket, winner: SafeOutcome | null, evidence: string, now: number, walletUtxos?: UTxO[], archive?: SafeEvidenceOutput) {

  if (m.datum.state.kind !== "frozen" || !/^[a-f0-9]{64}$/.test(evidence)) throw new Error("Freeze and verify first");
  const d: SafeDatum = { ...m.datum, state: { kind: "resolved", winner, evidence, settledAt: now } };
  let tx = lucid.newTx().collectFrom([m.utxo], action(2, [optionInt(winner), evidence, BigInt(now)])).attach.SpendingValidator(c.script)
    .pay.ToContract(...continuation(c, m, d, value(m))).addSignerKey(c.operatorKeyHash)
    .validFrom(now).validTo(now + 240_000);
  if (archive) tx = tx.pay.ToContract(archive.address, { kind: "inline", value: archive.datum }, { lovelace: 2_000_000n });
  return tx.complete(walletUtxos ? { presetWalletInputs: walletUtxos } : {});
}
export function safePositions(c: SafeContracts, utxos: UTxO[], id: string) {
  const assets: Assets = {}; let yes = 0n, no = 0n;
  for (const u of utxos) for (const [unit, q] of Object.entries(u.assets)) {
    if (!unit.startsWith(c.policy)) continue;
    const p = parsePositionName(unit.slice(56)); if (p?.marketId !== id || p.outcome > 1 || q <= 0n) continue;
    assets[unit] = (assets[unit] ?? 0n) + q;
    if (p.outcome === 0) yes += q; else no += q;
  }
  return { assets, yes, no };
}
export async function buildSafeClaim(lucid: LucidEvolution, c: SafeContracts, m: SafeMarket, now: number) {
  if (m.datum.state.kind !== "resolved") throw new Error("Market not verified");
  const inputs = await lucid.wallet().getUtxos(); const pos = safePositions(c, inputs, m.datum.marketId);
  if (pos.yes + pos.no <= 0n) throw new Error("No receipts to redeem");
  const payout = safeClaim(m.datum, pos.yes, pos.no);
  const d = { ...m.datum, claimedYes: m.datum.claimedYes + pos.yes, claimedNo: m.datum.claimedNo + pos.no };
  const minted = Object.fromEntries(Object.entries(pos.assets).map(([k, q]) => [k, -q]));
  let tx = lucid.newTx().collectFrom([m.utxo], action(3)).attach.SpendingValidator(c.script)
    .mintAssets(minted, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.script)
    .pay.ToContract(...continuation(c, m, d, value(m) - payout));
  if (payout > 0n) tx = tx.pay.ToAddress(await lucid.wallet().address(), { lovelace: payout });
  return tx.validFrom(now).validTo(now + 60_000).complete({ presetWalletInputs: inputs });
}
export async function buildSafeClose(lucid: LucidEvolution, c: SafeContracts, m: SafeMarket, now: number, walletUtxos?: UTxO[]) {
  if (m.datum.state.kind !== "resolved" || now <= m.datum.state.settledAt + SAFE_CLAIM_WINDOW) throw new Error("Claim window has not ended");
  return lucid.newTx().collectFrom([m.utxo], action(4)).attach.SpendingValidator(c.script)
    .mintAssets({ [c.policy + marketNftName(m.datum.marketId)]: -1n }, MintRedeemer.mintOrBurn()).attach.MintingPolicy(c.script)
    .addSignerKey(c.operatorKeyHash).validFrom(now).validTo(now + 60_000).complete(walletUtxos ? { presetWalletInputs: walletUtxos } : {});
}
