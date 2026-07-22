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
/// (batch_kind: u8) + the category's `updates`. The signature covers this
/// package's runtime address (via `type_name::original_id`, not a compile-time
/// literal) prepended to `payload` — a domain separator so signatures don't
/// verify across package versions despite a shared signer key (see
/// `verify_header`). Values are `u64` @1e9; SVI `a`/`rho`/`m` are magnitude +
/// `is_negative`. Each update carries its own `timestamp`, which drives the
/// future-date guard here and per-`sid` replay in the consumer.
///
/// The batch is a hot potato, so holding one is proof of a valid signature. Its
/// updates are not `store`: consumers unpack them into their own types rather than
/// persist this package's types across independently published versions (design.md §5).
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
    const EBadSigner: u64 = 2;
    const EFutureTimestamp: u64 = 3;
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
        v: u64,
    }

    /// An SVI parameter set for series `sid`, as of `timestamp`. `a`/`rho`/`m` are
    /// signed (magnitude + sign); `b`/`sigma` are non-negative.
    public struct SviUpdate has copy, drop {
        sid: u256,
        timestamp: u64,
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
    /// authenticity. Each update carries its own `timestamp`.
    public struct ValueBatch {
        updates: vector<ValueUpdate>,
    }

    /// A verified SVI batch (same gating as `ValueBatch`).
    public struct SviBatch {
        updates: vector<SviUpdate>,
    }

    public struct BatchVerified has copy, drop {
        batch_kind: u8,
        update_count: u64,
    }

    /// Verify a signed value batch and return the gated `ValueBatch`.
    public fun verify_and_create_value_batch(reg: &SignerRegistry, clock: &Clock, message: vector<u8>): ValueBatch {
        let mut p = verify_header(reg, message, BATCH_VALUE);
        let updates = peel_value_updates(&mut p, clock);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_VALUE, update_count: updates.length() });
        ValueBatch { updates }
    }

    /// Verify a signed SVI batch and return the gated `SviBatch`.
    public fun verify_and_create_svi_batch(reg: &SignerRegistry, clock: &Clock, message: vector<u8>): SviBatch {
        let mut p = verify_header(reg, message, BATCH_SVI);
        let updates = peel_svi_updates(&mut p, clock);
        assert!(p.into_remainder_bytes().is_empty(), ETrailingPayloadData);
        assert!(!updates.is_empty(), EEmptyBatch);
        event::emit(BatchVerified { batch_kind: BATCH_SVI, update_count: updates.length() });
        SviBatch { updates }
    }

    /// Split the signature, check the envelope (batch kind, address-prefixed
    /// signature), and return the decoder positioned at `updates`. Freshness is
    /// per-update, so the `peel_*` loops enforce it.
    fun verify_header(reg: &SignerRegistry, message: vector<u8>, expected_kind: u8): BCS {
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

        // Prepend this package's runtime address (see module doc) — resolved via
        // type_name, not a compile-time `@bs_oracle` literal (stays `0x0`). Requires
        // each version to be independently published, never an in-place Sui upgrade
        // (design.md §5): `original_id` stays pinned across an upgrade lineage.
        let self_address = type_name::original_id<PackageMarker>();
        let mut signed_bytes = bcs::to_bytes(&self_address);
        signed_bytes.append(payload);
        let recovered = ecdsa_k1::secp256k1_ecrecover(&signature, &signed_bytes, KECCAK256);
        assert!(recovered == reg.signer_pubkey(), EBadSigner);

        p
    }

    /// Reject future-dated timestamps, which would advance the consumer's per-`sid`
    /// replay guard past wall-clock. Staleness ("too old") is the client's call: a
    /// timestamp pinned to unchanged data is a valid update.
    fun peel_timestamp(cur: &mut BCS, now: u64): u64 {
        let timestamp = cur.peel_u64();
        assert!(timestamp <= now, EFutureTimestamp);
        timestamp
    }

    fun peel_value_updates(cur: &mut BCS, clock: &Clock): vector<ValueUpdate> {
        let now = clock.timestamp_ms();
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let timestamp = peel_timestamp(cur, now);
            let v = cur.peel_u64();
            updates.push_back(ValueUpdate { sid, timestamp, v });
            i = i + 1;
        };
        updates
    }

    fun peel_svi_updates(cur: &mut BCS, clock: &Clock): vector<SviUpdate> {
        let now = clock.timestamp_ms();
        let n = cur.peel_vec_length();
        let mut updates = vector[];
        let mut i = 0;
        while (i < n) {
            let sid = cur.peel_u256();
            let timestamp = peel_timestamp(cur, now);
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

    // === ValueBatch / ValueUpdate reads ===

    public fun value_sid(u: &ValueUpdate): u256 { u.sid }

    public fun value_timestamp(u: &ValueUpdate): u64 { u.timestamp }

    public fun value_v(u: &ValueUpdate): u64 { u.v }

    /// Consume a `ValueBatch`, moving its updates out (no vector copy) for ingest.
    public fun into_value_updates(b: ValueBatch): vector<ValueUpdate> {
        let ValueBatch { updates } = b;
        updates
    }

    // === SviBatch / SviUpdate reads ===

    public fun svi_sid(u: &SviUpdate): u256 { u.sid }

    public fun svi_timestamp(u: &SviUpdate): u64 { u.timestamp }

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

    /// Consume an `SviBatch`, moving its updates out (no vector copy) for ingest.
    public fun into_svi_updates(b: SviBatch): vector<SviUpdate> {
        let SviBatch { updates } = b;
        updates
    }

    // === Test-only helpers (excluded from the published package) ===

    #[test_only]
    public fun new_value_update_for_testing(sid: u256, timestamp: u64, v: u64): ValueUpdate {
        ValueUpdate { sid, timestamp, v }
    }

    #[test_only]
    public fun new_svi_for_testing(
        sid: u256,
        timestamp: u64,
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
    public fun new_value_batch_for_testing(updates: vector<ValueUpdate>): ValueBatch {
        ValueBatch { updates }
    }

    #[test_only]
    public fun new_svi_batch_for_testing(updates: vector<SviUpdate>): SviBatch {
        SviBatch { updates }
    }
}
