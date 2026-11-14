/**
 * Wallets. Browser wallets speak CIP-30; demo wallets (demo mode only) are
 * held by the server. Both expose the same interface, so the betting flow
 * is identical: server builds the transaction, the wallet signs, the server
 * assembles and submits.
 */
import { api, type WalletPayload } from "./api";

export interface AppWallet {
  id: string;
  name: string;
  icon?: string;
  kind: "cip30" | "demo";
  payload(): Promise<WalletPayload>;
  sign(tx: string): Promise<string>;
  /** 0 = testnet, 1 = mainnet; undefined for demo wallets. */
  networkId?: number;
}

interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUtxos(): Promise<string[] | undefined>;
  getChangeAddress(): Promise<string>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
}

interface Cip30Wallet {
  name: string;
  icon: string;
  apiVersion?: string;
  enable(): Promise<Cip30Api>;
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30Wallet | undefined>;
  }
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  kind: "cip30" | "demo";
}

export function browserWallets(): WalletOption[] {
  const c = window.cardano ?? {};
  return Object.entries(c)
    .filter(([, w]) => w && typeof w.enable === "function" && typeof w.name === "string")
    .map(([id, w]) => ({ id, name: w!.name, icon: w!.icon, kind: "cip30" as const }))
    .filter((w, i, all) => all.findIndex((x) => x.name === w.name) === i);
}

export async function connectBrowserWallet(id: string): Promise<AppWallet> {
  const w = window.cardano?.[id];
  if (!w) throw new Error("Wallet nicht gefunden");
  const cip = await w.enable();
  const networkId = await cip.getNetworkId();
  return {
    id,
    name: w.name,
    icon: w.icon,
    kind: "cip30",
    networkId,
    payload: async () => ({ address: await cip.getChangeAddress(), utxos: (await cip.getUtxos()) ?? [] }),
    sign: (tx) => cip.signTx(tx, true),
  };
}

export function demoWallet(name: string): AppWallet {
  return {
    id: `demo:${name}`,
    name: `Demo: ${name}`,
    kind: "demo",
    payload: () => api.demoUtxos(name.toLowerCase()),
    sign: async (tx) => (await api.demoSign(name.toLowerCase(), tx)).witness,
  };
}

/** Sign an already built transaction and submit it through the server. */
export async function signBuilt(wallet: AppWallet, tx: string): Promise<string> {
  const witness = await wallet.sign(tx);
  return (await api.submit(tx, witness)).txHash;
}

/** Build on the server, sign in the wallet, submit through the server. */
export async function signAndSubmit(wallet: AppWallet, build: (p: WalletPayload) => Promise<{ tx: string }>): Promise<string> {
  const payload = await wallet.payload();
  const { tx } = await build(payload);
  const witness = await wallet.sign(tx);
  return (await api.submit(tx, witness)).txHash;
}
