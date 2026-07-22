// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Accessor round-trip tests for the gated batch structs. These use the
/// `#[test_only]` constructors (no signing); the real signature path is covered by
/// the live-signed localnet e2e in `ts/src/e2e.test.ts`.
#[test_only]
module bs_oracle::verify_tests {
    use bs_oracle::{registry::{Self, SignerRegistry, AdminCap}, verify};
    use std::unit_test::assert_eq;
    use sui::{clock::{Self, Clock}, test_scenario::{Self as ts, return_shared}};

    const ADMIN: address = @0xAD;

    // A full-width hash-like sid — exceeds u32::MAX and u64::MAX, so it proves the
    // accessor/test-ctor path preserves the whole `u256` rather than narrowing it.
    const SID_A: u256 = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;
    const SID_B: u256 = 11;
    const SVI_SID: u256 = 12;

    #[test]
    fun value_batch_accessors_round_trip() {
        // Distinct timestamps, to prove each update carries its own.
        let updates = vector[
            verify::new_value_update_for_testing(SID_A, 1_000_000, 65_000_000_000_000),
            verify::new_value_update_for_testing(SID_B, 1_500_000, 65_250_000_000_000),
        ];
        let batch = verify::new_value_batch_for_testing(updates);

        // The call the consumer makes.
        let out = batch.into_value_updates();
        assert_eq!(out.length(), 2);
        assert_eq!(out[0].value_sid(), SID_A);
        assert_eq!(out[0].value_timestamp(), 1_000_000);
        assert_eq!(out[0].value_v(), 65_000_000_000_000);
        assert_eq!(out[1].value_sid(), SID_B);
        assert_eq!(out[1].value_timestamp(), 1_500_000);
        assert_eq!(out[1].value_v(), 65_250_000_000_000);
    }

    #[test]
    fun svi_batch_accessors_round_trip() {
        // Distinct sids and timestamps, to prove each SVI update carries its own.
        let updates = vector[
            // svi_a negative here, to prove the signed `a` round-trips.
            verify::new_svi_for_testing(
                SVI_SID,
                1_000_000,
                40_000_000,
                true,
                100_000_000,
                200_000_000,
                700_000_000,
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
        let batch = verify::new_svi_batch_for_testing(updates);

        let out = batch.into_svi_updates();
        assert_eq!(out.length(), 2);
        assert_eq!(out[0].svi_sid(), SVI_SID);
        assert_eq!(out[0].svi_timestamp(), 1_000_000);
        let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = out[0].svi_fields();
        assert_eq!(a_mag, 40_000_000);
        assert!(a_neg);
        assert_eq!(b, 100_000_000);
        assert_eq!(sigma, 200_000_000);
        assert_eq!(rho_mag, 700_000_000);
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

    // `verify_header` checks pause before signature/message parsing, so this exercises
    // the gate directly with a throwaway message rather than needing a real signature.
    #[test, expected_failure(abort_code = verify::EPaused)]
    fun verify_and_create_value_batch_rejects_when_paused() {
        let mut scenario = ts::begin(ADMIN);
        registry::init_for_testing(scenario.ctx());
        scenario.next_tx(ADMIN);
        let mut reg = scenario.take_shared<SignerRegistry>();
        let cap = scenario.take_from_sender<AdminCap>();
        let clk = clock::create_for_testing(scenario.ctx());

        registry::set_paused(&mut reg, &cap, true);
        let batch = verify::verify_and_create_value_batch(&reg, &clk, vector[]);
        batch.into_value_updates();

        ts::return_to_sender(&scenario, cap);
        return_shared(reg);
        clk.destroy_for_testing();
        scenario.end();
    }
}
