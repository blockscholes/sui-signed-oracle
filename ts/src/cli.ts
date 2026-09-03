// CLI for the signed-oracle MVP. One entry; the localnet demo plus the two real
// networks:
//   pnpm publish-packages  -> publish     publish both packages, set the signer, write deployment.json
//   pnpm set-signer        -> set-signer  set/rotate the signer on an already-published registry
//   pnpm relay [tsMs]      -> relay       sign + relay a value batch (two series) and an SVI batch; re-running
//                                         with the SAME timestamp succeeds as a no-op (each update's timestamp
//                                         must be strictly newer than that sid's stored one to be applied)
//   pnpm publish-testnet   -> publish-testnet / publish-mainnet   publish all three packages to a real network
//   pnpm staging-relay [network] / mark-relay [network]           relay live wsAPI-signed batches there
//
// Every real-network command takes the network as its argument and defaults to
// testnet. The wsAPI endpoint (SUI_WSAPI_URL) is a separate choice and must be
// the environment whose signer that deployment registered — staging batches do
// not verify against a mainnet registry holding the production signer.

import { readFileSync, writeFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils";
import {
  setupLocalnet,
  publishPackages,
  setSigner,
  parseDeploymentJson,
  relay,
  readValue,
  readSviAMagnitude,
  readLastTimestamp,
  readLastBatchTimestamp,
  useDeployer,
  deriveIndexPxSid,
  deriveMarkPxSid,
  deriveModelParamsSid,
  type Deployment,
} from "./chain.js";
import {
  signPayloadSecp256k1,
  frameMessage,
  compressedPubkey,
  compressedPubkeyHex,
  stripHex,
  type RsvSignature,
} from "./signer.js";
import {
  buildValueBatchPayload,
  buildSviBatchPayload,
  valueUpdate,
  sviUpdate,
  signedBytesFor,
  toFixed,
} from "./payloads.js";
import { SPOT_SID, FORWARD_SID, SVI_SID, TEST_SIGNER_PRIV, SPOT, FORWARD, SVI } from "./config.js";
import {
  fetchMarkBatches,
  fetchSuiBatches,
  MARK_SUBSCRIPTION,
  SUBSCRIPTION,
  WSAPI_URL,
  type SuiWireResult,
} from "./wsapi_client.js";
import { convertWireBatch, type ConvertedBatch } from "./wire_convert.js";
import { deploymentUrl, resolveNetwork, type NetworkTarget, type Relayer } from "./networks.js";

const DEPLOYMENT_URL = new URL("../deployment.json", import.meta.url);
const loadDeployment = () => parseDeploymentJson(readFileSync(DEPLOYMENT_URL, "utf8"));

async function publish(): Promise<void> {
  const { client, keypair, address } = await setupLocalnet();
  console.log("publisher / admin address:", address);

  const dep = await publishPackages(client, keypair);
  console.log("published packages (bs_oracle UpgradeCap burned):", dep);

  await setSigner(client, keypair, dep, compressedPubkey(TEST_SIGNER_PRIV));
  console.log("set Block Scholes signer pubkey: 0x" + compressedPubkeyHex(TEST_SIGNER_PRIV));

  writeFileSync(DEPLOYMENT_URL, JSON.stringify({ address, ...dep }, null, 2));
  console.log("wrote deployment.json");
}

async function setSignerCmd(): Promise<void> {
  const dep = loadDeployment();
  const { client, keypair } = await setupLocalnet();
  await setSigner(client, keypair, dep, compressedPubkey(TEST_SIGNER_PRIV));
  console.log("signer set on", dep.bsPackageId);
}

/// Publish all three packages to a real network from that network's deployer
/// identity and register the wsAPI signer whose batches this deployment will
/// accept. Each publish mints brand-new package ids (design.md §5 — never an
/// in-place upgrade), so the signing domain separator changes with it and
/// `/config/shared/sui_oracle/package_ids` has to follow for this network.
async function publishNetworkCmd(target: NetworkTarget): Promise<void> {
  const signerHex = process.env["SUI_SIGNER_PUBKEY"];
  if (!signerHex) {
    throw new Error(
      "SUI_SIGNER_PUBKEY is required: the wsAPI signer's compressed secp256k1 pubkey (33 bytes, " +
        "0x02/0x03-prefixed). Recover it from several independent live-signed batches — not from a " +
        "KMS alias, which has named the wrong key before.",
    );
  }
  // The registry enforces both of these on-chain, but `set_signer` runs after
  // three packages are published and the oracle made immutable — a key this
  // command could have refused would abort only once that is irreversible.
  const signerPubkey = hexToBytes(stripHex(signerHex));
  if (signerPubkey.length !== 33) {
    throw new Error(`signer pubkey must be 33 compressed bytes, got ${signerPubkey.length}`);
  }
  const prefix = signerPubkey[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error(`signer pubkey must carry a compressed 0x02/0x03 prefix, got 0x${prefix?.toString(16)}`);
  }

  const client = target.client();
  const { keypair, address } = useDeployer(target.network);
  console.log("network:", target.network);
  console.log("deployer address:", address);
  console.log("balance (MIST):", (await client.getBalance({ owner: address })).totalBalance);

  const dep = await publishPackages(client, keypair, "network");
  console.log("published (bs_oracle UpgradeCap burned):", dep);

  await setSigner(client, keypair, dep, signerPubkey);
  console.log("registered signer:", signerHex);

  const file = deploymentUrl(target.network);
  writeFileSync(file, JSON.stringify({ address, ...dep }, null, 2));
  console.log(`wrote deployment.${target.network}.json`);
  console.log(`\nNEXT: point /config/shared/sui_oracle/package_ids at ${dep.bsPackageId} for ${target.network},`);
  console.log("and confirm the live parameter version actually changed before relaying.");
}

const sidHex = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

/// The sid wsAPI derived for a subscription must equal the one derived on-chain
/// under the deployed scope. They can only differ if the package id wsAPI resolved
/// for this network is not the bs_oracle package being verified against.
function assertSidMatches(label: string, fromWsapi: bigint, onChain: bigint): void {
  console.log(`  ${label}\n    wsAPI: ${sidHex(fromWsapi)}\n    chain: ${sidHex(onChain)}`);
  if (fromWsapi !== onChain) {
    throw new Error(
      `${label} sid mismatch: wsAPI resolved a different bs_oracle package than the one being ` +
        `derived against. Check /config/shared/sui_oracle/package_ids live in this environment.`,
    );
  }
  console.log(`    MATCH`);
}

async function relayCmd(tsArg?: string): Promise<void> {
  const dep = loadDeployment();
  const { client, keypair, address } = await setupLocalnet();

  const timestamp = tsArg ? BigInt(tsArg) : BigInt(Date.now()) - 5_000n;
  console.log("update timestamp:", timestamp);

  const sign = async (payload: Uint8Array) => {
    const signedBytes = signedBytesFor(dep.bsPackageId, payload);
    return frameMessage(await signPayloadSecp256k1(signedBytes, TEST_SIGNER_PRIV), payload);
  };

  // Two signed batches (a value batch of two series + an SVI batch). Every update
  // carries its own timestamp; the demo gives them the same one so re-running with
  // an explicit `tsMs` reproduces the pinned/non-advancing case. The batch timestamp
  // is always "now", so a re-run advances it even when every update is pinned.
  const batchTimestamp = BigInt(Date.now());
  const batches = [
    {
      kind: "value" as const,
      msg: await sign(
        buildValueBatchPayload(batchTimestamp, [
          valueUpdate(SPOT_SID, timestamp, SPOT),
          valueUpdate(FORWARD_SID, timestamp, FORWARD),
        ]),
      ),
    },
    {
      kind: "svi" as const,
      msg: await sign(buildSviBatchPayload(batchTimestamp, [sviUpdate(SVI_SID, timestamp, SVI)])),
    },
  ];

  for (const { kind, msg } of batches) {
    const result = await relay(client, keypair, dep, msg, kind);
    console.log(`relay ${kind}:`, result.success ? "ok" : `FAILED ${result.error}`);
    if (!result.success) {
      process.exitCode = 1;
      throw new Error(`${kind} relay failed: ${result.error ?? "unknown error"}`);
    }
  }

  console.log("value[SPOT_SID]:", await readValue(client, dep, address, SPOT_SID), "(expected", `${toFixed(SPOT)})`);
  console.log(
    "value[FORWARD_SID]:",
    await readValue(client, dep, address, FORWARD_SID),
    "(expected",
    `${toFixed(FORWARD)})`,
  );
  console.log("svi a magnitude[SVI_SID]:", await readSviAMagnitude(client, dep, address, SVI_SID));
  console.log("last_timestamp[SPOT_SID]:", await readLastTimestamp(client, dep, address, SPOT_SID));
  // Advances on every run, even one where each update is pinned and skipped.
  console.log("last_batch_timestamp:", await readLastBatchTimestamp(client, dep, address));
}

function firstUpdate<T>(updates: T[]): T {
  const first = updates[0];
  if (first === undefined) {
    throw new Error("wsAPI streamed a batch with zero updates");
  }
  return first;
}

/// Relay a single wsAPI-signed batch (already converted + framed) and print the
/// resulting PTB link. Throws if the on-chain verify/ingest call fails.
async function relayConverted(
  target: NetworkTarget,
  { client, keypair }: Relayer,
  dep: Deployment,
  converted: ConvertedBatch,
  signature: RsvSignature,
  label: string,
): Promise<void> {
  const payload =
    converted.kind === "value"
      ? buildValueBatchPayload(converted.timestamp, converted.updates)
      : buildSviBatchPayload(converted.timestamp, converted.updates);
  const message = frameMessage(signature, payload);
  const result = await relay(client, keypair, dep, message, converted.kind);
  console.log(`relay ${label}:`, result.success ? "ok" : `FAILED ${result.error}`);
  console.log("  events:", result.eventTypes);
  console.log(`  PTB: ${target.explorerTx(result.digest)}`);
  if (!result.success) {
    throw new Error(`${label} relay failed: ${result.error ?? "unknown error"}`);
  }
}

/// Live e2e proof: subscribe to the wsAPI as a Deepbook client for one SUI value
/// batch (spot index) and one SUI SVI batch (21d composite BTC smile), then relay
/// both through that network's real bs_oracle/example_consumer deployment.
///
/// The endpoint (`SUI_WSAPI_URL`, staging by default) must be the environment
/// whose signer is registered in this deployment's SignerRegistry, and whose
/// `package_ids` config resolves this network + pkg_ver to this bs_oracle. Get
/// either wrong and verification fails on-chain after gas is spent.
async function stagingRelayCmd(target: NetworkTarget): Promise<void> {
  const apiKey = process.env["SUI_API_KEY"];
  if (!apiKey) {
    throw new Error("SUI_API_KEY env var is required (a Deepbook API key for the target wsAPI)");
  }

  const dep = target.deployment();
  console.log(`${target.network} RPC:`, target.rpc);
  console.log("bs_oracle package:", dep.bsPackageId);
  console.log("bs_sid package:", dep.sidPackageId);
  console.log("example_consumer package:", dep.examplePackageId);

  console.log("wsAPI endpoint:", WSAPI_URL);
  console.log("connecting to wsAPI, waiting for one signed value batch + one signed SVI batch...");
  const { value, svi }: { value: SuiWireResult; svi: SuiWireResult } = await fetchSuiBatches(apiKey, target.network);
  console.log("received signed value batch:", JSON.stringify(value.data));
  console.log("received signed svi batch:", JSON.stringify(svi.data));

  const relayer = await target.setupRelayer();
  const { client, address } = relayer;
  console.log("relayer address:", address);

  const valueConverted = convertWireBatch(value.data);
  const sviConverted = convertWireBatch(svi.data);
  if (valueConverted.kind !== "value" || sviConverted.kind !== "svi") {
    throw new Error(`unexpected batch_kind from wsAPI: value=${value.data.batch_kind} svi=${svi.data.batch_kind}`);
  }

  const valueSid = BigInt(firstUpdate(valueConverted.updates).sid);
  const sviSid = BigInt(firstUpdate(sviConverted.updates).sid);

  // Before spending any gas: the sids wsAPI derived must be the ones this
  // deployment derives. A mismatch is a config fault, and relaying would still
  // "succeed" while writing under keys no consumer will ever look up.
  console.log("\nchecking the on-chain derivation against the sids wsAPI derived:");
  assertSidMatches(
    "index.px",
    valueSid,
    await deriveIndexPxSid(
      client,
      address,
      dep,
      SUBSCRIPTION.indexAsset,
      SUBSCRIPTION.baseAsset,
      SUBSCRIPTION.decimals,
      "ms",
    ),
  );
  assertSidMatches(
    "model.params",
    sviSid,
    await deriveModelParamsSid(
      client,
      address,
      dep,
      SUBSCRIPTION.modelAsset,
      SUBSCRIPTION.baseAsset,
      SUBSCRIPTION.model,
      SUBSCRIPTION.tenorMs,
      SUBSCRIPTION.decimals,
      "ms",
    ),
  );

  console.log("");
  await relayConverted(target, relayer, dep, valueConverted, value.signature, "value");
  await relayConverted(target, relayer, dep, sviConverted, svi.signature, "svi");

  console.log("readback value[sid]:", await readValue(client, dep, address, valueSid));
  console.log("readback svi a magnitude[sid]:", await readSviAMagnitude(client, dep, address, sviSid));
  console.log("readback last_timestamp[value sid]:", await readLastTimestamp(client, dep, address, valueSid));
}

/// Relay two `mark.px` series in one run: a perpetual and a dated future. Same
/// feed, same base asset, same decimals — the asset class and the expiry are the
/// only reason they are two series, so this proves both that `asset` is identity
/// and that an absent expiry still occupies its BCS tag byte rather than being
/// dropped (which would shift later fields and let two instruments collide).
///
/// Both are greek-free, so each value is a single number and rides a value batch.
async function markRelayCmd(target: NetworkTarget): Promise<void> {
  const apiKey = process.env["SUI_API_KEY"];
  if (!apiKey) {
    throw new Error("SUI_API_KEY env var is required (a Deepbook API key for the target wsAPI)");
  }

  const dep = target.deployment();
  console.log(`${target.network} RPC:`, target.rpc);
  console.log("wsAPI endpoint:", WSAPI_URL);
  console.log("bs_oracle package:", dep.bsPackageId);

  const { perpetual: perpMark, future: futMark } = MARK_SUBSCRIPTION;
  console.log(`\nsubscribing to two marks:`);
  console.log(`  perpetual  ${perpMark.exchange} ${perpMark.baseAsset} (no expiry)`);
  console.log(`  future     ${futMark.exchange} ${futMark.baseAsset} @ ${futMark.expiry}`);
  const { perpetual, future } = await fetchMarkBatches(apiKey, target.network);
  console.log("received signed perpetual mark:", JSON.stringify(perpetual.data));
  console.log("received signed future mark:", JSON.stringify(future.data));

  const relayer = await target.setupRelayer();
  const { client, address } = relayer;
  console.log("relayer address:", address);

  const perpConverted = convertWireBatch(perpetual.data);
  const futConverted = convertWireBatch(future.data);
  if (perpConverted.kind !== "value" || futConverted.kind !== "value") {
    throw new Error(
      `a scalar mark must arrive as a value batch: perpetual=${perpetual.data.batch_kind} future=${future.data.batch_kind}`,
    );
  }

  const perpSid = BigInt(firstUpdate(perpConverted.updates).sid);
  const futSid = BigInt(firstUpdate(futConverted.updates).sid);

  console.log("\nchecking the on-chain derivation against the sids wsAPI derived:");
  assertSidMatches(
    "mark.px perpetual",
    perpSid,
    await deriveMarkPxSid(
      client,
      address,
      dep,
      perpMark.asset,
      perpMark.exchange,
      perpMark.baseAsset,
      null,
      SUBSCRIPTION.decimals,
      "ms",
    ),
  );
  assertSidMatches(
    "mark.px future",
    futSid,
    await deriveMarkPxSid(
      client,
      address,
      dep,
      futMark.asset,
      futMark.exchange,
      futMark.baseAsset,
      futMark.expiryMs,
      SUBSCRIPTION.decimals,
      "ms",
    ),
  );
  if (perpSid === futSid) {
    throw new Error("the two marks derived the same sid — they must be distinct series");
  }
  console.log("  the two marks are distinct series: OK");

  console.log("");
  await relayConverted(target, relayer, dep, perpConverted, perpetual.signature, "perpetual mark");
  await relayConverted(target, relayer, dep, futConverted, future.signature, "future mark");

  console.log("readback perpetual mark[sid]:", await readValue(client, dep, address, perpSid));
  console.log("readback future mark[sid]:", await readValue(client, dep, address, futSid));
  console.log("readback last_timestamp[perpetual]:", await readLastTimestamp(client, dep, address, perpSid));
  console.log("readback last_timestamp[future]:", await readLastTimestamp(client, dep, address, futSid));
}

const cmd = process.argv[2];
const arg = process.argv[3];
switch (cmd) {
  case "publish":
    await publish();
    break;
  case "set-signer":
    await setSignerCmd();
    break;
  case "relay":
    await relayCmd(arg);
    break;
  case "publish-testnet":
    await publishNetworkCmd(resolveNetwork("testnet"));
    break;
  case "publish-mainnet":
    await publishNetworkCmd(resolveNetwork("mainnet"));
    break;
  case "staging-relay":
    await stagingRelayCmd(resolveNetwork(arg));
    break;
  case "mark-relay":
    await markRelayCmd(resolveNetwork(arg));
    break;
  default:
    console.error(
      `unknown command: ${cmd ?? "(none)"} — expected: publish | set-signer | relay [tsMs] | ` +
        `publish-testnet | publish-mainnet | staging-relay [network] | mark-relay [network]`,
    );
    process.exitCode = 1;
}
