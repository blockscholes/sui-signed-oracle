// Fixed testnet deployment for the wsAPI -> Sui testnet e2e proof, with the
// SignerRegistry's signer set to a real wsAPI signer's pubkey, so this can relay
// genuinely wsAPI-signed batches rather than locally re-signed ones.
//
// Recover that pubkey by ECDSA-recovering it from several independent live-signed
// batches and cross-checking, never from a KMS alias whose name merely sounds like
// the signing key — the signing path is what decides, and it has not always been
// what the name suggests.

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { FaucetRateLimitError, getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import type { Deployment } from "./chain.js";

export const TESTNET_DEPLOYMENT: Deployment = {
  bsPackageId: "0xfea992ee94b84dcb9a7aacffddf703c514804205e3fa234e22ccbac0914b837b",
  // Filled by `pnpm publish-testnet`, which writes deployment.testnet.json and is
  // preferred over this constant when that file exists.
  sidPackageId: "",
  examplePackageId: "0x62b15982831425b7db64149aec82670af597e655818fbc6e4a07a3e6d05c542a",
  registryId: "0xa579d93b7c3b4d52585c008ba9fcf856bc64c6fbeadd836bfbb544d134986064",
  oracleId: "0x8b211d723bfebf91f5010ef5b0329d4351541d982088804a00717fa7e432b86f",
  adminCapId: "0x190b1e16e78cf9ef6a88b4808d09df90acf681ea3521ed77e07e1978f093e174",
};

/// `getFullnodeUrl("testnet")` (fullnode.testnet.sui.io) 404s from this environment's
/// network path. nodeinfra's public testnet RPC is reachable but lacks the fullnode
/// index store (`suix_getBalance` etc. fail with "Index store not available"); publicnode's
/// does support it. Override via SUI_TESTNET_RPC if needed.
const DEFAULT_TESTNET_RPC = "https://sui-testnet-rpc.publicnode.com";
export const TESTNET_RPC = process.env["SUI_TESTNET_RPC"] ?? DEFAULT_TESTNET_RPC;

const MIN_RELAY_BALANCE = 500_000_000n; // 0.5 SUI — two moveCalls per relay, no publish.

export function testnetClient(): SuiClient {
  return new SuiClient({ url: TESTNET_RPC });
}

const FAUCET_RETRIES = 5;

async function requestFaucetWithRetry(address: string): Promise<void> {
  for (let attempt = 1; attempt <= FAUCET_RETRIES; attempt++) {
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: address });
      return;
    } catch (err) {
      if (!(err instanceof FaucetRateLimitError) || attempt === FAUCET_RETRIES) throw err;
      console.log(`faucet request rate-limited (attempt ${attempt}/${FAUCET_RETRIES}), retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

async function fundIfNeeded(client: SuiClient, address: string): Promise<void> {
  const bal = await client.getBalance({ owner: address });
  if (BigInt(bal.totalBalance) >= MIN_RELAY_BALANCE) return;
  await requestFaucetWithRetry(address);
  for (let i = 0; i < 40; i++) {
    const balance = await client.getBalance({ owner: address });
    if (BigInt(balance.totalBalance) >= MIN_RELAY_BALANCE) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`testnet faucet funding timed out for ${address}`);
}

/// A funded testnet keypair: loads SUI_TESTNET_PRIVKEY (bech32 `suiprivkey1...`) if
/// set, else generates a fresh one and tops it up from the public testnet faucet.
export async function setupTestnet(): Promise<{
  client: SuiClient;
  keypair: Ed25519Keypair;
  address: string;
}> {
  const client = testnetClient();
  const existing = process.env["SUI_TESTNET_PRIVKEY"];
  const keypair = existing ? Ed25519Keypair.fromSecretKey(existing) : new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  if (!existing) {
    console.log(
      "generated a new testnet relayer keypair; set SUI_TESTNET_PRIVKEY to reuse it and skip re-funding:",
      keypair.getSecretKey(),
    );
  }
  await fundIfNeeded(client, address);
  return { client, keypair, address };
}
