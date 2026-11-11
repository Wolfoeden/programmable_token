/**
 * Chain access for the server: provider (emulator in demo mode), contract
 * addresses, the operator wallet, and per-request Lucid instances for
 * browser wallets.
 */
import {
  Blockfrost,
  CML,
  coreToUtxo,
  Emulator,
  generateEmulatorAccount,
  generateSeedPhrase,
  getAddressDetails,
  Koios,
  Lucid,
  utxoToCore,
  walletFromSeed,
  type EmulatorAccount,
  type LucidEvolution,
  type Network,
  type ProtocolParameters,
  type Provider,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { loadContracts, type Contracts } from "@flightradar/chain";
import type { Config } from "./config.js";
import { log, Mutex } from "./util.js";

export interface DemoWallet {
  name: string;
  account: EmulatorAccount;
}

export interface ChainContext {
  network: Network;
  provider: Provider;
  emulator?: Emulator;
  contracts: Contracts;
  operator: SerialWallet;
  demoWallets: DemoWallet[];
  /** Chain time (emulator clock in demo mode). */
  now(): number;
  /** Fresh Lucid instance without a wallet, for building user transactions. */
  newLucid(): Promise<LucidEvolution>;
  /** Lucid instance with a browser wallet given by address and CIP-30 UTxOs. */
  userLucid(address: string, utxosCbor: string[]): Promise<LucidEvolution>;
}

const outRefKey = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

/**
 * A wallet that the server signs with. Transactions are built one at a time
 * and their inputs stay reserved until the chain shows them spent, so
 * back-to-back transactions never try to spend the same UTxO.
 */
export class SerialWallet {
  private mutex = new Mutex();
  private reserved = new Map<string, number>();

  constructor(
    readonly lucid: LucidEvolution,
    readonly address: string,
    readonly keyHash: string,
    private reserveMs = 10 * 60_000,
  ) {}

  async availableUtxos(): Promise<UTxO[]> {
    const now = Date.now();
    for (const [k, until] of this.reserved) if (until < now) this.reserved.delete(k);
    const utxos = await this.lucid.wallet().getUtxos();
    return utxos.filter((u) => !this.reserved.has(outRefKey(u)));
  }

  /** Build with the available UTxOs, sign, submit and reserve the inputs. */
  run(build: (walletUtxos: UTxO[]) => Promise<TxSignBuilder>): Promise<string> {
    return this.mutex.run(async () => {
      const tx = await build(await this.availableUtxos());
      const body = tx.toTransaction().body();
      const inputs = body.inputs();
      const signed = await tx.sign.withWallet().complete();
      const hash = await signed.submit();
      for (let i = 0; i < inputs.len(); i++) {
        const input = inputs.get(i);
        this.reserved.set(`${input.transaction_id().to_hex()}#${input.index()}`, Date.now() + this.reserveMs);
      }
      return hash;
    });
  }
}

function keyHashOf(address: string): string {
  const pc = getAddressDetails(address).paymentCredential;
  if (!pc) throw new Error("address without payment credential");
  return pc.hash;
}

export async function createChain(cfg: Config): Promise<ChainContext> {
  if (cfg.DEMO) return createDemoChain();

  const network: Network = cfg.NETWORK;
  let provider: Provider;
  if (cfg.BLOCKFROST_PROJECT_ID) {
    const url = cfg.BLOCKFROST_URL ?? `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`;
    provider = new Blockfrost(url, cfg.BLOCKFROST_PROJECT_ID);
  } else {
    const url = cfg.KOIOS_URL ?? (network === "Mainnet" ? "https://api.koios.rest/api/v1" : `https://${network.toLowerCase()}.koios.rest/api/v1`);
    provider = cfg.KOIOS_TOKEN ? new Koios(url, cfg.KOIOS_TOKEN) : new Koios(url);
  }
  const seed = cfg.OPERATOR_SEED!;
  const operatorLucid = await Lucid(provider, network);
  operatorLucid.selectWallet.fromSeed(seed);
  const address = await operatorLucid.wallet().address();
  const keyHash = keyHashOf(address);
  let params: ProtocolParameters = await provider.getProtocolParameters();
  setInterval(() => {
    provider.getProtocolParameters().then((p) => (params = p)).catch(() => undefined);
  }, 10 * 60_000).unref();
  const newLucid = () => Lucid(provider, network, { presetProtocolParameters: params });
  // Splitting the operator funds runs in the background (keepOperatorSplit),
  // so a slow or rate-limited chain service cannot block the start.
  log.info("chain ready", { network, operator: address });
  return {
    network,
    provider,
    contracts: loadContracts(network, keyHash),
    operator: new SerialWallet(operatorLucid, address, keyHash),
    demoWallets: [],
    now: () => Date.now(),
    newLucid,
    userLucid: async (addr, utxosCbor) => {
      const lucid = await newLucid();
      lucid.selectWallet.fromAddress(addr, utxosCbor.map(decodeUtxo));
      return lucid;
    },
  };
}

/**
 * Re-check later (the wallet may be funded after the server started):
 * split through the serial wallet so reservations stay consistent.
 */
export async function keepOperatorSplit(w: SerialWallet, wanted = 12): Promise<void> {
  const utxos = await w.availableUtxos();
  const pure = utxos.filter((u) => Object.keys(u.assets).length === 1);
  if (pure.length >= wanted / 2) return;
  const total = pure.reduce((a, u) => a + (u.assets.lovelace ?? 0n), 0n);
  const each = (total * 8n) / 10n / BigInt(wanted);
  if (each < 30_000_000n) return;
  const hash = await w.run(async (walletUtxos) => {
    let tx = w.lucid.newTx().collectFrom(walletUtxos.filter((u) => Object.keys(u.assets).length === 1));
    for (let i = 0; i < wanted; i++) tx = tx.pay.ToAddress(w.address, { lovelace: each });
    return tx.complete({ presetWalletInputs: walletUtxos });
  });
  log.info("split operator funds into more UTxOs", { outputs: wanted, each, txHash: hash });
}

export function decodeUtxo(cbor: string): UTxO {
  return coreToUtxo(CML.TransactionUnspentOutput.from_cbor_hex(cbor));
}

export function encodeUtxo(u: UTxO): string {
  return utxoToCore(u).to_cbor_hex();
}

/**
 * Demo chain: an in-memory emulator whose clock follows the wall clock, an
 * operator with plenty of split UTxOs, and three funded demo wallets.
 */
async function createDemoChain(): Promise<ChainContext> {
  const ADA = 1_000_000n;
  const operatorSeed = generateSeedPhrase();
  const operatorAddress = walletFromSeed(operatorSeed, { network: "Custom" }).address;
  const operatorAccount: EmulatorAccount = {
    seedPhrase: operatorSeed,
    address: operatorAddress,
    assets: { lovelace: 1_000_000n * ADA },
    privateKey: "",
  };
  const names = ["Alice", "Bob", "Carol"];
  const demo = names.map((name) => ({ name, account: generateEmulatorAccount({ lovelace: 10_000n * ADA }) }));
  const emulator = new Emulator([operatorAccount, ...demo.map((d) => d.account)]);
  const operatorLucid = await Lucid(emulator, "Custom");
  operatorLucid.selectWallet.fromSeed(operatorSeed);
  const keyHash = keyHashOf(operatorAddress);

  // Split the operator's funds so that market creation, resolution and
  // batching can run in parallel.
  let split = operatorLucid.newTx();
  for (let i = 0; i < 60; i++) split = split.pay.ToAddress(operatorAddress, { lovelace: 5_000n * ADA });
  const splitTx = await split.complete();
  await (await splitTx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);

  // Keep the emulator clock in step with real time (1 slot = 1 second).
  // The emulator started at construction time and awaitBlock moved it 20 s
  // ahead; from here on it only advances when the wall clock catches up.
  setInterval(() => {
    const lag = Math.floor((Date.now() - emulator.now()) / 1000);
    if (lag > 0) emulator.awaitSlot(lag);
  }, 1000).unref();

  const newLucid = () => Lucid(emulator, "Custom");
  log.info("demo chain ready", { operator: operatorAddress, wallets: demo.map((d) => d.name) });
  return {
    network: "Custom",
    provider: emulator,
    emulator,
    contracts: loadContracts("Custom", keyHash),
    operator: new SerialWallet(operatorLucid, operatorAddress, keyHash, 2 * 60_000),
    demoWallets: demo,
    now: () => emulator.now(),
    newLucid,
    userLucid: async (addr, utxosCbor) => {
      const lucid = await newLucid();
      lucid.selectWallet.fromAddress(addr, utxosCbor.map(decodeUtxo));
      return lucid;
    },
  };
}
