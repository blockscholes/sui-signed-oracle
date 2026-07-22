// CLI for the signed-oracle MVP. One entry, three subcommands:
//   pnpm publish-packages  -> publish     publish both packages, set the signer, write deployment.json
//   pnpm set-signer        -> set-signer  set/rotate the signer on an already-published registry
//   pnpm relay [tsMs]      -> relay       sign + relay a value batch (two series) and an SVI batch; re-running
//                                         with the SAME timestamp succeeds as a no-op (each update's timestamp
//                                         must be strictly newer than that sid's stored one to be applied)

import { readFileSync, writeFileSync } from "node:fs";
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
} from "./chain.js";
import { signPayloadSecp256k1, frameMessage, compressedPubkeyHex } from "./signer.js";
import {
  buildValueBatchPayload,
  buildSviBatchPayload,
  valueUpdate,
  sviUpdate,
  signedBytesFor,
  toFixed,
} from "./payloads.js";
import { SPOT_SID, FORWARD_SID, SVI_SID, TEST_SIGNER_PRIV, SPOT, FORWARD, SVI } from "./config.js";

const DEPLOYMENT_URL = new URL("../deployment.json", import.meta.url);
const loadDeployment = () => parseDeploymentJson(readFileSync(DEPLOYMENT_URL, "utf8"));

async function publish(): Promise<void> {
  const { client, keypair, address } = await setupLocalnet();
  console.log("publisher / admin address:", address);

  const dep = await publishPackages(client, keypair);
  console.log("published packages (bs_oracle UpgradeCap burned):", dep);

  await setSigner(client, keypair, dep);
  console.log("set Block Scholes signer pubkey: 0x" + compressedPubkeyHex(TEST_SIGNER_PRIV));

  writeFileSync(DEPLOYMENT_URL, JSON.stringify({ address, ...dep }, null, 2));
  console.log("wrote deployment.json");
}

async function setSignerCmd(): Promise<void> {
  const dep = loadDeployment();
  const { client, keypair } = await setupLocalnet();
  await setSigner(client, keypair, dep);
  console.log("signer set on", dep.bsPackageId);
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

const cmd = process.argv[2];
switch (cmd) {
  case "publish":
    await publish();
    break;
  case "set-signer":
    await setSignerCmd();
    break;
  case "relay":
    await relayCmd(process.argv[3]);
    break;
  default:
    console.error(`unknown command: ${cmd ?? "(none)"} — expected: publish | set-signer | relay [tsMs]`);
    process.exitCode = 1;
}
