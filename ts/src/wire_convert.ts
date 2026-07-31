// Converts wsAPI's SUI batch wire JSON (data.timestamp + data.values[]) into the
// ValueUpdate/SviUpdate BCS-input shapes payloads.ts expects, so the exact same bytes
// wsAPI signed can be re-encoded here byte-for-byte. Field names/values are already
// identical to the BCS struct (wsAPI mirrors utils_web3.SviUpdate/ValueUpdate) — only
// `sid` needs parsing from its wire hex string to a bigint, the scaled values from
// decimal strings (they exceed JS's safe-integer range at high decimals) to bigint, and
// the per-entry timestamp, which wsAPI names `t` (its wire convention) against the
// BCS field's `timestamp`. The batch-level `timestamp` keeps its name on both sides.

import { BATCH_SVI, BATCH_VALUE, type SviUpdate, type ValueUpdate } from "./payloads.js";

export interface WireValueEntry {
  sid: string;
  t: number;
  v: string;
}

export interface WireSviEntry {
  sid: string;
  t: number;
  svi_a_magnitude: string;
  svi_a_is_negative: boolean;
  svi_b: string;
  svi_sigma: string;
  svi_rho_magnitude: string;
  svi_rho_is_negative: boolean;
  svi_m_magnitude: string;
  svi_m_is_negative: boolean;
}

export function toValueUpdate(entry: WireValueEntry): ValueUpdate {
  return { sid: BigInt(entry.sid), timestamp: BigInt(entry.t), v: BigInt(entry.v) };
}

export function toSviUpdate(entry: WireSviEntry): SviUpdate {
  return {
    sid: BigInt(entry.sid),
    timestamp: BigInt(entry.t),
    svi_a_magnitude: BigInt(entry.svi_a_magnitude),
    svi_a_is_negative: entry.svi_a_is_negative,
    svi_b: BigInt(entry.svi_b),
    svi_sigma: BigInt(entry.svi_sigma),
    svi_rho_magnitude: BigInt(entry.svi_rho_magnitude),
    svi_rho_is_negative: entry.svi_rho_is_negative,
    svi_m_magnitude: BigInt(entry.svi_m_magnitude),
    svi_m_is_negative: entry.svi_m_is_negative,
  };
}

export interface WireBatchData {
  batch_kind: number;
  timestamp: number;
  values: unknown[];
}

export type ConvertedBatch =
  | { kind: "value"; timestamp: bigint; updates: ValueUpdate[] }
  | { kind: "svi"; timestamp: bigint; updates: SviUpdate[] };

export function convertWireBatch(data: WireBatchData): ConvertedBatch {
  const timestamp = BigInt(data.timestamp);
  if (data.batch_kind === BATCH_VALUE) {
    return { kind: "value", timestamp, updates: (data.values as WireValueEntry[]).map(toValueUpdate) };
  }
  if (data.batch_kind === BATCH_SVI) {
    return { kind: "svi", timestamp, updates: (data.values as WireSviEntry[]).map(toSviUpdate) };
  }
  throw new Error(`unknown batch_kind from wsAPI: ${data.batch_kind}`);
}
