// All on-chain interaction for the MVP:
//   - localnet plumbing: CLI env bootstrap, client, the publisher/relayer keypair
//     (exported from the sui keystore so it owns the AdminCap), and faucet funding;
//   - publishing both Move packages (bs_oracle + example_consumer) and setting the
//     Block Scholes signer on the SignerRegistry;
//   - the relayer: the atomic verify -> consumer PTB, plus devInspect reads.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction } from "@mysten/sui/transactions";
import { RPC_URL, FAUCET_URL, TEST_SIGNER_PRIV } from "./config.js";
import { compressedPubkey } from "./signer.js";

const CLOCK_ID = "0x6";
/// Gas budget for a package publish; the active address must hold at least this.
const PUBLISH_GAS_BUDGET = 2_000_000_000n;
/// Named environment Move.lock pins framework dependencies for (see both Move.toml
/// files) — decoupled from the actual network we publish to (a real localnet), since
/// `--build-env` only accepts a stable, known environment name.
const BUILD_ENV = "testnet";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// === Localnet plumbing ===

/// Run the `sui` CLI with explicit args (no shell), returning stdout. `input` feeds
/// stdin (the first-run interactive setup). Arg arrays avoid shell quoting/injection
/// from interpolated values like RPC_URL or package paths that contain spaces.
function sui(args: string[], input?: string): string {
  return execFileSync("sui", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

export function client(): SuiClient {
  return new SuiClient({ url: RPC_URL });
}

/// Create the sui CLI config + a localnet env on first run, and make localnet active.
export function ensureCliEnv(): void {
  let hasConfig = true;
  try {
    sui(["client", "active-address"]);
  } catch {
    hasConfig = false;
  }
  if (!hasConfig) {
    // Feed the first-run prompts over stdin: connect? -> y, RPC url, alias, key scheme 0.
    sui(["client"], `y\n${RPC_URL}\nlocalnet\n0\n`);
  }
  try {
    sui(["client", "new-env", "--alias", "localnet", "--rpc", RPC_URL]);
  } catch {
    /* already exists */
  }
  sui(["client", "switch", "--env", "localnet"]);
}

export function activeAddress(): string {
  return sui(["client", "active-address"]).trim();
}

function exportedPrivateKeyFromJson(json: string): string {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("sui keytool export did not return an object");
  }

  const direct = parsed["exportedPrivateKey"];
  if (typeof direct === "string") return direct;

  const key = parsed["key"];
  if (isRecord(key) && typeof key["exportedPrivateKey"] === "string") {
    return key["exportedPrivateKey"];
  }

  throw new Error("sui keytool export response did not include exportedPrivateKey");
}

/// Export the active address's key from the keystore so the SDK signs with the
/// same key the CLI publishes with (the AdminCap owner).
export function exportActiveKeypair(): { keypair: Ed25519Keypair; address: string } {
  const address = activeAddress();
  const bech32 = exportedPrivateKeyFromJson(sui(["keytool", "export", "--key-identity", address, "--json"]));
  return { keypair: Ed25519Keypair.fromSecretKey(bech32), address };
}

export async function fundAddress(c: SuiClient, address: string, minBalance = 1n): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  for (let i = 0; i < 40; i++) {
    const bal = await c.getBalance({ owner: address });
    if (BigInt(bal.totalBalance) >= minBalance) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`faucet funding timed out for ${address}`);
}

/// One call: bootstrap CLI env, export keypair, ensure it is funded.
export async function setupLocalnet(): Promise<{ client: SuiClient; keypair: Ed25519Keypair; address: string }> {
  ensureCliEnv();
  const c = client();
  const { keypair, address } = exportActiveKeypair();
  const bal = await c.getBalance({ owner: address });
  if (BigInt(bal.totalBalance) < PUBLISH_GAS_BUDGET) await fundAddress(c, address, PUBLISH_GAS_BUDGET);
  return { client: c, keypair, address };
}

// === Publishing + signer ===

// `bsPackageId` doubles as the moveCall target and the address `signedBytesFor`
// prepends before hashing — these only stay identical because each version is
// independently published, not an in-place Sui upgrade (design.md §5); upgrading
// in-place would make them diverge (`type_name::original_id` stays pinned to
// the original address across an upgrade lineage).
export interface Deployment {
  bsPackageId: string;
  examplePackageId: string;
  registryId: string;
  oracleId: string;
  adminCapId: string;
}

interface ObjectChange {
  type: string;
  objectType?: string;
  objectId?: string;
  packageId?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const BS_PKG_PATH = resolve(here, "../../move/bs_oracle");
const EXAMPLE_PKG_PATH = resolve(here, "../../move/example_consumer");

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`deployment field ${field} is missing or invalid`);
  }
  return value;
}

export function parseDeploymentJson(json: string): Deployment {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("deployment JSON must be an object");
  }
  return {
    bsPackageId: requiredString(parsed, "bsPackageId"),
    examplePackageId: requiredString(parsed, "examplePackageId"),
    registryId: requiredString(parsed, "registryId"),
    oracleId: requiredString(parsed, "oracleId"),
    adminCapId: requiredString(parsed, "adminCapId"),
  };
}

function objectChangeFromUnknown(value: unknown): ObjectChange | undefined {
  if (!isRecord(value)) return undefined;
  const type = value["type"];
  if (typeof type !== "string") return undefined;

  const change: ObjectChange = { type };
  const objectType = value["objectType"];
  const objectId = value["objectId"];
  const packageId = value["packageId"];
  if (typeof objectType === "string") change.objectType = objectType;
  if (typeof objectId === "string") change.objectId = objectId;
  if (typeof packageId === "string") change.packageId = packageId;
  return change;
}

function objectChangesFromPublishResult(value: unknown): ObjectChange[] {
  if (!isRecord(value)) return [];
  const objectChanges = value["objectChanges"];
  if (!Array.isArray(objectChanges)) return [];
  return objectChanges.flatMap((change) => {
    const parsed = objectChangeFromUnknown(change);
    return parsed ? [parsed] : [];
  });
}

function publishStatusForError(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const effects = value["effects"];
  if (!isRecord(effects)) return value;
  return effects["status"] ?? value;
}

/// `sui client publish` requires the active client env to have a matching Move.lock
/// pin, which a `--force-regenesis` localnet never does (its chain id is different
/// every run). `test-publish` decouples build-time dependency resolution
/// (`--build-env`) from the network actually published to, at the cost of needing a
/// shared `pubfilePath` so a dependent package (example_consumer on bs_oracle) can
/// resolve the other's just-published address.
function publishOne(path: string, pubfilePath: string): { packageId: string; created: ObjectChange[] } {
  const out = sui([
    "client",
    "test-publish",
    "--json",
    "--skip-dependency-verification",
    "--gas-budget",
    String(PUBLISH_GAS_BUDGET),
    "--build-env",
    BUILD_ENV,
    "--pubfile-path",
    pubfilePath,
    path,
  ]);
  const res: unknown = JSON.parse(out.slice(out.indexOf("{")));
  const changes = objectChangesFromPublishResult(res);
  const published = changes.find((c) => c.type === "published");
  if (!published?.packageId) {
    throw new Error(`no published package for ${path}: ${JSON.stringify(publishStatusForError(res))}`);
  }
  return { packageId: published.packageId, created: changes.filter((c) => c.type === "created") };
}

/// Destroys a package's `UpgradeCap`, making it permanently immutable. Without
/// this, the domain-separator scheme's "independent package per version, never
/// an in-place upgrade" invariant (design.md §5) is only policy: an in-place
/// upgrade could add a function that mints a `ValueBatch`/`SviBatch` directly,
/// bypassing the signature check entirely, since Sui's type identity for the
/// batch structs stays pinned to this package regardless of which upgraded
/// module version actually constructs one.
async function burnUpgradeCap(client: SuiClient, keypair: Ed25519Keypair, upgradeCapId: string): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({ target: "0x2::package::make_immutable", arguments: [tx.object(upgradeCapId)] });
  const res = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`burning UpgradeCap ${upgradeCapId} failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: res.digest });
}

/// Publishes bs_oracle first, then example_consumer (which auto-links to the
/// published bs_oracle via Move.lock), yielding two distinct package ids —
/// keeping the verifier package separate from the consumer package. Burns
/// bs_oracle's `UpgradeCap` immediately after publish (see `burnUpgradeCap`).
export async function publishPackages(client: SuiClient, keypair: Ed25519Keypair): Promise<Deployment> {
  const pubDir = mkdtempSync(join(tmpdir(), "bs-oracle-pub-"));
  const pubfilePath = join(pubDir, "pubfile.toml");
  let bs: { packageId: string; created: ObjectChange[] };
  let example: { packageId: string; created: ObjectChange[] };
  try {
    bs = publishOne(BS_PKG_PATH, pubfilePath);
    example = publishOne(EXAMPLE_PKG_PATH, pubfilePath);
  } finally {
    rmSync(pubDir, { recursive: true, force: true });
  }
  const registry = bs.created.find((c) => String(c.objectType).endsWith("::registry::SignerRegistry"));
  const adminCap = bs.created.find((c) => String(c.objectType).endsWith("::registry::AdminCap"));
  const bsUpgradeCap = bs.created.find((c) => String(c.objectType).endsWith("::package::UpgradeCap"));

  const oracle = example.created.find((c) => String(c.objectType).endsWith("::oracle::ExampleOracle"));

  if (!registry || !adminCap || !oracle || !bsUpgradeCap) {
    throw new Error(
      `could not locate created objects.\nbs: ${JSON.stringify(bs.created)}\nexample: ${JSON.stringify(example.created)}`,
    );
  }
  if (!registry.objectId || !adminCap.objectId || !oracle.objectId || !bsUpgradeCap.objectId) {
    throw new Error(
      `created objects are missing ids.\nbs: ${JSON.stringify(bs.created)}\nexample: ${JSON.stringify(example.created)}`,
    );
  }

  await burnUpgradeCap(client, keypair, bsUpgradeCap.objectId);

  return {
    bsPackageId: bs.packageId,
    examplePackageId: example.packageId,
    registryId: registry.objectId,
    oracleId: oracle.objectId,
    adminCapId: adminCap.objectId,
  };
}

export async function setSigner(client: SuiClient, keypair: Ed25519Keypair, dep: Deployment): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${dep.bsPackageId}::registry::set_signer`,
    arguments: [
      tx.object(dep.registryId),
      tx.object(dep.adminCapId),
      tx.pure.vector("u8", Array.from(compressedPubkey(TEST_SIGNER_PRIV))),
    ],
  });
  const res = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`set_signer failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: res.digest });
}

// === Relayer ===

/// Which homogeneous batch a message carries — picks the verify + ingest pair.
export type BatchKind = "value" | "svi";

const VERIFY_FN: Record<BatchKind, string> = {
  value: "verify_and_create_value_batch",
  svi: "verify_and_create_svi_batch",
};
const INGEST_FN: Record<BatchKind, string> = {
  value: "ingest_value_batch",
  svi: "ingest_svi_batch",
};

export interface RelayResult {
  digest: string;
  success: boolean;
  error?: string;
  eventTypes: string[];
}

/// Build the composed verify -> consumer PTB for a signed batch message of the
/// given category.
export function buildRelayTx(dep: Deployment, message: Uint8Array, kind: BatchKind): Transaction {
  const tx = new Transaction();
  const batch = tx.moveCall({
    target: `${dep.bsPackageId}::verify::${VERIFY_FN[kind]}`,
    arguments: [tx.object(dep.registryId), tx.object(CLOCK_ID), tx.pure.vector("u8", Array.from(message))],
  })[0];
  if (batch === undefined) {
    throw new Error(`${VERIFY_FN[kind]} did not return a batch transaction argument`);
  }
  tx.moveCall({
    target: `${dep.examplePackageId}::oracle::${INGEST_FN[kind]}`,
    arguments: [tx.object(dep.oracleId), batch, tx.object(CLOCK_ID)],
  });
  return tx;
}

export async function relay(
  client: SuiClient,
  keypair: Ed25519Keypair,
  dep: Deployment,
  message: Uint8Array,
  kind: BatchKind,
): Promise<RelayResult> {
  const tx = buildRelayTx(dep, message, kind);
  const res = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const success = res.effects?.status.status === "success";
  const result: RelayResult = {
    digest: res.digest,
    success,
    eventTypes: (res.events ?? []).map((e) => e.type),
  };
  if (!success) {
    result.error = JSON.stringify(res.effects?.status);
  }
  return result;
}

function leToBigInt(bytes: number[]): bigint {
  let v = 0n;
  for (let i = bytes.length; i > 0; i--) {
    const byte = bytes[i - 1];
    if (byte === undefined) {
      throw new Error("unexpected sparse byte array");
    }
    v = (v << 8n) | BigInt(byte);
  }
  return v;
}

/// Read a `u64`/`u32` return value from a single-`moveCall` devInspect of `fn`.
async function readScalar(
  client: SuiClient,
  dep: Deployment,
  sender: string,
  fn: string,
  sid: bigint,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${dep.examplePackageId}::oracle::${fn}`,
    arguments: [tx.object(dep.oracleId), tx.pure.u256(sid)],
  });
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  const rv = res.results?.[0]?.returnValues?.[0];
  if (!rv) throw new Error(`no return value for ${fn}: ${JSON.stringify(res.error ?? res)}`);
  return leToBigInt(rv[0]);
}

/// Read the stored value (today: spot or forward price) for a `sid` via devInspect.
export function readValue(client: SuiClient, dep: Deployment, sender: string, sid: bigint): Promise<bigint> {
  return readScalar(client, dep, sender, "value", sid);
}

/// Read the SVI `a` magnitude (the first of the `svi_params` tuple) for a `sid`
/// via devInspect — enough to prove an SVI update landed with its values.
export function readSviAMagnitude(client: SuiClient, dep: Deployment, sender: string, sid: bigint): Promise<bigint> {
  return readScalar(client, dep, sender, "svi_params", sid);
}

/// Read the latest accepted timestamp for a `sid` via devInspect.
export function readLastTimestamp(client: SuiClient, dep: Deployment, sender: string, sid: bigint): Promise<bigint> {
  return readScalar(client, dep, sender, "last_timestamp", sid);
}
