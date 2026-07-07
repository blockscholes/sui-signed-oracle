// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Example Predict consumer. Consumes a verified `ValueBatch` / `SviBatch` by value
/// (it trusts the type — only `bs_oracle::verify` can mint one, and the verifier has
/// already enforced freshness on `timestamp`), does NO crypto, enforces per-`sid`
/// replay (the batch `timestamp` must be strictly greater than the `sid`'s stored
/// timestamp), and stores the latest value per `sid`. The real Predict consumer maps
/// each `sid` to its `{type, expiry, underlying}` and rebuilds deepbookv3's typed
/// update; this example just keeps the verified numbers.
module example_consumer::oracle {
    use bs_oracle::verify::{ValueBatch, SviBatch, SviUpdate};
    use sui::{clock::Clock, event, table::{Self, Table}};

    const EZeroValue: u64 = 1;
    const EReplayOrStale: u64 = 2;

    public struct OracleUpdated has copy, drop {
        sid: u256,
        timestamp: u64,
        update_ts_ms: u64,
    }

    /// Latest value (spot or forward price) per `sid`, latest SVI per `sid`, and the
    /// last-accepted batch `timestamp` per `sid` (replay guard spans both categories).
    public struct ExampleOracle has key {
        id: UID,
        values: Table<u256, u64>,
        svis: Table<u256, SviUpdate>,
        last_ts: Table<u256, u64>,
    }

    fun init(ctx: &mut TxContext) {
        transfer::share_object(ExampleOracle {
            id: object::new(ctx),
            values: table::new(ctx),
            svis: table::new(ctx),
            last_ts: table::new(ctx),
        });
    }

    /// Ingest a verified value batch (today: spot or forward price).
    public fun ingest_value_batch(oracle: &mut ExampleOracle, batch: ValueBatch, clock: &Clock) {
        let (timestamp, updates) = batch.into_value_batch_parts();
        let update_ts_ms = clock.timestamp_ms();

        let n = updates.length();
        let mut i = 0;
        while (i < n) {
            let u = &updates[i];
            let sid = u.value_sid();
            let v = u.value_v();
            assert!(v > 0, EZeroValue);
            replay_guard(oracle, sid, timestamp);
            upsert(&mut oracle.values, sid, v);
            event::emit(OracleUpdated { sid, timestamp, update_ts_ms });
            i = i + 1;
        };
    }

    /// Ingest a verified SVI batch.
    public fun ingest_svi_batch(oracle: &mut ExampleOracle, batch: SviBatch, clock: &Clock) {
        let (timestamp, updates) = batch.into_svi_batch_parts();
        let update_ts_ms = clock.timestamp_ms();

        let n = updates.length();
        let mut i = 0;
        while (i < n) {
            let u = &updates[i];
            let sid = u.svi_sid();
            replay_guard(oracle, sid, timestamp);
            upsert(&mut oracle.svis, sid, *u);
            event::emit(OracleUpdated { sid, timestamp, update_ts_ms });
            i = i + 1;
        };
    }

    // === Reads ===

    public fun has_value(oracle: &ExampleOracle, sid: u256): bool { oracle.values.contains(sid) }

    public fun has_svi(oracle: &ExampleOracle, sid: u256): bool { oracle.svis.contains(sid) }

    /// Latest value for `sid` (today: spot or forward price).
    public fun value(oracle: &ExampleOracle, sid: u256): u64 { oracle.values[sid] }

    public fun last_timestamp(oracle: &ExampleOracle, sid: u256): u64 { oracle.last_ts[sid] }

    /// `(svi_a_magnitude, svi_a_is_negative, svi_b, svi_sigma, svi_rho_magnitude, svi_rho_is_negative, svi_m_magnitude, svi_m_is_negative)`.
    public fun svi_params(oracle: &ExampleOracle, sid: u256): (u64, bool, u64, u64, u64, bool, u64, bool) {
        oracle.svis[sid].svi_fields()
    }

    // === Private ===

    /// Strictly-monotonic per-`sid` timestamp guard, recorded once per update.
    fun replay_guard(oracle: &mut ExampleOracle, sid: u256, timestamp: u64) {
        if (oracle.last_ts.contains(sid)) {
            assert!(timestamp > oracle.last_ts[sid], EReplayOrStale);
            *oracle.last_ts.borrow_mut(sid) = timestamp;
        } else {
            oracle.last_ts.add(sid, timestamp);
        };
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
}
