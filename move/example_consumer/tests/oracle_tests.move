// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Unit tests for the consumer ingest paths. Batches are built via the
/// `#[test_only]` constructors (no signing); the real signature path is covered
/// by the live-signed localnet e2e in `ts/src/e2e.test.ts`.
#[test_only]
module example_consumer::oracle_tests {
    use bs_oracle::verify::{Self, ValueBatch, SviBatch, ValueAbsoluteBatch, SviAbsoluteBatch};
    use example_consumer::oracle::{Self, ExampleOracle, BatchIngested};
    use std::unit_test::assert_eq;
    use sui::{clock::{Self, Clock}, event, test_scenario::{Self as ts, return_shared}};

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
    fun full_flow_value_absolute() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        let batch: ValueAbsoluteBatch = verify::new_value_absolute_batch_for_testing(
            BATCH_TS1,
            vector[verify::new_value_absolute_update_for_testing(SID_A, VALUE_A)],
        );
        oracle::ingest_value_absolute_batch(&mut oracle, batch, &clk);

        assert!(oracle::has_value(&oracle, SID_A));
        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        // No per-update timestamp: the batch's own timestamp is the replay key.
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), BATCH_TS1);

        teardown(oracle, clk);
        scenario.end();
    }

    #[test]
    fun full_flow_svi_absolute() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        let batch: SviAbsoluteBatch = verify::new_svi_absolute_batch_for_testing(
            BATCH_TS1,
            vector[
                verify::new_svi_absolute_for_testing(
                    SVI_SID,
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
        oracle::ingest_svi_absolute_batch(&mut oracle, batch, &clk);

        let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = oracle::svi_params(&oracle, SVI_SID);
        assert_eq!(a_mag, SVI_A);
        assert!(!a_neg);
        assert_eq!(b, SVI_B);
        assert_eq!(sigma, SVI_SIGMA);
        assert_eq!(rho_mag, SVI_RHO_MAG);
        assert!(rho_neg);
        assert_eq!(m_mag, SVI_M_MAG);
        assert!(!m_neg);
        assert_eq!(oracle::last_timestamp(&oracle, SVI_SID), BATCH_TS1);

        teardown(oracle, clk);
        scenario.end();
    }

    /// Every update in an absolute batch shares the same replay key (the batch
    /// timestamp), so a re-sent batch with an unchanged timestamp is a no-op for all
    /// of its sids at once — there's no per-sid pinning like the non-absolute path.
    #[test]
    fun multi_value_absolute_batch_replays_against_the_shared_batch_timestamp() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_absolute_batch(
            &mut oracle,
            verify::new_value_absolute_batch_for_testing(
                BATCH_TS1,
                vector[
                    verify::new_value_absolute_update_for_testing(SID_A, VALUE_A),
                    verify::new_value_absolute_update_for_testing(SID_B, VALUE_A),
                ],
            ),
            &clk,
        );

        // Same batch timestamp again, different values -> both sids skipped.
        oracle::ingest_value_absolute_batch(
            &mut oracle,
            verify::new_value_absolute_batch_for_testing(
                BATCH_TS1,
                vector[
                    verify::new_value_absolute_update_for_testing(SID_A, VALUE_B),
                    verify::new_value_absolute_update_for_testing(SID_B, VALUE_B),
                ],
            ),
            &clk,
        );
        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::value(&oracle, SID_B), VALUE_A);

        // A strictly newer batch timestamp advances every sid.
        oracle::ingest_value_absolute_batch(
            &mut oracle,
            verify::new_value_absolute_batch_for_testing(
                BATCH_TS2,
                vector[
                    verify::new_value_absolute_update_for_testing(SID_A, VALUE_B),
                    verify::new_value_absolute_update_for_testing(SID_B, VALUE_B),
                ],
            ),
            &clk,
        );
        assert_eq!(oracle::value(&oracle, SID_A), VALUE_B);
        assert_eq!(oracle::value(&oracle, SID_B), VALUE_B);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), BATCH_TS2);
        assert_eq!(oracle::last_timestamp(&oracle, SID_B), BATCH_TS2);

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

        // The second batch's BatchIngested event is the observable proof of the skip:
        // the batch carried one update, but none of them applied.
        let events = event::events_by_type<BatchIngested>();
        let (last_batch_timestamp, last_update_count, last_applied) = oracle::batch_ingested_for_testing(
            &events[events.length() - 1],
        );
        assert_eq!(last_batch_timestamp, BATCH_TS2);
        assert_eq!(last_update_count, 1);
        assert_eq!(last_applied, 0);

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

        // The second batch's own update fully applied, even though its (older) batch
        // timestamp did not move liveness forward.
        let events = event::events_by_type<BatchIngested>();
        let (last_batch_timestamp, last_update_count, last_applied) = oracle::batch_ingested_for_testing(
            &events[events.length() - 1],
        );
        assert_eq!(last_batch_timestamp, BATCH_TS1);
        assert_eq!(last_update_count, 1);
        assert_eq!(last_applied, 1);

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

    /// A `sid`'s per-update `timestamp` (its own `timestamp_precision`) and the
    /// absolute batch's envelope `timestamp` (always ms) are not comparable units.
    /// Once a normal batch has pinned a `sid`, a later absolute batch for the same
    /// `sid` must be skipped outright rather than compared against `last_ts`.
    #[test]
    fun absolute_update_is_skipped_after_sid_is_pinned_to_normal() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);
        assert!(!oracle::is_pinned_absolute(&oracle, SID_A));

        // A batch timestamp far larger than TS1 would (wrongly) look newer under a
        // naive direct comparison; the format pin must reject it regardless.
        oracle::ingest_value_absolute_batch(
            &mut oracle,
            verify::new_value_absolute_batch_for_testing(
                BATCH_TS1,
                vector[verify::new_value_absolute_update_for_testing(SID_A, VALUE_B)],
            ),
            &clk,
        );

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), TS1);
        assert!(!oracle::is_pinned_absolute(&oracle, SID_A));

        teardown(oracle, clk);
        scenario.end();
    }

    /// Symmetric case: once an absolute batch has pinned a `sid`, a later normal
    /// update for the same `sid` must be skipped, not compared against `last_ts`.
    #[test]
    fun normal_update_is_skipped_after_sid_is_pinned_to_absolute() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_absolute_batch(
            &mut oracle,
            verify::new_value_absolute_batch_for_testing(
                BATCH_TS1,
                vector[verify::new_value_absolute_update_for_testing(SID_A, VALUE_A)],
            ),
            &clk,
        );
        assert!(oracle::is_pinned_absolute(&oracle, SID_A));

        // A per-update timestamp strictly greater than BATCH_TS1 would (wrongly) pass
        // replay_guard on its own; the format pin must reject it before that check runs.
        oracle::ingest_value_batch(&mut oracle, value_batch(BATCH_TS1 + 1, VALUE_B), &clk);

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::last_timestamp(&oracle, SID_A), BATCH_TS1);
        assert!(oracle::is_pinned_absolute(&oracle, SID_A));

        teardown(oracle, clk);
        scenario.end();
    }

    /// The format pin is per-`sid`, not global: a different `sid` in the same batch
    /// is unaffected by another `sid`'s pinned format.
    #[test]
    fun format_pin_does_not_block_other_sids_in_the_same_batch() {
        let mut scenario = ts::begin(ADMIN);
        let (mut oracle, clk) = setup(&mut scenario);

        oracle::ingest_value_batch(&mut oracle, value_batch(TS1, VALUE_A), &clk);

        oracle::ingest_value_absolute_batch(
            &mut oracle,
            verify::new_value_absolute_batch_for_testing(
                BATCH_TS1,
                vector[
                    // SID_A is pinned to normal, so this entry is skipped...
                    verify::new_value_absolute_update_for_testing(SID_A, VALUE_B),
                    // ...but SID_B has never been written, so it applies.
                    verify::new_value_absolute_update_for_testing(SID_B, VALUE_B),
                ],
            ),
            &clk,
        );

        assert_eq!(oracle::value(&oracle, SID_A), VALUE_A);
        assert_eq!(oracle::value(&oracle, SID_B), VALUE_B);
        assert!(oracle::is_pinned_absolute(&oracle, SID_B));

        teardown(oracle, clk);
        scenario.end();
    }
}
