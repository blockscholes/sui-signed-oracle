// BCS schema + builders for the Block Scholes signed batches, plus fixed-point
// helpers. Field order and types in the schema MUST match the Move decoder in
// `bs_oracle::verify` byte-for-byte (the signature covers these bytes; on-chain
// `ecrecover` keccak-hashes them). A batch is homogeneous by category: a value or
// SVI batch, sharing one envelope.

import { bcs, type InferBcsInput } from "@mysten/bcs";

/// Sui address length (packages and objects are both 32-byte ids).
const ADDRESS_BYTES = 32;

/// Batch categories (envelope `batch_kind`); must match `verify` BATCH_*.
export const BATCH_VALUE = 0;
export const BATCH_SVI = 1;

// === BCS schema ===

/// A single value `v` for series `sid` (today: spot or forward price — the `sid`
/// says which). @1e9 fixed point.
export const ValueUpdate = bcs.struct("ValueUpdate", {
  sid: bcs.u256(),
  v: bcs.u64(),
});
export type ValueUpdate = InferBcsInput<typeof ValueUpdate>;

/// An SVI parameter set for series `sid`. `a`/`rho`/`m` are magnitude +
/// `is_negative`; `b`/`sigma` are non-negative.
export const SviUpdate = bcs.struct("SviUpdate", {
  sid: bcs.u256(),
  svi_a_magnitude: bcs.u64(),
  svi_a_is_negative: bcs.bool(),
  svi_b: bcs.u64(),
  svi_sigma: bcs.u64(),
  svi_rho_magnitude: bcs.u64(),
  svi_rho_is_negative: bcs.bool(),
  svi_m_magnitude: bcs.u64(),
  svi_m_is_negative: bcs.bool(),
});
export type SviUpdate = InferBcsInput<typeof SviUpdate>;

/// Shared envelope (in field order, so spreading it keeps the byte layout).
const envelope = {
  batch_kind: bcs.u8(),
  timestamp: bcs.u64(), // market-data time; drives the future-date guard + per-sid replay
};

const ValueBatchPayload = bcs.struct("ValueBatchPayload", {
  ...envelope,
  updates: bcs.vector(ValueUpdate),
});

const SviBatchPayload = bcs.struct("SviBatchPayload", {
  ...envelope,
  updates: bcs.vector(SviUpdate),
});

/// Decode a hex string (with or without 0x) to a byte array.
export function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex string (odd length): ${hex}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`invalid hex string (non-hex characters): ${hex}`);
  }
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function addressBytes(address: string): number[] {
  const b = hexToBytes(address);
  if (b.length !== ADDRESS_BYTES) {
    throw new Error(`invalid address: expected ${ADDRESS_BYTES} bytes, got ${b.length}`);
  }
  return b;
}

/// Prepend the target package's address to `payload` — the domain separator both
/// signer and verifier fold into the hash (see `bs_oracle::verify`, which resolves
/// it via `type_name::original_id`, not a compile-time literal). This is
/// what gets signed; the wire message still carries `payload` alone.
export function signedBytesFor(packageId: string, payload: Uint8Array): Uint8Array {
  return Uint8Array.from([...addressBytes(packageId), ...payload]);
}

// === Fixed-point ===

/// Fixed-point scale shared with the contracts (1e9).
export const SCALE = 1_000_000_000n;

export function toFixed(x: number): bigint {
  const scaled = x * Number(SCALE);
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`toFixed(${x}): scaled value exceeds the safe integer range, refusing to sign it`);
  }
  return BigInt(Math.round(scaled));
}

/// Signed value -> 1e9 magnitude + sign (how SVI `a`/`rho`/`m` are carried).
function signedFixed(x: number): { magnitude: bigint; isNegative: boolean } {
  return { magnitude: toFixed(Math.abs(x)), isNegative: x < 0 };
}

// === Builders ===

export interface BatchFields {
  timestamp: bigint;
}

/// The encoded envelope shared by every batch kind, ready to spread before `updates`.
function envelopeBytes(c: BatchFields, batchKind: number) {
  return {
    batch_kind: batchKind,
    timestamp: c.timestamp,
  };
}

export function buildValueBatchPayload(c: BatchFields, updates: ValueUpdate[]): Uint8Array {
  return ValueBatchPayload.serialize({ ...envelopeBytes(c, BATCH_VALUE), updates }).toBytes();
}

export function buildSviBatchPayload(c: BatchFields, updates: SviUpdate[]): Uint8Array {
  return SviBatchPayload.serialize({ ...envelopeBytes(c, BATCH_SVI), updates }).toBytes();
}

/// A value update for series `sid` (today: spot or forward price).
export function valueUpdate(sid: bigint, value: number): ValueUpdate {
  return { sid, v: toFixed(value) };
}

export interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

/// An SVI update for series `sid`. `a`/`rho`/`m` are encoded as magnitude + sign.
export function sviUpdate(sid: bigint, p: SviParams): SviUpdate {
  const a = signedFixed(p.a);
  const rho = signedFixed(p.rho);
  const m = signedFixed(p.m);
  return {
    sid,
    svi_a_magnitude: a.magnitude,
    svi_a_is_negative: a.isNegative,
    svi_b: toFixed(p.b),
    svi_sigma: toFixed(p.sigma),
    svi_rho_magnitude: rho.magnitude,
    svi_rho_is_negative: rho.isNegative,
    svi_m_magnitude: m.magnitude,
    svi_m_is_negative: m.isNegative,
  };
}
