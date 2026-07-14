// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Verifies a Block Scholes-signed batch and mints a gated batch struct.
///
/// A batch is homogeneous by category, so there are two entry points:
/// `verify_and_create_value_batch` (`{sid, v}` — spot or forward) and
/// `verify_and_create_svi_batch` (SVI parameter sets). The signed `batch_kind` byte
/// binds the category so an untrusted relayer can't cross-feed one to another.
/// Replay/monotonicity is the consumer's job (it owns per-feed state).
///
/// Wire message: `signature (65) || payload`, where `payload` BCS = envelope
/// (batch_kind: u8, timestamp: u64) + the category's `updates`. The signature
/// covers this package's runtime address (via `type_name::original_id`, not a
/// compile-time literal) prepended to `payload` — a domain separator so
/// signatures don't verify across package versions despite a shared signer key
/// (see `verify_header`). Values are `u64` @1e9; SVI `a`/`rho`/`m` are magnitude +
/// `is_negative`. `timestamp` drives freshness here and per-`sid` replay in the
/// consumer.
module bs_oracle::verify {
    use bs_oracle::registry::SignerRegistry;
    use std::type_name;
    use sui::{bcs::{Self, BCS}, clock::Clock, ecdsa_k1, event};

    const SECP256K1_SIG_LEN: u64 = 65;
    /// `secp256k1_ecrecover` hash selector: 0 = keccak256.
    const KECCAK256: u8 = 0;
    const BATCH_VALUE: u8 = 0;
    const BATCH_SVI: u8 = 1;

    const EBadMessageLength: u64 = 1;
    const EBadSigner: u64 = 5;
    const EFutureTimestamp: u64 = 6;
    const ETrailingPayloadData: u64 = 8;
    const EEmptyBatch: u64 = 9;
    const EBadBatchKind: u64 = 10;
    const EPaused: u64 = 11;

    /// Marker type used only to resolve this package's own runtime address
    /// (`type_name::original_id<PackageMarker>()`) — kept separate from the data
    /// structs so the domain separator doesn't depend on their shape.
    public struct PackageMarker has drop {}

    /// A single value `v` for series `sid` (today: spot or forward price — the `sid`
    /// identifies which). The contract expiry is not carried; the consumer holds the
    /// `sid` mapping.
    public struct ValueUpdate has copy, drop, store {
        sid: u256,
        v: u64,
    }

    /// An SVI parameter set for series `sid`. `a`/`rho`/`m` are signed (magnitude +
    /// sign); `b`/`sigma` are non-negative.
    public struct SviUpdate has copy, drop, store {
        sid: u256,
        svi_a_magnitude: u64,
        svi_a_is_negative: bool,
        svi_b: u64,
        svi_sigma: u64,
        svi_rho_magnitude: u64,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u64,
        svi_m_is_negative: bool,
    }

    /// A verified value batch. No abilities, so it must be consumed in the minting
    /// transaction and can only be created by `verify` — the on-chain proof of
    /// authenticity. `timestamp` is batch-level (shared by every update).
    public struct ValueBatch {
        timestamp: u64,
        updates: vector<ValueUpdate>,
    }

    /// A verified SVI batch (same gating as `ValueBatch`).
    public struct SviBatch {
        timestamp: u64,
        updates: vector<SviUpdate>,
    }

    public struct BatchVerified has copy, drop {
        batch_kind: u8,
        timestamp: u64,
        update_count: u64,
    }

    /// Verify a signed value batch and return the gated `ValueBatch`.
    public fun verify_and_create_value_batch(reg: &SignerRegistry, clock: &Clock, message: vector<u8>): ValueBatch {
        let (mut p, timestamp) = verify_header(reg, clock, message, BATCH_VALUE);
        let updates = peel_value_updates(&mut p);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_VALUE, timestamp, update_count: updates.length() });
        ValueBatch { timestamp, updates }
    }

    /// Verify a signed SVI batch and return the gated `SviBatch`.
    public fun verify_and_create_svi_batch(reg: &SignerRegistry, clock: &Clock, message: vector<u8>): SviBatch {
        let (mut p, timestamp) = verify_header(reg, clock, message, BATCH_SVI);
        let updates = peel_svi_updates(&mut p);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_SVI, timestamp, update_count: updates.length() });
        SviBatch { timestamp, updates }
    }

    /// Split the signature, check the shared envelope (batch kind, address-prefixed
    /// signature, freshness), and return the decoder at `updates`.
    fun verify_header(reg: &SignerRegistry, clock: &Clock, message: vector<u8>, expected_kind: u8): (BCS, u64) {
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

        // Reject future-dated timestamps — this also protects the consumer's per-`sid`
        // replay guard from being advanced past wall-clock. Staleness ("too old") is the
        // client's responsibility, not the verifier's.
        let now = clock.timestamp_ms();
        assert!(timestamp <= now, EFutureTimestamp);

        (p, timestamp)
    }

    fun peel_value_updates(cur: &mut BCS): vector<ValueUpdate> {
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let v = cur.peel_u64();
            updates.push_back(ValueUpdate { sid, v });
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
            let svi_a_magnitude = cur.peel_u64();
            let svi_a_is_negative = cur.peel_bool();
            let svi_b = cur.peel_u64();
            let svi_sigma = cur.peel_u64();
            let svi_rho_magnitude = cur.peel_u64();
            let svi_rho_is_negative = cur.peel_bool();
            let svi_m_magnitude = cur.peel_u64();
            let svi_m_is_negative = cur.peel_bool();
            updates.push_back(SviUpdate {
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

    public fun value_timestamp(b: &ValueBatch): u64 { b.timestamp }

    public fun value_update_count(b: &ValueBatch): u64 { b.updates.length() }

    public fun value_updates(b: &ValueBatch): vector<ValueUpdate> { b.updates }

    public fun value_sid(u: &ValueUpdate): u256 { u.sid }

    public fun value_v(u: &ValueUpdate): u64 { u.v }

    public fun destroy_value_batch(b: ValueBatch) {
        let ValueBatch { .. } = b;
    }

    /// Consume a `ValueBatch`, moving its parts out (no vector copy) for ingest.
    public fun into_value_batch_parts(b: ValueBatch): (u64, vector<ValueUpdate>) {
        let ValueBatch { timestamp, updates } = b;
        (timestamp, updates)
    }

    // === SviBatch / SviUpdate reads ===

    public fun svi_timestamp(b: &SviBatch): u64 { b.timestamp }

    public fun svi_update_count(b: &SviBatch): u64 { b.updates.length() }

    public fun svi_updates(b: &SviBatch): vector<SviUpdate> { b.updates }

    public fun svi_sid(u: &SviUpdate): u256 { u.sid }

    /// `(svi_a_magnitude, svi_a_is_negative, svi_b, svi_sigma, svi_rho_magnitude, svi_rho_is_negative, svi_m_magnitude, svi_m_is_negative)`.
    public fun svi_fields(u: &SviUpdate): (u64, bool, u64, u64, u64, bool, u64, bool) {
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

    public fun destroy_svi_batch(b: SviBatch) {
        let SviBatch { .. } = b;
    }

    /// Consume an `SviBatch`, moving its parts out (no vector copy) for ingest.
    public fun into_svi_batch_parts(b: SviBatch): (u64, vector<SviUpdate>) {
        let SviBatch { timestamp, updates } = b;
        (timestamp, updates)
    }

    // === Test-only constructors (excluded from the published package) ===

    #[test_only]
    public fun new_value_update_for_testing(sid: u256, v: u64): ValueUpdate {
        ValueUpdate { sid, v }
    }

    #[test_only]
    public fun new_svi_for_testing(
        sid: u256,
        svi_a_magnitude: u64,
        svi_a_is_negative: bool,
        svi_b: u64,
        svi_sigma: u64,
        svi_rho_magnitude: u64,
        svi_rho_is_negative: bool,
        svi_m_magnitude: u64,
        svi_m_is_negative: bool,
    ): SviUpdate {
        SviUpdate {
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
    public fun new_value_batch_for_testing(timestamp: u64, updates: vector<ValueUpdate>): ValueBatch {
        ValueBatch { timestamp, updates }
    }

    #[test_only]
    public fun new_svi_batch_for_testing(timestamp: u64, updates: vector<SviUpdate>): SviBatch {
        SviBatch { timestamp, updates }
    }
}
