// Shared constants for the MVP scripts and tests.
//
// The private keys here are throwaway TEST keys with deterministic values so the
// tests are reproducible. NEVER use them for anything real.

export const TEST_SIGNER_PRIV = "0x1111111111111111111111111111111111111111111111111111111111111111";
// A second key, never set as the signer — used as the "unauthorized signer" in
// the bad-signature e2e test (its recovered pubkey is not the authorized one).
export const TEST_SIGNER_PRIV_2 = "0x2222222222222222222222222222222222222222222222222222222222222222";

// Series ids (`u256`). The verifier does not interpret them; the consumer keys
// storage by `sid` and the Predict client maps each `sid` to its {type, expiry}.
// SPOT_SID / FORWARD_SID are two price series (a spot and a forward feed, both ride
// the value batch); SVI_SID an SVI smile.
export const SPOT_SID = 10n;
export const FORWARD_SID = 11n;
export const SVI_SID = 12n;

// Sample market data.
export const SPOT = 65_000;
export const FORWARD = 65_250;
export const SVI = { a: 0.04, b: 0.1, rho: -0.7, m: 0.0, sigma: 0.2 };

// Localnet endpoints (overridable via env for the e2e harness).
export const RPC_URL = process.env["SUI_RPC"] ?? "http://127.0.0.1:9000";
export const FAUCET_URL = process.env["SUI_FAUCET"] ?? "http://127.0.0.1:9123/gas";
