// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Authorized-signer registry for the Block Scholes oracle.
///
/// Holds the single authorized public key. Read immutably by the verifier;
/// mutated only via the `AdminCap`. The verifier
/// accepts a signature iff the recovered key equals `signer_pubkey` (rotated by
/// `set_signer`, no expiry).
///
/// Published fresh per version, but the registry id isn't what stops cross-deployment
/// replay — `verify` prepends its own runtime address (`type_name::original_id`)
/// before hashing, so a signature only recovers the key when checked by the package
/// it was signed for, despite a shared signer key across versions. `sid` meaning is
/// the consumer's concern, not the verifier's.
module bs_oracle::registry {
    use sui::event;

    const EBadPubkeyLength: u64 = 1;
    const EBadPubkeyPrefix: u64 = 2;

    /// secp256k1 compressed public key length; matches `secp256k1_ecrecover` output.
    const SECP256K1_COMPRESSED_PUBKEY_LEN: u64 = 33;
    /// A compressed secp256k1 key starts with 0x02 (even Y) or 0x03 (odd Y).
    const SECP256K1_COMPRESSED_EVEN: u8 = 0x02;
    const SECP256K1_COMPRESSED_ODD: u8 = 0x03;

    /// Shared registry object. Read immutably by the verifier; mutated only via `AdminCap`.
    public struct SignerRegistry has key {
        id: UID,
        /// The single authorized compressed secp256k1 public key. Empty until the
        /// admin sets it; the verifier accepts a signature iff its recovered key
        /// equals this.
        signer_pubkey: vector<u8>,
        /// Emergency stop. While `true`, the verifier rejects every batch (both
        /// categories), so a compromised signer can be halted without a package
        /// upgrade — which is impossible here, as the `UpgradeCap` is burned at publish.
        paused: bool,
    }

    /// Authority to mutate the registry (set the signer).
    public struct AdminCap has key, store { id: UID }

    /// The authorized signing key was set or rotated.
    public struct SignerSet has copy, drop {
        public_key: vector<u8>,
    }

    /// The emergency pause flag was set or cleared.
    public struct PauseSet has copy, drop {
        paused: bool,
    }

    fun init(ctx: &mut TxContext) {
        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
        transfer::share_object(SignerRegistry {
            id: object::new(ctx),
            signer_pubkey: vector[],
            paused: false,
        });
    }

    // === Admin (AdminCap-gated) ===

    /// Set (or rotate) the single authorized signing key. Aborts unless the key has
    /// the shape of a compressed secp256k1 key (33 bytes, 0x02/0x03 prefix) — a
    /// format check only, not proof the bytes are a valid curve point. There's no
    /// Move-level primitive to fully validate the point, so a wrong-but-well-formed
    /// key still passes here; it simply can never recover a real signature.
    public fun set_signer(reg: &mut SignerRegistry, _admin: &AdminCap, public_key: vector<u8>) {
        assert_valid_pubkey(&public_key);
        reg.signer_pubkey = public_key;
        event::emit(SignerSet { public_key });
    }

    /// Set or clear the emergency pause flag. While paused, the verifier rejects every
    /// batch; clearing it resumes normal verification.
    public fun set_paused(reg: &mut SignerRegistry, _admin: &AdminCap, paused: bool) {
        reg.paused = paused;
        event::emit(PauseSet { paused });
    }

    // === Public reads ===

    /// The authorized signer's compressed public key (empty if unset).
    public fun signer_pubkey(reg: &SignerRegistry): vector<u8> { reg.signer_pubkey }

    /// Whether the oracle is emergency-paused (verifier rejects all batches).
    public fun is_paused(reg: &SignerRegistry): bool { reg.paused }

    // === Private ===

    fun assert_valid_pubkey(public_key: &vector<u8>) {
        assert!(public_key.length() == SECP256K1_COMPRESSED_PUBKEY_LEN, EBadPubkeyLength);
        let prefix = *public_key.borrow(0);
        assert!(prefix == SECP256K1_COMPRESSED_EVEN || prefix == SECP256K1_COMPRESSED_ODD, EBadPubkeyPrefix);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
}
