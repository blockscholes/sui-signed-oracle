// BCS schema + builders for the Block Scholes signed batches, plus fixed-point
// helpers. Field order and types in the schema MUST match the Move decoder in
// `bs_oracle::verify` byte-for-byte (the signature covers these bytes; on-chain
// `ecrecover` keccak-hashes them). A batch is homogeneous by category: a value or
// SVI batch, sharing one envelope.
//
// Two timestamps, answering different questions: the envelope's is when this batch
// was sent (it advances every flush, so the feed is visibly alive even when nothing
// moved), while each update's own is when that series' data is "as of" — so a series
// whose data hasn't advanced is re-sent pinned to its original time.

import { bcs, type InferBcsInput } from "@mysten/bcs";

/// Sui address length (packages and objects are both 32-byte ids).
const ADDRESS_BYTES = 32;

/// Batch categories (envelope `batch_kind`); must match `verify` BATCH_*.
export const BATCH_VALUE = 0;
export const BATCH_SVI = 1;

// === BCS schema ===

/// A single value `v` for series `sid` (today: spot or forward price — the `sid`
/// says which), as of `timestamp`. `v` is a fixed-point integer at whatever scale
/// the signer and consumer agreed off-chain; the contract stores it verbatim.
export const ValueUpdate = bcs.struct("ValueUpdate", {
  sid: bcs.u256(),
  timestamp: bcs.u64(), // this series' market-data time
  v: bcs.u128(),
});
export type ValueUpdate = InferBcsInput<typeof ValueUpdate>;

/// An SVI parameter set for series `sid`, as of `timestamp`. `a`/`rho`/`m` are
/// magnitude + `is_negative`; `b`/`sigma` are non-negative.
export const SviUpdate = bcs.struct("SviUpdate", {
  sid: bcs.u256(),
  timestamp: bcs.u64(), // this series' market-data time
  svi_a_magnitude: bcs.u128(),
  svi_a_is_negative: bcs.bool(),
  svi_b: bcs.u128(),
  svi_sigma: bcs.u128(),
  svi_rho_magnitude: bcs.u128(),
  svi_rho_is_negative: bcs.bool(),
  svi_m_magnitude: bcs.u128(),
  svi_m_is_negative: bcs.bool(),
});
export type SviUpdate = InferBcsInput<typeof SviUpdate>;

/// Shared envelope (in field order, so spreading it keeps the byte layout). Its
/// `timestamp` is the batch's send time; each update additionally carries the time
/// its own series is "as of" — see `ValueUpdate`/`SviUpdate`.
const envelope = {
  batch_kind: bcs.u8(),
  timestamp: bcs.u64(),
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

/// Default fixed-point scale used by this reference client's helpers. The
/// contract fixes no scale — it is an off-chain agreement between the signer
/// and the consumer, so a client signing at another scale bypasses `toFixed`.
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

/// `timestamp` is when this batch was sent, not when any one series last moved.
export function buildValueBatchPayload(timestamp: bigint, updates: ValueUpdate[]): Uint8Array {
  return ValueBatchPayload.serialize({ batch_kind: BATCH_VALUE, timestamp, updates }).toBytes();
}

/// `timestamp` is when this batch was sent, not when any one series last moved.
export function buildSviBatchPayload(timestamp: bigint, updates: SviUpdate[]): Uint8Array {
  return SviBatchPayload.serialize({ batch_kind: BATCH_SVI, timestamp, updates }).toBytes();
}

/// A value update for series `sid` (today: spot or forward price), as of `timestamp`.
/// `value` is a JS `number`, so it is bounded by `toFixed`'s safe-integer check —
/// fine at this reference client's 1e9 scale, but a client signing at a scale wide
/// enough to need the full `u128` range should construct the `ValueUpdate` object
/// directly with `v` as a `bigint`/decimal string instead of going through this helper.
export function valueUpdate(sid: bigint, timestamp: bigint, value: number): ValueUpdate {
  return { sid, timestamp, v: toFixed(value) };
}

export interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

/// An SVI update for series `sid`, as of `timestamp`. `a`/`rho`/`m` are encoded as
/// magnitude + sign. Same `number`/safe-integer caveat as `valueUpdate` — construct
/// the `SviUpdate` object directly for any field that needs the full `u128` range,
/// including `svi_b` and `svi_sigma`.
export function sviUpdate(sid: bigint, timestamp: bigint, p: SviParams): SviUpdate {
  const a = signedFixed(p.a);
  const rho = signedFixed(p.rho);
  const m = signedFixed(p.m);
  return {
    sid,
    timestamp,
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
