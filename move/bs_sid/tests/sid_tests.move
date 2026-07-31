// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Pins the sid layout against the shared vectors.
///
/// The wsAPI assigns sids using this same derivation, so these literals are
/// the interface between signer and consumer: a change that breaks them is a
/// coordinated break with the provider, not a local edit.
///
/// Every derive call passes the vectors' own placeholder oracle id as the
/// scope, so the public functions reproduce the pinned literals directly.
///
/// Generator: `ts/src/generate_sid_vectors.ts` (`pnpm -C ts generate-vectors`),
/// output `../vectors.json`. Every constant below is copied from it; the
/// `preimage` field is the byte-level diff aid when a literal fails.
#[test_only]
module bs_sid::sid_tests {
    use bs_sid::sid;
    use std::unit_test::assert_eq;

    /// The vectors' placeholder for the bs_oracle id — the deployment these
    /// pinned literals belong to. Regenerate with the real id after the
    /// oracle is published, and re-pin.
    const ORACLE_PACKAGE_ID: address = @0x1111111111111111111111111111111111111111111111111111111111111111;

    const DECIMALS: u8 = 9;

    /// 2026-07-28T15:00:00Z.
    const EXPIRY_MS: u64 = 1_785_250_800_000;
    /// `30d` as a duration.
    const TENOR_30D_MS: u64 = 2_592_000_000;
    /// `42.50` at nine decimal places.
    const STRIKE_42_50: u128 = 42_500_000_000;
    /// The same 42.5 strike at decimals=5 — identity numbers scale at the
    /// series' own decimals, so the encoded integer differs from the above.
    const STRIKE_42_50_AT_5: u128 = 4_250_000;
    const DECIMALS_5: u8 = 5;

    // Expected ids, from vectors.json.
    const INDEX_PX_BASIC: u256 = 0x087887a7b41642e5385d647cbf0d3a726c95d2696db16e461364d91ce5a0ef55;
    const INDEX_PX_REFERENCE: u256 = 0x4d9ca0b9e55650ad92bffb4cd259c4cdb2d2a5546c02ec6acc73cc5f2eeee2d5;
    const INDEX_PX_SPREAD: u256 = 0xe97408d790bd4550734f84c9d6ef2cd88a667b702f88859d0d905621d7656185;
    const INDEX_PX_FUTURE: u256 = 0xa932a97048234543ae0b73f3a42a605e754ac77ea2dbf3154358c2476f4c822e;
    const INDEX_PX_FUTURE_TENOR: u256 = 0x63c45b292b35c00616fd6d8b55b80f6f5fa748bb14c69bca0f6c77a1c786ecc0;
    const INDEX_PX_SPOT_EQUITY: u256 = 0xa15f5d59dc91b2c73201c12e8b6490e4ae719bb4e8e3a4f9383e7206a72acd4d;
    const MARK_PX_OPTION_ATM: u256 = 0xda87ca5cc16a95043ed09030f22ce8860dda63bc837038cbb93158f699d9bbb1;
    const MARK_PX_FUTURE: u256 = 0x767852094662e0763fdfb8cc02f08969892b2d083159df16cb91ccb6505e3cd6;
    const MARK_PX_FUTURE_TENOR: u256 = 0x619bdb1ce815f1520fd76398018024515fc5e9c652d60be893c936a80519fc8e;
    const MARK_PX_FUTURE_EQUITY: u256 = 0xe8b762be292336c60f3d92bb14ad5a75c99f1e55dba7c69c2d7f1bd17cfb8fa5;
    const MARK_PX_PERPETUAL: u256 = 0x8320d1bd10f808f939c234e27f8cdb3905c4811fe2622424a3ecdd490f57b87e;
    const MARK_PX_OPTION_DECIMALS_5: u256 = 0xfe47cdb2a4ba151772e344147c9202a8eb30e241ebce1c04dfb5282563f19d14;
    const MARK_PX_OPTION: u256 = 0xbd9d049995595ca20c98d3bf3bb153a5c2bf0a4615509a03c9b74450039b56b8;
    const MODEL_PARAMS_SVI: u256 = 0x29f876378481972bf272eddcbb987579ec3a75a634533295c3c8c2cbfe548a6a;
    const MODEL_PARAMS_ASSET_OVERRIDE: u256 = 0x93fe2e645bbc214eb6d90fe8b1e8fe54c43ac6696a6a91e283ad52fd9c5c5d9a;
    const MODEL_PARAMS_TENOR: u256 = 0xc248b2a85721bc2e5d00b1dda8baa96d7f2a0270f111d5a511f2aa03b07bddae;
    const MODEL_PARAMS_DECIMALS_5: u256 = 0x0d96e85ca50a4d31530575202d1d0e6c2f5738531163248c20d5c6335fd22a68;
    const MODEL_PARAMS_SECOND_PRECISION: u256 = 0x68c29e470e07e248ed8f7a9f82f8000ab6af07e70796d5a45c0d0b8616b2b6b9;
    const SETTLEMENT_PX: u256 = 0xb0f36a4bf705d213886362a7b1b238c155a0d3ef946ac30771db5bffa85d0ae7;

    // === index.px ===

    #[test]
    fun index_px_matches_the_shared_vector() {
        let sid = sid::index_px_generic(
            ORACLE_PACKAGE_ID,
            b"spot".to_string(),
            b"composite".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::none(),
            false,
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, INDEX_PX_BASIC);
    }

    /// `index_px` defaults to the `blockscholes` exchange — index.px only ever
    /// serves `blockscholes` or `binance`, never `composite`.
    #[test]
    fun index_px_defaults_to_blockscholes_exchange() {
        let defaulted = sid::index_px(
            ORACLE_PACKAGE_ID,
            b"spot".to_string(),
            b"HYPE".to_string(),
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        let explicit = sid::index_px_generic(
            ORACLE_PACKAGE_ID,
            b"spot".to_string(),
            b"blockscholes".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::none(),
            false,
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(defaulted, explicit);
        assert!(defaulted != INDEX_PX_BASIC);
    }

    /// An equity underlying suffixes its asset class, so `asset` can never be
    /// pinned by a convenience form: `spot-equity` is its own series.
    #[test]
    fun index_px_asset_is_part_of_the_identity() {
        let equity = sid::index_px(
            ORACLE_PACKAGE_ID,
            b"spot-equity".to_string(),
            b"HYPE".to_string(),
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        let crypto = sid::index_px(
            ORACLE_PACKAGE_ID,
            b"spot".to_string(),
            b"HYPE".to_string(),
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(equity, INDEX_PX_SPOT_EQUITY);
        assert!(equity != crypto);
    }

    /// `index_type` selects which price is served, so it must move the id.
    #[test]
    fun index_type_is_part_of_the_identity() {
        let sid = sid::index_px_generic(
            ORACLE_PACKAGE_ID,
            b"spot".to_string(),
            b"blockscholes".to_string(),
            b"LBTC".to_string(),
            b"USD".to_string(),
            option::some(b"reference".to_string()),
            false,
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, INDEX_PX_REFERENCE);
        assert!(sid != INDEX_PX_BASIC);
    }

    /// Two futures-index expiries are two series: the expiry is in the served
    /// qn, so it is identity.
    #[test]
    fun index_px_future_expiry_is_identity() {
        let sid = sid::index_px_generic(
            ORACLE_PACKAGE_ID,
            b"future".to_string(),
            b"blockscholes".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::none(),
            false,
            option::some(sid::expiry_at(EXPIRY_MS)),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, INDEX_PX_FUTURE);
        assert!(sid != INDEX_PX_BASIC);
    }

    /// A rolling constant-maturity futures index is a tenor sid, distinct from
    /// any absolute-expiry one.
    #[test]
    fun index_px_future_tenor_is_a_distinct_series() {
        let sid = sid::index_px_generic(
            ORACLE_PACKAGE_ID,
            b"future".to_string(),
            b"blockscholes".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::none(),
            false,
            option::some(sid::expiry_tenor(TENOR_30D_MS)),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, INDEX_PX_FUTURE_TENOR);
        assert!(sid != INDEX_PX_FUTURE);
    }

    // === mark.px ===

    /// A future's absent Options each encode one 0x00 byte — BCS is
    /// positional, so omission would let two instruments encode identically.
    #[test]
    fun mark_px_future_matches_the_shared_vector() {
        let sid = sid::mark_px(
            ORACLE_PACKAGE_ID,
            b"future".to_string(),
            b"composite".to_string(),
            b"HYPE".to_string(),
            option::some(sid::expiry_at(EXPIRY_MS)),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_FUTURE);
    }

    /// A constant-maturity ("30d") future mark is not an ISO expiry — it must
    /// derive through `expiry_tenor`, a distinct series from the absolute one.
    #[test]
    fun mark_px_future_tenor_is_a_distinct_series() {
        let sid = sid::mark_px(
            ORACLE_PACKAGE_ID,
            b"future".to_string(),
            b"composite".to_string(),
            b"HYPE".to_string(),
            option::some(sid::expiry_tenor(TENOR_30D_MS)),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_FUTURE_TENOR);
        assert!(sid != MARK_PX_FUTURE);
    }

    /// The same suffix rule as index.px: an equity future is `future-equity`,
    /// so the mark convenience form cannot pin `asset` either.
    #[test]
    fun mark_px_asset_is_part_of_the_identity() {
        let sid = sid::mark_px(
            ORACLE_PACKAGE_ID,
            b"future-equity".to_string(),
            b"composite".to_string(),
            b"HYPE".to_string(),
            option::some(sid::expiry_at(EXPIRY_MS)),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_FUTURE_EQUITY);
        assert!(sid != MARK_PX_FUTURE);
    }

    /// A perpetual is the same scalar shape as a future, minus the expiry.
    #[test]
    fun mark_px_perpetual_matches_the_shared_vector() {
        let sid = sid::mark_px(
            ORACLE_PACKAGE_ID,
            b"perpetual".to_string(),
            b"blockscholes".to_string(),
            b"HYPE".to_string(),
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_PERPETUAL);
    }

    /// index_spread selects a different served price, so it is identity. The
    /// only pin on the BCS bool's TRUE byte — every other vector encodes false.
    #[test]
    fun index_px_spread_is_identity() {
        // index_px cannot express this: it hardcodes index_spread false. The
        // values below are what that convenience form would supply.
        let sid = sid::index_px_generic(
            ORACLE_PACKAGE_ID,
            b"spot".to_string(),
            b"blockscholes".to_string(),
            b"BTC".to_string(),
            b"USD".to_string(),
            option::none(),
            true,
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, INDEX_PX_SPREAD);
        assert!(sid != INDEX_PX_BASIC);
    }

    /// The scale is identity, not presentation: the same strike at a different
    /// decimals encodes a different integer, so it is a different series.
    #[test]
    fun mark_px_option_decimals_5_is_a_different_series() {
        let sid = sid::mark_px_generic(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"deribit".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::some(sid::expiry_at(EXPIRY_MS)),
            option::some(vector[sid::mark_strike(0, STRIKE_42_50_AT_5, b"".to_string())]),
            option::none(),
            option::none(),
            option::some(b"C".to_string()),
            option::some(vector[b"delta".to_string(), b"vega".to_string()]),
            DECIMALS_5,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_OPTION_DECIMALS_5);
        assert!(sid != MARK_PX_OPTION);
    }

    /// Not SUI-signable today (an option's mark is not a scalar), but the
    /// layout must round-trip it so a future promotion cannot move ids.
    #[test]
    fun mark_px_option_matches_the_shared_vector() {
        let sid = sid::mark_px_generic(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"deribit".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::some(sid::expiry_at(EXPIRY_MS)),
            option::some(vector[sid::mark_strike(0, STRIKE_42_50, b"".to_string())]),
            option::none(),
            option::none(),
            option::some(b"C".to_string()),
            option::some(vector[b"delta".to_string(), b"vega".to_string()]),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_OPTION);
    }

    /// A named strike is a different instrument from any number.
    #[test]
    fun mark_px_named_strike_matches_the_shared_vector() {
        let sid = sid::mark_px_generic(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"deribit".to_string(),
            b"HYPE".to_string(),
            b"USD".to_string(),
            option::some(sid::expiry_at(EXPIRY_MS)),
            option::some(vector[sid::mark_strike(1, 0, b"atm_forward".to_string())]),
            option::none(),
            option::none(),
            option::some(b"C".to_string()),
            option::none(),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MARK_PX_OPTION_ATM);
    }

    // === strikes ===

    /// The two kinds share one layout, so a mixed spelling is representable in
    /// bytes but is not something the wsAPI ever emits — it would derive an id
    /// nothing is stored under.
    #[test, expected_failure(abort_code = sid::EInvalidMarkStrike)]
    fun mark_strike_rejects_a_named_strike_carrying_a_value() {
        let _ = sid::mark_strike(1, STRIKE_42_50, b"atm_forward".to_string());
    }

    #[test, expected_failure(abort_code = sid::EInvalidMarkStrike)]
    fun mark_strike_rejects_a_numeric_strike_carrying_a_name() {
        let _ = sid::mark_strike(0, STRIKE_42_50, b"atm_forward".to_string());
    }

    #[test, expected_failure(abort_code = sid::EInvalidMarkStrike)]
    fun mark_strike_rejects_an_unnamed_strike_name() {
        let _ = sid::mark_strike(1, 0, b"atm_median".to_string());
    }

    #[test, expected_failure(abort_code = sid::EInvalidMarkStrike)]
    fun mark_strike_rejects_an_unknown_kind() {
        let _ = sid::mark_strike(2, 0, b"".to_string());
    }

    // === model.params ===

    /// A client omitting a defaulted field and one naming it must subscribe
    /// to the same series.
    #[test]
    fun model_params_defaults_equal_explicit_spelling() {
        let defaulted = sid::model_params(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_at(EXPIRY_MS),
            DECIMALS,
            b"ms".to_string(),
        );
        let explicit = sid::model_params_generic(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"composite".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_at(EXPIRY_MS),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(defaulted, MODEL_PARAMS_SVI);
        assert_eq!(explicit, MODEL_PARAMS_SVI);
    }

    /// `asset` branches the surface (e.g. an RWA `option-equity` model), so it
    /// must move the id like any other identity field.
    #[test]
    fun model_params_asset_is_part_of_the_identity() {
        let sid = sid::model_params(
            ORACLE_PACKAGE_ID,
            b"option-equity".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_at(EXPIRY_MS),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MODEL_PARAMS_ASSET_OVERRIDE);
        assert!(sid != MODEL_PARAMS_SVI);
    }

    /// A tenor is its own series — it does not roll — and is distinct from any
    /// absolute instant, discriminant included.
    #[test]
    fun tenor_and_instant_are_separate_series() {
        let sid = sid::model_params(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_tenor(TENOR_30D_MS),
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, MODEL_PARAMS_TENOR);
        assert!(sid != MODEL_PARAMS_SVI);
    }

    /// The value scale is identity: a provider-side rescale must land in a new
    /// slot rather than be read at the wrong magnitude.
    #[test]
    fun scale_is_part_of_the_identity() {
        let sid = sid::model_params(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_at(EXPIRY_MS),
            5,
            b"ms".to_string(),
        );
        assert_eq!(sid, MODEL_PARAMS_DECIMALS_5);
        assert!(sid != MODEL_PARAMS_SVI);
    }

    /// The payload's u64 timestamps mean nothing without their unit, so one
    /// surface at second-precision is its own series.
    #[test]
    fun timestamp_precision_is_part_of_the_identity() {
        let sid = sid::model_params_generic(
            ORACLE_PACKAGE_ID,
            b"option".to_string(),
            b"composite".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_at(EXPIRY_MS),
            DECIMALS,
            b"s".to_string(),
        );
        assert_eq!(sid, MODEL_PARAMS_SECOND_PRECISION);
        assert!(sid != MODEL_PARAMS_SVI);
    }

    // === settlement.px ===

    /// A tenor settlement needs no rejection test: `settlement_px` takes raw
    /// unix-ms, so a tenor is unrepresentable by construction.
    #[test]
    fun settlement_px_matches_the_shared_vector() {
        let sid = sid::settlement_px(
            ORACLE_PACKAGE_ID,
            b"HYPE".to_string(),
            EXPIRY_MS,
            DECIMALS,
            b"ms".to_string(),
        );
        assert_eq!(sid, SETTLEMENT_PX);
    }

    // === Deployment scope ===

    /// The oracle id the caller passes is the whole scope, so one descriptor
    /// under a different deployment is a different series.
    #[test]
    fun deployment_scope_separates_ids() {
        let other_deployment = sid::model_params(
            @0x2222222222222222222222222222222222222222222222222222222222222222,
            b"option".to_string(),
            b"HYPE".to_string(),
            b"SVI".to_string(),
            sid::expiry_at(EXPIRY_MS),
            DECIMALS,
            b"ms".to_string(),
        );
        assert!(other_deployment != MODEL_PARAMS_SVI);
    }
}
