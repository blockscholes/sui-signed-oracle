// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Example Predict consumer. Consumes a verified `ValueBatch` / `SviBatch` (or their
/// "absolute" counterparts) by value (it trusts the type — only `bs_oracle::verify` can
/// mint one), does NO crypto, enforces per-`sid` replay (an update's `timestamp` must be
/// strictly greater than the `sid`'s stored timestamp, otherwise that update is skipped),
/// and stores the latest value per `sid`, unpacking each verified update into this
/// module's own `RawSvi` on the way in. This consumer defines the batch timestamp as
/// milliseconds and rejects envelopes that are too old or too far ahead of Sui's
/// `Clock`. Per-update timestamp precision and freshness remain part of each configured
/// feed's consumer policy. The "absolute" batches carry no per-update timestamp, so
/// their replay guard uses the batch's own `timestamp` for every update instead.
///
/// The greatest accepted batch `timestamp` is recorded separately as `last_batch_ts`,
/// so a feed whose series have all gone quiet is still visibly running without an
/// out-of-order envelope regressing liveness. The real Predict consumer maps each `sid`
/// to its `{type, expiry, underlying}` and rebuilds deepbookv3's typed update.
module example_consumer::oracle {
    use bs_oracle::verify::{ValueBatch, SviBatch, ValueAbsoluteBatch, SviAbsoluteBatch};
    use sui::{clock::Clock, event, table::{Self, Table}};

    const EZeroValue: u64 = 1;
    const EBatchTimestampTooOld: u64 = 2;
    const EBatchTimestampTooFarInFuture: u64 = 3;

    const MAX_BATCH_AGE_MS: u64 = 60_000;
    const MAX_BATCH_FUTURE_SKEW_MS: u64 = 5_000;

    /// Emitted only for applied updates, so it means "this `sid` advanced".
    public struct OracleUpdated has copy, drop {
        sid: u256,
        timestamp: u64,
        update_ts_ms: u64,
    }

    /// Emitted once per ingested batch, whether or not any update applied — the
    /// batch `timestamp` advances every flush, so this is the "feed is still
    /// running" signal when `applied` is 0 because nothing moved.
    public struct BatchIngested has copy, drop {
        batch_timestamp: u64,
        update_count: u64,
        applied: u64,
        update_ts_ms: u64,
    }

    /// This module's storage form for an SVI parameter set, decoded from the
    /// non-storable `bs_oracle::verify::SviUpdate`.
    public struct RawSvi has copy, drop, store {
        svi_a_magnitude: u128,
        svi_a_is_negative: bool,
        svi_b: u128,
        svi_sigma: u128,
        svi_rho_magnitude: u128,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u128,
        svi_m_is_negative: bool,
    }

    /// Latest value (spot or forward price) per `sid`, latest SVI per `sid`, the
    /// last-accepted update `timestamp` per `sid` (replay guard spans both categories),
    /// and the greatest accepted batch `timestamp` (feed liveness — advances even when
    /// every update in a newer batch was skipped).
    public struct ExampleOracle has key {
        id: UID,
        values: Table<u256, u128>,
        svis: Table<u256, RawSvi>,
        last_ts: Table<u256, u64>,
        last_batch_ts: u64,
    }

    fun init(ctx: &mut TxContext) {
        transfer::share_object(ExampleOracle {
            id: object::new(ctx),
            values: table::new(ctx),
            svis: table::new(ctx),
            last_ts: table::new(ctx),
            last_batch_ts: 0,
        });
    }

    /// Ingest a verified value batch (today: spot or forward price).
    public fun ingest_value_batch(oracle: &mut ExampleOracle, batch: ValueBatch, clock: &Clock) {
        let batch_timestamp = batch.value_batch_timestamp();
        let update_ts_ms = clock.timestamp_ms();
        validate_batch_timestamp(batch_timestamp, update_ts_ms);
        let updates = batch.into_value_updates();
        record_batch_timestamp(oracle, batch_timestamp);

        let n = updates.length();
        let mut applied = 0;
        let mut i = 0;
        while (i < n) {
            let u = &updates[i];
            let sid = u.value_sid();
            let timestamp = u.value_timestamp();
            i = i + 1;
            if (!replay_guard(oracle, sid, timestamp)) continue;
            let v = u.value_v();
            assert!(v > 0, EZeroValue);
            upsert(&mut oracle.values, sid, v);
            applied = applied + 1;
            event::emit(OracleUpdated { sid, timestamp, update_ts_ms });
        };
        event::emit(BatchIngested { batch_timestamp, update_count: n, applied, update_ts_ms });
    }

    /// Ingest a verified SVI batch.
    public fun ingest_svi_batch(oracle: &mut ExampleOracle, batch: SviBatch, clock: &Clock) {
        let batch_timestamp = batch.svi_batch_timestamp();
        let update_ts_ms = clock.timestamp_ms();
        validate_batch_timestamp(batch_timestamp, update_ts_ms);
        let updates = batch.into_svi_updates();
        record_batch_timestamp(oracle, batch_timestamp);

        let n = updates.length();
        let mut applied = 0;
        let mut i = 0;
        while (i < n) {
            let u = &updates[i];
            let sid = u.svi_sid();
            let timestamp = u.svi_timestamp();
            i = i + 1;
            if (!replay_guard(oracle, sid, timestamp)) continue;
            let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = u.svi_fields();
            upsert(
                &mut oracle.svis,
                sid,
                RawSvi {
                    svi_a_magnitude: a_mag,
                    svi_a_is_negative: a_neg,
                    svi_b: b,
                    svi_sigma: sigma,
                    svi_rho_magnitude: rho_mag,
                    svi_rho_is_negative: rho_neg,
                    svi_m_magnitude: m_mag,
                    svi_m_is_negative: m_neg,
                },
            );
            applied = applied + 1;
            event::emit(OracleUpdated { sid, timestamp, update_ts_ms });
        };
        event::emit(BatchIngested { batch_timestamp, update_count: n, applied, update_ts_ms });
    }

    /// Ingest a verified value-absolute batch. There is no per-update timestamp, so
    /// every update in the batch replays against the batch's own `timestamp`.
    public fun ingest_value_absolute_batch(oracle: &mut ExampleOracle, batch: ValueAbsoluteBatch, clock: &Clock) {
        let batch_timestamp = batch.value_absolute_batch_timestamp();
        let update_ts_ms = clock.timestamp_ms();
        validate_batch_timestamp(batch_timestamp, update_ts_ms);
        let updates = batch.into_value_absolute_updates();
        record_batch_timestamp(oracle, batch_timestamp);

        let n = updates.length();
        let mut applied = 0;
        let mut i = 0;
        while (i < n) {
            let u = &updates[i];
            let sid = u.value_absolute_sid();
            i = i + 1;
            if (!replay_guard(oracle, sid, batch_timestamp)) continue;
            let v = u.value_absolute_v();
            assert!(v > 0, EZeroValue);
            upsert(&mut oracle.values, sid, v);
            applied = applied + 1;
            event::emit(OracleUpdated { sid, timestamp: batch_timestamp, update_ts_ms });
        };
        event::emit(BatchIngested { batch_timestamp, update_count: n, applied, update_ts_ms });
    }

    /// Ingest a verified SVI-absolute batch (see `ingest_value_absolute_batch` for the
    /// batch-timestamp-as-replay-key rationale).
    public fun ingest_svi_absolute_batch(oracle: &mut ExampleOracle, batch: SviAbsoluteBatch, clock: &Clock) {
        let batch_timestamp = batch.svi_absolute_batch_timestamp();
        let update_ts_ms = clock.timestamp_ms();
        validate_batch_timestamp(batch_timestamp, update_ts_ms);
        let updates = batch.into_svi_absolute_updates();
        record_batch_timestamp(oracle, batch_timestamp);

        let n = updates.length();
        let mut applied = 0;
        let mut i = 0;
        while (i < n) {
            let u = &updates[i];
            let sid = u.svi_absolute_sid();
            i = i + 1;
            if (!replay_guard(oracle, sid, batch_timestamp)) continue;
            let (a_mag, a_neg, b, sigma, rho_mag, rho_neg, m_mag, m_neg) = u.svi_absolute_fields();
            upsert(
                &mut oracle.svis,
                sid,
                RawSvi {
                    svi_a_magnitude: a_mag,
                    svi_a_is_negative: a_neg,
                    svi_b: b,
                    svi_sigma: sigma,
                    svi_rho_magnitude: rho_mag,
                    svi_rho_is_negative: rho_neg,
                    svi_m_magnitude: m_mag,
                    svi_m_is_negative: m_neg,
                },
            );
            applied = applied + 1;
            event::emit(OracleUpdated { sid, timestamp: batch_timestamp, update_ts_ms });
        };
        event::emit(BatchIngested { batch_timestamp, update_count: n, applied, update_ts_ms });
    }

    // === Reads ===

    public fun has_value(oracle: &ExampleOracle, sid: u256): bool { oracle.values.contains(sid) }

    public fun has_svi(oracle: &ExampleOracle, sid: u256): bool { oracle.svis.contains(sid) }

    /// Latest value for `sid` (today: spot or forward price).
    public fun value(oracle: &ExampleOracle, sid: u256): u128 { oracle.values[sid] }

    public fun last_timestamp(oracle: &ExampleOracle, sid: u256): u64 { oracle.last_ts[sid] }

    /// Greatest accepted batch `timestamp`, regardless of whether any updates in that
    /// batch applied — the feed-liveness read.
    public fun last_batch_timestamp(oracle: &ExampleOracle): u64 { oracle.last_batch_ts }

    /// `(svi_a_magnitude, svi_a_is_negative, svi_b, svi_sigma, svi_rho_magnitude, svi_rho_is_negative, svi_m_magnitude, svi_m_is_negative)`.
    public fun svi_params(oracle: &ExampleOracle, sid: u256): (u128, bool, u128, u128, u128, bool, u128, bool) {
        let p = &oracle.svis[sid];
        (
            p.svi_a_magnitude,
            p.svi_a_is_negative,
            p.svi_b,
            p.svi_sigma,
            p.svi_rho_magnitude,
            p.svi_rho_is_negative,
            p.svi_m_magnitude,
            p.svi_m_is_negative,
        )
    }

    // === Private ===

    /// Enforce this consumer's millisecond envelope policy before treating a batch
    /// timestamp as evidence of publisher liveness.
    fun validate_batch_timestamp(batch_timestamp_ms: u64, now_ms: u64) {
        if (batch_timestamp_ms > now_ms) {
            assert!(batch_timestamp_ms - now_ms <= MAX_BATCH_FUTURE_SKEW_MS, EBatchTimestampTooFarInFuture);
        } else {
            assert!(now_ms - batch_timestamp_ms <= MAX_BATCH_AGE_MS, EBatchTimestampTooOld);
        };
    }

    fun record_batch_timestamp(oracle: &mut ExampleOracle, batch_timestamp: u64) {
        if (batch_timestamp > oracle.last_batch_ts) {
            oracle.last_batch_ts = batch_timestamp;
        };
    }

    /// Per-`sid` timestamp guard; returns whether to apply the update.
    ///
    /// A non-advancing timestamp signals that the series' source data has not moved,
    /// and the publisher re-sends it pinned so the chain keeps updating. Skipping it
    /// keeps one pinned series from stalling the whole batch.
    fun replay_guard(oracle: &mut ExampleOracle, sid: u256, timestamp: u64): bool {
        if (oracle.last_ts.contains(sid)) {
            if (timestamp <= oracle.last_ts[sid]) return false;
            *oracle.last_ts.borrow_mut(sid) = timestamp;
        } else {
            oracle.last_ts.add(sid, timestamp);
        };
        true
    }

    fun upsert<V: store + drop>(t: &mut Table<u256, V>, sid: u256, v: V) {
        if (t.contains(sid)) {
            *t.borrow_mut(sid) = v;
        } else {
            t.add(sid, v);
        };
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

    /// `(batch_timestamp, update_count, applied)` — the liveness/coverage fields
    /// tests need off an emitted `BatchIngested`.
    #[test_only]
    public fun batch_ingested_for_testing(e: &BatchIngested): (u64, u64, u64) {
        (e.batch_timestamp, e.update_count, e.applied)
    }
}
