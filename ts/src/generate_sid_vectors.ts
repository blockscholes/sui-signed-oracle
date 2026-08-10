// Generates the shared sid vectors pinned by `bs_sid::sid_tests`.
// Run: `pnpm -C ts generate-vectors` (writes `move/bs_sid/vectors.json`).
//
// A sid is the `u256` a feed's signed values are keyed by on-chain, and the
// only binding between a stored value and its meaning. This file is the
// executable reference for that derivation; the Move module reimplements it,
// `generate_sid_vectors.test.ts` pins this output to the committed artifact,
// and websocketAPI must regenerate it byte-for-byte. Full layout and
// rationale: `docs/design.md` (Preimage).
//
//     preimage = scope | feed | body
//     scope    = package_id(32 raw)
//
// Encoding rules, each killing a class of sid fork:
//
// - BCS throughout — canonical by construction, and POSITIONAL, so an absent
//   optional still emits its tag byte: dropping it would shift later fields
//   and collide `{model:"C", type:null}` with `{model:null, type:"C"}`.
// - Expiries parse to unix-ms; tenors normalise to duration-ms (`30d` ==
//   `720h`), with a discriminant byte because `2592000000` is a plausible
//   value of either.
// - Decimal quantities scale at the subscription's `format.decimals`, the
//   scale the contract stores them at, so two scales are two sids. Exact BigInt
//   arithmetic, never floats.
// - Signed quantities are (u128 magnitude, bool is_negative) — Move has no
//   signed integers.
// - DEFAULTED fields resolve before encoding (omitted == explicit); OPTIONAL
//   fields encode their absence, which is part of the identity.
// - `decimals` and timestamp precision are signed identity and close every
//   body; pure response-shaping (`params`, `hexify`) never participates.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bcs } from "@mysten/bcs";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

import { stripHex } from "./signer.js";

// The scope is bs_oracle's id (bs_sid's own address is not folded in — see
// docs/design.md, Preimage). The deployment these vectors are for is
// unpublished, so they pin a placeholder — the same value bs_sid's Move.toml
// bakes for its test build; after publish, regenerate with the real id and
// re-pin the Move literals.
const ORACLE_PACKAGE_ID = "0x" + "11".repeat(32);
const NETWORK = "testnet";
// Resolves which published deployment to scope by; the resolved id is what
// the scope carries, so this key itself is never hashed.
const PKG_VER = 1;

const ABSOLUTE = "2026-07-28T15:00:00Z";

const FEEDS = [
  "index.px",
  "mark.px",
  "model.params",
  "settlement.px",
  "index.iv",
  "realized.vol",
  "interest.rate",
  "impact.bid.diff.twap.px",
  "impact.ask.diff.twap.px",
  "mid.diff.twap.px",
  "moneyness.iv",
  "delta.iv",
  "skew.iv",
  "risk-reversal.iv",
  "butterfly.iv",
  "strike.iv",
];
// The four kinds the Move package implements; every other feed is derived by
// the wsAPI alone. Not a flag in code — just which derive functions exist.
const MOVE_KINDS = new Set(["index.px", "mark.px", "settlement.px", "model.params"]);

const TENOR_UNIT_MS: Record<string, bigint> = { d: 86_400_000n, h: 3_600_000n };
const EXPIRY_ABSOLUTE = 0;
const EXPIRY_TENOR = 1;
const STRIKE_IV_LISTED = 0;
const STRIKE_IV_VALUES = 1;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// === BCS primitives ===
// Leaf encodings come from @mysten/bcs — the library payloads.ts already signs
// with. Only the structural helpers over pre-encoded bytes are local.

function uleb128(n: number): Uint8Array {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const b = rest & 0x7f;
    rest >>>= 7;
    out.push(rest ? b | 0x80 : b);
    if (!rest) return Uint8Array.from(out);
  }
}

const bStr = (v: string): Uint8Array => bcs.string().serialize(v).toBytes();
const bU8 = (v: number): Uint8Array => bcs.u8().serialize(v).toBytes();
const bU64 = (v: number | bigint): Uint8Array => bcs.u64().serialize(v).toBytes();
const bU128 = (v: bigint): Uint8Array => bcs.u128().serialize(v).toBytes();
const bBool = (v: boolean): Uint8Array => bcs.bool().serialize(v).toBytes();

function bAddr(v: string): Uint8Array {
  const raw = hexToBytes(stripHex(v));
  if (raw.length !== 32) throw new Error(`address must be 32 bytes, got ${raw.length}`);
  return raw;
}

const bOpt = (inner: Uint8Array | null): Uint8Array =>
  inner === null ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), inner);

const bVec = (items: Uint8Array[]): Uint8Array => concatBytes(uleb128(items.length), ...items);

// === Normalisation ===

// String()'s shortest round-trip form switches to exponential notation
// outside ~1e-7..1e21 (e.g. 0.0000001 -> "1e-7"). Expand it back to plain
// digits via string manipulation only — never through float math again, so
// the exact literal survives.
function expandExponential(s: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign = "", intPart = "", fracPart = "", expStr = "0"] = m;
  const digits = intPart + fracPart;
  const pointPos = intPart.length + Number(expStr);
  const out =
    pointPos <= 0
      ? "0." + "0".repeat(-pointPos) + digits
      : pointPos >= digits.length
        ? digits + "0".repeat(pointPos - digits.length)
        : digits.slice(0, pointPos) + "." + digits.slice(pointPos);
  return sign + out;
}

// Splits a decimal literal exactly. Numbers go through String(), whose
// shortest round-trip form matches the literal the request carried; arithmetic
// is BigInt-only so a hashed value never depends on float rounding.
function decimalParts(v: number | string): { sign: bigint; int: string; frac: string } {
  const s = expandExponential(typeof v === "number" ? String(v) : v);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new Error(`unsupported decimal literal: ${s}`);
  // "" -> "0" for a bare fraction like ".5" (?? is wrong: the group matches
  // as empty, not undefined).
  const int = m[2] === undefined || m[2] === "" ? "0" : m[2];
  return { sign: m[1] === "-" ? -1n : 1n, int, frac: m[3] ?? "" };
}

function isTenor(v: unknown): boolean {
  const s = String(v);
  const unit = s.slice(-1).toLowerCase();
  if (!s || !(unit in TENOR_UNIT_MS)) return false;
  try {
    decimalParts(s.slice(0, -1));
  } catch {
    return false;
  }
  return true;
}

function tenorMs(v: string): bigint {
  const unit = TENOR_UNIT_MS[v.slice(-1).toLowerCase()];
  if (unit === undefined) throw new Error(`unknown tenor unit in ${v}`);
  const { sign, int, frac } = decimalParts(v.slice(0, -1));
  const scale = 10n ** BigInt(frac.length);
  const total = sign * BigInt(int + frac) * unit;
  if (total % scale !== 0n) throw new Error(`tenor ${v} is not a whole number of milliseconds`);
  return total / scale;
}

function absoluteMs(v: string): number {
  // Parsing is the canonicalisation: every ISO spelling of one instant lands
  // on one unix-ms value. No offset means UTC.
  let s = v.replace("Z", "+00:00");
  if (!/[+-]\d{2}:\d{2}$/.test(s)) s += "+00:00";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`unparseable expiry: ${v}`);
  return ms;
}

function bExpiry(v: string): Uint8Array {
  if (isTenor(v)) return concatBytes(bU8(EXPIRY_TENOR), bU64(tenorMs(v)));
  return concatBytes(bU8(EXPIRY_ABSOLUTE), bU64(absoluteMs(v)));
}

// Identity numbers scale at the subscription's own `format.decimals` — the
// scale the contract stores the value at, so the key and the datum agree. It
// is identity, not presentation: one strike at 10 decimals and the same
// strike at 12 are different integers on-chain, hence different sids (which
// is also why the body closes with the decimals byte).
function scaled(v: number | string, decimals: number): bigint {
  const { sign, int, frac } = decimalParts(v);
  if (frac.length > decimals && !/^0*$/.test(frac.slice(decimals))) {
    throw new Error(`${v} does not fit ${decimals} decimal places`);
  }
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  return sign * (BigInt(int) * 10n ** BigInt(decimals) + BigInt(fracPadded));
}

const bScaled = (v: number | string, decimals: number): Uint8Array => bU128(scaled(v, decimals));

const MARK_STRIKE_VALUE = 0;
const MARK_STRIKE_NAMED = 1;
const NAMED_STRIKES = new Set(["atm_spot", "atm_forward"]);

/// mark.px strike: scalar, named (atm_spot/atm_forward) or a mixed list, as a
/// vector of (kind, value, name) elements; scalar == singleton.
function bMarkStrike(v: MarkStrikeInput, decimals: number): Uint8Array {
  const items = asList(v).map((x) =>
    typeof x === "string" && NAMED_STRIKES.has(x)
      ? concatBytes(bU8(MARK_STRIKE_NAMED), bU128(0n), bStr(x))
      : concatBytes(bU8(MARK_STRIKE_VALUE), bU128(scaled(x, decimals)), bStr("")),
  );
  return bVec(items);
}
type MarkStrikeInput = number | string | Array<number | string>;

/// (u128 magnitude, bool is_negative) — the on-chain SVI convention.
function bSignedScaled(v: number | string, decimals: number): Uint8Array {
  const val = scaled(v, decimals);
  const negative = val < 0n;
  return concatBytes(bU128(negative ? -val : val), bBool(negative));
}

/// A scalar moneyness/delta and its single-element list are one series.
const asList = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/// A string the qn layer interpolates into a qualified name: encoded EXACTLY
/// as sent, not even trimmed, since the qn takes it unchanged and two
/// spellings reach two different upstream feeds. Canonicalising spelling
/// belongs at validation, where routing would see it too.
const routed = (v: string): string => v;

// === Descriptors (identity fields only, pinned order, closed by
// `decimals | timestamp_precision`) ===

// The network is not hashed: distinct chains carry distinct original ids. It
// remains the off-chain lookup key selecting which id to scope by.
const scopeBcs = (): Uint8Array => bAddr(ORACLE_PACKAGE_ID);

interface FormatOpts {
  decimals: number;
  precision?: string;
}

// Every body builder takes ONE named-object argument. The fields are all
// same-typed strings, so positional parameters let a transposed pair
// type-check and silently re-derive every sid; naming them makes that
// unrepresentable.

function bodyIndexPx(
  o: FormatOpts & {
    baseAsset: string;
    exchange: string;
    asset?: string;
    quoteAsset?: string;
    indexType?: string;
    indexSpread?: boolean;
    expiry?: string;
  },
): Uint8Array {
  // index_type/index_spread select WHICH price is served — identity, not
  // presentation.
  return concatBytes(
    bStr(routed(o.asset ?? "spot")),
    bStr(routed(o.exchange)),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.quoteAsset ?? "USD")),
    bOpt(o.indexType !== undefined ? bStr(routed(o.indexType)) : null),
    // absent IS false
    bBool(Boolean(o.indexSpread)),
    // dated futures indices carry the expiry in the qn
    bOpt(o.expiry !== undefined ? bExpiry(o.expiry) : null),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyMarkPx(
  o: FormatOpts & {
    asset: string;
    baseAsset: string;
    exchange: string;
    quoteAsset?: string;
    expiry?: string;
    strike?: MarkStrikeInput;
    model?: string;
    moneyness?: number | number[];
    optionType?: string;
    greeks?: string[];
  },
): Uint8Array {
  // One feed spans perpetuals, futures and options, so instrument fields are
  // Options rather than split kinds. ref_expiry is response-shaping, not
  // identity, so it never participates.
  return concatBytes(
    bStr(routed(o.asset)),
    bStr(routed(o.exchange)),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.quoteAsset ?? "USD")),
    bOpt(o.expiry !== undefined ? bExpiry(o.expiry) : null),
    bOpt(o.strike !== undefined ? bMarkStrike(o.strike, o.decimals) : null),
    bOpt(o.model !== undefined ? bStr(routed(o.model)) : null),
    bOpt(o.moneyness !== undefined ? bVec(asList(o.moneyness).map((x) => bScaled(x, o.decimals))) : null),
    bOpt(o.optionType !== undefined ? bStr(routed(o.optionType)) : null),
    bOpt(o.greeks !== undefined ? bVec(o.greeks.map((g) => bStr(routed(g)))) : null),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyModelParams(
  o: FormatOpts & { baseAsset: string; model: string; expiry: string; asset?: string; exchange?: string },
): Uint8Array {
  // No quote_asset: a params surface is always quoted in USD, so there is
  // nothing to encode. `params` (which parameters to RETURN) never participates.
  return concatBytes(
    bStr(routed(o.asset ?? "option")),
    bStr(routed(o.exchange ?? "composite")),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.model)),
    bExpiry(o.expiry),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodySettlementPx(
  o: FormatOpts & { baseAsset: string; expiry: string; asset?: string; exchange?: string },
): Uint8Array {
  // asset is "spot" for a settlement print; a suffixed class branches the same
  // shape. No quote. Scoped by base asset and the settlement instant, which is
  // always absolute — the model rejects tenors.
  if (isTenor(o.expiry)) throw new Error("settlement.px expiry must be absolute");
  return concatBytes(
    bStr(routed(o.exchange ?? "composite")),
    bStr(routed(o.baseAsset)),
    bExpiry(o.expiry),
    bStr(routed(o.asset ?? "spot")),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyIndexIv(
  o: FormatOpts & { baseAsset: string; expiry: string; asset?: string; exchange?: string },
): Uint8Array {
  return concatBytes(
    bStr(routed(o.exchange ?? "composite")),
    bStr(routed(o.baseAsset)),
    bExpiry(o.expiry),
    // Defaults to "option" so an omitted asset and an explicit "option" derive
    // byte-identically.
    bStr(routed(o.asset ?? "option")),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyRealizedVol(
  o: FormatOpts & { baseAsset: string; lookback: string; asset?: string; exchange?: string },
): Uint8Array {
  // lookback is SPELLING-sensitive: the qn interpolates it raw, so equal
  // durations spelled differently are different upstream feeds.
  return concatBytes(
    bStr(routed(o.asset ?? "spot")),
    bStr(routed(o.exchange ?? "blockscholes")),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.lookback)),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyInterestRate(o: FormatOpts & { baseAsset: string; expiry: string; asset?: string }): Uint8Array {
  // asset branches the rate source (crypto basis vs. a suffixed theoretical
  // rate); defaults to "future" so an omitted field and an explicit "future"
  // derive byte-identically.
  return concatBytes(
    bStr(routed(o.baseAsset)),
    bExpiry(o.expiry),
    bStr(routed(o.asset ?? "future")),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyPerpPx(
  o: FormatOpts & {
    exchange: string;
    asset: string;
    baseAsset: string;
    quoteAsset: string;
    intervalMs?: number;
  },
): Uint8Array {
  return concatBytes(
    bStr(routed(o.exchange)),
    bStr(routed(o.asset)),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.quoteAsset)),
    bU64(o.intervalMs ?? 30 * 60 * 1000),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyIvMoneyness(
  o: FormatOpts & {
    exchange: string;
    baseAsset: string;
    model: string;
    expiry: string;
    moneyness: number | number[];
    asset?: string;
  },
): Uint8Array {
  return concatBytes(
    bStr(routed(o.exchange)),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.model)),
    bExpiry(o.expiry),
    bVec(asList(o.moneyness).map((x) => bScaled(x, o.decimals))),
    // asset branches the option-variant surface (crypto vs. a suffixed
    // commodity/fx/equity underlying); defaults to "option".
    bStr(routed(o.asset ?? "option")),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyIvDelta(
  o: FormatOpts & {
    exchange: string;
    baseAsset: string;
    model: string;
    expiry: string;
    delta: number | number[];
    asset?: string;
  },
): Uint8Array {
  // delta.iv / skew.iv / risk-reversal.iv / butterfly.iv share this shape; the
  // feed string outside the body separates them. Delta may be negative.
  return concatBytes(
    bStr(routed(o.exchange)),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.model)),
    bExpiry(o.expiry),
    bVec(asList(o.delta).map((x) => bSignedScaled(x, o.decimals))),
    bStr(routed(o.asset ?? "option")),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

function bodyIvStrike(
  o: FormatOpts & {
    exchange: string;
    baseAsset: string;
    model: string;
    expiry: string;
    strike: number[] | "listed";
    asset?: string;
  },
): Uint8Array {
  // A tagged union: "listed" (the venue's live strike set) is a different
  // series from any fixed list.
  const strikeBytes =
    o.strike === "listed"
      ? bU8(STRIKE_IV_LISTED)
      : concatBytes(bU8(STRIKE_IV_VALUES), bVec(o.strike.map((x) => bScaled(x, o.decimals))));
  return concatBytes(
    bStr(routed(o.exchange)),
    bStr(routed(o.baseAsset)),
    bStr(routed(o.model)),
    bExpiry(o.expiry),
    strikeBytes,
    bStr(routed(o.asset ?? "option")),
    bU8(o.decimals),
    bStr(o.precision ?? "ms"),
  );
}

// === Derivation ===

const preimage = (feed: string, body: Uint8Array): Uint8Array => concatBytes(scopeBcs(), bStr(feed), body);

const sidHex = (feed: string, body: Uint8Array): string => "0x" + bytesToHex(keccak_256(preimage(feed, body)));

// === Vector table ===

interface Vector {
  name: string;
  feed: string;
  move_kind: boolean;
  request: Json;
  preimage: string;
  sid: string;
  note: string;
}

export function build(): Record<string, Json | Vector[]> {
  function vectorCase(name: string, feed: string, body: Uint8Array, request: Record<string, Json>, note = ""): Vector {
    // The real wire shape: feed items inside `batch`, `options` on the
    // enclosing subscription object.
    const { options, ...item } = request;
    // Every body now carries its own `decimals`, so nothing forces it to agree
    // with the `format.decimals` of the request printed beside it. A vector
    // whose two halves disagree is worse than no vector: an implementer would
    // reproduce the request and derive a different sid, and blame their code.
    // The body ends `decimals | timestamp_precision`, so the request's own
    // format must be exactly those trailing bytes.
    const format = (options as { format: { decimals: number; timestamp: string } }).format;
    const tail = bytesToHex(concatBytes(bU8(format.decimals), bStr(format.timestamp)));
    const encoded = bytesToHex(body);
    if (!encoded.endsWith(tail)) {
      throw new Error(
        `${name}: body does not end with the request's format (decimals=${format.decimals}, timestamp=${format.timestamp})`,
      );
    }
    return {
      name,
      feed,
      move_kind: MOVE_KINDS.has(feed),
      request: { batch: [item], options: options ?? null },
      preimage: bytesToHex(preimage(feed, body)),
      sid: sidHex(feed, body),
      note,
    };
  }

  const fmt: Record<string, Json> = { timestamp: "ms", hexify: false, decimals: 9 };
  // The signature block SELECTS signed output and the sui scope; it is not
  // itself hashed, so it moves no sid, but without it these requests would not
  // reproduce the vectors. Shape matches ts/src/wsapi_client.ts.
  const signature: Record<string, Json> = { type: "SUI", pkg_ver: PKG_VER, domain: { network: NETWORK } };
  const vectors = [
    vectorCase("index_px_basic", "index.px", bodyIndexPx({ decimals: 9, baseAsset: "HYPE", exchange: "composite" }), {
      feed: "index.px",
      asset: "spot",
      base_asset: "HYPE",
      quote_asset: "USD",
      exchange: "composite",
      options: { format: fmt, signature },
    }),
    vectorCase(
      "index_px_reference",
      "index.px",
      bodyIndexPx({ decimals: 9, baseAsset: "LBTC", exchange: "blockscholes", indexType: "reference" }),
      {
        feed: "index.px",
        asset: "spot",
        base_asset: "LBTC",
        exchange: "blockscholes",
        index_type: "reference",
        options: { format: fmt, signature },
      },
      "index_type selects a different served price -> different series",
    ),
    vectorCase(
      "index_px_spread",
      "index.px",
      bodyIndexPx({ decimals: 9, baseAsset: "BTC", exchange: "blockscholes", indexSpread: true }),
      {
        feed: "index.px",
        base_asset: "BTC",
        index_spread: true,
        options: { format: fmt, signature },
      },
      "index_spread selects a different served price; the only vector pinning the BCS bool's TRUE byte (0x01) — every other vector encodes it false. asset/exchange/quote_asset are omitted, so it also pins that the defaults resolve to spot/blockscholes/USD",
    ),
    vectorCase(
      "index_px_future",
      "index.px",
      bodyIndexPx({ decimals: 9, baseAsset: "HYPE", exchange: "blockscholes", asset: "future", expiry: ABSOLUTE }),
      {
        feed: "index.px",
        asset: "future",
        base_asset: "HYPE",
        exchange: "blockscholes",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "a dated futures index: the expiry is in the served qn, so two expiries are two series",
    ),
    vectorCase(
      "index_px_future_tenor",
      "index.px",
      bodyIndexPx({ decimals: 9, baseAsset: "HYPE", exchange: "blockscholes", asset: "future", expiry: "30d" }),
      {
        feed: "index.px",
        asset: "future",
        base_asset: "HYPE",
        exchange: "blockscholes",
        expiry: "30d",
        options: { format: fmt, signature },
      },
      "a rolling constant-maturity futures index: a tenor expiry, distinct from any absolute one",
    ),
    vectorCase(
      "index_px_spot_equity",
      "index.px",
      bodyIndexPx({ decimals: 9, baseAsset: "HYPE", exchange: "blockscholes", asset: "spot-equity" }),
      {
        feed: "index.px",
        asset: "spot-equity",
        base_asset: "HYPE",
        exchange: "blockscholes",
        options: { format: fmt, signature },
      },
      "a non-crypto underlying suffixes its asset class: spot-equity is a different series from spot",
    ),
    vectorCase(
      "mark_px_future",
      "mark.px",
      bodyMarkPx({ decimals: 9, asset: "future", baseAsset: "HYPE", exchange: "composite", expiry: ABSOLUTE }),
      {
        feed: "mark.px",
        asset: "future",
        base_asset: "HYPE",
        exchange: "composite",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "every absent Option is one 0x00 byte, never omitted",
    ),
    vectorCase(
      "mark_px_future_tenor",
      "mark.px",
      bodyMarkPx({ decimals: 9, asset: "future", baseAsset: "HYPE", exchange: "composite", expiry: "30d" }),
      {
        feed: "mark.px",
        asset: "future",
        base_asset: "HYPE",
        exchange: "composite",
        expiry: "30d",
        options: { format: fmt, signature },
      },
      "mark.px is not always an iso expiry either: a constant-maturity ('30d') mark is a tenor sid",
    ),
    vectorCase(
      "mark_px_future_equity",
      "mark.px",
      bodyMarkPx({ decimals: 9, asset: "future-equity", baseAsset: "HYPE", exchange: "composite", expiry: ABSOLUTE }),
      {
        feed: "mark.px",
        asset: "future-equity",
        base_asset: "HYPE",
        exchange: "composite",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "the same suffix on a mark: future-equity and future are two series",
    ),
    vectorCase(
      "mark_px_perpetual",
      "mark.px",
      bodyMarkPx({ decimals: 9, asset: "perpetual", baseAsset: "HYPE", exchange: "blockscholes" }),
      {
        feed: "mark.px",
        asset: "perpetual",
        base_asset: "HYPE",
        exchange: "blockscholes",
        options: { format: fmt, signature },
      },
    ),
    vectorCase(
      "mark_px_option",
      "mark.px",
      bodyMarkPx({
        decimals: 9,
        asset: "option",
        baseAsset: "HYPE",
        exchange: "deribit",
        expiry: ABSOLUTE,
        strike: "42.50",
        optionType: "C",
        greeks: ["delta", "vega"],
      }),
      {
        feed: "mark.px",
        asset: "option",
        base_asset: "HYPE",
        exchange: "deribit",
        expiry: ABSOLUTE,
        strike: 42.5,
        type: "C",
        greeks: ["delta", "vega"],
        options: { format: fmt, signature },
      },
      "not SUI-signable today (option mark is not a scalar); pinned so a future promotion cannot move ids",
    ),
    vectorCase(
      "mark_px_option_atm",
      "mark.px",
      bodyMarkPx({
        decimals: 9,
        asset: "option",
        baseAsset: "HYPE",
        exchange: "deribit",
        expiry: ABSOLUTE,
        strike: "atm_forward",
        optionType: "C",
      }),
      {
        feed: "mark.px",
        asset: "option",
        base_asset: "HYPE",
        exchange: "deribit",
        expiry: ABSOLUTE,
        strike: "atm_forward",
        type: "C",
        options: { format: fmt, signature },
      },
      "a named strike is a different instrument from any number",
    ),
    vectorCase(
      "model_params_svi",
      "model.params",
      bodyModelParams({ decimals: 9, baseAsset: "HYPE", model: "SVI", expiry: ABSOLUTE }),
      {
        feed: "model.params",
        asset: "option",
        exchange: "composite",
        base_asset: "HYPE",
        model: "SVI",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "asset/exchange defaulted; explicit spelling is byte-identical",
    ),
    vectorCase(
      "model_params_asset_override",
      "model.params",
      bodyModelParams({ decimals: 9, baseAsset: "HYPE", model: "SVI", expiry: ABSOLUTE, asset: "option-equity" }),
      {
        feed: "model.params",
        asset: "option-equity",
        exchange: "composite",
        base_asset: "HYPE",
        model: "SVI",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "asset branches the surface (e.g. RWA option-equity): a non-default asset is a different series",
    ),
    vectorCase(
      "model_params_tenor",
      "model.params",
      bodyModelParams({ decimals: 9, baseAsset: "HYPE", model: "SVI", expiry: "30d" }),
      {
        feed: "model.params",
        base_asset: "HYPE",
        model: "SVI",
        expiry: "30d",
        options: { format: fmt, signature },
      },
      "tenor: 2592000000 ms behind discriminant 0x01; does not roll",
    ),
    vectorCase(
      "model_params_decimals_5",
      "model.params",
      bodyModelParams({ baseAsset: "HYPE", model: "SVI", expiry: ABSOLUTE, decimals: 5 }),
      {
        feed: "model.params",
        base_asset: "HYPE",
        model: "SVI",
        expiry: ABSOLUTE,
        options: { format: { ...fmt, decimals: 5 }, signature },
      },
      "scale is identity: a provider rescale lands in a new slot",
    ),
    vectorCase(
      "mark_px_option_decimals_5",
      "mark.px",
      bodyMarkPx({
        asset: "option",
        baseAsset: "HYPE",
        exchange: "deribit",
        expiry: ABSOLUTE,
        strike: "42.50",
        optionType: "C",
        greeks: ["delta", "vega"],
        decimals: 5,
      }),
      {
        feed: "mark.px",
        asset: "option",
        base_asset: "HYPE",
        exchange: "deribit",
        expiry: ABSOLUTE,
        strike: 42.5,
        type: "C",
        greeks: ["delta", "vega"],
        options: { format: { ...fmt, decimals: 5 }, signature },
      },
      "identity numbers scale at format.decimals: the strike bytes AND the trailing decimals byte both differ from mark_px_option",
    ),
    vectorCase(
      "model_params_second_precision",
      "model.params",
      bodyModelParams({ decimals: 9, baseAsset: "HYPE", model: "SVI", expiry: ABSOLUTE, precision: "s" }),
      {
        feed: "model.params",
        base_asset: "HYPE",
        model: "SVI",
        expiry: ABSOLUTE,
        options: { format: { ...fmt, timestamp: "s" }, signature },
      },
      "timestamp precision is signed identity: the same surface at second-precision timestamps is its own series",
    ),
    vectorCase(
      "settlement_px",
      "settlement.px",
      bodySettlementPx({ decimals: 9, baseAsset: "HYPE", expiry: ABSOLUTE }),
      {
        feed: "settlement.px",
        base_asset: "HYPE",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "exchange defaults to composite; tenor expiry is rejected",
    ),
    vectorCase(
      "settlement_px_asset_override",
      "settlement.px",
      bodySettlementPx({ decimals: 9, baseAsset: "HYPE", expiry: ABSOLUTE, asset: "spot-equity" }),
      {
        feed: "settlement.px",
        asset: "spot-equity",
        base_asset: "HYPE",
        expiry: ABSOLUTE,
        options: { format: fmt, signature },
      },
      "asset branches the settlement underlying (e.g. an RWA spot-equity): a non-default asset is a different series",
    ),
    vectorCase("index_iv", "index.iv", bodyIndexIv({ decimals: 9, baseAsset: "BTC", expiry: "30d" }), {
      feed: "index.iv",
      base_asset: "BTC",
      expiry: "30d",
      options: { format: fmt, signature },
    }),
    vectorCase("realized_vol", "realized.vol", bodyRealizedVol({ decimals: 9, baseAsset: "BTC", lookback: "30d" }), {
      feed: "realized.vol",
      base_asset: "BTC",
      lookback: "30d",
      options: { format: fmt, signature },
    }),
    vectorCase("interest_rate", "interest.rate", bodyInterestRate({ decimals: 9, baseAsset: "USDC", expiry: "30d" }), {
      feed: "interest.rate",
      base_asset: "USDC",
      expiry: "30d",
      options: { format: fmt, signature },
    }),
    vectorCase(
      "interest_rate_asset_override",
      "interest.rate",
      bodyInterestRate({ decimals: 9, baseAsset: "XAU", expiry: "30d", asset: "future-commodity" }),
      {
        feed: "interest.rate",
        asset: "future-commodity",
        base_asset: "XAU",
        expiry: "30d",
        options: { format: fmt, signature },
      },
      "asset branches the rate source (crypto basis vs. a suffixed T-pricer theoretical rate): a non-default asset is a different series",
    ),
    vectorCase(
      "perp_px_mid_twap",
      "mid.diff.twap.px",
      bodyPerpPx({ decimals: 9, exchange: "derive", asset: "perpetual", baseAsset: "BTC", quoteAsset: "USDC" }),
      {
        feed: "mid.diff.twap.px",
        exchange: "derive",
        asset: "perpetual",
        base_asset: "BTC",
        quote_asset: "USDC",
        interval: "30m",
        options: { format: fmt, signature },
      },
      "interval normalised to ms; the three twap feeds are separate kinds",
    ),
    vectorCase(
      "perp_px_impact_bid_twap",
      "impact.bid.diff.twap.px",
      bodyPerpPx({ decimals: 9, exchange: "derive", asset: "perpetual", baseAsset: "BTC", quoteAsset: "USDC" }),
      {
        feed: "impact.bid.diff.twap.px",
        exchange: "derive",
        asset: "perpetual",
        base_asset: "BTC",
        quote_asset: "USDC",
        interval: "30m",
        options: { format: fmt, signature },
      },
    ),
    vectorCase(
      "perp_px_impact_ask_twap",
      "impact.ask.diff.twap.px",
      bodyPerpPx({ decimals: 9, exchange: "derive", asset: "perpetual", baseAsset: "BTC", quoteAsset: "USDC" }),
      {
        feed: "impact.ask.diff.twap.px",
        exchange: "derive",
        asset: "perpetual",
        base_asset: "BTC",
        quote_asset: "USDC",
        interval: "30m",
        options: { format: fmt, signature },
      },
    ),
    vectorCase(
      "moneyness_iv",
      "moneyness.iv",
      bodyIvMoneyness({
        decimals: 9,
        exchange: "deribit",
        baseAsset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        moneyness: [0.25, 0.5, 0.75],
      }),
      {
        feed: "moneyness.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        moneyness: [0.25, 0.5, 0.75],
        options: { format: fmt, signature },
      },
    ),
    vectorCase(
      "moneyness_iv_asset_override",
      "moneyness.iv",
      bodyIvMoneyness({
        decimals: 9,
        exchange: "composite",
        baseAsset: "XAU",
        model: "SVI",
        expiry: ABSOLUTE,
        moneyness: [0.25, 0.5, 0.75],
        asset: "option-commodity",
      }),
      {
        feed: "moneyness.iv",
        asset: "option-commodity",
        exchange: "composite",
        base_asset: "XAU",
        model: "SVI",
        expiry: ABSOLUTE,
        moneyness: [0.25, 0.5, 0.75],
        options: { format: fmt, signature },
      },
      "asset branches the option-variant surface (crypto vs. a suffixed commodity/fx/equity underlying): a non-default asset is a different series",
    ),
    vectorCase(
      "delta_iv_negative",
      "delta.iv",
      bodyIvDelta({
        decimals: 9,
        exchange: "deribit",
        baseAsset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: [-0.25, 0.25],
      }),
      {
        feed: "delta.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: [-0.25, 0.25],
        options: { format: fmt, signature },
      },
      "delta is signed: (u128 magnitude, bool negative), the SVI convention",
    ),
    vectorCase(
      "delta_iv_exponent_form",
      "delta.iv",
      bodyIvDelta({
        decimals: 9,
        exchange: "deribit",
        baseAsset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: 0.0000001,
      }),
      {
        feed: "delta.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: 0.0000001,
        options: { format: fmt, signature },
      },
      '0.0000001 stringifies as "1e-7": exponent-form JSON numbers must scale exactly, not throw',
    ),
    vectorCase(
      "skew_iv",
      "skew.iv",
      bodyIvDelta({ decimals: 9, exchange: "deribit", baseAsset: "BTC", model: "SVI", expiry: ABSOLUTE, delta: 0.25 }),
      {
        feed: "skew.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: 0.25,
        options: { format: fmt, signature },
      },
      "scalar delta == its one-element list",
    ),
    vectorCase(
      "risk_reversal_iv",
      "risk-reversal.iv",
      bodyIvDelta({ decimals: 9, exchange: "deribit", baseAsset: "BTC", model: "SVI", expiry: ABSOLUTE, delta: 0.25 }),
      {
        feed: "risk-reversal.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: 0.25,
        options: { format: fmt, signature },
      },
      "same shape as skew.iv; the feed string alone separates them",
    ),
    vectorCase(
      "butterfly_iv",
      "butterfly.iv",
      bodyIvDelta({ decimals: 9, exchange: "deribit", baseAsset: "BTC", model: "SVI", expiry: ABSOLUTE, delta: 0.1 }),
      {
        feed: "butterfly.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        delta: 0.1,
        options: { format: fmt, signature },
      },
    ),
    vectorCase(
      "strike_iv_values",
      "strike.iv",
      bodyIvStrike({
        decimals: 9,
        exchange: "deribit",
        baseAsset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        strike: [40000, 50000],
      }),
      {
        feed: "strike.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        strike: [40000, 50000],
        options: { format: fmt, signature },
      },
    ),
    vectorCase(
      "strike_iv_listed",
      "strike.iv",
      bodyIvStrike({
        decimals: 9,
        exchange: "deribit",
        baseAsset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        strike: "listed",
      }),
      {
        feed: "strike.iv",
        exchange: "deribit",
        base_asset: "BTC",
        model: "SVI",
        expiry: ABSOLUTE,
        strike: "listed",
        options: { format: fmt, signature },
      },
      "'listed' (the venue's live set) is its own series, tagged 0x00",
    ),
  ];

  const equivalences: Json = [
    {
      name: "expiry_spellings_collapse",
      why: "parsing is the canonicalisation",
      sids: [ABSOLUTE, "2026-07-28T15:00:00.000Z", "2026-07-28T15:00:00+00:00"].map((e) =>
        sidHex("model.params", bodyModelParams({ decimals: 9, baseAsset: "HYPE", model: "SVI", expiry: e })),
      ),
    },
    {
      name: "tenor_spellings_collapse",
      why: "duration-normalised: 30d == 720h == 30.0d",
      sids: ["30d", "720h", "30.0d"].map((t) =>
        sidHex("model.params", bodyModelParams({ decimals: 9, baseAsset: "HYPE", model: "SVI", expiry: t })),
      ),
    },
    {
      name: "strike_spellings_collapse",
      why: "scaled to integers: 42.5 == 42.50",
      sids: ["42.5", "42.50", "42.500"].map((s) =>
        sidHex(
          "mark.px",
          bodyMarkPx({
            decimals: 9,
            asset: "option",
            baseAsset: "HYPE",
            exchange: "deribit",
            expiry: ABSOLUTE,
            strike: s,
            optionType: "C",
            greeks: ["delta", "vega"],
          }),
        ),
      ),
    },
    {
      name: "scalar_equals_singleton_list",
      why: "a scalar delta and its one-element list are one series",
      sids: [0.25 as number | number[], [0.25]].map((d) =>
        sidHex(
          "skew.iv",
          bodyIvDelta({ decimals: 9, exchange: "deribit", baseAsset: "BTC", model: "SVI", expiry: ABSOLUTE, delta: d }),
        ),
      ),
    },
  ];

  const caseDisjointness: Json = {
    name: "routed_spellings_stay_distinct",
    why: "the qn layer interpolates these raw — two spellings are two upstream feeds, so they must not share an on-chain key",
    sids: (
      [
        ["HYPE", "composite"],
        ["hype", "COMPOSITE"],
      ] as const
    ).map(([b, e]) =>
      sidHex(
        "model.params",
        bodyModelParams({ decimals: 9, baseAsset: b, model: "SVI", expiry: ABSOLUTE, exchange: e }),
      ),
    ),
  };

  const disjointness: Json = {
    name: "same_shape_kinds_stay_disjoint",
    why: "skew.iv and risk-reversal.iv share a body; feed separates them",
    sids: ["skew.iv", "risk-reversal.iv", "delta.iv", "butterfly.iv"].map((f) =>
      sidHex(
        f,
        bodyIvDelta({
          decimals: 9,
          exchange: "deribit",
          baseAsset: "BTC",
          model: "SVI",
          expiry: ABSOLUTE,
          delta: 0.25,
        }),
      ),
    ),
  };

  return {
    scope: { package_id: ORACLE_PACKAGE_ID, pkg_ver: PKG_VER },
    network_lookup: NETWORK,
    feeds: [...FEEDS].sort(),
    move_kinds: [...MOVE_KINDS].sort(),
    vectors,
    equivalences,
    disjointness,
    case_disjointness: caseDisjointness,
  };
}

/// The committed artifact's exact text: 2-space-indented JSON, non-ASCII
/// escaped, closed by one newline.
export function render(data: unknown): string {
  const escaped = JSON.stringify(data, null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return escaped + "\n";
}

export function main(): void {
  const data = build();

  const groups = data["equivalences"] as Array<{ name: string; sids: string[] }>;
  for (const group of groups) {
    if (new Set(group.sids).size !== 1) throw new Error(`equivalence broken: ${group.name}`);
  }
  const disjoint = data["disjointness"] as { sids: string[] };
  if (new Set(disjoint.sids).size !== disjoint.sids.length) throw new Error("same-shape kinds collided");
  const caseDisjoint = data["case_disjointness"] as { sids: string[] };
  if (new Set(caseDisjoint.sids).size !== caseDisjoint.sids.length) {
    throw new Error("routed spellings collapsed — they reach different upstream feeds");
  }
  const vectors = data["vectors"] as Vector[];
  const covered = new Set(vectors.map((v) => v.feed));
  const missing = FEEDS.filter((f) => !covered.has(f));
  if (missing.length > 0) throw new Error(`kinds without vectors: ${missing.join(", ")}`);

  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../move/bs_sid/vectors.json");
  writeFileSync(out, render(data));
  console.log(`wrote ${out} (${vectors.length} vectors)`);
  for (const v of vectors) {
    const flag = v.move_kind ? "move" : "wapi";
    console.log(`  [${flag}] ${v.name.padEnd(28)} ${v.sid}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
