// Copyright (c) Block Scholes.
// SPDX-License-Identifier: Apache-2.0

/// Unit tests for `set_signer` / `assert_pubkey_length` — the sole gate on
/// which key the whole system trusts, so it's worth covering directly rather
/// than only through the verify/consumer round-trip tests.
#[test_only]
module bs_oracle::registry_tests {
    use bs_oracle::registry::{Self, SignerRegistry, AdminCap, SignerSet};
    use std::unit_test::assert_eq;
    use sui::{event, test_scenario::{Self as ts, return_shared}};

    const ADMIN: address = @0xAD;

    fun valid_key(): vector<u8> {
        let mut k = vector[];
        let mut i = 0u64;
        while (i < 33) {
            k.push_back(i as u8);
            i = i + 1;
        };
        k
    }

    fun setup(scenario: &mut ts::Scenario): (SignerRegistry, AdminCap) {
        registry::init_for_testing(scenario.ctx());
        scenario.next_tx(ADMIN);
        let reg = scenario.take_shared<SignerRegistry>();
        let cap = scenario.take_from_sender<AdminCap>();
        (reg, cap)
    }

    #[test]
    fun set_signer_updates_pubkey_and_emits_event() {
        let mut scenario = ts::begin(ADMIN);
        let (mut reg, cap) = setup(&mut scenario);

        let key = valid_key();
        registry::set_signer(&mut reg, &cap, key);

        assert_eq!(registry::signer_pubkey(&reg), key);
        let events = event::events_by_type<SignerSet>();
        assert_eq!(events.length(), 1);

        ts::return_to_sender(&scenario, cap);
        return_shared(reg);
        scenario.end();
    }

    #[test, expected_failure(abort_code = registry::EBadPubkeyLength)]
    fun set_signer_rejects_wrong_length_key() {
        let mut scenario = ts::begin(ADMIN);
        let (mut reg, cap) = setup(&mut scenario);

        registry::set_signer(&mut reg, &cap, vector[1, 2, 3]);

        ts::return_to_sender(&scenario, cap);
        return_shared(reg);
        scenario.end();
    }
}
