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
  readSviParams,
  readLastTimestamp,
} from "./chain.js";
import { signPayloadSecp256k1, frameMessage } from "./signer.js";
import {
  buildValueBatchPayload,
  buildSviBatchPayload,
  buildValueAbsoluteBatchPayload,
  buildSviAbsoluteBatchPayload,
  valueUpdate,
  sviUpdate,
  valueAbsoluteUpdate,
  signedBytesFor,
  toFixed,
  ValueUpdate,
  SviUpdate,
  ValueAbsoluteUpdate,
  SviAbsoluteUpdate,
} from "./payloads.js";
import { SPOT_SID, TEST_SIGNER_PRIV, TEST_SIGNER_PRIV_2, SPOT, FORWARD, SVI } from "./config.js";

let client: SuiClient;
let keypair: Ed25519Keypair;
let address: string;
let dep: Deployment;

// Every update carries its own `timestamp`, which is that sid's replay key in the
// consumer; the batch additionally carries the time it was sent. Each case derives its
// timestamps from `nowMs()` at send time, a few seconds in the past; nothing is frozen
// across the suite, so per-sid ordering stays tied to send time.
const nowMs = () => BigInt(Date.now());
const secsAgo = (s: number) => nowMs() - BigInt(s) * 1_000n;

interface Overrides {
  priv?: string;
  packageId?: string;
  /// Batch send time; defaults to now, which is what a live publisher sends.
  batchTimestamp?: bigint;
}

async function signValue(updates: ValueUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildValueBatchPayload(over.batchTimestamp ?? nowMs(), updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

async function signSvi(updates: SviUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildSviBatchPayload(over.batchTimestamp ?? nowMs(), updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

// The "absolute" builders take no per-update timestamp: every update is as of the
// batch timestamp alone, so `over.batchTimestamp` is the only time in play here.
async function signValueAbsolute(updates: ValueAbsoluteUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildValueAbsoluteBatchPayload(over.batchTimestamp ?? nowMs(), updates);
  const signedBytes = signedBytesFor(over.packageId ?? dep.bsPackageId, payload);
  return frameMessage(await signPayloadSecp256k1(signedBytes, over.priv ?? TEST_SIGNER_PRIV), payload);
}

async function signSviAbsolute(updates: SviAbsoluteUpdate[], over: Overrides = {}): Promise<Uint8Array> {
  const payload = buildSviAbsoluteBatchPayload(over.batchTimestamp ?? nowMs(), updates);
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

  it("round-trips every widened SVI field above u64::MAX", async () => {
    const u64Max = (1n << 64n) - 1n;
    const ts = secsAgo(5);
    const sid = 51n;
    const update: SviUpdate = {
      sid,
      timestamp: ts,
      svi_a_magnitude: u64Max + 1n,
      svi_a_is_negative: true,
      svi_b: u64Max + 2n,
      svi_sigma: u64Max + 3n,
      svi_rho_magnitude: u64Max + 4n,
      svi_rho_is_negative: false,
      svi_m_magnitude: u64Max + 5n,
      svi_m_is_negative: true,
    };
    const r = await relaySafe(await signSvi([update]), "svi");
    expect(r.success).toBe(true);
    expect(await readSviParams(client, dep, address, sid)).toEqual({
      svi_a_magnitude: update.svi_a_magnitude,
      svi_a_is_negative: update.svi_a_is_negative,
      svi_b: update.svi_b,
      svi_sigma: update.svi_sigma,
      svi_rho_magnitude: update.svi_rho_magnitude,
      svi_rho_is_negative: update.svi_rho_is_negative,
      svi_m_magnitude: update.svi_m_magnitude,
      svi_m_is_negative: update.svi_m_is_negative,
    });
    expect(await readLastTimestamp(client, dep, address, sid)).toBe(ts);
  }, 60_000);

  it("ingests a value-absolute batch, timed by the batch envelope alone", async () => {
    const sid = 70n;
    const batchTimestamp = secsAgo(5);
    const r = await relaySafe(
      await signValueAbsolute([valueAbsoluteUpdate(sid, SPOT)], { batchTimestamp }),
      "value_absolute",
    );
    expect(r.success).toBe(true);
    expect(r.eventTypes.some((t) => t.endsWith("::verify::BatchVerified"))).toBe(true);
    expect(await readValue(client, dep, address, sid)).toBe(toFixed(SPOT));
    // No per-update timestamp exists: the batch's own timestamp is the replay key.
    expect(await readLastTimestamp(client, dep, address, sid)).toBe(batchTimestamp);
  }, 60_000);

  it("round-trips every widened SVI-absolute field above u64::MAX", async () => {
    const u64Max = (1n << 64n) - 1n;
    const batchTimestamp = secsAgo(5);
    const sid = 71n;
    const update: SviAbsoluteUpdate = {
      sid,
      svi_a_magnitude: u64Max + 1n,
      svi_a_is_negative: true,
      svi_b: u64Max + 2n,
      svi_sigma: u64Max + 3n,
      svi_rho_magnitude: u64Max + 4n,
      svi_rho_is_negative: false,
      svi_m_magnitude: u64Max + 5n,
      svi_m_is_negative: true,
    };
    const r = await relaySafe(await signSviAbsolute([update], { batchTimestamp }), "svi_absolute");
    expect(r.success).toBe(true);
    expect(await readSviParams(client, dep, address, sid)).toEqual({
      svi_a_magnitude: update.svi_a_magnitude,
      svi_a_is_negative: update.svi_a_is_negative,
      svi_b: update.svi_b,
      svi_sigma: update.svi_sigma,
      svi_rho_magnitude: update.svi_rho_magnitude,
      svi_rho_is_negative: update.svi_rho_is_negative,
      svi_m_magnitude: update.svi_m_magnitude,
      svi_m_is_negative: update.svi_m_is_negative,
    });
    expect(await readLastTimestamp(client, dep, address, sid)).toBe(batchTimestamp);
  }, 60_000);

  it("verifies a multi-update value-absolute batch, every series sharing one batch timestamp", async () => {
    // fresh sids, so this case carries no dependency on prior tests
    const sidA = 72n;
    const sidB = 73n;
    const batchTimestamp = secsAgo(5);
    const updates = [valueAbsoluteUpdate(sidA, SPOT), valueAbsoluteUpdate(sidB, FORWARD)];
    const r = await relaySafe(await signValueAbsolute(updates, { batchTimestamp }), "value_absolute");
    expect(r.success).toBe(true);
    // Unlike the non-absolute batch, there's no per-sid timestamp to differ: both
    // sids replay against the same envelope timestamp.
    expect(await readLastTimestamp(client, dep, address, sidA)).toBe(batchTimestamp);
    expect(await readLastTimestamp(client, dep, address, sidB)).toBe(batchTimestamp);
    expect(await readValue(client, dep, address, sidA)).toBe(toFixed(SPOT));
    expect(await readValue(client, dep, address, sidB)).toBe(toFixed(FORWARD));
  }, 60_000);

  it("rejects a value-absolute batch fed to the SVI-absolute verifier (batch-kind guard)", async () => {
    const r = await relaySafe(
      await signValueAbsolute([valueAbsoluteUpdate(74n, SPOT)], { batchTimestamp: secsAgo(5) }),
      "svi_absolute",
    );
    expect(r.success).toBe(false);
    expectAbort(r.error, "verify_header", 6); // EBadBatchKind
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

  it("round-trips a u128 value while accepting an update timestamp ahead of the chain clock", async () => {
    // `verify` does not interpret the timestamp: precision is the client's choice,
    // so a value that looks future-dated in ms may just be another unit. Per-update
    // bounds belong to the feed-aware consumer policy.
    const sid = 60n;
    const ts = nowMs() + 120_000n;
    const v = (1n << 64n) + 1n;
    const r = await relaySafe(await signValue([{ sid, timestamp: ts, v }]), "value");
    expect(r.success).toBe(true);
    expect(await readLastTimestamp(client, dep, address, sid)).toBe(ts);
    expect(await readValue(client, dep, address, sid)).toBe(v);
  }, 60_000);

  it("rejects a batch timestamp too far ahead of the chain clock", async () => {
    const r = await relaySafe(await valueMessage(secsAgo(5), { batchTimestamp: nowMs() + 120_000n }), "value");
    expect(r.success).toBe(false);
    expectAbort(r.error, "validate_batch_timestamp", 3);
  }, 60_000);

  it("rejects a stale batch timestamp", async () => {
    const r = await relaySafe(
      await signSvi([sviUpdate(62n, secsAgo(5), SVI)], { batchTimestamp: nowMs() - 120_000n }),
      "svi",
    );
    expect(r.success).toBe(false);
    expectAbort(r.error, "validate_batch_timestamp", 2);
  }, 60_000);

  it("rejects a message that's exactly the signature length (no payload)", async () => {
    // A valid signature over some payload, framed with no payload at all: the
    // message is exactly 65 bytes, so `verify_header` rejects it on length alone,
    // before signature recovery is even attempted.
    const payload = buildValueBatchPayload(nowMs(), [valueUpdate(SPOT_SID, secsAgo(5), SPOT)]);
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
    const payload = buildValueBatchPayload(nowMs(), [valueUpdate(SPOT_SID, secsAgo(5), SPOT)]);
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
