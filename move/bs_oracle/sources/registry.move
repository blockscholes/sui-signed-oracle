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

    /// secp256k1 compressed public key length; matches `secp256k1_ecrecover` output.
    const SECP256K1_COMPRESSED_PUBKEY_LEN: u64 = 33;

    /// Shared registry object. Read immutably by the verifier; mutated only via `AdminCap`.
    public struct SignerRegistry has key {
        id: UID,
        /// The single authorized compressed secp256k1 public key. Empty until the
        /// admin sets it; the verifier accepts a signature iff its recovered key
        /// equals this.
        signer_pubkey: vector<u8>,
    }

    /// Authority to mutate the registry (set the signer).
    public struct AdminCap has key, store { id: UID }

    /// The authorized signing key was set or rotated.
    public struct SignerSet has copy, drop {
        public_key: vector<u8>,
    }

    fun init(ctx: &mut TxContext) {
        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
        transfer::share_object(SignerRegistry {
            id: object::new(ctx),
            signer_pubkey: vector[],
        });
    }

    // === Admin (AdminCap-gated) ===

    /// Set (or rotate) the single authorized signing key. Aborts if the key length
    /// does not match a compressed secp256k1 key.
    public fun set_signer(reg: &mut SignerRegistry, _admin: &AdminCap, public_key: vector<u8>) {
        assert_pubkey_length(&public_key);
        reg.signer_pubkey = public_key;
        event::emit(SignerSet { public_key });
    }

    // === Public reads ===

    /// The authorized signer's compressed public key (empty if unset).
    public fun signer_pubkey(reg: &SignerRegistry): vector<u8> { reg.signer_pubkey }

    // === Private ===

    fun assert_pubkey_length(public_key: &vector<u8>) {
        assert!(public_key.length() == SECP256K1_COMPRESSED_PUBKEY_LEN, EBadPubkeyLength);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
}
