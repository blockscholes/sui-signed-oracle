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
        let updates = vector[
            verify::new_value_update_for_testing(SID_A, 65_000_000_000_000),
            verify::new_value_update_for_testing(SID_B, 65_250_000_000_000),
        ];
        let batch = verify::new_value_batch_for_testing(1_000_000, updates);

        assert_eq!(batch.value_timestamp(), 1_000_000);
        assert_eq!(batch.value_update_count(), 2);

        let out = batch.value_updates();
        assert_eq!(out[0].value_sid(), SID_A);
        assert_eq!(out[0].value_v(), 65_000_000_000_000);
        assert_eq!(out[1].value_sid(), SID_B);
        assert_eq!(out[1].value_v(), 65_250_000_000_000);

        batch.destroy_value_batch();
    }

    #[test]
    fun svi_batch_accessors_round_trip() {
        let updates = vector[
            // svi_a negative here, to prove the signed `a` round-trips.
            verify::new_svi_for_testing(
                SVI_SID,
                40_000_000,
                true,
                100_000_000,
                200_000_000,
                700_000_000,
                true,
                0,
                false,
            ),
        ];
        let batch = verify::new_svi_batch_for_testing(1_000_000, updates);

        assert_eq!(batch.svi_timestamp(), 1_000_000);
        assert_eq!(batch.svi_update_count(), 1);

        let out = batch.svi_updates();
        assert_eq!(out[0].svi_sid(), SVI_SID);
        let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = out[0].svi_fields();
        assert_eq!(a_mag, 40_000_000);
        assert!(a_neg);
        assert_eq!(b, 100_000_000);
        assert_eq!(sigma, 200_000_000);
        assert_eq!(rho_mag, 700_000_000);
        assert!(rho_neg);
        assert_eq!(m_mag, 0);
        assert!(!m_neg);

        batch.destroy_svi_batch();
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
        batch.destroy_value_batch();

        ts::return_to_sender(&scenario, cap);
        return_shared(reg);
        clk.destroy_for_testing();
        scenario.end();
    }
}
