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
   Scholes generates one as a deterministic hash of all the request item's fields — and returns the
   resolved `sid` in the subscription confirmation (see [Subscription & sid](#subscription--sid)).
2. **Sign.** Block Scholes produces the data as a self-contained **value object** and signs its
   canonical bytes with **one** secp256k1 signature over the whole batch (see §2). A batch is
   **homogeneous by category** — a value or SVI batch — and each entry is a minimal
   `{sid, timestamp, value(s)}`; the signature is batch-level, not per update.
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
`sid` string; if no `sid` is present, Block Scholes generates one by hashing all of the request item's
fields. In every case Block Scholes returns the resolved `sid` string in the **subscription
confirmation**, so the client always learns the final `sid` for each item. The rest of this section
describes the `sid` **Block Scholes generates** (when the client omits one) and how we intend clients to
consume it; a client that supplies its own `sid` owns the same guarantees itself.

**What the `sid` is — identity and integrity.** A `sid` is the immutable identifier for one feed, and
the only thing binding an on-chain `{sid, value}` to a real-world meaning: the verifier proves the bytes
are authentically signed but never interprets them. Two consequences:

- **It fully specifies the value's meaning.** Block Scholes derives the `sid` from the feed's
  fully-qualified name, which encodes every value-affecting property — provider/exchange, asset,
  base/quote, model, expiry, frequency, datatype, and **scale/decimals**. BS stores the `sid ↔ format`
  binding, so a config change (e.g. different `decimals`) gets a **fresh** `sid` and a `sid` never
  changes meaning. Receiving `{sid, value}` therefore tells the consumer exactly how to interpret the
  value.
- **The client can use it as an integrity check on its own side.** Because the `sid` is a deterministic
  commitment to the config, the Predict consumer can reconstruct it from the config of the slot it is
  about to write to and confirm it matches the incoming `sid` before storing — catching **client-side**
  mistakes like mapping a BTC-spot update into an ETH-spot slot, or applying the wrong decimals when
  converting to its on-chain form. The data from BS is already correct and fully specified; this guards
  the consumer's handling of it.

**(a) Subscribe request** — no `sid` supplied, so BS generates one by hashing all of the request
item's fields.

The `options.signing` object controls the signature scheme, and **the data is signed only when it is
present** in the subscription — omit `signing` and the data is streamed **unsigned** (the existing wsAPI
behaviour). When `signing` is present, `type` defaults to `"EVM"`; clients receiving Sui-verified
batches set `type: "SUI"`. In the SUI case: `pkg_ver` selects which verifying-package version Block
Scholes signs for (`1` by default) — a purely off-chain lookup key Block Scholes uses to pick the
target package/registry (see §5); it is never itself part of the signed bytes. `signature_schema`
selects the signing algorithm (`"ecdsa"` by default; `"ed25519"` will be supported in future);
`domain.network` pins the network (`"mainnet"` by default).

Choosing `type: "SUI"` also fixes the **value encoding**: because Move has no signed or
floating-point type, every number is 1e9 fixed-point and signed parameters (SVI `rho`/`m`) are
carried as `*_magnitude` (`u64`) + `*_is_negative` (`bool`). The default/EVM path is unchanged —
normal signed decimals.

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
        "signing": {
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
          "signing": {
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
`batch_kind` and the `values`, each value carrying its own `t` — nothing else needs to be prepended
or reconstructed before verifying (§2). On the SUI path, SVI values are the
**raw on-chain fields** — `svi_b`/`svi_sigma` and the signed `svi_a`/`svi_rho`/`svi_m` as `*_magnitude`
(`u64`, 1e9-scaled) + `*_is_negative` (`bool`) — i.e. exactly the field names and encoding deepbook
ingests, not decimal-scaled floats.

```json
{
  "jsonrpc": "2.0",
  "method": "subscription",
  "params": [
    {
      "data": {
        "batch_kind": 1,
        "values": [
          {
            "sid": "0x9f3a…",
            "t": 1761807600000,
            "svi_a_magnitude": 40000000,
            "svi_a_is_negative": false,
            "svi_b": 100000000,
            "svi_sigma": 200000000,
            "svi_rho_magnitude": 700000000,
            "svi_rho_is_negative": true,
            "svi_m_magnitude": 0,
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
carrying **its own `timestamp`**, signed **once**. A batch is **homogeneous by category** — a
**value batch** or an **SVI batch** — so there are two verify entry points,
`verify_and_create_value_batch` and `verify_and_create_svi_batch`. The signature covers the
**target package's own address, followed by the raw BCS-encoded payload bytes**; the verifier
reconstructs the same prefixed bytes on-chain, so they must be byte-identical (§2.4).

| Data type | Batch kind | `batch_kind` | Verify function |
| --- | --- | --- | --- |
| Spot / forward price | Value batch | `0` | `verify_and_create_value_batch` |
| SVI params | SVI batch | `1` | `verify_and_create_svi_batch` |

The payload is a shared envelope plus the category's vector of typed updates:

| Envelope field | Type | What it is | Role |
| --- | --- | --- | --- |
| `batch_kind` | `u8` | `0` = value, `1` = svi; each verify function asserts its own kind | Category binding — an untrusted relayer can't feed one category to another verifier |
| `updates` | `vector<ValueUpdate \| SviUpdate>` | The category's entries, each with its own `timestamp` (see below) | One signature covers them all |

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
payload's. Prices/params are `u64`, 1e9-scaled fixed point; SVI `a`/`rho`/`m` are signed and
carried as **magnitude + `is_negative`** (`b`/`sigma` are non-negative).

**`ValueUpdate`**

| Field | Type | What it is |
| --- | --- | --- |
| `sid` | `u256` | Series id of the price feed (spot or forward) |
| `timestamp` | `u64` | This series' market-data time (when its value is "as of") |
| `v` | `u64` | The price |

**`SviUpdate`**

| Field | Type | What it is |
| --- | --- | --- |
| `sid` | `u256` | Series id of the SVI smile |
| `timestamp` | `u64` | This series' market-data time |
| `svi_a_magnitude` / `svi_a_is_negative` | `u64` / `bool` | Signed `a` as magnitude + sign |
| `svi_b`, `svi_sigma` | `u64` | SVI parameters (non-negative) |
| `svi_rho_magnitude` / `svi_rho_is_negative` | `u64` / `bool` | Signed `rho` as magnitude + sign |
| `svi_m_magnitude` / `svi_m_is_negative` | `u64` / `bool` | Signed `m` as magnitude + sign |

```move
public struct ValueUpdate has copy, drop {
    sid: u256,
    timestamp: u64,
    v: u64,
}

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

public struct ValueBatch {
    updates: vector<ValueUpdate>,
}

public struct SviBatch {
    updates: vector<SviUpdate>,
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
payload      = BCS(batch)                        // batch_kind, updates[] (each with its own timestamp)
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

## 3. Replay & future-date

Both key off each update's own `timestamp`, split by owner.

**Future-date — the verifier** (oracle-level), enforced per update as the batch is decoded:

```move
assert!(timestamp <= now, EFutureTimestamp);  // not future-dated
```

Rejecting future-dated timestamps keeps the consumer's per-`sid` replay guard from being advanced
past wall-clock (which would block later legitimate updates). Staleness ("too old") is left to the
client layer — the verifier does not bound how old an update may be. A future-dated timestamp
anywhere in the vector aborts the whole batch: the message is malformed, so none of it is trusted.

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

That skip is deliberate, and it is why the timestamp is per update rather than per batch. When a
series' source data hasn't moved, the publisher re-sends it pinned to its **original** timestamp, so
the chain keeps updating at a high frequency with the best data available while explicitly signalling
that the series has not advanced. The consumer reads `last_ts[sid]` and applies its own freshness
policy. Under a batch-level timestamp this was impossible: a pinned series either forced the whole
batch to abort, or had to be re-stamped with a fresh time it hadn't earned.

Note that a skipped update discards its value as well as its timestamp — a pinned timestamp means the
series has not advanced, so its stored value must not move either.

**Why the split.** The verifier is stateless about feeds: it only proves the signed message is
authentic and not future-dated. The consumer owns the per-feed state, so per-`sid` replay/monotonicity
lives there. Staleness is the client's responsibility, so neither the verifier nor the consumer
enforces a max age.

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
`options.signing.pkg_ver: N` tells Block Scholes which verifying-package version to sign for. A new
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

**Client upgrade (v1 → v2):** request `pkg_ver: 2` (`options.signing.pkg_ver`), repoint the Move.toml
dependency at `package_id_2`, reference its `SignerRegistry` object / call `package_id_2::verify::…`
in the PTB, then redeploy.

In-place Sui upgrades keep one registry but split the client across two ids (type-origin vs.
new-code); an independent package avoids that, trading a re-published registry for a single id
per version.
