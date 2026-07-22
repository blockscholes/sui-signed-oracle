# Block Scholes → Predict on Sui — Signed‑Oracle

A working reference integration for the Predict (Mysten/deepbookv3) client: a Block Scholes package that **takes a signed
batch of updates, validates the signature, and produces a gated Move batch struct that can only be
created if the batch is signed and validated** — which a mock Predict oracle then ingests, storing the
verified value per `sid`. A batch is **homogeneous by category**, so there are two paths: a **value
batch** (`{sid, timestamp, v}` — today: spot or forward price) and an **SVI batch**
(`{sid, timestamp, params}`). The client sends each category in its own batch and holds the
`sid → {type, expiry, underlying}` mapping itself.

Off‑chain signing and on‑chain verification are **real secp256k1 cryptography, not mocked.** Only the
Block Scholes market data and the Predict consumer contract are mocked.

> Test inventory: 21 Move unit tests (registry + consumer logic + accessors; no network) and 22
> TypeScript tests (7 signer/encoding + 15 live‑signed localnet e2e through a published contract).
> The localnet suite is the real-signature verification gate because Move's test VM cannot sign
> in-process.

---

## Summary — design decisions

- **The gated‑struct pattern.** An off‑chain signer signs a batch of updates; an on‑chain verify
  function — `verify_and_create_value_batch` or `verify_and_create_svi_batch`
  `(&SignerRegistry, vector<u8>)` — verifies the one signature over the whole batch and returns a
  gated `ValueBatch` / `SviBatch` struct. The struct has
  **no public constructor** and **no abilities**, so the only way one can exist is through the verifier —
  and it must be consumed in the same transaction. The Predict consumer then ingests that
  already‑verified batch and does **zero** crypto itself: it trusts the struct's _type_.
- **Two verify paths, homogeneous batches.** A value update is scalar (`{sid, v}` — today: spot or forward price);
  SVI is a parameter set — each gets its own verify function. A signed `batch_kind` byte binds each
  batch to its category, so an untrusted relayer cannot feed one category to another verifier. The
  client guarantees a batch carries a single category.
- **Minimal payload; the client owns the `sid` mapping.** An update carries only `sid` + `timestamp` +
  value(s) — no feed type, expiry, or underlying. The Predict client holds the `sid → {type, expiry, underlying}`
  mapping and rebuilds deepbookv3's typed update (`new_spot_update` / `new_forward_update` /
  `new_svi_update`) on its side. Our `sid` is the **full BS hash as a `u256`** (no compaction), so
  Predict widens deepbookv3's `source_id` to `u256` to match.
- **Signature scheme: secp256k1 ECDSA**, verified on‑chain via
  `sui::ecdsa_k1::secp256k1_ecrecover(sig, msg, 0)` (`0` = keccak256), 65‑byte signature. `secp256k1`
  is native on Sui (`0x2::ecdsa_k1`), not EVM‑only. We chose it because it lets Block Scholes reuse an
  existing EVM EIP‑712 key. There is **one** authorized signer: the verifier recovers the signing key
  and requires it to equal the registry's `signer_pubkey` (the EVM `require(ecrecover(...) == signer)`
  model) — payloads name no key, and the key has no expiry (it stays until the admin rotates it).
- **Languages:** on‑chain is **Move** (no choice). Off‑chain, the only Sui submission SDK is
  **TypeScript** (`@mysten/sui`, `@mysten/bcs`) — so our signer + relayer are TypeScript.
- **The client imposes no signing scheme.** The Predict requirement is _structural_: "hand me an
  already‑verified batch of the right type." The signing scheme was genuinely our choice.

---

## 1. The architecture (who calls whom)

No contract "calls" another like a server. A **relayer** (untrusted, permissionless — can be Mysten,
Block Scholes, or a third party) submits **one atomic PTB** (Programmable Transaction Block — a
multicall that threads a return value into the next call):

```
 Block Scholes signer (off-chain, TypeScript)
   builds BCS payload → keccak256 → secp256k1 sign → {r,s,v} → relayer packs 65-byte r||s||v
        │  signed bytes (over HTTP/stream)
        ▼
 Relayer builds ONE PTB (the value path shown; SVI is the same shape):
   ┌── bs_oracle::verify::verify_and_create_value_batch(registry, message) ─────────┐
   │     • split: signature(65) || payload                                           │
   │     • check batch_kind, prepend this package's own runtime address to payload   │
   │     • secp256k1_ecrecover(sig, address||payload, 0) == the authorized signer key │
   │     • RETURNS a gated `ValueBatch` (no abilities, no public ctor)               │
   └───────────────────────────────┬────────────────────────────────────────────────┘
                                   │  the ValueBatch value (same tx)
                                   ▼
   ┌── example_consumer::oracle::ingest_value_batch(oracle, batch, clock) ───┐
   │     • NO crypto — trusts the struct's type                               │
   │     • bounds the millisecond batch timestamp against the Sui Clock       │
   │     • replay guard per sid; a non-advancing update is skipped, not fatal │
   │     • stores the value keyed by sid; emits OracleUpdated + BatchIngested  │
   └──────────────────────────────────────────────────────────────────────────┘
   (SVI: same shape — verify_and_create_svi_batch -> SviBatch -> ingest_svi_batch)
```

If the signature is bad, the verify step aborts and the consumer step never runs. The gated batch
(`ValueBatch` / `SviBatch`) has **no `copy`/`drop`/`store`/`key` abilities**, so the Sui runtime forces
the relayer to consume it in the same transaction — it cannot be stored, duplicated, or silently dropped,
and (because Move only lets a struct be packed in its defining module) it cannot be forged outside the
verifier. This is the on‑chain proof that the data was signed and validated.

---

## 2. Repo layout

```
sui-signed-oracle/
├── move/
│   ├── bs_oracle/                         # PACKAGE 1 — the verifier
│   │   ├── sources/
│   │   │   ├── registry.move              # SignerRegistry (shared) + AdminCap + single-signer (set_signer) + SignerSet event
│   │   │   └── verify.move                # verify_and_create_{value,svi}_batch (ecrecover == signer); gated ability-less {Value,Svi}Batch + ValueUpdate/SviUpdate + BatchVerified event
│   │   └── tests/
│   │       ├── registry_tests.move        # 5 tests (signer set/rotate + key validation, pause toggle)
│   │       └── verify_tests.move          # 3 no-crypto unit tests (value/SVI accessors + batch timestamp, pause gate)
│   └── example_consumer/                  # PACKAGE 2 — the consumer (example stand-in for the Predict oracle)
│       ├── sources/oracle.move            # ingest_{value,svi}_batch: unpacks each update into its own RawSvi/u128 per sid + last_batch_ts + OracleUpdated/BatchIngested events
│       └── tests/oracle_tests.move        # 13 consumer tests (via verify::new_*_for_testing; no signing)
├── ts/                                    # off-chain signer + relayer + e2e (TypeScript)
│   └── src/
│       ├── config.ts                      # constants, sample data, localnet endpoints
│       ├── signer.ts                      # secp256k1 keys + recoverable sign; {r,s,v}; frameMessage packs the 65-byte wire
│       ├── payloads.ts                    # BCS schema + payload builder + fixed-point / signed SVI encoding + hex utils
│       ├── chain.ts                       # localnet plumbing + publish/set-signer + verify->consumer PTB relay + devInspect reads
│       ├── cli.ts                         # CLI entry: publish | set-signer | relay subcommands
│       └── signer.test.ts / e2e.test.ts   # vitest (unit + localnet e2e)
└── reference/deepbookv3/                  # READ-ONLY clone of MystenLabs/deepbookv3 @ main (not built)
```

---

## 3. The signed batch (wire format)

A Block Scholes feed publishes a **batch**: many typed updates (one per series), each carrying **its own
`timestamp`**, under one **batch `timestamp`**, signed once. A batch is homogeneous by category — a
**value batch** or an **SVI batch** — and both share one envelope. `message = signature (65 bytes) || payload`. The signature covers
this package's own runtime address (32 bytes) prepended to the raw `payload` bytes
(`secp256k1_ecrecover` keccak‑hashes the prefixed bytes internally) — a domain separator that makes
signatures non‑interchangeable across package versions even though every version's registry shares one
signer key; it is resolved on-chain via `type_name::original_id`, never transmitted or decoded
as a payload field. The `payload` itself is the BCS encoding, **in this exact field order** (TS
`payloads.ts` ↔ Move `verify.move` must match byte‑for‑byte):

| field        | type                 | meaning                                                                                             |
| ------------ | -------------------- | --------------------------------------------------------------------------------------------------- |
| `batch_kind` | `u8`                 | `0` = value, `1` = svi; each verify function asserts its own kind (no cross‑feeding by the relayer) |
| `timestamp`  | `u64`                | when the publisher sent this batch — advances every flush, so the feed is visibly alive             |
| `updates`    | `vector<Value\|Svi>` | the category's updates, each carrying its own `timestamp`; one signature covers them all            |

A **value batch** (`verify_and_create_value_batch`) carries `ValueUpdate` structs; an **SVI batch**
(`verify_and_create_svi_batch`) carries `SviUpdate`. Neither has a per‑update tag — the batch is all one
category. The `sid` is a `u256` (the full BS hash) and `timestamp` a `u64`; the scaled
values are `u128`, at a fixed-point scale the signer and consumer agree off-chain — the
contract stores them verbatim and never rescales:

| update        | fields                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValueUpdate` | `sid: u256`, `timestamp: u64`, `v`                                                                                                                                                                |
| `SviUpdate`   | `sid: u256`, `timestamp: u64`, `svi_a_magnitude`, `svi_a_is_negative: bool`, `svi_b`, `svi_sigma`, `svi_rho_magnitude`, `svi_rho_is_negative: bool`, `svi_m_magnitude`, `svi_m_is_negative: bool` |

Updates are **carriers, not storage types**: the batch is a hot potato (no abilities, mintable only by
`verify`, must be consumed in the same transaction), and the updates it yields are `copy, drop` but not
`store` — a consumer unpacks them into its own type rather than persisting ours, the same way deepbookv3
decodes its `SVIUpdate` into a storable `RawSVI`.

`sid` is the series id; `timestamp` is that series' market-data time, driving **per-`sid` replay
ordering** in the consumer; a value `v` is a single integer (today: spot or
forward price); SVI `a`/`rho`/`m` are signed, carried as magnitude + `is_negative` (`b`/`sigma` are
non-negative). Because the timestamp is per update, a series whose data hasn't advanced can be re-sent
pinned to its original timestamp: the consumer skips it without failing the batch, so the chain keeps
updating at a high frequency and the client can see that the series did not move.

The **envelope's** `timestamp` answers the other question: when this batch was sent. It advances on
every flush regardless of whether any series moved, so a batch in which every update is pinned and
skipped still proves the publisher is running rather than stalled. `example_consumer` records it as
`last_batch_ts` and emits it on `BatchIngested` for exactly that reason, after enforcing its policy
that the envelope timestamp is in milliseconds and no more than 60 seconds old or 5 seconds ahead
of Sui's `Clock`. The consumer keys storage
by `sid` and the Predict client holds the `sid → {underlying, expiry, type}` mapping, so the verifier
does not interpret values. The verifier proves authenticity and deployment binding only; consumers
enforce freshness and per-`sid` ordering in the timestamp units configured for each feed.

---

## 4. What is REAL vs MOCKED

| Component                                                       | Status   | Notes                                                                  |
| --------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| secp256k1 signing (off‑chain)                                   | **REAL** | `@noble/secp256k1`, keccak256, recoverable sig returned as `{r,s,v}`   |
| Signature verification (on‑chain)                               | **REAL** | `sui::ecdsa_k1::secp256k1_ecrecover`, native Move                      |
| BCS encode/decode parity                                        | **REAL** | `@mysten/bcs` ↔ `sui::bcs::peel_*`                                     |
| The gated `Batch` struct + registry + consumer freshness/replay | **REAL** | full Move logic; covered by unit and live-signed e2e tests             |
| Publishing + PTB relay on a real Sui network                    | **REAL** | sui localnet, real transactions                                        |
| Block Scholes market data (spot/forward/SVI values)             | mocked   | sample BTC numbers in `config.ts`                                      |
| Predict oracle contract                                         | mocked   | `example_consumer` stands in for the client's on‑chain oracle consumer |

---

## 5. How to run & verify

Prereqs: `sui` CLI (tested on 1.74.1; matches CI's `SUI_VERSION`), Node + `pnpm`. No Rust/cargo needed.

```bash
# 1. Move unit tests — consumer logic + accessors, no network required
(cd move/bs_oracle    && sui move test --gas-limit 100000000000)   # 8 pass
(cd move/example_consumer && sui move test --gas-limit 100000000000)   # 13 tests

# 2. Start a local Sui network (separate terminal; Clock = real wall-time)
sui start --with-faucet --force-regenesis

# 3. TypeScript: signer unit tests + full live-signed localnet e2e
cd ts
pnpm install
pnpm test                      # 22 tests (7 signer/encoding + 15 e2e)

# 4. Manual one-shot demo
pnpm publish-packages          # publishes both packages, sets signer, writes deployment.json
pnpm relay                      # signs + relays a value batch (two series) and an SVI batch (timestamp = now-5s); prints on-chain values/last_timestamp
pnpm relay <that-timestamp>     # relay the SAME timestamp again -> transaction succeeds as a no-op (not strictly newer, so each update is skipped and last_timestamp is unchanged), but last_batch_timestamp still advances
```

### Local quality gate

```bash
cd ts
pnpm install                    # also installs the repo pre-commit hook via Husky
pnpm check                      # same local quality gate used by CI
```

The pre-commit hook runs `pnpm -C ts format` first (Prettier, covering both TS and Move sources via
`@mysten/prettier-plugin-move`). If formatting changes files, the commit is blocked so the updated
files can be reviewed and staged. It then runs `scripts/check.sh`, which checks Prettier formatting,
ESLint, strict TypeScript, TS unit tests, and Move tests with lint and warnings-as-errors.

GitHub Actions runs two required jobs on pull requests and pushes to `main`: `Quality and unit tests`
and `Localnet e2e`. Configure the `main` branch protection rule to require both checks before merge.

**Success looks like:** the e2e prints `BatchVerified` (from the bs_oracle package) **and**
`OracleUpdated` (from the example_consumer package) events, and reads back the signed value and SVI values
on‑chain; the replay, bad‑signature, and all the validation‑rejection cases fail as expected.

The e2e happy path is the **definitive proof** that the off‑chain secp256k1 signature verifies
on‑chain via `ecrecover` — in particular that the recovery‑id conversion is correct: the signer
returns `{r,s,v}` with the EVM `v` (`27/28`), and the relayer packs the 65‑byte `r||s||v` wire with
`v` normalized to Sui's `{0,1}` low form. Real signatures are tested only here, not in the
Move unit tests, because Move's test VM has no in‑process signing primitive (no Foundry `vm.sign`
equivalent) — so live signing + a real transaction is the natural place to prove the wire contract.

---

## 6. Mapping to production / real Block Scholes feeds

This reference signs ad‑hoc payloads from a TS script. To productionise:

- Replace the sample data in `payloads.ts` with real Block Scholes feeds (the existing
  `oracleFeedUpdater`‑style stream), keeping the BCS schema identical.
- Move the signing key into **KMS** (matching the EVM `FEED_UPDATER_ROLE` KMS EOA). Note: KMS
  secp256k1 returns a DER signature **without a recovery id** — you must recover `v` by trial
  (a known KMS+ecrecover gotcha).
- Run one or more permissionless **relayers** (Mysten, Block Scholes, or third parties) that fetch the
  signed stream and submit the PTB — the relayer is untrusted.
- Point the consumer at the real Predict oracle (Mysten/deepbookv3 `block_scholes_oracle::update`). It
  maps each verified `sid` to its `{type, expiry, underlying}` and calls `new_spot_update` /
  `new_forward_update` / `new_svi_update` — our `sid` is the full BS hash as a `u256`, so Predict
  widens their `source_id` to `u256` to match (no hash→compact-id mapping needed).
