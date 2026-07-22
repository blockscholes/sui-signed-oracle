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
  ValueUpdate,
  SviUpdate,
} from "./payloads.js";
import { SPOT_SID, SVI_SID, TEST_SIGNER_PRIV, TEST_SIGNER_PRIV_2, SPOT, FORWARD, SVI } from "./config.js";

let client: SuiClient;
let keypair: Ed25519Keypair;
let address: string;
let dep: Deployment;

// Every update carries its own `timestamp`: it is both the future-date anchor
// (verifier) and that sid's replay key (consumer). Each case derives its timestamps
// from `nowMs()` at send time, a few seconds in the past so they are never
// future-dated; nothing is frozen across the suite, so per-sid ordering stays tied
// to send time.
const nowMs = () => BigInt(Date.now());
const secsAgo = (s: number) => nowMs() - BigInt(s) * 1_000n;

interface Overrides {
  priv?: string;
  packageId?: string;
}

async function signValue(updates: ValueUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildValueBatchPayload(updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

async function signSvi(updates: SviUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildSviBatchPayload(updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

// A single-value-update batch at `timestamp` — the workhorse for happy/rejection cases.
async function valueMessage(timestamp: bigint, over: Overrides = {}): Promise<Uint8Array> {
  return signValue([valueUpdate(SPOT_SID, timestamp, SPOT)], over);
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
/// (e.g. `function_name: Some("verify_header") }, 2)`).
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
  it("ingests a value batch, accepts a newer timestamp, and skips a replay", async () => {
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

    // Replaying the old timestamp succeeds as a no-op: the tx lands, the batch
    // verifies, but the update is skipped and no OracleUpdated is emitted for it.
    r = await relaySafe(await valueMessage(t1), "value");
    expect(r.success).toBe(true);
    expect(r.eventTypes.some((t) => t.endsWith("::verify::BatchVerified"))).toBe(true);
    expect(r.eventTypes.some((t) => t.endsWith("::oracle::OracleUpdated"))).toBe(false);
    expect(await readLastTimestamp(client, dep, address, SPOT_SID)).toBe(t2);
  }, 90_000);

  // This is what lets the publisher keep the chain updating at a high frequency
  // when a series' data hasn't advanced: re-send it pinned to its original
  // timestamp and the chain accepts the transaction without moving that sid.
  it("accepts a re-sent, non-advancing update as a no-op (pinned timestamp)", async () => {
    const sid = 50n;
    const ts = secsAgo(5);

    let r = await relaySafe(await signValue([valueUpdate(sid, ts, SPOT)]), "value");
    expect(r.success).toBe(true);
    expect(await readValue(client, dep, address, sid)).toBe(toFixed(SPOT));

    // Same sid, same timestamp, different value -> neither is applied.
    r = await relaySafe(await signValue([valueUpdate(sid, ts, FORWARD)]), "value");
    expect(r.success).toBe(true);
    expect(await readValue(client, dep, address, sid)).toBe(toFixed(SPOT));
    expect(await readLastTimestamp(client, dep, address, sid)).toBe(ts);
  }, 90_000);

  it("verifies and ingests an SVI batch", async () => {
    const ts = secsAgo(5);
    const r = await relaySafe(await signSvi([sviUpdate(SVI_SID, ts, SVI)]), "svi");
    expect(r.success).toBe(true);
    expect(await readSviAMagnitude(client, dep, address, SVI_SID)).toBe(toFixed(SVI.a));
    expect(await readLastTimestamp(client, dep, address, SVI_SID)).toBe(ts);
  }, 60_000);

  it("verifies a multi-update value batch, each series carrying its own timestamp", async () => {
    // fresh sids, so this case carries no dependency on prior tests
    const sidA = 20n;
    const sidB = 21n;
    const tsA = secsAgo(6);
    const tsB = secsAgo(4); // deliberately different from tsA
    const updates = [valueUpdate(sidA, tsA, SPOT), valueUpdate(sidB, tsB, FORWARD)];
    const r = await relaySafe(await signValue(updates), "value");
    expect(r.success).toBe(true);
    expect(await readLastTimestamp(client, dep, address, sidA)).toBe(tsA);
    expect(await readLastTimestamp(client, dep, address, sidB)).toBe(tsB);
    expect(await readValue(client, dep, address, sidA)).toBe(toFixed(SPOT));
    expect(await readValue(client, dep, address, sidB)).toBe(toFixed(FORWARD));
  }, 60_000);

  it("applies a multi-update value batch per-update when one sid is stale (not atomic)", async () => {
    const sidA = 30n;
    const sidB = 31n;
    const t1 = secsAgo(6);
    const t2 = secsAgo(3);

    // seed sidA so the second batch below repeats its timestamp
    const seed = await relaySafe(await signValue([valueUpdate(sidA, t1, SPOT)]), "value");
    expect(seed.success).toBe(true);

    // sidA repeats t1 (pinned) while sidB advances -> sidB still lands
    const updates = [valueUpdate(sidA, t1, FORWARD), valueUpdate(sidB, t2, FORWARD)];
    const r = await relaySafe(await signValue(updates), "value");
    expect(r.success).toBe(true);
    // sidA untouched: neither its value nor its timestamp moved
    expect(await readValue(client, dep, address, sidA)).toBe(toFixed(SPOT));
    expect(await readLastTimestamp(client, dep, address, sidA)).toBe(t1);
    // sidB applied
    expect(await readValue(client, dep, address, sidB)).toBe(toFixed(FORWARD));
    expect(await readLastTimestamp(client, dep, address, sidB)).toBe(t2);
  }, 60_000);

  // --- rejection paths (all abort in `verify`, so they never mutate state) ---

  it("rejects a message signed by an unauthorized key (not the signer)", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5), { priv: TEST_SIGNER_PRIV_2 }), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 2); // EBadSigner
  }, 60_000);

  it("rejects a batch signed for a different package's address (cross-deployment replay guard)", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5), { packageId: "0x" + "99".repeat(32) }), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 2); // EBadSigner
  }, 60_000);

  it("rejects a value batch fed to the SVI verifier (batch-kind guard)", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5)), "svi");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 6); // EBadBatchKind
  }, 60_000);

  it("rejects a future-dated timestamp", async () => {
    const r = await relaySafe(await valueMessage(nowMs() + 120_000n), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "peel_timestamp", 3); // EFutureTimestamp
  }, 60_000);

  it("rejects a batch when only the second update is future-dated", async () => {
    // The guard is per-update now, so it has to catch a bad entry anywhere in the
    // vector — not just the first one it decodes.
    const updates = [valueUpdate(60n, secsAgo(5), SPOT), valueUpdate(61n, nowMs() + 120_000n, FORWARD)];
    const r = await relaySafe(await signValue(updates), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "peel_timestamp", 3); // EFutureTimestamp
    // the batch aborted in `verify`, so even the well-formed first update is
    // unapplied — reading an absent sid aborts the devInspect call
    await expect(readValue(client, dep, address, 60n)).rejects.toThrow(/no return value/);
  }, 60_000);

  it("rejects a message that's exactly the signature length (no payload)", async () => {
    // A valid signature over some payload, framed with no payload at all: the
    // message is exactly 65 bytes, so `verify_header` rejects it on length alone,
    // before signature recovery is even attempted.
    const payload = buildValueBatchPayload([valueUpdate(SPOT_SID, secsAgo(5), SPOT)]);
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
    const payload = buildValueBatchPayload([valueUpdate(SPOT_SID, secsAgo(5), SPOT)]);
    const extended = new Uint8Array(payload.length + 1);
    extended.set(payload);
    extended[payload.length] = 0xff;
    const signedBytes = signedBytesFor(dep.bsPackageId, extended);
    const sig = await signPayloadSecp256k1(signedBytes, TEST_SIGNER_PRIV);
    const r = await relaySafe(frameMessage(sig, extended), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_and_create_value_batch", 4); // ETrailingPayloadData
  }, 60_000);

  it("rejects an empty value batch (zero updates)", async () => {
    const r = await relaySafe(await signValue([]), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_and_create_value_batch", 5); // EEmptyBatch
  }, 60_000);

  it("rejects every batch while paused, and resumes once unpaused", async () => {
    // fresh sid so this case is independent of prior tests
    const sid = 40n;
    await setPaused(client, keypair, dep, true);
    try {
      const blocked = await relaySafe(await signValue([valueUpdate(sid, secsAgo(5), SPOT)]), "value");
      expect(blocked.success).toBe(false);
      expectAbort(blocked.error, "verify_header", 7); // EPaused
    } finally {
      await setPaused(client, keypair, dep, false);
    }

    // a well-formed batch verifies again after unpausing
    const resumed = await relaySafe(await signValue([valueUpdate(sid, secsAgo(5), SPOT)]), "value");
    expect(resumed.success).toBe(true);
    expect(await readValue(client, dep, address, sid)).toBe(toFixed(SPOT));
  }, 90_000);
});
