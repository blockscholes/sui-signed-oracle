// Pure-TS checks for the signer: signature shape, recovery round-trip, and
// framing. The DEFINITIVE on-chain proof that the signature verifies via
// ecrecover lives in the Move tests (bs_oracle) and the localnet e2e; this
// file guards the off-chain half.

import { describe, it, expect } from "vitest";
import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { signPayloadSecp256k1, frameMessage, compressedPubkey, evmAddress } from "./signer.js";
import { buildValueBatchPayload, valueUpdate, hexToBytes, signedBytesFor } from "./payloads.js";
import { TEST_SIGNER_PRIV, SPOT_SID } from "./config.js";

const BATCH_TS = 9_000_000n;
const updates = [valueUpdate(SPOT_SID, 1_000_000n, 65000)];

describe("secp256k1 signer", () => {
  it("produces an {r,s,v} signature with EVM recovery id (27 or 28)", async () => {
    const payload = buildValueBatchPayload(BATCH_TS, updates);
    const sig = await signPayloadSecp256k1(payload, TEST_SIGNER_PRIV);
    expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect(["0x1b", "0x1c"]).toContain(sig.v);
  });

  it("recovers the registered 33-byte compressed pubkey from (sig, keccak(payload))", async () => {
    const payload = buildValueBatchPayload(BATCH_TS, updates);
    const sig = await signPayloadSecp256k1(payload, TEST_SIGNER_PRIV);
    const digest = keccak_256(payload);
    const compact = Uint8Array.from([...hexToBytes(sig.r), ...hexToBytes(sig.s)]);
    const recovered = secp.Signature.fromCompact(compact)
      .addRecoveryBit(Number(BigInt(sig.v)) - 27)
      .recoverPublicKey(digest)
      .toRawBytes(true);
    expect(Buffer.from(recovered).equals(Buffer.from(compressedPubkey(TEST_SIGNER_PRIV)))).toBe(true);
  });

  it("frames the wire message as r||s||v (v normalized to {0,1}) || payload", async () => {
    const payload = buildValueBatchPayload(BATCH_TS, updates);
    const sig = await signPayloadSecp256k1(payload, TEST_SIGNER_PRIV);
    const msg = frameMessage(sig, payload);
    expect(msg.length).toBe(65 + payload.length);
    expect(Buffer.from(msg.slice(0, 32)).equals(Buffer.from(hexToBytes(sig.r)))).toBe(true);
    expect(Buffer.from(msg.slice(32, 64)).equals(Buffer.from(hexToBytes(sig.s)))).toBe(true);
    expect(msg[64]).toBe(Number(BigInt(sig.v)) - 27); // EVM 27/28 -> Sui {0,1}
    expect(Buffer.from(msg.slice(65)).equals(Buffer.from(payload))).toBe(true);
  });

  it("derives a valid Ethereum address for the same key (EVM key reuse)", () => {
    const addr = evmAddress(TEST_SIGNER_PRIV);
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe("payload encoding validation", () => {
  it("rejects non-hex characters", () => {
    expect(() => hexToBytes("0x" + "zz".repeat(32))).toThrow(/non-hex/);
  });

  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("0xabc")).toThrow(/odd length/);
  });

  it("rejects a packageId that is not 32 bytes", () => {
    const payload = buildValueBatchPayload(BATCH_TS, updates);
    expect(() => signedBytesFor("0xdead", payload)).toThrow(/expected 32 bytes/);
  });
});
