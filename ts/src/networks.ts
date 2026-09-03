// Which chain a command runs against, in one place: the RPC to read and submit
// through, the deployment ids to use, the key that pays for relays, and where to
// link a transaction. `testnet.ts` keeps the faucet plumbing only testnet has;
// mainnet's equivalents live here.
//
// Deliberately one lookup rather than a network argument threaded through every
// call: the endpoint, the deployment and the relayer key are a single choice.
// Mixing them — mainnet ids relayed through a testnet RPC, or the reverse — is
// the failure this shape rules out.

import { existsSync, readFileSync } from "node:fs";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { parseDeploymentJson, type Deployment, type Network } from "./chain.js";
import { TESTNET_DEPLOYMENT, TESTNET_RPC, testnetClient, setupTestnet } from "./testnet.js";

/// Published 2026-09-03 from the `mainnet-deployer` alias, with the production
/// wsAPI signer registered — so only batches signed by production verify here.
/// `pnpm publish-mainnet` overwrites this by writing deployment.mainnet.json,
/// which is preferred over this constant when present.
export const MAINNET_DEPLOYMENT: Deployment = {
  bsPackageId: "0xa408bcdeb8e7607b1cbb92c088147d61664a6255a3ea5696a8fef44711e113d8",
  sidPackageId: "0xdacaf624c4802c9ff7b8c72447207f5078b78be246f78e143d63e6cd89b4f63d",
  examplePackageId: "0x27382a2058063f29c6adcf32d2489b9b8ce64202b6b2f7606335974764a84316",
  registryId: "0xc578b6058b0ba9cf2254962168cd779593805c4f10f80aef8749df75ef7fc0e5",
  oracleId: "0xf10649932629bf99c3107d1b5c1f9be818e03445079d1d2fd7244f76dc0fa7ee",
  adminCapId: "0x4ae63f14e18bc11f689421d1577771a2019ed1565ce12c6cd31b3babc005ad2c",
};

/// `fullnode.mainnet.sui.io` has retired JSON-RPC ("JSON-RPC on public fullnodes
/// has been deprecated"), which is the protocol this SDK's `SuiClient` speaks —
/// so the SDK and the `sui` CLI need different endpoints on mainnet. The CLI env
/// named `mainnet` must stay on a gRPC fullnode (see `useDeployer`); this is the
/// JSON-RPC one everything else here goes through. Override via SUI_MAINNET_RPC.
const DEFAULT_MAINNET_RPC = "https://sui-rpc.publicnode.com";
export const MAINNET_RPC = process.env["SUI_MAINNET_RPC"] ?? DEFAULT_MAINNET_RPC;

export function mainnetClient(): SuiClient {
  return new SuiClient({ url: MAINNET_RPC });
}

/// Two SUI: hundreds of relays at the ~0.003 SUI a verify -> ingest PTB costs,
/// while leaving a visible shortfall rather than a mid-run failure.
const MIN_MAINNET_RELAY_BALANCE = 2_000_000_000n;

/// The mainnet relayer key, which — unlike testnet's — cannot be conjured: there
/// is no faucet, so refuse up front rather than fail at signing time.
async function setupMainnet(): Promise<Relayer> {
  const secret = process.env["SUI_MAINNET_PRIVKEY"];
  if (!secret) {
    throw new Error(
      "SUI_MAINNET_PRIVKEY is required to relay on mainnet: a funded key's bech32 secret " +
        "(`suiprivkey1...`, from `sui keytool export --key-identity <alias>`). There is no mainnet faucet.",
    );
  }
  const client = mainnetClient();
  const keypair = Ed25519Keypair.fromSecretKey(secret);
  const address = keypair.toSuiAddress();
  const balance = BigInt((await client.getBalance({ owner: address })).totalBalance);
  if (balance < MIN_MAINNET_RELAY_BALANCE) {
    throw new Error(
      `mainnet relayer ${address} holds ${balance} MIST, below the ${MIN_MAINNET_RELAY_BALANCE} MIST floor — fund it first`,
    );
  }
  return { client, keypair, address };
}

/// A funded identity plus the client it submits through — always taken together,
/// so a key can never be paired with another network's endpoint.
export interface Relayer {
  client: SuiClient;
  keypair: Ed25519Keypair;
  address: string;
}

export interface NetworkTarget {
  network: Network;
  /// The JSON-RPC endpoint the SDK reads and submits through.
  rpc: string;
  client: () => SuiClient;
  /// The ids to relay through: whatever the last publish wrote to
  /// deployment.<network>.json, else the constant checked in for that network.
  deployment: () => Deployment;
  /// A funded key to sign relay transactions with.
  setupRelayer: () => Promise<Relayer>;
  explorerTx: (digest: string) => string;
}

export const deploymentUrl = (network: Network) => new URL(`../deployment.${network}.json`, import.meta.url);

/// A real publish writes deployment.<network>.json; the checked-in constant is
/// the fallback for a deployment nobody re-published locally.
function loadDeployment(network: Network, fallback: Deployment): Deployment {
  const url = deploymentUrl(network);
  return existsSync(url) ? parseDeploymentJson(readFileSync(url, "utf8")) : fallback;
}

export const NETWORKS: Record<Network, NetworkTarget> = {
  testnet: {
    network: "testnet",
    rpc: TESTNET_RPC,
    client: testnetClient,
    deployment: () => loadDeployment("testnet", TESTNET_DEPLOYMENT),
    setupRelayer: setupTestnet,
    explorerTx: (digest) => `https://testnet.suivision.xyz/txblock/${digest}`,
  },
  mainnet: {
    network: "mainnet",
    rpc: MAINNET_RPC,
    client: mainnetClient,
    deployment: () => loadDeployment("mainnet", MAINNET_DEPLOYMENT),
    setupRelayer: setupMainnet,
    explorerTx: (digest) => `https://suivision.xyz/txblock/${digest}`,
  },
};

/// Resolve a CLI network argument, defaulting to testnet so the existing
/// commands keep their meaning when invoked with no argument.
export function resolveNetwork(arg?: string): NetworkTarget {
  const name = arg ?? "testnet";
  const target = Object.hasOwn(NETWORKS, name) ? NETWORKS[name as Network] : undefined;
  if (!target) {
    throw new Error(`unknown network: ${name} — expected ${Object.keys(NETWORKS).join(" | ")}`);
  }
  return target;
}
