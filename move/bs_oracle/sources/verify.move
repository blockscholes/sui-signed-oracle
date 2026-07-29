// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Verifies a Block Scholes-signed batch and mints a gated batch struct.
///
/// A batch is homogeneous by category, so there are four entry points: two carry a
/// per-update `timestamp` — `verify_and_create_value_batch` (`{sid, timestamp, v}` —
/// spot or forward) and `verify_and_create_svi_batch` (SVI parameter sets) — and two
/// "absolute" variants drop the per-update `timestamp` and rely on the batch's own
/// timestamp alone — `verify_and_create_value_absolute_batch` and
/// `verify_and_create_svi_absolute_batch`. The signed `batch_kind` byte binds the
/// category so an untrusted relayer can't cross-feed one to another.
/// Replay/monotonicity is the consumer's job (it owns per-feed state).
///
/// Wire message: `signature (65) || payload`, where `payload` BCS = envelope
/// (batch_kind: u8, timestamp: u64) + the category's `updates`. The signature
/// covers this package's runtime address (via `type_name::original_id`, not a
/// compile-time literal) prepended to `payload` — a domain separator so
/// signatures don't verify across package versions despite a shared signer key
/// (see `verify_header`). Values are `u128`; SVI `a`/`rho`/`m` are magnitude +
/// `is_negative`. The fixed-point scale is the client's choice, agreed
/// off-chain with the signer — this package stores the integers as signed and
/// never scales them.
///
/// There are two timestamps, and they answer different questions. The envelope's
/// `timestamp` is when the publisher sent this batch, so it advances on every
/// flush and shows the feed is still running even when no series moved. Each
/// update's own `timestamp` is when that series' data is "as of", so a series
/// that hasn't moved is re-sent pinned to its original time. Both are in whatever
/// precision that client signs; interpreting them (and any freshness or replay
/// bound) is the consumer's job. The "absolute" batch variants (`ValueAbsoluteUpdate`/
/// `SviAbsoluteUpdate`) carry no per-update `timestamp` at all — every update in
/// that batch is as of the single envelope `timestamp`, so a consumer using them
/// forgoes per-`sid` "as of" precision in exchange for a smaller payload.
///
/// The batch is a hot potato, so holding one is proof of a valid signature. Its
/// updates are not `store`: consumers unpack them into their own types rather than
/// persist this package's types across independently published versions (design.md §5).
module bs_oracle::verify {
    use bs_oracle::registry::SignerRegistry;
    use std::type_name;
    use sui::{bcs::{Self, BCS}, ecdsa_k1, event};

    const SECP256K1_SIG_LEN: u64 = 65;
    /// `secp256k1_ecrecover` hash selector: 0 = keccak256.
    const KECCAK256: u8 = 0;
    const BATCH_VALUE: u8 = 0;
    const BATCH_SVI: u8 = 1;
    const BATCH_VALUE_ABSOLUTE: u8 = 2;
    const BATCH_SVI_ABSOLUTE: u8 = 3;

    const EBadMessageLength: u64 = 1;
    const EBadSigner: u64 = 2;
    const ETrailingPayloadData: u64 = 4;
    const EEmptyBatch: u64 = 5;
    const EBadBatchKind: u64 = 6;
    const EPaused: u64 = 7;

    /// Marker type used only to resolve this package's own runtime address
    /// (`type_name::original_id<PackageMarker>()`) — kept separate from the data
    /// structs so the domain separator doesn't depend on their shape.
    public struct PackageMarker has drop {}

    /// A single value `v` for series `sid` (today: spot or forward price — the `sid`
    /// identifies which), as of `timestamp`. The contract expiry is not carried; the
    /// consumer holds the `sid` mapping.
    public struct ValueUpdate has copy, drop {
        sid: u256,
        timestamp: u64,
        v: u128,
    }

    /// An SVI parameter set for series `sid`, as of `timestamp`. `a`/`rho`/`m` are
    /// signed (magnitude + sign); `b`/`sigma` are non-negative.
    public struct SviUpdate has copy, drop {
        sid: u256,
        timestamp: u64,
        svi_a_magnitude: u128,
        svi_a_is_negative: bool,
        svi_b: u128,
        svi_sigma: u128,
        svi_rho_magnitude: u128,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u128,
        svi_m_is_negative: bool,
    }

    /// A single value `v` for series `sid`, with no per-update `timestamp` — it is
    /// as of the enclosing batch's `timestamp` alone (see the module doc).
    public struct ValueAbsoluteUpdate has copy, drop {
        sid: u256,
        v: u128,
    }

    /// An SVI parameter set for series `sid`, with no per-update `timestamp` — it is
    /// as of the enclosing batch's `timestamp` alone. `a`/`rho`/`m` are signed
    /// (magnitude + sign); `b`/`sigma` are non-negative.
    public struct SviAbsoluteUpdate has copy, drop {
        sid: u256,
        svi_a_magnitude: u128,
        svi_a_is_negative: bool,
        svi_b: u128,
        svi_sigma: u128,
        svi_rho_magnitude: u128,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u128,
        svi_m_is_negative: bool,
    }

    /// A verified value batch. No abilities, so it must be consumed in the minting
    /// transaction and can only be created by `verify` — the on-chain proof of
    /// authenticity. `timestamp` is when the publisher sent the batch; each update
    /// additionally carries its own.
    public struct ValueBatch {
        timestamp: u64,
        updates: vector<ValueUpdate>,
    }

    /// A verified SVI batch (same gating as `ValueBatch`).
    public struct SviBatch {
        timestamp: u64,
        updates: vector<SviUpdate>,
    }

    /// A verified value batch whose updates carry no per-update timestamp (same
    /// gating as `ValueBatch`).
    public struct ValueAbsoluteBatch {
        timestamp: u64,
        updates: vector<ValueAbsoluteUpdate>,
    }

    /// A verified SVI batch whose updates carry no per-update timestamp (same
    /// gating as `ValueBatch`).
    public struct SviAbsoluteBatch {
        timestamp: u64,
        updates: vector<SviAbsoluteUpdate>,
    }

    public struct BatchVerified has copy, drop {
        batch_kind: u8,
        timestamp: u64,
        update_count: u64,
    }

    /// Verify a signed value batch and return the gated `ValueBatch`.
    public fun verify_and_create_value_batch(reg: &SignerRegistry, message: vector<u8>): ValueBatch {
        let (timestamp, mut p) = verify_header(reg, message, BATCH_VALUE);
        let updates = peel_value_updates(&mut p);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_VALUE, timestamp, update_count: updates.length() });
        ValueBatch { timestamp, updates }
    }

    /// Verify a signed SVI batch and return the gated `SviBatch`.
    public fun verify_and_create_svi_batch(reg: &SignerRegistry, message: vector<u8>): SviBatch {
        let (timestamp, mut p) = verify_header(reg, message, BATCH_SVI);
        let updates = peel_svi_updates(&mut p);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_SVI, timestamp, update_count: updates.length() });
        SviBatch { timestamp, updates }
    }

    /// Verify a signed value batch whose updates carry no per-update timestamp and
    /// return the gated `ValueAbsoluteBatch`.
    public fun verify_and_create_value_absolute_batch(reg: &SignerRegistry, message: vector<u8>): ValueAbsoluteBatch {
        let (timestamp, mut p) = verify_header(reg, message, BATCH_VALUE_ABSOLUTE);
        let updates = peel_value_absolute_updates(&mut p);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_VALUE_ABSOLUTE, timestamp, update_count: updates.length() });
        ValueAbsoluteBatch { timestamp, updates }
    }

    /// Verify a signed SVI batch whose updates carry no per-update timestamp and
    /// return the gated `SviAbsoluteBatch`.
    public fun verify_and_create_svi_absolute_batch(reg: &SignerRegistry, message: vector<u8>): SviAbsoluteBatch {
        let (timestamp, mut p) = verify_header(reg, message, BATCH_SVI_ABSOLUTE);
        let updates = peel_svi_absolute_updates(&mut p);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_SVI_ABSOLUTE, timestamp, update_count: updates.length() });
        SviAbsoluteBatch { timestamp, updates }
    }

    /// Split the signature, check the envelope (batch kind, address-prefixed
    /// signature), and return the batch `timestamp` with the decoder positioned at
    /// `updates`.
    fun verify_header(reg: &SignerRegistry, message: vector<u8>, expected_kind: u8): (u64, BCS) {
        assert!(!reg.is_paused(), EPaused);
        assert!(message.length() > SECP256K1_SIG_LEN, EBadMessageLength);

        let mut envelope = bcs::new(message);
        let signature = vector::tabulate!(SECP256K1_SIG_LEN, |_| envelope.peel_u8());
        let payload = envelope.into_remainder_bytes();

        // Decode the envelope from a copy; `payload` is kept for the signed-bytes
        // reconstruction below.
        let mut p = bcs::new(copy payload);
        let batch_kind = p.peel_u8();
        assert!(batch_kind == expected_kind, EBadBatchKind);
        let timestamp = p.peel_u64();

        // Prepend this package's runtime address (see module doc) — resolved via
        // type_name, not a compile-time `@bs_oracle` literal (stays `0x0`). Requires
        // each version to be independently published, never an in-place Sui upgrade
        // (design.md §5): `original_id` stays pinned across an upgrade lineage.
        let self_address = type_name::original_id<PackageMarker>();
        let mut signed_bytes = bcs::to_bytes(&self_address);
        signed_bytes.append(payload);
        let recovered = ecdsa_k1::secp256k1_ecrecover(&signature, &signed_bytes, KECCAK256);
        assert!(recovered == reg.signer_pubkey(), EBadSigner);

        (timestamp, p)
    }

    fun peel_value_updates(cur: &mut BCS): vector<ValueUpdate> {
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let timestamp = cur.peel_u64();
            let v = cur.peel_u128();
            updates.push_back(ValueUpdate { sid, timestamp, v });
            i = i + 1;
        };
        updates
    }

    fun peel_svi_updates(cur: &mut BCS): vector<SviUpdate> {
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let timestamp = cur.peel_u64();
            let svi_a_magnitude = cur.peel_u128();
            let svi_a_is_negative = cur.peel_bool();
            let svi_b = cur.peel_u128();
            let svi_sigma = cur.peel_u128();
            let svi_rho_magnitude = cur.peel_u128();
            let svi_rho_is_negative = cur.peel_bool();
            let svi_m_magnitude = cur.peel_u128();
            let svi_m_is_negative = cur.peel_bool();
            updates.push_back(SviUpdate {
                sid,
                timestamp,
                svi_a_magnitude,
                svi_a_is_negative,
                svi_b,
                svi_sigma,
                svi_rho_magnitude,
                svi_rho_is_negative,
                svi_m_magnitude,
                svi_m_is_negative,
            });
            i = i + 1;
        };
        updates
    }

    fun peel_value_absolute_updates(cur: &mut BCS): vector<ValueAbsoluteUpdate> {
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let v = cur.peel_u128();
            updates.push_back(ValueAbsoluteUpdate { sid, v });
            i = i + 1;
        };
        updates
    }

    fun peel_svi_absolute_updates(cur: &mut BCS): vector<SviAbsoluteUpdate> {
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let svi_a_magnitude = cur.peel_u128();
            let svi_a_is_negative = cur.peel_bool();
            let svi_b = cur.peel_u128();
            let svi_sigma = cur.peel_u128();
            let svi_rho_magnitude = cur.peel_u128();
            let svi_rho_is_negative = cur.peel_bool();
            let svi_m_magnitude = cur.peel_u128();
            let svi_m_is_negative = cur.peel_bool();
            updates.push_back(SviAbsoluteUpdate {
                sid,
                svi_a_magnitude,
                svi_a_is_negative,
                svi_b,
                svi_sigma,
                svi_rho_magnitude,
                svi_rho_is_negative,
                svi_m_magnitude,
                svi_m_is_negative,
            });
            i = i + 1;
        };
        updates
    }

    // === ValueBatch / ValueUpdate reads ===

    public fun value_sid(u: &ValueUpdate): u256 { u.sid }

    public fun value_timestamp(u: &ValueUpdate): u64 { u.timestamp }

    public fun value_v(u: &ValueUpdate): u128 { u.v }

    /// When the publisher sent this batch. Advances every flush, so a consumer can
    /// tell the feed is live even when every update is pinned. Read it before
    /// `into_value_updates` consumes the batch.
    public fun value_batch_timestamp(b: &ValueBatch): u64 { b.timestamp }

    /// Consume a `ValueBatch`, moving its updates out (no vector copy) for ingest.
    public fun into_value_updates(b: ValueBatch): vector<ValueUpdate> {
        let ValueBatch { timestamp: _, updates } = b;
        updates
    }

    // === SviBatch / SviUpdate reads ===

    public fun svi_sid(u: &SviUpdate): u256 { u.sid }

    public fun svi_timestamp(u: &SviUpdate): u64 { u.timestamp }

    /// `(svi_a_magnitude, svi_a_is_negative, svi_b, svi_sigma, svi_rho_magnitude, svi_rho_is_negative, svi_m_magnitude, svi_m_is_negative)`.
    public fun svi_fields(u: &SviUpdate): (u128, bool, u128, u128, u128, bool, u128, bool) {
        (
            u.svi_a_magnitude,
            u.svi_a_is_negative,
            u.svi_b,
            u.svi_sigma,
            u.svi_rho_magnitude,
            u.svi_rho_is_negative,
            u.svi_m_magnitude,
            u.svi_m_is_negative,
        )
    }

    /// When the publisher sent this batch (see `value_batch_timestamp`).
    public fun svi_batch_timestamp(b: &SviBatch): u64 { b.timestamp }

    /// Consume an `SviBatch`, moving its updates out (no vector copy) for ingest.
    public fun into_svi_updates(b: SviBatch): vector<SviUpdate> {
        let SviBatch { timestamp: _, updates } = b;
        updates
    }

    // === ValueAbsoluteBatch / ValueAbsoluteUpdate reads ===

    public fun value_absolute_sid(u: &ValueAbsoluteUpdate): u256 { u.sid }

    public fun value_absolute_v(u: &ValueAbsoluteUpdate): u128 { u.v }

    /// When the publisher sent this batch (see `value_batch_timestamp`) — the only
    /// timestamp an absolute batch's updates have.
    public fun value_absolute_batch_timestamp(b: &ValueAbsoluteBatch): u64 { b.timestamp }

    /// Consume a `ValueAbsoluteBatch`, moving its updates out (no vector copy) for ingest.
    public fun into_value_absolute_updates(b: ValueAbsoluteBatch): vector<ValueAbsoluteUpdate> {
        let ValueAbsoluteBatch { timestamp: _, updates } = b;
        updates
    }

    // === SviAbsoluteBatch / SviAbsoluteUpdate reads ===

    public fun svi_absolute_sid(u: &SviAbsoluteUpdate): u256 { u.sid }

    /// `(svi_a_magnitude, svi_a_is_negative, svi_b, svi_sigma, svi_rho_magnitude, svi_rho_is_negative, svi_m_magnitude, svi_m_is_negative)`.
    public fun svi_absolute_fields(u: &SviAbsoluteUpdate): (u128, bool, u128, u128, u128, bool, u128, bool) {
        (
            u.svi_a_magnitude,
            u.svi_a_is_negative,
            u.svi_b,
            u.svi_sigma,
            u.svi_rho_magnitude,
            u.svi_rho_is_negative,
            u.svi_m_magnitude,
            u.svi_m_is_negative,
        )
    }

    /// When the publisher sent this batch (see `value_batch_timestamp`) — the only
    /// timestamp an absolute batch's updates have.
    public fun svi_absolute_batch_timestamp(b: &SviAbsoluteBatch): u64 { b.timestamp }

    /// Consume an `SviAbsoluteBatch`, moving its updates out (no vector copy) for ingest.
    public fun into_svi_absolute_updates(b: SviAbsoluteBatch): vector<SviAbsoluteUpdate> {
        let SviAbsoluteBatch { timestamp: _, updates } = b;
        updates
    }

    // === Test-only helpers (excluded from the published package) ===

    #[test_only]
    public fun new_value_update_for_testing(sid: u256, timestamp: u64, v: u128): ValueUpdate {
        ValueUpdate { sid, timestamp, v }
    }

    #[test_only]
    public fun new_svi_for_testing(
        sid: u256,
        timestamp: u64,
        svi_a_magnitude: u128,
        svi_a_is_negative: bool,
        svi_b: u128,
        svi_sigma: u128,
        svi_rho_magnitude: u128,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u128,
        svi_m_is_negative: bool,
    ): SviUpdate {
        SviUpdate {
            sid,
            timestamp,
            svi_a_magnitude,
            svi_a_is_negative,
            svi_b,
            svi_sigma,
            svi_rho_magnitude,
            svi_rho_is_negative,
            svi_m_magnitude,
            svi_m_is_negative,
        }
    }

    #[test_only]
    public fun new_value_batch_for_testing(timestamp: u64, updates: vector<ValueUpdate>): ValueBatch {
        ValueBatch { timestamp, updates }
    }

    #[test_only]
    public fun new_svi_batch_for_testing(timestamp: u64, updates: vector<SviUpdate>): SviBatch {
        SviBatch { timestamp, updates }
    }

    #[test_only]
    public fun new_value_absolute_update_for_testing(sid: u256, v: u128): ValueAbsoluteUpdate {
        ValueAbsoluteUpdate { sid, v }
    }

    #[test_only]
    public fun new_svi_absolute_for_testing(
        sid: u256,
        svi_a_magnitude: u128,
        svi_a_is_negative: bool,
        svi_b: u128,
        svi_sigma: u128,
        svi_rho_magnitude: u128,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u128,
        svi_m_is_negative: bool,
    ): SviAbsoluteUpdate {
        SviAbsoluteUpdate {
            sid,
            svi_a_magnitude,
            svi_a_is_negative,
            svi_b,
            svi_sigma,
            svi_rho_magnitude,
            svi_rho_is_negative,
            svi_m_magnitude,
            svi_m_is_negative,
        }
    }

    #[test_only]
    public fun new_value_absolute_batch_for_testing(
        timestamp: u64,
        updates: vector<ValueAbsoluteUpdate>,
    ): ValueAbsoluteBatch {
        ValueAbsoluteBatch { timestamp, updates }
    }

    #[test_only]
    public fun new_svi_absolute_batch_for_testing(
        timestamp: u64,
        updates: vector<SviAbsoluteUpdate>,
    ): SviAbsoluteBatch {
        SviAbsoluteBatch { timestamp, updates }
    }
}
