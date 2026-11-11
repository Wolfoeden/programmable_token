/** Read markets and orders from the chain through any Lucid provider. */
import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { decodeMarketDatum, decodeOrderDatum, type MarketDatum, type OrderDatum } from "./codec.js";
import type { Contracts } from "./contracts.js";
import { MARKET_NFT_PREFIX } from "./tokens.js";

export interface MarketView {
  utxo: UTxO;
  datum: MarketDatum;
}

export interface OrderView {
  utxo: UTxO;
  datum: OrderDatum;
}

function holdsMarketNft(c: Contracts, u: UTxO, marketId: string): boolean {
  return u.assets[c.marketHash + MARKET_NFT_PREFIX + marketId] === 1n;
}

// Query by address, not by script credential: the Koios provider rejects
// credential queries ("Credential Type is not supported in Koios yet").
export async function fetchMarkets(lucid: LucidEvolution, c: Contracts): Promise<MarketView[]> {
  const utxos = await lucid.utxosAt(c.marketAddress);
  const out: MarketView[] = [];
  for (const u of utxos) {
    if (!u.datum) continue;
    try {
      const datum = decodeMarketDatum(u.datum);
      if (holdsMarketNft(c, u, datum.marketId)) out.push({ utxo: u, datum });
    } catch {
      // Not a market (junk sent to the script address).
    }
  }
  return out;
}

export async function fetchOrders(lucid: LucidEvolution, c: Contracts): Promise<OrderView[]> {
  const utxos = await lucid.utxosAt(c.orderAddress);
  const out: OrderView[] = [];
  for (const u of utxos) {
    if (!u.datum) continue;
    try {
      out.push({ utxo: u, datum: decodeOrderDatum(u.datum, c.network) });
    } catch {
      // Malformed order: nobody can fill it; the owner can still cancel.
    }
  }
  return out;
}

export async function fetchReferenceNfts(lucid: LucidEvolution, c: Contracts, marketId: string): Promise<UTxO[]> {
  const utxos = await lucid.utxosAt(c.metadataAddress);
  return utxos.filter((u) => Object.keys(u.assets).some((k) => k.startsWith(c.marketHash) && k.includes(marketId)));
}
