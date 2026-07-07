// secp256k1 keys + recoverable signing for the Block Scholes oracle, matching
// Sui's `sui::ecdsa_k1::secp256k1_ecrecover(sig, msg, 0)` (0 = keccak256).
//
// The signer keccak-hashes the payload and signs the digest, returning the
// signature as split `{ r, s, v }` values — the form Block Scholes already returns
// for its EIP-712 signing, so `v` is the EVM recovery id 27/28 (`0x1b`/`0x1c`).
// `frameMessage` packs that into the 65-byte `r || s || v` wire form Sui's
// `ecrecover` expects, normalizing `v` to Sui's {0, 1}. On-chain we pass the RAW
// payload to ecrecover with hash=0, so the framework re-computes the same keccak256.

import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";

// === Keys ===

export function stripHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

export function privBytes(privHex: string): Uint8Array {
  return hexToBytes(stripHex(privHex));
}

/// 33-byte compressed public key. This is what `secp256k1_ecrecover` returns
/// on-chain, so this is the value registered in the `SignerRegistry`.
export function compressedPubkey(privHex: string): Uint8Array {
  return secp.getPublicKey(privBytes(privHex), true);
}

export function compressedPubkeyHex(privHex: string): string {
  return bytesToHex(compressedPubkey(privHex));
}

/// Ethereum-style address for the same key (cross-check that an EVM EIP-712 key
/// can be reused for Sui without re-keying).
export function evmAddress(privHex: string): string {
  const uncompressed = secp.getPublicKey(privBytes(privHex), false); // 0x04 || X || Y
  return "0x" + bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20));
}

// === Signing ===

/// A secp256k1 signature in the split form Block Scholes returns. `r`/`s` are
/// 0x-prefixed 32-byte hex; `v` is the EVM recovery id `0x1b` (27) or `0x1c` (28).
export interface RsvSignature {
  r: string;
  s: string;
  v: string;
}

/// Sign a payload, returning the recoverable signature as `{ r, s, v }`.
export async function signPayloadSecp256k1(payload: Uint8Array, privHex: string): Promise<RsvSignature> {
  const digest = keccak_256(payload);
  const sig = await secp.signAsync(digest, privBytes(privHex));
  if (sig.recovery !== 0 && sig.recovery !== 1) {
    // Sui's ecrecover does accept recovery 2/3, but they (r >= curve order n) are
    // ~2^-128 unlikely AND have no EVM `v` (27/28 cover only recovery 0/1), so we
    // reject rather than emit a non-standard {r,s,v}. A deterministic re-sign with
    // extra entropy would yield a 0/1 recovery if this ever fired.
    throw new Error(`unexpected secp256k1 recovery id ${sig.recovery} (no EVM v for 2/3)`);
  }
  const compact = sig.toBytes(); // 64-byte compact r || s
  return {
    r: "0x" + bytesToHex(compact.slice(0, 32)),
    s: "0x" + bytesToHex(compact.slice(32, 64)),
    v: "0x" + (sig.recovery + 27).toString(16), // EVM 27/28, uniform with BS EIP-712 output
  };
}

/// Frame the wire message consumed by the verifier: pack `{ r, s, v }` into the
/// 65-byte `r || s || v` form (v normalized from EVM 27/28 to Sui's {0, 1}),
/// followed by the payload.
export function frameMessage(sig: RsvSignature, payload: Uint8Array): Uint8Array {
  const r = hexToBytes(stripHex(sig.r));
  const s = hexToBytes(stripHex(sig.s));
  if (r.length !== 32 || s.length !== 32) {
    throw new Error(`invalid signature r/s length: ${r.length}/${s.length} (expected 32/32)`);
  }
  const v = Number(BigInt(sig.v)) - 27; // EVM 27/28 -> Sui {0,1}
  if (v !== 0 && v !== 1) {
    throw new Error(`unexpected recovery id v=${sig.v} (expected 0x1b or 0x1c)`);
  }
  const out = new Uint8Array(65 + payload.length);
  out.set(r, 0);
  out.set(s, 32);
  out[64] = v;
  out.set(payload, 65);
  return out;
}
