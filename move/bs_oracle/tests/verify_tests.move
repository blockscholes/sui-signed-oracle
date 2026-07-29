// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Accessor round-trip tests for the gated batch structs. These use the
/// `#[test_only]` constructors (no signing); the real signature path is covered by
/// the live-signed localnet e2e in `ts/src/e2e.test.ts`.
#[test_only]
module bs_oracle::verify_tests {
    use bs_oracle::{registry::{Self, SignerRegistry, AdminCap}, verify};
    use std::unit_test::assert_eq;
    use sui::test_scenario::{Self as ts, return_shared};

    const ADMIN: address = @0xAD;

    // A full-width hash-like sid — exceeds u32::MAX and u64::MAX, so it proves the
    // accessor/test-ctor path preserves the whole `u256` rather than narrowing it.
    const SID_A: u256 = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;
    const SID_B: u256 = 11;
    const SVI_SID: u256 = 12;

    // Distinct from every per-update timestamp below, so the batch accessor can't pass
    // by accidentally reading an update's.
    const BATCH_TS: u64 = 9_000_000;

    // Comfortably above u64::MAX (18_446_744_073_709_551_615), so the round-trip tests
    // prove the accessor path preserves the full u128 width rather than truncating it.
    const ABOVE_U64_MAX: u128 = 100_000_000_000_000_000_000;

    #[test]
    fun value_batch_accessors_round_trip() {
        // Distinct timestamps, to prove each update carries its own. SID_A's value is
        // above u64::MAX to prove the u128 width round-trips.
        let updates = vector[
            verify::new_value_update_for_testing(SID_A, 1_000_000, ABOVE_U64_MAX),
            verify::new_value_update_for_testing(SID_B, 1_500_000, 65_250_000_000_000),
        ];
        let batch = verify::new_value_batch_for_testing(BATCH_TS, updates);

        // The batch's own send time, read before the batch is consumed.
        assert_eq!(batch.value_batch_timestamp(), BATCH_TS);

        // The call the consumer makes.
        let out = batch.into_value_updates();
        assert_eq!(out.length(), 2);
        assert_eq!(out[0].value_sid(), SID_A);
        assert_eq!(out[0].value_timestamp(), 1_000_000);
        assert_eq!(out[0].value_v(), ABOVE_U64_MAX);
        assert_eq!(out[1].value_sid(), SID_B);
        assert_eq!(out[1].value_timestamp(), 1_500_000);
        assert_eq!(out[1].value_v(), 65_250_000_000_000);
    }

    #[test]
    fun svi_batch_accessors_round_trip() {
        // Distinct sids and timestamps, to prove each SVI update carries its own.
        // The first update's `a`/`rho` magnitudes are above u64::MAX, to prove the
        // u128 width round-trips on the signed (magnitude + is_negative) fields too.
        let updates = vector[
            // svi_a negative here, to prove the signed `a` round-trips.
            verify::new_svi_for_testing(
                SVI_SID,
                1_000_000,
                ABOVE_U64_MAX,
                true,
                100_000_000,
                200_000_000,
                ABOVE_U64_MAX,
                true,
                0,
                false,
            ),
            verify::new_svi_for_testing(
                SID_B,
                1_500_000,
                10_000_000,
                false,
                50_000_000,
                60_000_000,
                80_000_000,
                false,
                5_000_000,
                true,
            ),
        ];
        let batch = verify::new_svi_batch_for_testing(BATCH_TS, updates);

        assert_eq!(batch.svi_batch_timestamp(), BATCH_TS);

        let out = batch.into_svi_updates();
        assert_eq!(out.length(), 2);
        assert_eq!(out[0].svi_sid(), SVI_SID);
        assert_eq!(out[0].svi_timestamp(), 1_000_000);
        let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = out[0].svi_fields();
        assert_eq!(a_mag, ABOVE_U64_MAX);
        assert!(a_neg);
        assert_eq!(b, 100_000_000);
        assert_eq!(sigma, 200_000_000);
        assert_eq!(rho_mag, ABOVE_U64_MAX);
        assert!(rho_neg);
        assert_eq!(m_mag, 0);
        assert!(!m_neg);

        assert_eq!(out[1].svi_sid(), SID_B);
        assert_eq!(out[1].svi_timestamp(), 1_500_000);
        let (a_mag2, a_neg2, b2, sigma2, rho_mag2, rho_neg2, m_mag2, m_neg2) = out[1].svi_fields();
        assert_eq!(a_mag2, 10_000_000);
        assert!(!a_neg2);
        assert_eq!(b2, 50_000_000);
        assert_eq!(sigma2, 60_000_000);
        assert_eq!(rho_mag2, 80_000_000);
        assert!(!rho_neg2);
        assert_eq!(m_mag2, 5_000_000);
        assert!(m_neg2);
    }

    #[test]
    fun value_absolute_batch_accessors_round_trip() {
        // No per-update timestamp to distinguish — the batch timestamp alone applies.
        // SID_A's value is above u64::MAX to prove the u128 width round-trips.
        let updates = vector[
            verify::new_value_absolute_update_for_testing(SID_A, ABOVE_U64_MAX),
            verify::new_value_absolute_update_for_testing(SID_B, 65_250_000_000_000),
        ];
        let batch = verify::new_value_absolute_batch_for_testing(BATCH_TS, updates);

        assert_eq!(batch.value_absolute_batch_timestamp(), BATCH_TS);

        let out = batch.into_value_absolute_updates();
        assert_eq!(out.length(), 2);
        assert_eq!(out[0].value_absolute_sid(), SID_A);
        assert_eq!(out[0].value_absolute_v(), ABOVE_U64_MAX);
        assert_eq!(out[1].value_absolute_sid(), SID_B);
        assert_eq!(out[1].value_absolute_v(), 65_250_000_000_000);
    }

    #[test]
    fun svi_absolute_batch_accessors_round_trip() {
        // Distinct sids, no per-update timestamp. The first update's `a`/`rho`
        // magnitudes are above u64::MAX, to prove the u128 width round-trips on the
        // signed (magnitude + is_negative) fields too.
        let updates = vector[
            // svi_a negative here, to prove the signed `a` round-trips.
            verify::new_svi_absolute_for_testing(
                SVI_SID,
                ABOVE_U64_MAX,
                true,
                100_000_000,
                200_000_000,
                ABOVE_U64_MAX,
                true,
                0,
                false,
            ),
            verify::new_svi_absolute_for_testing(
                SID_B,
                10_000_000,
                false,
                50_000_000,
                60_000_000,
                80_000_000,
                false,
                5_000_000,
                true,
            ),
        ];
        let batch = verify::new_svi_absolute_batch_for_testing(BATCH_TS, updates);

        assert_eq!(batch.svi_absolute_batch_timestamp(), BATCH_TS);

        let out = batch.into_svi_absolute_updates();
        assert_eq!(out.length(), 2);
        assert_eq!(out[0].svi_absolute_sid(), SVI_SID);
        let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = out[0].svi_absolute_fields();
        assert_eq!(a_mag, ABOVE_U64_MAX);
        assert!(a_neg);
        assert_eq!(b, 100_000_000);
        assert_eq!(sigma, 200_000_000);
        assert_eq!(rho_mag, ABOVE_U64_MAX);
        assert!(rho_neg);
        assert_eq!(m_mag, 0);
        assert!(!m_neg);

        assert_eq!(out[1].svi_absolute_sid(), SID_B);
        let (a_mag2, a_neg2, b2, sigma2, rho_mag2, rho_neg2, m_mag2, m_neg2) = out[1].svi_absolute_fields();
        assert_eq!(a_mag2, 10_000_000);
        assert!(!a_neg2);
        assert_eq!(b2, 50_000_000);
        assert_eq!(sigma2, 60_000_000);
        assert_eq!(rho_mag2, 80_000_000);
        assert!(!rho_neg2);
        assert_eq!(m_mag2, 5_000_000);
        assert!(m_neg2);
    }

    // `verify_header` checks pause before signature/message parsing, so this exercises
    // the gate directly with a throwaway message rather than needing a real signature.
    #[test, expected_failure(abort_code = verify::EPaused)]
    fun verify_and_create_value_batch_rejects_when_paused() {
        let mut scenario = ts::begin(ADMIN);
        registry::init_for_testing(scenario.ctx());
        scenario.next_tx(ADMIN);
        let mut reg = scenario.take_shared<SignerRegistry>();
        let cap = scenario.take_from_sender<AdminCap>();

        registry::set_paused(&mut reg, &cap, true);
        let batch = verify::verify_and_create_value_batch(&reg, vector[]);
        batch.into_value_updates();

        ts::return_to_sender(&scenario, cap);
        return_shared(reg);
        scenario.end();
    }
}
