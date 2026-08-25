# Block Scholes Signed Oracle — Design & Data Flow

How a Block Scholes value travels from off-chain signing to an on-chain, verified
batch (`ValueBatch` / `SviBatch`) the Predict consumer can trust.

---

## 1. End-to-end flow

```
client subscribes → each series gets an immutable sid → BS signs a homogeneous batch (value or SVI)
  → relayer fetches the signed value object → PTB: verify_and_create_{value,svi}_batch → consumer stores each value by sid
```

### Off-chain (Block Scholes + relayer)

1. **Subscribe & sid.** A client subscribes to a request or batch request over the `wsAPI`. Each batch
   item identifies a feed (`feed`/`asset`/`base_asset`/`model`/`expiry`/…) and carries an **immutable
   `sid`**. Unlike the standard wsAPI (where `sid` is client-supplied), the signed-oracle flow makes it
   **optional**: the client may supply a pre-assigned `sid` string, or omit it — in which case Block
   Scholes generates one as a deterministic encoding of the request item's identity fields — and returns
   the resolved `sid` in the subscription confirmation (see [Subscription & sid](#subscription--sid)).
2. **Sign.** Block Scholes produces the data as a self-contained **value object** and signs its
   canonical bytes with **one** secp256k1 signature over the whole batch (see §2). A batch is
   **homogeneous by category** — a value or SVI batch — and each entry is a minimal
   `{sid, timestamp, value(s)}`, or, for the "absolute" variants, `{sid, value(s)}` with no
   per-update timestamp — every entry is as of the batch `timestamp` alone (§2.2); the signature
   is batch-level, not per update.
3. **Fetch.** An off-chain **relayer** (run by Predict/deepbook) fetches the signed value objects. It is
   untrusted — it cannot forge or alter the data.

### On-chain (Sui)

1. **Package binding.** Block Scholes publishes the `bs_oracle` Move package; its **package id** (and
   the matching `SignerRegistry` id) are shared with Predict upfront — a new pair each time Block
   Scholes publishes a new version (see §5).
2. **One atomic PTB.** The relayer submits a single transaction with two sequential calls (the verify
   function and the consumer ingest are paired to the batch category):
   1. `bs_oracle::verify::verify_and_create_value_batch(...)` (or `…_svi_batch`) — checks the secp256k1
      signature against the registered signer and returns a gated `ValueBatch` (or `SviBatch`).
   2. the Predict consumer's ingest, which takes that batch by value and stores each value keyed by
      `sid` (the real consumer maps `sid` → its config — exchange, base asset, expiry, type, etc. —
      and rebuilds deepbookv3's typed update).
   If the verify call aborts, the ingest never runs.
3. **Type gating.** The ingest is typed to accept `ValueBatch` / `SviBatch`. Move enforces this at the
   VM level, and the type is namespaced to the `bs_oracle` package id — so the consumer cannot receive a
   same-named type from any other package. The batch struct has **no public constructor**: it can only
   be minted inside `bs_oracle` after a valid signature. Receiving one is therefore typed proof that the
   data is authentic Block Scholes data.

> The consumer shown here is `example_consumer` — a reference implementation of how to ingest the
> verified batch; production wires it to the real Predict/deepbook oracle.

### Subscription & sid

A client opens a subscription describing the feeds it wants. Each batch item may carry a pre-assigned
`sid` string; if no `sid` is present, Block Scholes generates one from the request item's identity
fields (junk keys do not participate). In every case Block Scholes returns the resolved `sid` string in the **subscription
confirmation**, so the client always learns the final `sid` for each item. The rest of this section
describes the `sid` **Block Scholes generates** (when the client omits one) and how we intend clients to
consume it; a client that supplies its own `sid` owns the same guarantees itself.

**What the `sid` is — identity and integrity.** A `sid` is the immutable identifier for one feed, and
the only thing binding an on-chain `{sid, value}` to a real-world meaning: the verifier proves the bytes
are authentically signed but never interprets them. Two consequences:

- **It fully specifies the value's meaning.** The `sid` is derived from a structured, versioned binary
  encoding of the request's identity fields — provider/exchange, asset, base/quote, model, expiry, and
  **decimals and timestamp precision** — never a hash of the raw request or of the feed's display name
  (see [Preimage](#preimage) below). BS stores the `sid ↔ format` binding, so a config change (e.g.
  different `decimals`) gets a **fresh** `sid` and a `sid` never changes meaning. Equivalent spellings of
  one series (tenor forms, decimal strikes, an explicit default vs. omitting the field) collapse onto the
  same `sid`. Strings the qn layer routes on — base asset, exchange, the `realized.vol` lookback — are
  instead encoded **exactly as sent**, case included, because two spellings reach two different upstream
  feeds and must not share one on-chain key. The derivation is additionally scoped to the **deployment**
  — the verifying package's id, which `domain.network` and `pkg_ver` resolve — so the same feed signed
  for a different network or deployment version yields a **different** `sid` (see the version-upgrade
  note in §5).
  Receiving `{sid, value}` therefore tells the consumer exactly how to interpret the value.
- **The client can use it as an integrity check on its own side.** Because the `sid` is a deterministic
  commitment to the config, the Predict consumer can reconstruct it from the config of the slot it is
  about to write to and confirm it matches the incoming `sid` before storing — catching **client-side**
  mistakes like mapping a BTC-spot update into an ETH-spot slot, or applying the wrong decimals when
  converting to its on-chain form. The data from BS is already correct and fully specified; this guards
  the consumer's handling of it.

**(a) Subscribe request** — no `sid` supplied, so BS generates one from the request item's identity
fields (see [Preimage](#preimage)).

The `options.signature` object controls the signature scheme, and **the data is signed only when it is
present** in the subscription — omit `signature` and the data is streamed **unsigned** (the existing wsAPI
behaviour). When `signature` is present, `type` defaults to `"EVM"`; clients receiving Sui-verified
batches set `type: "SUI"`. In the SUI case: `pkg_ver` selects which verifying-package version Block
Scholes signs for (`1` by default) — an off-chain lookup key used to pick the target package/registry
(see §5). It is not carried inside the signed batch bytes; the package id it resolves to is what
scopes the preimage (see [Preimage](#preimage)), so it selects the sid namespace too.
`signature_schema` selects the signing algorithm (`"ecdsa"` by default; `"ed25519"` will be supported in
future); `domain.network` pins the network (`"mainnet"` by default) — not hashed itself, but it resolves
which package id scopes the preimage, so two networks still derive different sids.

Choosing `type: "SUI"` also fixes the **value encoding**: because Move has no signed or
floating-point type, every number is a fixed-point integer at the client's chosen `decimals`
(`0`–`38`, the `u128` limit) and signed parameters (SVI `rho`/`m`) are carried as `*_magnitude`
(`u128`) + `*_is_negative` (`bool`). The contract stores the integers verbatim and never rescales,
so the scale is an off-chain agreement between the signer and the consumer. The default/EVM path is
unchanged — normal signed decimals.

```json
{
  "jsonrpc": "2.0",
  "method": "subscribe",
  "params": [
    {
      "frequency": "20000ms",
      "retransmit_frequency": "20000ms",
      "client_id": "CLIENT_ID",
      "batch": [
        {
          "feed": "model.params",
          "exchange": "composite",
          "asset": "option",
          "base_asset": "BTC",
          "model": "SVI",
          "expiry": "2026-04-21T15:30:00Z"
        }
      ],
      "options": {
        "format": {
          "timestamp": "ms",
          "hexify": false,
          "decimals": 9
        },
        "signature": {
          "type": "SUI",
          "pkg_ver": 1,
          "signature_schema": "ecdsa",
          "domain": {
            "network": "mainnet"
          }
        }
      }
    }
  ]
}
```

**(b) Subscription confirmation** — BS echoes the subscription back with the generated `sid` injected:

```json
{
  "jsonrpc": "2.0",
  "result": [
    {
      "batch": {
        "frequency": "20000ms",
        "client_id": "CLIENT_ID",
        "batch": [
          {
            "sid": "0x9f3a…",
            "feed": "model.params",
            "exchange": "composite",
            "asset": "option",
            "base_asset": "BTC",
            "model": "SVI",
            "expiry": "2026-04-21T15:30:00Z"
          }
        ],
        "options": {
          "format": {
            "timestamp": "ms",
            "hexify": false,
            "decimals": 9
          },
          "signature": {
            "type": "SUI",
            "pkg_ver": 1,
            "signature_schema": "ecdsa",
            "domain": {
              "network": "mainnet"
            }
          }
        }
      }
    }
  ]
}
```

**(c) Result message** — the streamed signed data. The `data` object carries exactly what's signed —
`batch_kind`, the envelope `timestamp`, and the `values`; for the non-absolute batch kinds each value
also carries its own `t`, while the absolute kinds (`batch_kind` `2`/`3`) omit it and are as of the
envelope `timestamp` alone (§2.2) — nothing else needs to be prepended or reconstructed before
verifying (§2). On the SUI path, SVI values are the
**raw on-chain fields** — `svi_b`/`svi_sigma` and the signed `svi_a`/`svi_rho`/`svi_m` as `*_magnitude`
(`u128`, scaled to the requested `decimals`) + `*_is_negative` (`bool`) — i.e. exactly the field names
and encoding deepbook ingests, not decimal-scaled floats. Scaled values are carried as decimal
**strings** on the wire, since at high `decimals` they exceed JSON's 2^53 safe-integer range — and so
are both timestamps, since **precision is the client's choice** (§3) and a nanosecond epoch overflows
that same range just as easily as a wide scaled value.

```json
{
  "jsonrpc": "2.0",
  "method": "subscription",
  "params": [
    {
      "data": {
        "batch_kind": 1,
        "timestamp": "1761807620000",
        "values": [
          {
            "sid": "0x9f3a…",
            "t": "1761807600000",
            "svi_a_magnitude": "40000000",
            "svi_a_is_negative": false,
            "svi_b": "100000000",
            "svi_sigma": "200000000",
            "svi_rho_magnitude": "700000000",
            "svi_rho_is_negative": true,
            "svi_m_magnitude": "0",
            "svi_m_is_negative": false
          }
        ]
      },
      "signature": { "r": "0x…", "s": "0x…", "v": "0x1b" },
      "client_id": "CLIENT_ID"
    }
  ]
}
```

The signature is **batch-level** (one signature over the canonical payload — the `data` fields, with
the target package's own address folded into the hash on both sides, not per item) and is returned
as split **`{ r, s, v }`** — the same shape Block Scholes returns from its EIP-712 signing, so `v` is
the EVM recovery id (`0x1b`/`0x1c`). The relayer packs this into the on-chain wire form (§2.3),
normalizing `v` to Sui's `{0, 1}`. The
verification package takes this **signed value object** and returns the **verified value object** — that
reconstructed canonical payload is exactly the on-chain payload decoded in §2.

#### Preimage

The Sui-signed path's `sid` is `keccak256` of a structured, versioned byte layout implemented once in
`bs_sid::sid` (Move) and mirrored by an executable reference
(`ts/src/generate_sid_vectors.ts`, run with `pnpm -C ts generate-vectors`); the pinned request → `sid`
vectors are `move/bs_sid/vectors.json`, exercised by `move/bs_sid/tests/sid_tests.move`, held to the
committed file by `ts/src/generate_sid_vectors.test.ts`, and reproduced byte-for-byte by the wsAPI
implementation. A change to the layout without regenerating and re-pinning both sides is a
coordinated break with the provider, never a local edit.

```text
preimage = scope | feed | body
sid      = keccak256(preimage), read big-endian into u256
```

- `scope` = `package_id(32 raw)` — the deployment's identity. The package id is
  **`bs_oracle`'s** — the contract that verifies, stores and serves the values, *not* `bs_sid`, which
  only computes the digest. A feed key belongs to the deployment that holds it; the EVM families scope
  by their EIP-712 `verifying_contract` for exactly the same reason. Scoping by `bs_sid` would instead
  have namespaced keys by which helper hashed them and split a deployment's keys in two the day that
  helper was republished. The caller supplies it — a consumer passes the id of the very oracle it
  verifies against — so one published `bs_sid` stays correct for every deployment and every oracle
  version. The oracle is immutable (§4: its `UpgradeCap` is burned), so
  within one version the id cannot move, and a **new** oracle version is a new package and
  deliberately a new `sid` namespace, shipping as a fresh `bs_sid` build (§5). Neither the network nor
  `pkg_ver` is hashed: both are off-chain lookup keys that resolve *which* id scopes the preimage, and
  distinct chains and versions already carry distinct ids (see (a) above).
- `feed` is a BCS-encoded string supplied by the derive function (`index_px`, `mark_px`,
  `model_params`, `settlement_px` in `bs_sid::sid`, each taking the kind's identity fields and
  returning the `sid` in one call; each has an `*_generic` form spelling out the fields the short
  one defaults) — never caller-supplied, so a request cannot name a feed that contradicts the
  descriptor it derives. `asset` is a parameter of every generic form and of every short form except
  `settlement_px`, which pins `spot` — its callers only ever settle spot underlyings, and a suffixed
  one (`spot-equity`, `future-equity`, `option-equity`) still derives through `settlement_px_generic`.
- `body` is the feed kind's descriptor struct, BCS-encoded, identity fields in pinned order and
  `decimals`/`timestamp_precision` last. Absent `Option` fields still emit their `0x00` tag — BCS is
  positional, so dropping one would shift every later field. **Timestamp precision is signed identity**:
  a surface at two precisions is two different series, since the payload's `u64` timestamps mean nothing
  without their unit.

Byte-annotated example (`model.params`, SVI, HYPE, composite, an absolute expiry, testnet,
unpublished placeholder package id):

```text
1111111111111111111111111111111111111111111111111111111111111111  package id (placeholder 0x11*32)
0c6d6f64656c2e706172616d73                    feed = BCS "model.params"
066f7074696f6e09636f6d706f736974650448595045035356490080613da99f01000009026d73  body (descriptor BCS, closed by decimals | timestamp_precision)
```

sid = `0x29f876378481972bf272eddcbb987579ec3a75a634533295c3c8c2cbfe548a6a`

The full pinned vector set — every feed kind, the equivalence groups that must collapse onto one `sid`,
and the disjointness checks that must not — lives in `move/bs_sid/vectors.json`.

---

## 2. Signature mechanism

### 2.1 Scheme

secp256k1 ECDSA, recoverable, over a keccak256 digest, via `sui::ecdsa_k1` (`0x2`).

| Property | Value |
| --- | --- |
| Curve / algorithm | secp256k1 ECDSA (recoverable) |
| Hash | keccak256 (selector `0` in `ecdsa_k1`; `1` = sha256) |
| Signature (returned) | split `{ r, s, v }` (uniform with BS's EIP-712 output); `v` is the EVM recovery id `0x1b`/`0x1c` (27/28) |
| Signature (on-chain wire) | 65 bytes = `r (32) ‖ s (32) ‖ v (1)`, with `v` normalized to `0`/`1` (what `ecdsa_k1` expects) |
| Key form | 33-byte compressed public key — what `ecrecover` returns and the registry stores |

### 2.2 The signed batch

A Block Scholes feed publishes a **batch**: many typed updates (one per series), each
carrying **its own `timestamp`**, under one **batch `timestamp`**, signed **once**. A batch is **homogeneous by category** — a
**value batch** or an **SVI batch** — so there are four verify entry points:
`verify_and_create_value_batch` and `verify_and_create_svi_batch`, plus two "absolute"
variants, `verify_and_create_value_absolute_batch` and `verify_and_create_svi_absolute_batch`,
whose updates drop the per-update `timestamp` entirely and are as of the batch `timestamp`
alone (see below). The signature covers the
**target package's own address, followed by the raw BCS-encoded payload bytes**; the verifier
reconstructs the same prefixed bytes on-chain, so they must be byte-identical (§2.4).

| Data type | Batch kind | `batch_kind` | Verify function |
| --- | --- | --- | --- |
| Spot / forward price | Value batch | `0` | `verify_and_create_value_batch` |
| SVI params | SVI batch | `1` | `verify_and_create_svi_batch` |
| Spot / forward price, no per-update timestamp | Value absolute batch | `2` | `verify_and_create_value_absolute_batch` |
| SVI params, no per-update timestamp | SVI absolute batch | `3` | `verify_and_create_svi_absolute_batch` |

The payload is a shared envelope plus the category's vector of typed updates:

| Envelope field | Type | What it is | Role |
| --- | --- | --- | --- |
| `batch_kind` | `u8` | `0`/`1`/`2`/`3` = value / svi / value-absolute / svi-absolute; each verify function asserts its own kind | Category binding — an untrusted relayer can't feed one category to another verifier |
| `timestamp` | `u64` | When the publisher sent this batch | Feed liveness — advances every flush even when no series moved (§3); for the absolute variants, also the only "as of" time their updates have |
| `updates` | `vector<ValueUpdate \| SviUpdate \| ValueAbsoluteUpdate \| SviAbsoluteUpdate>` | The category's entries — the non-absolute variants each with their own `timestamp` (see below) | One signature covers them all |

There's no `registry_id`/`pkg_ver` field to decode or assert. Deployment/version binding instead
comes from what's hashed, not from a field inside it: both the signer (off-chain) and the verifier
(on-chain) prepend the target package's own address to the payload before hashing (§2.3/§2.4). Every
version's registry shares the same signer key, so this prefix — not the key — is what makes
signatures non-interchangeable across packages: a message signed with `package_id_1`'s address only
recovers the right key when re-hashed with that same prefix, so submitting it to any other package's
verify function fails the signer check.

A **value batch** carries `ValueUpdate` structs; an **SVI batch** carries `SviUpdate`. Neither has
a per-update tag — the batch is all one category. An update carries its `sid`, its `timestamp`,
and the value(s); the feed type, expiry, and underlying are the consumer's `sid` mapping, not the
payload's. Prices/params are `u128` fixed-point integers at the client's chosen scale; SVI
`a`/`rho`/`m` are signed and carried as **magnitude + `is_negative`** (`b`/`sigma` are non-negative).

**`ValueUpdate`**

| Field | Type | What it is |
| --- | --- | --- |
| `sid` | `u256` | Series id of the price feed (spot or forward) |
| `timestamp` | `u64` | This series' market-data time (when its value is "as of") |
| `v` | `u128` | The price |

**`SviUpdate`**

| Field | Type | What it is |
| --- | --- | --- |
| `sid` | `u256` | Series id of the SVI smile |
| `timestamp` | `u64` | This series' market-data time |
| `svi_a_magnitude` / `svi_a_is_negative` | `u128` / `bool` | Signed `a` as magnitude + sign |
| `svi_b`, `svi_sigma` | `u128` | SVI parameters (non-negative) |
| `svi_rho_magnitude` / `svi_rho_is_negative` | `u128` / `bool` | Signed `rho` as magnitude + sign |
| `svi_m_magnitude` / `svi_m_is_negative` | `u128` / `bool` | Signed `m` as magnitude + sign |

The **absolute** variants, `ValueAbsoluteUpdate`/`SviAbsoluteUpdate`, carry the same fields minus
`timestamp` — every update in one of these batches is as of the envelope `timestamp` alone, so a
consumer using them forgoes per-`sid` "as of" precision in exchange for a smaller payload.

```move
public struct ValueUpdate has copy, drop {
    sid: u256,
    timestamp: u64,
    v: u128,
}

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

public struct ValueAbsoluteUpdate has copy, drop {
    sid: u256,
    v: u128,
}

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

public struct ValueBatch {
    timestamp: u64,
    updates: vector<ValueUpdate>,
}

public struct SviBatch {
    timestamp: u64,
    updates: vector<SviUpdate>,
}

public struct ValueAbsoluteBatch {
    timestamp: u64,
    updates: vector<ValueAbsoluteUpdate>,
}

public struct SviAbsoluteBatch {
    timestamp: u64,
    updates: vector<SviAbsoluteUpdate>,
}
```

The consumer keys its storage by `sid`. The Predict client maps each `sid` to its config —
exchange, base asset, expiry, type, etc. — and rebuilds deepbookv3's typed update (`new_spot_update` /
`new_forward_update` / `new_svi_update`), and the verifier never interprets the values.

**Updates are carriers, not storage types.** The batch is a hot potato (no abilities): only `verify`
mints one, and it must be consumed in the minting transaction — that is what makes receiving one proof
of a valid signature. The updates it yields are `copy, drop` but deliberately **not** `store`, so a
consumer has to unpack them into its own representation instead of persisting ours. This mirrors
deepbookv3, whose `SpotUpdate`/`ForwardUpdate`/`SVIUpdate` are likewise `copy, drop` and are decoded
into a storable `RawSVI` before reaching `BlockScholesSVIFeed`'s table. It also keeps this package's
shape out of long-lived consumer storage, which matters because each version is published
independently and never upgraded in place (§5).

> **`sid` representation.** Off-chain (wsAPI, §1) a `sid` is a Block Scholes series identifier —
> a string, e.g. a hash of the request (`0x9f3a…`). On-chain each update carries that same hash as
> a full `u256`, and deepbookv3 widens its `source_id` to `u256` to match — the identical value is
> used on both sides.

### 2.3 Producing a signature (off-chain)

```
payload      = BCS(batch)                        // batch_kind, batch timestamp, updates[] (each with its own timestamp)
package_id   = pkgVerMap[pkg_ver].package_id      // resolved off-chain from the client's pkg_ver
signed_bytes = package_id(32) ‖ payload           // domain separator: never itself transmitted
digest       = keccak256(signed_bytes)
(r,s,rec)    = secp256k1_sign(digest, privKey)    // recoverable; low-s
signature    = { r, s, v },  v = rec + 27         // returned form: EVM v = 0x1b/0x1c

// the relayer packs the on-chain wire (normalizing v back to {0,1}) — package_id is not
// part of the wire message; it's implicit in which package's verify function is called:
message      = r(32) ‖ s(32) ‖ (v - 27)(1) ‖ payload
```

- The signer rejects recovery ids `2`/`3` (rare large-x cases); after the `-27` normalization Sui's
  `ecrecover` accepts only `{0, 1}`.
- `@noble/secp256k1` produces low-s signatures by default.

### 2.4 Verifying (on-chain, `bs_oracle::verify`)

```move
// split: first 65 bytes = signature, remainder = payload
let signature = /* first 65 bytes */;
let payload   = /* remainder */;

// prepend this package's own runtime address — the same domain separator the signer
// used. A compile-time `@bs_oracle` literal would stay `0x0`: publishing doesn't
// retroactively patch address constants baked into already-compiled bytecode, so the
// address is resolved dynamically instead, via a dedicated marker type this package
// defines (kept separate from the data structs so the domain separator doesn't
// depend on their shape).
let self_address = type_name::original_id<PackageMarker>();
let mut signed_bytes = bcs::to_bytes(&self_address);
signed_bytes.append(payload);

let recovered = ecdsa_k1::secp256k1_ecrecover(&signature, &signed_bytes, KECCAK256);
assert!(recovered == reg.signer_pubkey(), EBadSigner);
```

`ecrecover` re-hashes `signed_bytes` internally, so the verifier passes raw bytes (this snippet is
the shared core of both entry points; each also asserts its own `batch_kind`). A payload signed for
a different package's address reconstructs different `signed_bytes` here, so `ecrecover` recovers an
unrelated key and the signer check fails — this is what replaces an explicit registry/version-id
assertion. A failed check aborts (malformed signature → inside `ecrecover`; wrong key → `EBadSigner`)
and no batch is produced.
`verify_and_create_value_batch` / `…_svi_batch` return a gated `ValueBatch` / `SviBatch`; the
consumer stores each value keyed by `sid`, applying per-`sid` replay protection against each
update's own `timestamp`.

The registry holds exactly **one** authorized signer (`signer_pubkey`, set/rotated by the
admin); verification requires the recovered key to equal it.

---

## 3. Replay

Ordering keys off each update's own `timestamp`, and is entirely the consumer's. For the
non-absolute batch kinds, the batch-level `timestamp` plays no part in it (see "The batch
timestamp is a different signal" below); the absolute batch kinds have no per-update
`timestamp` at all, so for them the batch-level `timestamp` *is* the replay key (see "Absolute
batches and the format pin" below).

The verifier does not interpret either timestamp at all: it decodes them, binds them under the
signature, and hands them on. Timestamp **precision is the client's choice** (`format.timestamp`),
so the verifier has no unit to compare against `clock.timestamp_ms()` — a value that looks
future-dated in ms may simply be seconds or nanoseconds. Bounding freshness therefore belongs
where the units are known: the consumer/application, which must enforce a maximum age in each
feed's configured timestamp precision and already owns the per-`sid` state.

**Replay — the consumer** (per-feed, on each update's `timestamp`):

```move
// per update — first update for a sid just records it; later ones must be strictly newer:
if (last_ts.contains(sid)) {
    if (timestamp <= last_ts[sid]) return false;  // skip: this series hasn't advanced
};
// record `timestamp` as last_ts[sid], apply the update
```

The consumer stores each `sid`'s last-applied `timestamp` and applies an update only if its
`timestamp` is strictly greater. A non-advancing update is **skipped, not rejected** — the batch
still lands and every other `sid` in it is applied normally.

That skip is deliberate, and it is why replay keys off a **per-update** timestamp. When a series'
source data hasn't moved, the publisher re-sends it pinned to its **original** timestamp, so the
chain keeps updating at a high frequency with the best data available while explicitly signalling
that the series has not advanced. The consumer reads `last_ts[sid]` and applies its own freshness
policy. A single batch-level timestamp could not express this: a pinned series would either force
the whole batch to abort, or have to be re-stamped with a fresh time it hadn't earned.

Note that a skipped update discards its value as well as its timestamp — a pinned timestamp means the
series has not advanced, so its stored value must not move either.

**The batch timestamp is a different signal, not a replacement.** Because a quiet feed produces a
batch in which *every* update is pinned and therefore skipped, per-update timestamps alone leave a
consumer unable to distinguish "nothing moved" from "the publisher died". The envelope's `timestamp`
closes that gap: it is when the batch was sent, so it advances on every flush regardless of what the
data did. For the non-absolute batch kinds it takes no part in replay — `example_consumer` records
it separately as `last_batch_ts` and emits it on `BatchIngested` purely as the liveness read.

**Absolute batches and the format pin.** The absolute batch kinds (`batch_kind` `2`/`3`) have no
per-update `timestamp`, so their replay key *is* the envelope `timestamp` — always milliseconds,
per `example_consumer`'s own policy. That is a different unit from a non-absolute `sid`'s own
`timestamp_precision`, which may not be milliseconds, so the two are not comparable. Nothing in
the wire format constrains a `sid` to one batch kind for life, so `example_consumer` pins each
`sid` to whichever kind first writes it: an update for a `sid` arriving under the other kind is
skipped, the same as a stale replay, rather than being compared across incompatible domains.

**Why the split.** The verifier is stateless about feeds: it only proves the signed message is
authentic. The consumer owns the per-feed state, so per-`sid` replay/monotonicity lives there.
Freshness is also a consumer/application responsibility: it must enforce a maximum age for signed
timestamps in the precision configured for each feed. `example_consumer` demonstrates one concrete
policy for the liveness signal by defining the envelope timestamp as milliseconds and rejecting
batches more than 60 seconds old or more than 5 seconds ahead of Sui's `Clock`. A production consumer
must likewise bound per-update market-data timestamps according to each feed's configured units.

---

## 4. Registry & admin

The `SignerRegistry` is a shared object — the oracle's trust anchor. It is read immutably
by the verifier and mutated only via the `AdminCap`.

| Field | What it is | Admin setter |
| --- | --- | --- |
| `signer_pubkey` | the single authorized 33-byte compressed key | `set_signer` (set / rotate) |
| `paused` | emergency stop; while `true` the verifier rejects every batch (both categories) | `set_paused` |

**Key validation.** `set_signer` rejects anything that isn't a well-formed compressed secp256k1 key
(33 bytes with a `0x02`/`0x03` prefix), so an admin typo cannot silently brick verification with a
key `ecrecover` can never match.

**Emergency pause.** `set_paused(true)` makes `verify_header` abort with `EPaused` on every batch,
halting a compromised signer without a package upgrade (impossible here — the `UpgradeCap` is burned).
`set_paused(false)` resumes. Reads are unaffected.

**Deployment binding.** There's no `registry_id` field to assert — deployment binding instead comes
from what's hashed: the signer and verifier both prepend the target package's own address before
hashing (§2.3/§2.4), so a signature only recovers the right key when checked by the package it was
signed for (see §5). The `SignerRegistry` itself is still published fresh per package version — it's
what actually holds the signer key the verifier checks against — but cross-deployment /
cross-network / cross-version replay protection now comes from the address-prefixed hash, not a
decoded/compared `registry_id`.

**Value sanity.** The verifier does not bounds-check values — meaningful sanity limits depend on the
series (a BTC spot vs an SVI parameter) and are the consumer's concern, alongside per-`sid` interpretation.

**Production.** Hold the `AdminCap` in a Sui multisig; key rotation is `set_signer` with the new pubkey.

**UpgradeCap.** §5's "independent package per version, never an in-place upgrade" is enforced, not
just documented: `publishPackages` burns `bs_oracle`'s `UpgradeCap` (`0x2::package::make_immutable`)
immediately after publish. Without this, an in-place upgrade could add a function that mints a
`ValueBatch`/`SviBatch` directly — bypassing the signature check entirely, since Sui's type identity
for the batch structs stays pinned to the package regardless of which upgraded module version
actually constructs one — making the `UpgradeCap` holder a total-forgery single point of compromise.

---

## 5. Package versioning & upgrades

`pkg_ver` is an **off-chain lookup key**, not an on-chain field: a client requesting
`options.signature.pkg_ver: N` tells Block Scholes which verifying-package version to sign for. A new
data type or feed is a `verify.move` change (new `*Update` + `batch_kind` + `verify_and_create_*_batch`,
or a struct change), so Block Scholes **publishes a brand-new package** — its own package id *and* its
own `SignerRegistry`. Block Scholes keeps an off-chain `pkg_ver → { package_id, registry_id }` map;
when signing, it resolves `pkg_ver` to a `package_id` and folds that package's own address into the
signed hash (§2.3). It re-sets the **same** signer key on each version's registry (no routine
per-version rotation — but the admin can still rotate the key via `set_signer` on any registry, e.g.
if it is compromised).

**Per-version isolation.** `package_id_N::verify` prepends its own runtime address (resolved via
`type_name::original_id`, not a compile-time address literal — see §2.4) before hashing, so
a signature produced for `package_id_M`'s address only ever recovers the correct signer key when
checked by `package_id_M`'s own code (§2.4) — every other version's `ecrecover` call fails. This holds
even though every version's registry shares the same signer key: nothing about the key distinguishes
versions, the address prefix does. Existing v1 integrations keep working unchanged.

**Client upgrade (v1 → v2):** request `pkg_ver: 2` (`options.signature.pkg_ver`), repoint the
Move.toml dependency at `package_id_2`, reference its `SignerRegistry` object / call
`package_id_2::verify::…` in the PTB, then redeploy. Because that version's package id is folded into
the `sid` scope (see [Subscription & sid](#subscription--sid)), this upgrade mints a **new** `sid` for every affected
feed — the client must pick up the newly resolved v2 sids rather than reusing the v1 ones.

In-place Sui upgrades keep one registry but split the client across two ids (type-origin vs.
new-code); an independent package avoids that, trading a re-published registry for a single id
per version.
