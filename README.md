# Block Scholes → Predict on Sui — Signed‑Oracle

A working reference integration for the Predict (Mysten/deepbookv3) client: a Block Scholes package that **takes a signed
batch of updates, validates the signature, and produces a gated Move batch struct that can only be
created if the batch is signed and validated** — which a mock Predict oracle then ingests, storing the
verified value per `sid`. A batch is **homogeneous by category**, so there are four paths: a **value
batch** (`{sid, timestamp, v}` — today: spot or forward price) and an **SVI batch**
(`{sid, timestamp, params}`), plus an **absolute** variant of each (`{sid, v}` / `{sid, params}`,
timed by the batch envelope alone). The client sends each category in its own batch and holds the
`sid → {type, expiry, underlying}` mapping itself.

Off‑chain signing and on‑chain verification are **real secp256k1 cryptography, not mocked.** Only the
Block Scholes market data and the Predict consumer contract are mocked.

> Test inventory: 26 Move unit tests (registry + consumer logic + accessors; no network) and 27
> TypeScript tests (8 signer/encoding + 19 live‑signed localnet e2e through a published contract).
> The localnet suite is the real-signature verification gate because Move's test VM cannot sign
> in-process.

---

## Summary — design decisions

- **The gated‑struct pattern.** An off‑chain signer signs a batch of updates; an on‑chain verify
  function — `verify_and_create_value_batch`/`verify_and_create_svi_batch`, or their "absolute"
  counterparts `verify_and_create_value_absolute_batch`/`verify_and_create_svi_absolute_batch`
  `(&SignerRegistry, vector<u8>)` — verifies the one signature over the whole batch and returns a
  gated `ValueBatch` / `SviBatch` / `ValueAbsoluteBatch` / `SviAbsoluteBatch` struct. The struct has
  **no public constructor** and **no abilities**, so the only way one can exist is through the verifier —
  and it must be consumed in the same transaction. The Predict consumer then ingests that
  already‑verified batch and does **zero** crypto itself: it trusts the struct's _type_.
- **Four verify paths, homogeneous batches.** A value update is scalar (`{sid, v}` — today: spot or forward price);
  SVI is a parameter set — each gets its own verify function, plus an "absolute" variant that drops
  the per-update `timestamp` (every entry is as of the batch `timestamp` alone). A signed `batch_kind`
  byte binds each batch to its category, so an untrusted relayer cannot feed one category to another
  verifier. The client guarantees a batch carries a single category.
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
   (absolute variants: same shape, no per-update timestamp —
    verify_and_create_{value,svi}_absolute_batch -> {Value,Svi}AbsoluteBatch ->
    ingest_{value,svi}_absolute_batch)
```

If the signature is bad, the verify step aborts and the consumer step never runs. The gated batch
(`ValueBatch` / `SviBatch` / `ValueAbsoluteBatch` / `SviAbsoluteBatch`) has **no
`copy`/`drop`/`store`/`key` abilities**, so the Sui runtime forces
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
│   │   │   └── verify.move                # verify_and_create_{value,svi}_batch + {value,svi}_absolute_batch (ecrecover == signer); gated ability-less Value/Svi/ValueAbsolute/SviAbsolute Batch + Update + BatchVerified event
│   │   └── tests/
│   │       ├── registry_tests.move        # 5 tests (signer set/rotate + key validation, pause toggle)
│   │       └── verify_tests.move          # 5 no-crypto unit tests (value/SVI + absolute accessors + batch timestamp, pause gate)
│   └── example_consumer/                  # PACKAGE 2 — the consumer (example stand-in for the Predict oracle)
│       ├── sources/oracle.move            # ingest_{value,svi}_batch + {value,svi}_absolute_batch: unpacks each update into its own RawSvi/u128 per sid + last_batch_ts + OracleUpdated/BatchIngested events
│       └── tests/oracle_tests.move        # 16 consumer tests (via verify::new_*_for_testing; no signing)
├── ts/                                    # off-chain signer + relayer + e2e (TypeScript)
│   └── src/
│       ├── config.ts                      # constants, sample data, localnet endpoints
│       ├── signer.ts                      # secp256k1 keys + recoverable sign; {r,s,v}; frameMessage packs the 65-byte wire
│       ├── payloads.ts                    # BCS schema + payload builder + fixed-point / signed SVI encoding + hex utils
│       ├── chain.ts                       # localnet plumbing + publish/set-signer + verify->consumer PTB relay + devInspect reads
│       ├── cli.ts                         # CLI entry: publish | set-signer | relay | publish-{testnet,mainnet} | staging-relay | mark-relay
│       ├── wsapi_client.ts                 # staging wsAPI client (JSON-RPC over websocket) for the signed-batch stream
│       ├── wire_convert.ts                 # wsAPI batch JSON -> the BCS input shapes payloads.ts re-encodes
│       ├── testnet.ts                      # testnet RPC + faucet-funded relayer setup
│       ├── networks.ts                      # per-network wiring: RPC, published ids, relayer key, explorer links
│       └── signer.test.ts / e2e.test.ts   # vitest (unit + localnet e2e)
└── reference/deepbookv3/                  # READ-ONLY clone of MystenLabs/deepbookv3 @ main (not built)
```

---

## 3. The signed batch (wire format)

A Block Scholes feed publishes a **batch**: many typed updates (one per series), each carrying **its own
`timestamp`** (or, for the "absolute" kinds, no per-update timestamp at all — see below), under one
**batch `timestamp`**, signed once. A batch is homogeneous by category — a **value batch**, an **SVI
batch**, or one of their **absolute** counterparts — and all share one envelope.
`message = signature (65 bytes) || payload`. The signature covers
this package's own runtime address (32 bytes) prepended to the raw `payload` bytes
(`secp256k1_ecrecover` keccak‑hashes the prefixed bytes internally) — a domain separator that makes
signatures non‑interchangeable across package versions even though every version's registry shares one
signer key; it is resolved on-chain via `type_name::original_id`, never transmitted or decoded
as a payload field. The `payload` itself is the BCS encoding, **in this exact field order** (TS
`payloads.ts` ↔ Move `verify.move` must match byte‑for‑byte):

| field        | type                                             | meaning                                                                                                                                                |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `batch_kind` | `u8`                                             | `0`/`1`/`2`/`3` = value / svi / value-absolute / svi-absolute; each verify function asserts its own kind (no cross‑feeding by the relayer)             |
| `timestamp`  | `u64`                                            | when the publisher sent this batch — advances every flush, so the feed is visibly alive; for the absolute kinds, also every update's only "as of" time |
| `updates`    | `vector<Value\|Svi\|ValueAbsolute\|SviAbsolute>` | the category's updates — the non-absolute kinds each carrying their own `timestamp`; one signature covers them all                                     |

A **value batch** (`verify_and_create_value_batch`) carries `ValueUpdate` structs; an **SVI batch**
(`verify_and_create_svi_batch`) carries `SviUpdate`. The **absolute** variants
(`verify_and_create_value_absolute_batch` / `verify_and_create_svi_absolute_batch`) carry
`ValueAbsoluteUpdate` / `SviAbsoluteUpdate` — the same fields minus `timestamp`, since every entry in
one of these batches is as of the envelope `timestamp` alone. Neither has a per‑update tag — a batch is
all one category. The `sid` is a `u256` (the full BS hash) and `timestamp` a `u64`; the scaled
values are `u128`, at a fixed-point scale the signer and consumer agree off-chain — the
contract stores them verbatim and never rescales:

| update                | fields                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValueUpdate`         | `sid: u256`, `timestamp: u64`, `v`                                                                                                                                                                |
| `SviUpdate`           | `sid: u256`, `timestamp: u64`, `svi_a_magnitude`, `svi_a_is_negative: bool`, `svi_b`, `svi_sigma`, `svi_rho_magnitude`, `svi_rho_is_negative: bool`, `svi_m_magnitude`, `svi_m_is_negative: bool` |
| `ValueAbsoluteUpdate` | `sid: u256`, `v`                                                                                                                                                                                  |
| `SviAbsoluteUpdate`   | `sid: u256`, `svi_a_magnitude`, `svi_a_is_negative: bool`, `svi_b`, `svi_sigma`, `svi_rho_magnitude`, `svi_rho_is_negative: bool`, `svi_m_magnitude`, `svi_m_is_negative: bool`                   |

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
(cd move/bs_oracle    && sui move test --gas-limit 100000000000)   # 10 pass
(cd move/example_consumer && sui move test --gas-limit 100000000000)   # 16 tests

# 2. Start a local Sui network (separate terminal; Clock = real wall-time)
sui start --with-faucet --force-regenesis

# 3. TypeScript: signer unit tests + full live-signed localnet e2e
cd ts
pnpm install
pnpm test                      # 27 tests (8 signer/encoding + 19 e2e)

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

## 6. Published deployments

Every version is published as a **brand-new package** — never an in-place upgrade — because
`verify.move`'s domain separator _is_ the package id (§5 of `docs/design.md`). So each row below is
a distinct verifier, and a batch signed for one does not verify against another. `bs_oracle`'s
`UpgradeCap` is burned at publish time, which makes that guarantee structural rather than a policy
anyone has to remember.

|                    | mainnet (`35834a8a`)                                                 | testnet (`4c78adac`)                                                 |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bs_oracle`        | `0xa408bcdeb8e7607b1cbb92c088147d61664a6255a3ea5696a8fef44711e113d8` | `0x9d2cf38611d971a0e918b93fc0113d279f5c923f43e62c407a9ad0f9d82f6698` |
| `bs_sid`           | `0xdacaf624c4802c9ff7b8c72447207f5078b78be246f78e143d63e6cd89b4f63d` | `0x6a54299d593fca24edf6b17bf8c3aff0b7ba8bc8f4276e9c1065689c50223bba` |
| `example_consumer` | `0x27382a2058063f29c6adcf32d2489b9b8ce64202b6b2f7606335974764a84316` | `0x54e04f7e68c17e8798996186a0bbdd81bc6ad4dd512d79ee91b0f458a3df24c3` |
| `SignerRegistry`   | `0xc578b6058b0ba9cf2254962168cd779593805c4f10f80aef8749df75ef7fc0e5` | `0x94d0198a6fa973bb457603ed39b39b76c98468114808ad5b518745b7b957c414` |
| `ExampleOracle`    | `0xf10649932629bf99c3107d1b5c1f9be818e03445079d1d2fd7244f76dc0fa7ee` | `0x28267662344c00763d76b4aae1e854086bf8893b9f8ba014b991d833ebbf8362` |
| registered signer  | production                                                           | production                                                           |

The canonical record is each package's `Published.toml` (written by `sui client publish`) plus
`ts/deployment.<network>.json`; the tables above and `ts/src/networks.ts` restate them for readers
and for the relay commands' fallback.

```bash
cd ts
# Publish all three packages and register the signer whose batches this deployment accepts.
# SUI_SIGNER_PUBKEY is the wsAPI signer's 33-byte compressed secp256k1 key — recover it from
# several independent live-signed batches, never from a KMS alias.
SUI_SIGNER_PUBKEY=0x02... pnpm publish-mainnet    # or pnpm publish-testnet

# Relay live wsAPI-signed batches through a published deployment. The network argument and
# SUI_WSAPI_URL must agree: only the environment whose signer that registry holds will verify.
SUI_API_KEY=... pnpm staging-relay mainnet
SUI_API_KEY=... pnpm mark-relay mainnet
```

Each network needs a `sui` CLI env under **its own name** (`sui client new-env --alias mainnet
--rpc <gRPC fullnode>`), since `sui client publish` records `Published.toml` under the active env
name, and a keystore alias to publish from (`mainnet-deployer` / `testnet-deployer`, overridable
with `SUI_DEPLOYER_ALIAS`). The CLI speaks gRPC while this SDK speaks JSON-RPC, and
`fullnode.mainnet.sui.io` has retired the latter — so `SUI_MAINNET_RPC` points at a JSON-RPC
endpoint separately. Mainnet has no faucet: `SUI_MAINNET_PRIVKEY` must name an already-funded
relayer key.

**After any publish**, point `/config/shared/sui_oracle/package_ids` at the new `bs_oracle` id for
that network and confirm the live parameter version actually changed — the id is the signing
domain separator, so a stale one fails every relay with `EBadSigner` long after the publish looked
successful.

---

## 7. Mapping to production / real Block Scholes feeds

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
