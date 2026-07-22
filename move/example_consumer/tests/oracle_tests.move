// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Unit tests for the consumer ingest paths. Batches are built via the
/// `#[test_only]` constructors (no signing); the real signature path is covered
/// by the live-signed localnet e2e in `ts/src/e2e.test.ts`.
#[test_only]
module example_consumer::oracle_tests {
    use bs_oracle::verify::{Self, ValueBatch, SviBatch};
    use example_consumer::oracle::{Self, ExampleOracle};
    use std::unit_test::assert_eq;
    use sui::{clock::{Self, Clock}, test_scenario::{Self as ts, return_shared}};

    const ADMIN: address = @0xAD;

    // A full-width hash-like sid — exceeds u32::MAX and u64::MAX, so the storage/replay
    // tests prove `Table<u256, ...>` keys preserve the high bits.
    const SID_A: u256 = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;
    const SID_B: u256 = 11;
    const SVI_SID: u256 = 12;

    // Per-update market-data times; TS2 > TS1 for the monotonic case.
    const TS1: u64 = 1_000_000;
    const TS2: u64 = 2_000_000;
    const CLOCK_TS_MS: u64 = 10_000_000;

    // Batch send times, distinct from every per-update time above so a test asserting
    // one can't pass by accidentally reading the other.
    const BATCH_TS1: u64 = 9_980_000;
    const BATCH_TS2: u64 = 9_990_000;

    const VALUE_A: u128 = 65_000_000_000_000;
    const VALUE_B: u128 = 65_250_000_000_000;
    const SVI_A: u128 = 40_000_000;
    const SVI_B: u128 = 100_000_000;
    const SVI_SIGMA: u128 = 200_000_000;
    const SVI_RHO_MAG: u128 = 700_000_000;
    const SVI_M_MAG: u128 = 0;

    fun value_batch(timestamp: u64, v: u128): ValueBatch {
        batch_at(BATCH_TS1, timestamp, v)
    }

    fun batch_at(batch_timestamp: u64, timestamp: u64, v: u128): ValueBatch {
        verify::new_value_batch_for_testing(
            batch_timestamp,
            vector[verify::new_value_update_for_testing(SID_A, timestamp, v)],
        )
    }

    fun svi_batch(timestamp: u64): SviBatch {
        svi_batch_for_sid(timestamp, SVI_SID)
    }

    fun setup(scenario: &mut ts::Scenario): (ExampleOracle, Clock) {
        oracle::init_for_testing(scenario.ctx());
        scenario.next_tx(ADMIN);
        let oracle = scenario.take_shared<ExampleOracle>();
        let mut clk = clock::create_for_testing(scenario.ctx());
        clk.set_for_testing(CLOCK_TS_MS);
        (oracle, clk)
    }

    fun teardown(oracle: ExampleOracle, clk: Clock) {
        clk.destroy_for_testing();
        return_shared(oracle);
    }

    #[test]
    fun full_flow_value() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);

        assert!(oracle::has_value(&oracle, SID_A));
        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun full_flow_svi() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_svi_batch(&mut oracle, svi_batch(TS1), &clk);

        let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = oracle::svi_params(&oracle, SVI_SID);
        assert_eq!(a_mag, SVI_A);
        assert!(!a_neg);
        assert_eq!(b, SVI_B);
        assert_eq!(sigma, SVI_SIGMA);
        assert_eq!(rho_mag, SVI_RHO_MAG);
        assert!(rho_neg);
        assert_eq!(m_mag, SVI_M_MAG);
        assert!(!m_neg);
        assert_eq!(oracle::last_timestamp(&oracle, SVI_SID), TS1);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun multi_value_batch_updates_every_sid_with_its_own_timestamp() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        let batch = verify::new_value_batch_for_testing(
            BATCH_TS1,
            vector[
                verify::new_value_update_for_testing(SID_A, TS1, VALUE_A),
                verify::new_value_update_for_testing(SID_B, TS2, VALUE_B),
            ],
        );
        oracle::ingest_value_batch(&mut oracle, batch, &clk);

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::value(&oracle, SID_B), VALUE_B);
        // Each sid records the timestamp of its own update.
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);
        assert_eq!(oracle::last_timestamp(&oracle, SID_B), TS2);

        teardown(oracle, clk);
        scenario.end();
    }

    /// A series re-sent pinned to its original timestamp must not stop the other
    /// series in the same batch from landing.
    #[test]
    fun stale_sid_is_skipped_without_blocking_the_rest_of_the_batch() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(
            &mut oracle,
            verify::new_value_batch_for_testing(
                BATCH_TS1,
                vector[
                    verify::new_value_update_for_testing(SID_A, TS1, VALUE_A),
                    verify::new_value_update_for_testing(SID_B, TS1, VALUE_A),
                ],
            ),
            &clk,
        );

        // SID_A is pinned (same TS1, data hasn't moved); SID_B advances to TS2.
        oracle::ingest_value_batch(
            &mut oracle,
            verify::new_value_batch_for_testing(
                BATCH_TS2,
                vector[
                    verify::new_value_update_for_testing(SID_A, TS1, VALUE_B),
                    verify::new_value_update_for_testing(SID_B, TS2, VALUE_B),
                ],
            ),
            &clk,
        );

        // SID_A kept its original value and timestamp: the pinned update was a no-op.
        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);
        // SID_B landed regardless.
        assert_eq!(oracle::value(&oracle, SID_B), VALUE_B);
        assert_eq!(oracle::last_timestamp(&oracle, SID_B), TS2);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun monotonic_timestamp_accepts() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS2, VALUE_A), &clk);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS2);

        teardown(oracle, clk);
        scenario.end();
    }

    /// The point of carrying a batch timestamp alongside the per-update ones: when a
    /// feed goes quiet, every update is skipped by the replay guard and no `sid`
    /// advances — but the batch timestamp still moves, so a consumer can tell the
    /// publisher is running rather than dead.
    #[test]
    fun batch_timestamp_advances_even_when_every_update_is_skipped() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, batch_at(BATCH_TS1, TS1, VALUE_A), &clk);
        assert_eq!(oracle::last_batch_timestamp(&oracle), BATCH_TS1);

        // Same TS1: the series has not moved, so the update is skipped.
        oracle::ingest_value_batch(&mut oracle, batch_at(BATCH_TS2, TS1, VALUE_B), &clk);

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);
        // ...but the batch itself is visibly newer.
        assert_eq!(oracle::last_batch_timestamp(&oracle), BATCH_TS2);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun older_batch_timestamp_does_not_regress_liveness() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, batch_at(BATCH_TS2, TS1, VALUE_A), &clk);
        assert_eq!(oracle::last_batch_timestamp(&oracle), BATCH_TS2);

        oracle::ingest_value_batch(&mut oracle, batch_at(BATCH_TS1, TS2, VALUE_B), &clk);

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_B);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS2);
        assert_eq!(oracle::last_batch_timestamp(&oracle), BATCH_TS2);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun skips_replayed_timestamp() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);
        // Not strictly greater -> skipped, and the new value is discarded with it:
        // a pinned timestamp means the series has not advanced.
        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_B), &clk);

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test, expected_failure(abort_code = oracle::EZeroValue)]
    fun rejects_zero_value() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, 0), &clk);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test, expected_failure(abort_code = oracle::EBatchTimestampTooFarInFuture)]
    fun rejects_value_batch_timestamp_too_far_in_future() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(
            &mut oracle,
            batch_at(CLOCK_TS_MS + 5_001, TS1, VALUE_A),
            &clk,
        );

        teardown(oracle, clk);
        scenario.end();
    }

    #[test, expected_failure(abort_code = oracle::EBatchTimestampTooOld)]
    fun rejects_stale_svi_batch_timestamp() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);
        let batch = verify::new_svi_batch_for_testing(
            CLOCK_TS_MS - 60_001,
            vector[
                verify::new_svi_for_testing(
                    SVI_SID,
                    TS1,
                    SVI_A,
                    false,
                    SVI_B,
                    SVI_SIGMA,
                    SVI_RHO_MAG,
                    true,
                    SVI_M_MAG,
                    false,
                ),
            ],
        );

        oracle::ingest_svi_batch(&mut oracle, batch, &clk);

        teardown(oracle, clk);
        scenario.end();
    }

    fun svi_batch_for_sid(timestamp: u64, sid: u256): SviBatch {
        verify::new_svi_batch_for_testing(
            BATCH_TS1,
            vector[
                verify::new_svi_for_testing(
                    sid,
                    timestamp,
                    SVI_A,
                    false,
                    SVI_B,
                    SVI_SIGMA,
                    SVI_RHO_MAG,
                    true,
                    SVI_M_MAG,
                    false,
                ),
            ],
        )
    }

    #[test]
    fun skips_value_then_svi_same_sid_same_timestamp() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);
        // Same sid and timestamp as the value update above: the replay guard spans
        // both categories, so this is skipped despite being a different feed type.
        oracle::ingest_svi_batch(&mut oracle, svi_batch_for_sid(TS1, SID_A), &clk);

        assert!(!oracle::has_svi(&oracle, SID_A));
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun accepts_value_then_svi_same_sid_later_timestamp() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);
        oracle::ingest_svi_batch(&mut oracle, svi_batch_for_sid(TS2, SID_A), &clk);

        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS2);

        teardown(oracle, clk);
        scenario.end();
    }
}
