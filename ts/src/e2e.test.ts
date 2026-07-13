// End-to-end localnet test of the full signed-oracle flow with REAL crypto:
// publish both packages, register the Block Scholes signer, then for each case
// sign a batch off-chain (secp256k1) and submit the verify -> consumer PTB.
//
// This is the sole home of real-signature testing: Move's test VM cannot sign
// in-process, so the signature path (happy AND every rejection path) is exercised
// here with live signatures against a real chain.
//
// Requires a running localnet:  sui start --with-faucet --force-regenesis

import { describe, it, expect, beforeAll } from "vitest";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  setupLocalnet,
  publishPackages,
  setSigner,
  setPaused,
  Deployment,
  relay,
  BatchKind,
  readValue,
  readSviAMagnitude,
  readLastTimestamp,
} from "./chain.js";
import { signPayloadSecp256k1, frameMessage } from "./signer.js";
import {
  buildValueBatchPayload,
  buildSviBatchPayload,
  valueUpdate,
  sviUpdate,
  signedBytesFor,
  toFixed,
  BatchFields,
  ValueUpdate,
  SviUpdate,
} from "./payloads.js";
import { SPOT_SID, SVI_SID, TEST_SIGNER_PRIV, TEST_SIGNER_PRIV_2, SPOT, FORWARD, SVI } from "./config.js";

let client: SuiClient;
let keypair: Ed25519Keypair;
let address: string;
let dep: Deployment;

// `timestamp` is both the future-date anchor (verifier) and the per-sid replay key
// (consumer). Each case derives its timestamps from `nowMs()` at send time, a few
// seconds in the past so they are never future-dated; nothing is frozen across the
// suite, so per-sid ordering stays tied to send time.
const nowMs = () => BigInt(Date.now());
const secsAgo = (s: number) => nowMs() - BigInt(s) * 1_000n;

function batchFields(timestamp: bigint): BatchFields {
  return { timestamp };
}

interface Overrides {
  priv?: string;
  packageId?: string;
}

async function signValue(c: BatchFields, updates: ValueUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildValueBatchPayload(c, updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

async function signSvi(c: BatchFields, updates: SviUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildSviBatchPayload(c, updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

// A single-value-update batch at `timestamp` — the workhorse for happy/rejection cases.
async function valueMessage(timestamp: bigint, over: Overrides = {}): Promise<Uint8Array> {
  return signValue(batchFields(timestamp), [valueUpdate(SPOT_SID, SPOT)], over);
}

async function relaySafe(message: Uint8Array, kind: BatchKind) {
  try {
    return await relay(client, keypair, dep, message, kind);
  } catch (e) {
    return { digest: "", success: false, error: String(e), eventTypes: [] as string[] };
  }
}

/// Asserts a relay failed with the specific expected Move abort — not just any
/// failure — by matching the aborting function and its abort code in `r.error`
/// (e.g. `function_name: Some("verify_header") }, 5)`).
function expectAbort(error: string | undefined, fnName: string, code: number) {
  expect(error).toMatch(new RegExp(`function_name: Some\\("${fnName}"\\).*,\\s*${code}\\)`));
}

beforeAll(async () => {
  ({ client, keypair, address } = await setupLocalnet());
  dep = await publishPackages(client, keypair);
  await setSigner(client, keypair, dep);
}, 180_000);

describe("Block Scholes -> Predict signed-oracle e2e (localnet)", () => {
  // The monotonic + replay flow is one test so freshness stays tied to send time;
  // its two timestamps come from a single `nowMs()` taken at the start of the case.
  it("ingests a value batch, accepts a newer timestamp, and rejects a replay", async () => {
    const base = nowMs();
    const t1 = base - 6_000n;
    const t2 = base - 3_000n; // strictly newer than t1, still fresh

    let r = await relaySafe(await valueMessage(t1), "value");
    expect(r.success).toBe(true);
    expect(r.eventTypes.some((t) => t.endsWith("::verify::BatchVerified"))).toBe(true);
    expect(r.eventTypes.some((t) => t.endsWith("::oracle::OracleUpdated"))).toBe(true);
    expect(await readValue(client, dep, address, SPOT_SID)).toBe(toFixed(SPOT));
    expect(await readLastTimestamp(client, dep, address, SPOT_SID)).toBe(t1);

    // a strictly-newer timestamp is accepted
    r = await relaySafe(await valueMessage(t2), "value");
    expect(r.success).toBe(true);
    expect(await readLastTimestamp(client, dep, address, SPOT_SID)).toBe(t2);

    // replaying the old timestamp is rejected; stored state unchanged
    r = await relaySafe(await valueMessage(t1), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "replay_guard", 2); // EReplayOrStale
    expect(await readLastTimestamp(client, dep, address, SPOT_SID)).toBe(t2);
  }, 90_000);

  it("verifies and ingests an SVI batch", async () => {
    const ts = secsAgo(5);
    const r = await relaySafe(await signSvi(batchFields(ts), [sviUpdate(SVI_SID, SVI)]), "svi");
    expect(r.success).toBe(true);
    expect(await readSviAMagnitude(client, dep, address, SVI_SID)).toBe(toFixed(SVI.a));
    expect(await readLastTimestamp(client, dep, address, SVI_SID)).toBe(ts);
  }, 60_000);

  it("verifies a multi-update value batch (two series, one signature)", async () => {
    // fresh sids, so this case carries no dependency on prior tests
    const sidA = 20n;
    const sidB = 21n;
    const ts = secsAgo(5);
    const updates = [valueUpdate(sidA, SPOT), valueUpdate(sidB, FORWARD)];
    const r = await relaySafe(await signValue(batchFields(ts), updates), "value");
    expect(r.success).toBe(true);
    expect(await readLastTimestamp(client, dep, address, sidA)).toBe(ts);
    expect(await readLastTimestamp(client, dep, address, sidB)).toBe(ts);
    expect(await readValue(client, dep, address, sidA)).toBe(toFixed(SPOT));
    expect(await readValue(client, dep, address, sidB)).toBe(toFixed(FORWARD));
  }, 60_000);

  it("rejects a multi-update value batch when any sid is stale (atomic — not applied per-update)", async () => {
    const sidA = 30n;
    const sidB = 31n;
    const t1 = secsAgo(6);

    // seed sidA so the second batch below replays its timestamp
    const seed = await relaySafe(await signValue(batchFields(t1), [valueUpdate(sidA, SPOT)]), "value");
    expect(seed.success).toBe(true);

    // sidB is fresh, but sidA repeats t1 -> the whole batch aborts, including sidB
    const updates = [valueUpdate(sidA, SPOT), valueUpdate(sidB, FORWARD)];
    const r = await relaySafe(await signValue(batchFields(t1), updates), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "replay_guard", 2); // EReplayOrStale
    expect(await readLastTimestamp(client, dep, address, sidA)).toBe(t1);
  }, 60_000);

  // --- rejection paths (all abort in `verify`, so they never mutate state) ---

  it("rejects a message signed by an unauthorized key (not the signer)", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5), { priv: TEST_SIGNER_PRIV_2 }), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 5); // EBadSigner
  }, 60_000);

  it("rejects a batch signed for a different package's address (cross-deployment replay guard)", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5), { packageId: "0x" + "99".repeat(32) }), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 5); // EBadSigner
  }, 60_000);

  it("rejects a value batch fed to the SVI verifier (batch-kind guard)", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5)), "svi");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 10); // EBadBatchKind
  }, 60_000);

  it("rejects a future-dated timestamp", async () => {
    const r = await relaySafe(await valueMessage(nowMs() + 120_000n), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 6); // EFutureTimestamp
  }, 60_000);

  it("rejects a message that's exactly the signature length (no payload)", async () => {
    // A valid signature over some payload, framed with no payload at all: the
    // message is exactly 65 bytes, so `verify_header` rejects it on length alone,
    // before signature recovery is even attempted.
    const payload = buildValueBatchPayload(batchFields(secsAgo(5)), [valueUpdate(SPOT_SID, SPOT)]);
    const signedBytes = signedBytesFor(dep.bsPackageId, payload);
    const sig = await signPayloadSecp256k1(signedBytes, TEST_SIGNER_PRIV);
    const r = await relaySafe(frameMessage(sig, new Uint8Array(0)), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 1); // EBadMessageLength
  }, 60_000);

  it("rejects a payload with an undecoded trailing byte", async () => {
    // Append a byte to the payload *before* signing, so the signature covers the
    // extended bytes and stays valid — the decoder consumes exactly the batch it
    // knows about and leaves the extra byte as an unconsumed remainder.
    const payload = buildValueBatchPayload(batchFields(secsAgo(5)), [valueUpdate(SPOT_SID, SPOT)]);
    const extended = new Uint8Array(payload.length + 1);
    extended.set(payload);
    extended[payload.length] = 0xff;
    const signedBytes = signedBytesFor(dep.bsPackageId, extended);
    const sig = await signPayloadSecp256k1(signedBytes, TEST_SIGNER_PRIV);
    const r = await relaySafe(frameMessage(sig, extended), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_and_create_value_batch", 8); // ETrailingPayloadData
  }, 60_000);

  it("rejects an empty value batch (zero updates)", async () => {
    const r = await relaySafe(await signValue(batchFields(secsAgo(5)), []), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_and_create_value_batch", 9); // EEmptyBatch
  }, 60_000);

  it("rejects every batch while paused, and resumes once unpaused", async () => {
    // fresh sid so this case is independent of prior tests
    const sid = 40n;
    await setPaused(client, keypair, dep, true);
    try {
      const blocked = await relaySafe(await signValue(batchFields(secsAgo(5)), [valueUpdate(sid, SPOT)]), "value");
      expect(blocked.success).toBe(false);
      expectAbort(blocked.error, "verify_header", 11); // EPaused
    } finally {
      await setPaused(client, keypair, dep, false);
    }

    // a well-formed batch verifies again after unpausing
    const resumed = await relaySafe(await signValue(batchFields(secsAgo(5)), [valueUpdate(sid, SPOT)]), "value");
    expect(resumed.success).toBe(true);
    expect(await readValue(client, dep, address, sid)).toBe(toFixed(SPOT));
  }, 90_000);
});
