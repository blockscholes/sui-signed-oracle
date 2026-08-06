// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Derives the Block Scholes series id (sid) for one subscribed feed.
///
/// A sid is the `u256` a feed's signed values are keyed by, and the only
/// binding between a stored value and its real-world meaning —
/// `bs_oracle::verify` proves bytes are authentic but never interprets them.
/// So this derivation is a contract with the wsAPI signer, not an
/// implementation detail: `ts/src/generate_sid_vectors.ts` is the executable
/// reference, `tests/sid_tests.move` pins its output, and breaking the vectors
/// is a coordinated break with the provider. Full layout and rationale:
/// `docs/design.md` (Preimage).
///
///     preimage = scope | feed | body
///
/// - `scope` = the bs_oracle package id (32), supplied by the caller — the
///   deployment that verifies and stores the values, NOT this package, which
///   only computes digests (the EVM side scopes by its EIP-712
///   verifying_contract for the same reason). A consumer already holds the id
///   of the oracle it verifies against, and passes that same id here, so one
///   published copy of this library stays correct for every deployment and
///   every oracle version rather than needing a rebuild per id.
/// - `feed` is supplied by each derive function, never the caller.
/// - `body` is the kind's identity fields in pinned order, closed by
///   `decimals | timestamp_precision`.
///
/// Each public function takes the oracle package id plus a feed kind's
/// identity fields and returns the sid in one call; the descriptor structs exist only to declare each body's
/// BCS layout and never reach a caller. Every kind comes in two forms: `X`
/// defaults the fields a subscription rarely varies, `X_generic` spells all of
/// them out. `asset` is a parameter of both — asset classes carry a suffix for
/// a non-crypto underlying (`spot-equity`, `future-equity`, `option-equity`),
/// so no wrapper may pin one. Only the four SUI-signable kinds live
/// here; the wsAPI derives every feed the same way. Normalisation is
/// off-chain, except that routed strings (base asset, exchange, lookback) are
/// carried AS SENT — two spellings reach two different upstream feeds. An
/// absent `Option` still emits its tag byte: BCS is positional, so omission
/// would shift later fields and let two instruments encode identically.
module bs_sid::sid {
    use std::string::String;
    use sui::{bcs, hash};

    // === Constants ===

    const FEED_INDEX_PX: vector<u8> = b"index.px";
    const FEED_MARK_PX: vector<u8> = b"mark.px";
    const FEED_MODEL_PARAMS: vector<u8> = b"model.params";
    const FEED_SETTLEMENT_PX: vector<u8> = b"settlement.px";

    /// Mirror the wsAPI subscription defaults — an on-chain caller cannot run
    /// the off-chain normaliser. The vectors assert defaulted and explicit
    /// spellings derive byte-identically.
    const DEFAULT_QUOTE_ASSET: vector<u8> = b"USD";
    const DEFAULT_INDEX_EXCHANGE: vector<u8> = b"blockscholes";
    const DEFAULT_MODEL_PARAMS_EXCHANGE: vector<u8> = b"composite";
    const DEFAULT_SETTLEMENT_EXCHANGE: vector<u8> = b"composite";

    /// mark.px strike tags. Move has no public constants, so a caller spells
    /// these as bare 0/1 — `mark_strike` documents and enforces them.
    const STRIKE_VALUE: u8 = 0;
    const STRIKE_NAMED: u8 = 1;

    const EXPIRY_ABSOLUTE: u8 = 0;
    const EXPIRY_TENOR: u8 = 1;

    /// A strike whose fields contradict its tag: it would encode bytes the
    /// wsAPI never produces, and derive an id nothing is stored under.
    const EInvalidMarkStrike: u64 = 0;

    // === Types ===
    //
    // The descriptor structs' field order IS the pinned BCS body layout,
    // declared once here and mirrored by the TS generator. They have no
    // public constructors and are never returned, so callers never hold one —
    // the derive functions build, encode and hash in one step.

    /// One element of a mark.px strike: a number (kind 0, at the series'
    /// `decimals`) or a named strike (kind 1 — `atm_spot`/`atm_forward`).
    /// The unused field of each kind encodes its zero, so both share one
    /// layout. Built via `mark_strike`.
    public struct MarkStrike has copy, drop {
        kind: u8,
        value: u128,
        name: String,
    }

    /// An instant (unix ms) or a constant maturity (duration in ms). The
    /// discriminant keeps them in separate slots — `2592000000` is a plausible
    /// value of either. A tenor sid never rolls. `index.px`, `mark.px` and
    /// `model.params` all let the caller choose between the two; only
    /// `settlement.px` is always an instant, taken as raw unix-ms — a
    /// settlement print is a stated event, never a rolling window.
    public struct Expiry has copy, drop {
        kind: u8,
        value: u64,
    }

    /// `index.px`. `index_type`/`index_spread` select WHICH price is served,
    /// so they are identity, not presentation.
    public struct IndexPx has copy, drop {
        asset: String,
        exchange: String,
        base_asset: String,
        quote_asset: String,
        index_type: Option<String>,
        /// Absent IS false, so a plain bool rather than an Option.
        index_spread: bool,
        /// Dated futures indices carry it in the served qn. Absent for spot.
        expiry: Option<Expiry>,
        decimals: u8,
        /// Unit of this series' u64 timestamps — signed identity (e.g. `ms`, `ns`, `s`).
        timestamp_precision: String,
    }

    /// `mark.px`. One feed spans perpetuals, futures and options, so the
    /// instrument fields are Options rather than split kinds — a perpetual
    /// encodes every one absent. `strike`/`moneyness` are fixed-point at this
    /// series' own `decimals` — the scale the contract stores the value at, so
    /// key and datum agree, and two scales of one instrument are two ids (the
    /// body closes with that same decimals byte). Equivalent SPELLINGS of one
    /// number still cannot fork the id: 42.5 and 42.50 scale identically.
    /// `ref_expiry` is response-shaping, not identity, so it never participates.
    public struct MarkPx has copy, drop {
        asset: String,
        exchange: String,
        base_asset: String,
        quote_asset: String,
        expiry: Option<Expiry>,
        // scalar strikes arrive as their singleton vector (scalar == singleton)
        strike: Option<vector<MarkStrike>>,
        model: Option<String>,
        moneyness: Option<vector<u128>>,
        option_type: Option<String>,
        greeks: Option<vector<String>>,
        decimals: u8,
        /// Unit of this series' u64 timestamps — signed identity (e.g. `ms`, `ns`, `s`).
        timestamp_precision: String,
    }

    /// `model.params`. No quote asset — a params surface is always quoted in
    /// USD, so there is nothing to encode. The response-shaping `params` list
    /// never participates, so two clients reading one surface share a sid.
    public struct ModelParams has copy, drop {
        asset: String,
        exchange: String,
        base_asset: String,
        model: String,
        expiry: Expiry,
        decimals: u8,
        /// Unit of this series' u64 timestamps — signed identity (e.g. `ms`, `ns`, `s`).
        timestamp_precision: String,
    }

    /// `settlement.px`. `asset` is `spot` for a settlement print, but a
    /// suffixed class (e.g. `spot-commodity`) branches the same shape; no
    /// quote — scoped by base asset and the settlement instant.
    public struct SettlementPx has copy, drop {
        exchange: String,
        base_asset: String,
        expiry: Expiry,
        asset: String,
        decimals: u8,
        /// Unit of this series' u64 timestamps — signed identity (e.g. `ms`, `ns`, `s`).
        timestamp_precision: String,
    }

    // === Expiry ===

    /// An instant, in unix milliseconds.
    public fun expiry_at(expiry_ms: u64): Expiry {
        Expiry { kind: EXPIRY_ABSOLUTE, value: expiry_ms }
    }

    /// A constant maturity, as a duration in ms. The off-chain normaliser
    /// collapses spellings (`30d` == `720h` == `30.0d`) before this.
    public fun expiry_tenor(tenor_ms: u64): Expiry {
        Expiry { kind: EXPIRY_TENOR, value: tenor_ms }
    }

    // === Strikes ===

    /// One element of a mark.px strike list.
    ///
    /// `kind` 0 is a number: `value` pre-scaled at the series' `decimals`,
    /// `name` empty. `kind` 1 is a named strike: `name` is `atm_spot` or
    /// `atm_forward`, `value` zero. Both kinds share one layout, so a spelling
    /// that mixes them — a named strike carrying a value, a numeric one
    /// carrying a name — encodes bytes the wsAPI never emits and would derive
    /// an id holding nothing. Refused here rather than discovered on-chain.
    ///
    /// A greek-free option mark is a single number, so it rides a signed batch
    /// like any other scalar; carrying `greeks` is what makes a mark
    /// unsignable, not carrying a strike.
    public fun mark_strike(kind: u8, value: u128, name: String): MarkStrike {
        if (kind == STRIKE_VALUE) {
            assert!(name.is_empty(), EInvalidMarkStrike);
        } else {
            assert!(kind == STRIKE_NAMED, EInvalidMarkStrike);
            assert!(value == 0, EInvalidMarkStrike);
            assert!(name == b"atm_spot".to_string() || name == b"atm_forward".to_string(), EInvalidMarkStrike);
        };
        MarkStrike { kind, value, name }
    }

    // === Derivation ===

    /// Every `index.px` identity field spelled out. `index_px` is the common
    /// shape; reach for this one to name a non-default exchange or quote, or to
    /// select an index type.
    public fun index_px_generic(
        package_id: address,
        asset: String,
        exchange: String,
        base_asset: String,
        quote_asset: String,
        index_type: Option<String>,
        index_spread: bool,
        // dated or constant-maturity futures index; a spot index has none
        expiry: Option<Expiry>,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        let d = IndexPx {
            asset,
            exchange,
            base_asset,
            quote_asset,
            index_type,
            index_spread,
            expiry,
            decimals,
            timestamp_precision,
        };
        digest(package_id, FEED_INDEX_PX, bcs::to_bytes(&d))
    }

    /// The common shape: blockscholes exchange, USD quote, no index-type
    /// override. `asset` stays a parameter because it is not always `spot` —
    /// a non-crypto underlying spells it `spot-equity`/`future-equity` — and so
    /// does `expiry`, which a futures index carries and a spot index does not.
    public fun index_px(
        package_id: address,
        asset: String,
        base_asset: String,
        expiry: Option<Expiry>,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        index_px_generic(
            package_id,
            asset,
            DEFAULT_INDEX_EXCHANGE.to_string(),
            base_asset,
            DEFAULT_QUOTE_ASSET.to_string(),
            option::none(),
            false,
            expiry,
            decimals,
            timestamp_precision,
        )
    }

    /// Every `mark.px` identity field spelled out. `mark_px` covers the scalar
    /// instruments; an option's mark — strike, option type, greeks — needs this
    /// one.
    public fun mark_px_generic(
        package_id: address,
        asset: String,
        exchange: String,
        base_asset: String,
        quote_asset: String,
        // dated or constant-maturity (e.g. a rolling "30d" future/option)
        expiry: Option<Expiry>,
        // scalar strikes arrive as their singleton vector (scalar == singleton)
        strike: Option<vector<MarkStrike>>,
        model: Option<String>,
        moneyness: Option<vector<u128>>,
        option_type: Option<String>,
        greeks: Option<vector<String>>,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        let d = MarkPx {
            asset,
            exchange,
            base_asset,
            quote_asset,
            expiry,
            strike,
            model,
            moneyness,
            option_type,
            greeks,
            decimals,
            timestamp_precision,
        };
        digest(package_id, FEED_MARK_PX, bcs::to_bytes(&d))
    }

    /// A scalar mark: USD quote and every instrument field absent — the shape
    /// of a perpetual (no expiry) or a future, dated or constant-maturity.
    /// `asset` stays a parameter because an equity underlying spells it
    /// `future-equity`, and the same shape serves `perpetual`.
    public fun mark_px(
        package_id: address,
        asset: String,
        exchange: String,
        base_asset: String,
        expiry: Option<Expiry>,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        mark_px_generic(
            package_id,
            asset,
            exchange,
            base_asset,
            DEFAULT_QUOTE_ASSET.to_string(),
            expiry,
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            decimals,
            timestamp_precision,
        )
    }

    /// Every `model.params` identity field spelled out. `model_params` is the
    /// common shape; reach for this one to name a per-venue surface rather than
    /// the composite.
    public fun model_params_generic(
        package_id: address,
        asset: String,
        exchange: String,
        base_asset: String,
        model: String,
        expiry: Expiry,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        let d = ModelParams { asset, exchange, base_asset, model, expiry, decimals, timestamp_precision };
        digest(package_id, FEED_MODEL_PARAMS, bcs::to_bytes(&d))
    }

    /// The composite surface at this feed's default exchange. `asset` is
    /// `option` for a vol surface, but other asset classes (e.g. an RWA
    /// `option-equity` surface) branch the same shape.
    public fun model_params(
        package_id: address,
        asset: String,
        base_asset: String,
        model: String,
        expiry: Expiry,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        model_params_generic(
            package_id,
            asset,
            DEFAULT_MODEL_PARAMS_EXCHANGE.to_string(),
            base_asset,
            model,
            expiry,
            decimals,
            timestamp_precision,
        )
    }

    /// Every `settlement.px` identity field spelled out; `settlement_px` is the
    /// common shape. A settlement print is always at a stated instant, so the
    /// expiry is raw unix-ms — a tenor is unrepresentable here, the same shape
    /// the wsAPI enforces at subscribe.
    public fun settlement_px_generic(
        package_id: address,
        asset: String,
        exchange: String,
        base_asset: String,
        expiry_ms: u64,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        let d = SettlementPx {
            exchange,
            base_asset,
            expiry: expiry_at(expiry_ms),
            asset,
            decimals,
            timestamp_precision,
        };
        digest(package_id, FEED_SETTLEMENT_PX, bcs::to_bytes(&d))
    }

    /// The settlement print at this feed's default exchange.
    public fun settlement_px(
        package_id: address,
        asset: String,
        base_asset: String,
        expiry_ms: u64,
        decimals: u8,
        timestamp_precision: String,
    ): u256 {
        settlement_px_generic(
            package_id,
            asset,
            DEFAULT_SETTLEMENT_EXCHANGE.to_string(),
            base_asset,
            expiry_ms,
            decimals,
            timestamp_precision,
        )
    }

    // === Private ===

    fun digest(package_id: address, feed: vector<u8>, body: vector<u8>): u256 {
        // No network: distinct chains already carry distinct package ids.
        let mut preimage = bcs::to_bytes(&package_id);
        // As a String so it carries its ULEB length prefix; raw bytes would
        // drop it and diverge from every other field.
        preimage.append(bcs::to_bytes(&feed.to_string()));
        preimage.append(body);
        keccak_to_u256(preimage)
    }

    /// Big-endian fold, matching `int.from_bytes(digest, "big")` off-chain.
    /// Deliberately not `bcs::peel_u256`, which reads little-endian.
    fun keccak_to_u256(bytes: vector<u8>): u256 {
        let digest = hash::keccak256(&bytes);
        let mut acc = 0u256;
        let mut i = 0;
        while (i < 32) {
            acc = (acc << 8) | (digest[i] as u256);
            i = i + 1;
        };
        acc
    }
}
