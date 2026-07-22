// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Example Predict consumer. Consumes a verified `ValueBatch` / `SviBatch` by value
/// (it trusts the type — only `bs_oracle::verify` can mint one, and the verifier has
/// already enforced freshness on each update's `timestamp`), does NO crypto, enforces
/// per-`sid` replay (an update's `timestamp` must be strictly greater than the `sid`'s
/// stored timestamp, otherwise that update is skipped), and stores the latest value
/// per `sid`, unpacking each verified update into this module's own `RawSvi` on the way
/// in. The real Predict consumer maps each `sid` to its `{type, expiry, underlying}` and
/// rebuilds deepbookv3's typed update.
module example_consumer::oracle {
    use bs_oracle::verify::{ValueBatch, SviBatch};
    use sui::{clock::Clock, event, table::{Self, Table}};

    const EZeroValue: u64 = 1;

    /// Emitted only for applied updates, so it means "this `sid` advanced".
    public struct OracleUpdated has copy, drop {
        sid: u256,
        timestamp: u64,
        update_ts_ms: u64,
    }

    /// This module's storage form for an SVI parameter set, decoded from the
    /// non-storable `bs_oracle::verify::SviUpdate`.
    public struct RawSvi has copy, drop, store {
        svi_a_magnitude: u64,
        svi_a_is_negative: bool,
        svi_b: u64,
        svi_sigma: u64,
        svi_rho_magnitude: u64,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u64,
        svi_m_is_negative: bool,
    }

    /// Latest value (spot or forward price) per `sid`, latest SVI per `sid`, and the
    /// last-accepted update `timestamp` per `sid` (replay guard spans both categories).
    public struct ExampleOracle has key {
        id: UID,
        values: Table<u256, u64>,
        svis: Table<u256, RawSvi>,
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
        let updates = batch.into_value_updates();
        let update_ts_ms = clock.timestamp_ms();

        let n = updates.length();
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
            event::emit(OracleUpdated { sid, timestamp, update_ts_ms });
        };
    }

    /// Ingest a verified SVI batch.
    public fun ingest_svi_batch(oracle: &mut ExampleOracle, batch: SviBatch, clock: &Clock) {
        let updates = batch.into_svi_updates();
        let update_ts_ms = clock.timestamp_ms();

        let n = updates.length();
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
            event::emit(OracleUpdated { sid, timestamp, update_ts_ms });
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
}
