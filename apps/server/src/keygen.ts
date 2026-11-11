/**
 * New operator wallet: prints a fresh 24-word seed phrase and its address.
 * Run it on your own machine, store the phrase in a password manager and in
 * the Render environment (OPERATOR_SEED), then fund the address from the
 * faucet. Never commit or paste the phrase anywhere else.
 *
 *   npm run keygen -w @flightradar/server -- Preprod
 */
import { generateSeedPhrase, walletFromSeed } from "@lucid-evolution/lucid";

const network = (process.argv[2] ?? "Preprod") as "Preprod" | "Preview" | "Mainnet";
const seed = generateSeedPhrase();
const { address } = walletFromSeed(seed, { network });
console.log(`Network:  ${network}\nAddress:  ${address}\nSeed:     ${seed}\n\nFund the address at https://docs.cardano.org/cardano-testnets/tools/faucet`);
