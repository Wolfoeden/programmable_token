/**
 * Compiled validators from onchain/plutus.json with their parameters applied.
 *
 *   metadata_store(operator)
 *   market(operator, metadata_store_hash)   -> policy id = market script hash
 *   order(market_policy)
 */
import {
  applyDoubleCborEncoding,
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  type Credential,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import blueprint from "../../../onchain/plutus.json" with { type: "json" };

interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
}

function compiled(title: string): string {
  const v = (blueprint.validators as BlueprintValidator[]).find((x) => x.title === title);
  if (!v) throw new Error(`validator ${title} missing from plutus.json — run "aiken build" in onchain/`);
  return v.compiledCode;
}

export interface Contracts {
  network: Network;
  operatorKeyHash: string;
  market: Script;
  marketHash: string;
  marketAddress: string;
  metadata: Script;
  metadataHash: string;
  metadataAddress: string;
  order: Script;
  orderHash: string;
  orderAddress: string;
  /** Optional stake credential for the market and order addresses. */
  stake?: Credential;
}

export function loadContracts(network: Network, operatorKeyHash: string, stake?: Credential): Contracts {
  const metadata: Script = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(applyParamsToScript(compiled("metadata.metadata_store.spend"), [operatorKeyHash])),
  };
  const metadataHash = validatorToScriptHash(metadata);
  const market: Script = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(applyParamsToScript(compiled("market.market.spend"), [operatorKeyHash, metadataHash])),
  };
  const marketHash = validatorToScriptHash(market);
  const order: Script = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(applyParamsToScript(compiled("order.order.spend"), [marketHash])),
  };
  const orderHash = validatorToScriptHash(order);
  return {
    network,
    operatorKeyHash,
    market,
    marketHash,
    marketAddress: validatorToAddress(network, market, stake),
    metadata,
    metadataHash,
    metadataAddress: validatorToAddress(network, metadata, stake),
    order,
    orderHash,
    orderAddress: validatorToAddress(network, order, stake),
    ...(stake ? { stake } : {}),
  };
}

export const unit = (policyId: string, assetName: string) => policyId + assetName;
