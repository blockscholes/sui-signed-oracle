// All on-chain interaction for the MVP:
//   - localnet plumbing: CLI env bootstrap, client, the publisher/relayer keypair
//     (exported from the sui keystore so it owns the AdminCap), and faucet funding;
//   - publishing both Move packages (bs_oracle + example_consumer) and setting the
//     Block Scholes signer on the SignerRegistry;
//   - the relayer: the atomic verify -> consumer PTB, plus devInspect reads.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction, type TransactionArgument } from "@mysten/sui/transactions";
import { RPC_URL, FAUCET_URL } from "./config.js";

const CLOCK_ID = "0x6";
/// Bound on AdminCap-gated calls (setSigner/setPaused) so a hung RPC surfaces as an
/// error instead of blocking indefinitely — setPaused is the emergency-stop lever, so
/// this matters most exactly when an operator is relying on it during an incident.
const ADMIN_CALL_TIMEOUT_MS = 30_000;
/// Gas budget for a package publish; the active address must hold at least this in a
/// single coin. Observed actual cost is ~0.03 SUI per package; this leaves ~10x margin
/// without requiring an oversized single gas coin.
const PUBLISH_GAS_BUDGET = 300_000_000n;
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

/// Point the CLI at testnet and the deployer identity, then export that key so the
/// SDK signs with the same address the CLI publishes from. The `testnet` env must
/// already exist in the CLI config, and must be an endpoint serving gRPC —
/// `test-publish` needs it, and JSON-RPC-only endpoints fail with a missing
/// grpc-status header.
export function useTestnetDeployer(): { keypair: Ed25519Keypair; address: string } {
  try {
    sui(["client", "switch", "--env", "testnet"]);
  } catch (err) {
    throw new Error(
      "no `testnet` env in the sui CLI config — add one pointing at a gRPC-capable fullnode " +
        "(`sui client new-env --alias testnet --rpc <url>`)",
      { cause: err },
    );
  }
  sui(["client", "switch", "--address", TESTNET_DEPLOYER_ALIAS]);
  return exportActiveKeypair();
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
  /// bs_sid: a pure derivation library, scoped per call by `bsPackageId`, so it
  /// depends on nothing and can be published in any order.
  sidPackageId: string;
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
const SID_PKG_PATH = resolve(here, "../../move/bs_sid");

/// sui keystore alias that owns the testnet packages and their AdminCap.
const TESTNET_DEPLOYER_ALIAS = process.env["SUI_DEPLOYER_ALIAS"] ?? "testnet-deployer";

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
    sidPackageId: requiredString(parsed, "sidPackageId"),
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

function activeEnv(): string {
  return sui(["client", "active-env"]).trim();
}

/// `sui client publish` refuses a package that already records a publication for
/// the active environment, and offers no force flag — the documented path is to
/// drop that entry. Republishing is the intended flow here rather than an edge
/// case: every oracle version is a brand-new package by design (design.md §5,
/// never an in-place upgrade), so a fresh id is the point. Returns the id being
/// replaced, so the caller can say what it just dropped; git history keeps the
/// committed record either way.
function clearPublication(pkgPath: string, env: string): string | undefined {
  const file = join(pkgPath, "Published.toml");
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `[published.${env}]`);
  if (start === -1) return undefined;

  let end = start + 1;
  let previous: string | undefined;
  while (end < lines.length && !lines[end]?.trimStart().startsWith("[")) {
    const match = /^\s*published-at\s*=\s*"([^"]+)"/.exec(lines[end] ?? "");
    if (match) previous = match[1];
    end++;
  }
  lines.splice(start, end - start);
  writeFileSync(file, `${lines.join("\n").trimEnd()}\n`);
  return previous;
}

/// Where a publish is going, which decides the CLI verb.
///
/// A real network publish records `Published.toml` per package — the committed
/// record of what is deployed where, and what a dependent resolves its
/// dependencies from.
///
/// Localnet cannot use it: `sui client publish` requires the active env to have a
/// matching Move.lock pin, which a `--force-regenesis` localnet never has (fresh
/// chain id every run). `test-publish` decouples build-time dependency resolution
/// (`--build-env`) from the network published to, at the cost of a shared
/// `pubfilePath` for dependents to resolve through, and writes no Published.toml.
type PublishTarget = { kind: "localnet"; pubfilePath: string } | { kind: "network" };

function publishOne(path: string, target: PublishTarget): { packageId: string; created: ObjectChange[] } {
  const verb = target.kind === "localnet" ? "test-publish" : "publish";
  const args = ["client", verb, "--json", "--gas-budget", String(PUBLISH_GAS_BUDGET)];
  if (target.kind === "localnet") {
    args.push("--build-env", BUILD_ENV, "--pubfile-path", target.pubfilePath);
  }
  args.push(path);
  const out = sui(args);
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
/// bs_oracle's `UpgradeCap` before either dependent is published, so no failure
/// path can leave a published verifier upgradeable (see `burnUpgradeCap`).
export async function publishPackages(
  client: SuiClient,
  keypair: Ed25519Keypair,
  mode: "localnet" | "network" = "localnet",
): Promise<Deployment> {
  const pubDir = mode === "localnet" ? mkdtempSync(join(tmpdir(), "bs-oracle-pub-")) : undefined;
  const target: PublishTarget = pubDir
    ? { kind: "localnet", pubfilePath: join(pubDir, "pubfile.toml") }
    : { kind: "network" };
  if (mode === "network") {
    const env = activeEnv();
    for (const [name, pkgPath] of [
      ["bs_oracle", BS_PKG_PATH],
      ["bs_sid", SID_PKG_PATH],
      ["example_consumer", EXAMPLE_PKG_PATH],
    ] as const) {
      const previous = clearPublication(pkgPath, env);
      if (previous) console.log(`replacing ${env} publication of ${name}: was ${previous}`);
    }
  }
  let bs: { packageId: string; created: ObjectChange[] };
  let sid: { packageId: string; created: ObjectChange[] };
  let example: { packageId: string; created: ObjectChange[] };
  try {
    bs = publishOne(BS_PKG_PATH, target);
    // Burn before publishing anything else. A later failure would otherwise
    // strand a verifier package that exists on chain — and whose id the
    // publication files already record — with its UpgradeCap still live, which
    // is precisely the state §5 rules out.
    const bsUpgradeCapId = bs.created.find((c) => String(c.objectType).endsWith("::package::UpgradeCap"))?.objectId;
    if (!bsUpgradeCapId) {
      throw new Error(`bs_oracle published without a locatable UpgradeCap: ${JSON.stringify(bs.created)}`);
    }
    await burnUpgradeCap(client, keypair, bsUpgradeCapId);
    sid = publishOne(SID_PKG_PATH, target);
    example = publishOne(EXAMPLE_PKG_PATH, target);
  } finally {
    if (pubDir) rmSync(pubDir, { recursive: true, force: true });
  }
  const registry = bs.created.find((c) => String(c.objectType).endsWith("::registry::SignerRegistry"));
  const adminCap = bs.created.find((c) => String(c.objectType).endsWith("::registry::AdminCap"));

  const oracle = example.created.find((c) => String(c.objectType).endsWith("::oracle::ExampleOracle"));

  if (!registry || !adminCap || !oracle) {
    throw new Error(
      `could not locate created objects.\nbs: ${JSON.stringify(bs.created)}\nexample: ${JSON.stringify(example.created)}`,
    );
  }
  if (!registry.objectId || !adminCap.objectId || !oracle.objectId) {
    throw new Error(
      `created objects are missing ids.\nbs: ${JSON.stringify(bs.created)}\nexample: ${JSON.stringify(example.created)}`,
    );
  }

  return {
    bsPackageId: bs.packageId,
    sidPackageId: sid.packageId,
    examplePackageId: example.packageId,
    registryId: registry.objectId,
    oracleId: oracle.objectId,
    adminCapId: adminCap.objectId,
  };
}

/// Shared request/response flow for AdminCap-gated registry calls: build the PTB via
/// `buildArgs`, submit, check status, and wait for finality.
async function execAdminCall(
  client: SuiClient,
  keypair: Ed25519Keypair,
  target: string,
  buildArgs: (tx: Transaction) => TransactionArgument[],
  errLabel: string,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({ target, arguments: buildArgs(tx) });
  const res = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
    signal: AbortSignal.timeout(ADMIN_CALL_TIMEOUT_MS),
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`${errLabel} failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: res.digest, timeout: ADMIN_CALL_TIMEOUT_MS });
}

export async function setSigner(
  client: SuiClient,
  keypair: Ed25519Keypair,
  dep: Deployment,
  signerPubkey: Uint8Array,
): Promise<void> {
  return execAdminCall(
    client,
    keypair,
    `${dep.bsPackageId}::registry::set_signer`,
    (tx) => [tx.object(dep.registryId), tx.object(dep.adminCapId), tx.pure.vector("u8", Array.from(signerPubkey))],
    "set_signer",
  );
}

/// Toggle the registry's emergency pause flag (AdminCap-gated).
export async function setPaused(
  client: SuiClient,
  keypair: Ed25519Keypair,
  dep: Deployment,
  paused: boolean,
): Promise<void> {
  return execAdminCall(
    client,
    keypair,
    `${dep.bsPackageId}::registry::set_paused`,
    (tx) => [tx.object(dep.registryId), tx.object(dep.adminCapId), tx.pure.bool(paused)],
    `set_paused(${paused})`,
  );
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
    arguments: [tx.object(dep.registryId), tx.pure.vector("u8", Array.from(message))],
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

function requireSidPackage(dep: Deployment): void {
  if (!dep.sidPackageId) {
    throw new Error("no bs_sid package id in the deployment — run `pnpm publish-testnet` first");
  }
}

/// Decode a `u256` returned by the `resultIndex`-th moveCall of a devInspect.
async function devInspectU256(
  client: SuiClient,
  sender: string,
  tx: Transaction,
  resultIndex: number,
): Promise<bigint> {
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  const rv = res.results?.[resultIndex]?.returnValues?.[0];
  if (!rv) throw new Error(`no return value at result ${resultIndex}: ${JSON.stringify(res.error ?? res)}`);
  return leToBigInt(rv[0]);
}

/// Derive an expiryless `index.px` sid on-chain. Pure and read-only: no gas, no
/// signing, no objects. `oraclePackageId` is the scope — the deployment the sid
/// belongs to, which must be the id wsAPI resolves for this network. `index_px`
/// bakes in the `blockscholes` exchange — index.px never serves `composite` —
/// but takes `asset`, which a non-crypto underlying suffixes (`spot-equity`).
export function deriveIndexPxSid(
  client: SuiClient,
  sender: string,
  dep: Deployment,
  asset: string,
  baseAsset: string,
  decimals: number,
  timestampPrecision: string,
): Promise<bigint> {
  requireSidPackage(dep);
  const tx = new Transaction();
  // `Expiry` is a struct, so `Option<Expiry>` is not a pure type: even the
  // absent case has to be produced by a call rather than serialised inline.
  const expiry = tx.moveCall({
    target: "0x1::option::none",
    typeArguments: [`${dep.sidPackageId}::sid::Expiry`],
  });
  tx.moveCall({
    target: `${dep.sidPackageId}::sid::index_px`,
    arguments: [
      tx.pure.address(dep.bsPackageId),
      tx.pure.string(asset),
      tx.pure.string(baseAsset),
      expiry,
      tx.pure.u8(decimals),
      tx.pure.string(timestampPrecision),
    ],
  });
  return devInspectU256(client, sender, tx, 1);
}

/// Derive a `mark.px` sid on-chain for a scalar (greek-free) mark. `expiryMs`
/// absent is a perpetual; present is a dated future. Both go through the same
/// `mark_px`, differing only in `asset` and whether the expiry is there — which
/// is exactly what makes them two series rather than one.
///
/// `Option<Expiry>` is not a pure argument, so even the absent case is a call:
/// `option::none` for the perpetual, `expiry_at` then `option::some` for the
/// future. The derive is therefore the last command either way.
export function deriveMarkPxSid(
  client: SuiClient,
  sender: string,
  dep: Deployment,
  asset: string,
  exchange: string,
  baseAsset: string,
  expiryMs: bigint | null,
  decimals: number,
  timestampPrecision: string,
): Promise<bigint> {
  requireSidPackage(dep);
  const tx = new Transaction();
  const expiryType = `${dep.sidPackageId}::sid::Expiry`;
  let expiry;
  if (expiryMs === null) {
    expiry = tx.moveCall({ target: "0x1::option::none", typeArguments: [expiryType] });
  } else {
    const instant = tx.moveCall({
      target: `${dep.sidPackageId}::sid::expiry_at`,
      arguments: [tx.pure.u64(expiryMs)],
    });
    expiry = tx.moveCall({ target: "0x1::option::some", typeArguments: [expiryType], arguments: [instant] });
  }
  tx.moveCall({
    target: `${dep.sidPackageId}::sid::mark_px`,
    arguments: [
      tx.pure.address(dep.bsPackageId),
      tx.pure.string(asset),
      tx.pure.string(exchange),
      tx.pure.string(baseAsset),
      expiry,
      tx.pure.u8(decimals),
      tx.pure.string(timestampPrecision),
    ],
  });
  return devInspectU256(client, sender, tx, expiryMs === null ? 1 : 2);
}

/// Derive a `model.params` composite sid on-chain for a constant-maturity tenor.
/// Two chained moveCalls: `Expiry` is `copy, drop`, so the first call's result
/// passes straight into the second.
export function deriveModelParamsSid(
  client: SuiClient,
  sender: string,
  dep: Deployment,
  asset: string,
  baseAsset: string,
  model: string,
  tenorMs: bigint,
  decimals: number,
  timestampPrecision: string,
): Promise<bigint> {
  requireSidPackage(dep);
  const tx = new Transaction();
  const expiry = tx.moveCall({
    target: `${dep.sidPackageId}::sid::expiry_tenor`,
    arguments: [tx.pure.u64(tenorMs)],
  });
  tx.moveCall({
    target: `${dep.sidPackageId}::sid::model_params`,
    arguments: [
      tx.pure.address(dep.bsPackageId),
      tx.pure.string(asset),
      tx.pure.string(baseAsset),
      tx.pure.string(model),
      expiry,
      tx.pure.u8(decimals),
      tx.pure.string(timestampPrecision),
    ],
  });
  return devInspectU256(client, sender, tx, 1);
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

export interface SviReadback {
  svi_a_magnitude: bigint;
  svi_a_is_negative: boolean;
  svi_b: bigint;
  svi_sigma: bigint;
  svi_rho_magnitude: bigint;
  svi_rho_is_negative: boolean;
  svi_m_magnitude: bigint;
  svi_m_is_negative: boolean;
}

/// Read every stored SVI field for a `sid` via devInspect.
export async function readSviParams(
  client: SuiClient,
  dep: Deployment,
  sender: string,
  sid: bigint,
): Promise<SviReadback> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${dep.examplePackageId}::oracle::svi_params`,
    arguments: [tx.object(dep.oracleId), tx.pure.u256(sid)],
  });
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  const values = res.results?.[0]?.returnValues;
  if (values?.length !== 8) {
    throw new Error(`expected 8 return values for svi_params: ${JSON.stringify(res.error ?? res)}`);
  }
  const scalar = (index: number): bigint => {
    const value = values[index];
    if (!value) throw new Error(`missing svi_params return value at index ${index}`);
    return leToBigInt(value[0]);
  };
  const bool = (index: number): boolean => {
    const value = scalar(index);
    if (value > 1n) throw new Error(`invalid bool return value at svi_params index ${index}: ${value}`);
    return value === 1n;
  };
  return {
    svi_a_magnitude: scalar(0),
    svi_a_is_negative: bool(1),
    svi_b: scalar(2),
    svi_sigma: scalar(3),
    svi_rho_magnitude: scalar(4),
    svi_rho_is_negative: bool(5),
    svi_m_magnitude: scalar(6),
    svi_m_is_negative: bool(7),
  };
}

/// Read the latest accepted timestamp for a `sid` via devInspect.
export function readLastTimestamp(client: SuiClient, dep: Deployment, sender: string, sid: bigint): Promise<bigint> {
  return readScalar(client, dep, sender, "last_timestamp", sid);
}

/// Read the most recent batch timestamp via devInspect. Unlike the reads above this
/// takes no `sid`: it is the feed-liveness signal, and advances on every ingested
/// batch even when every update in it was skipped.
export async function readLastBatchTimestamp(client: SuiClient, dep: Deployment, sender: string): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${dep.examplePackageId}::oracle::last_batch_timestamp`,
    arguments: [tx.object(dep.oracleId)],
  });
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  const rv = res.results?.[0]?.returnValues?.[0];
  if (!rv) throw new Error(`no return value for last_batch_timestamp: ${JSON.stringify(res.error ?? res)}`);
  return leToBigInt(rv[0]);
}
