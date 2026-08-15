# Changelog

All notable changes to ODATANO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v2.0.0] - CAP 10, chain crawler / pre-sync, wallet worker

> Shipping first as **v2.0.0-rc.1**, published to npm as `latest` (14-08-2026) —
> a plain `npm i @odatano/core` installs the RC. `^2.0.0` does not match a
> pre-release, so pin `@odatano/core@2.0.0-rc.1` in `package.json`; consumers
> that need to stay on the 1.x line pin `@odatano/core@^1.11.0`.

### ⚠ Breaking

- **SAP CAP 10** — peer dependency is now `@sap/cds >=10` (was `^9`). Consumer projects on CAP 9 must upgrade before adopting `@odatano/core@2`.
- **Node.js >= 22.5** — required by `@cap-js/sqlite` v3 (`node:sqlite` floor).
- **Numeric OData fields serialize as strings** — CAP 10 renders `Decimal`, `Int64` and `$count` values as JSON strings. API clients that parse these fields as JSON numbers must be adapted.
- **XSUAA role separation** — the `$XSAPPNAME.Admin` scope (crawler/worker control) is no longer part of the `CardanoUser` role template or the app authorities; assign the new `CardanoAdmin` template explicitly. Existing `CardanoUser` role collections lose crawler/worker control on redeploy (intentional least-privilege fix).
- **Database redeploy required** — 2.0 adds four tables (`CardanoSyncState`, `CardanoReorgLog`, `CardanoWorkerWallets`, `CardanoWalletJobs`) plus a `dedupKey` column and its unique constraint on the jobs table. Consumers upgrading from 1.x must run `cds deploy`; without it the new services answer `no such table` and `getStatus`/`GetWorkerStatus` return 500. (Verified against a real 1.10 consumer project.)

### Added

- **Chain crawler / pre-sync (opt-in)** — `CRAWLER_ENABLED` / `cds.requires.odatano-core.crawler`: streams the chain forward from a configured start block into `Blocks`/`Transactions` (+inputs/outputs/assets/metadata) so queries hit local data instead of a backend per request. Ogmios chain-sync (native rollForward/rollBackward) with Blockfrost/Koios pagination fallback, parent-hash reorg recovery, cursor (`CardanoSyncState`) + audit log (`CardanoReorgLog`), cluster-safe via DB lease. New **CardanoIndexerService** (`/odata/v4/cardano-indexer/`): SyncState + ReorgLog (read-only), `getStatus` / `pauseCrawler` / `resumeCrawler` (Admin).
- **Wallet worker (opt-in)** — `WALLET_WORKER_ENABLED` / `cds.requires.odatano-core.walletWorker`: asynchronous per-wallet transaction queue (build → sign → submit → confirm) with software/HSM signers, idempotency keys, exponential retry, per-wallet DB leases (multi-instance safe), and a confirmation tracker (crawler hook or polling) with rollback re-submit of the SAME signed CBOR. New **CardanoWorkerService** (`/odata/v4/cardano-worker/`): `SubmitWalletJob` / `CancelJob` / `GetJobStatus` / `GetWorkerStatus` / `PauseWorker` / `ResumeWorker`.
- **CAP events on both v2.0 services** — consumers can subscribe instead of polling.
  `CardanoIndexerService` publishes `blockIndexed` (hash, slot, height, txHashes, tip) and `reorg`
  (forkSlot, forkHeight, blocksRolledBack); `CardanoWorkerService` publishes the terminal
  `jobConfirmed` and `jobFailed` (jobId, walletId, kind, txHash, + errorCode/errorMessage).
  ODATANO runs in the consumer's process as a plugin, so this needs no broker and no
  `cds.requires.messaging`; configuring one later routes the same emits through it. All emits
  happen AFTER the corresponding commit, are fire-and-forget, and swallow subscriber failures so a
  broken observer cannot stall the crawler or a wallet job. Events are absent from `$metadata`
  (OData V4 has no event concept), so the change is additive for existing HTTP clients.
- **KoiosBackend.getDrep** with the new Koios schema.

### Changed

- **Test suite migrated from Jest to Vitest 4** (unit + integration projects, coverage via `@vitest/coverage-v8`). 1908 tests across 58 files (44 unit + 14 integration).
- **Integration suites for both v2.0 subsystems** — `test/integration/wallet-worker.test.ts` (real CAP + real SQLite, backends stubbed: guards the deployed `UNIQUE(walletId, kind, dedupKey)`, real transactions and the OData layer; needs no network or funds) and `test/integration/crawler.test.ts` (real Ogmios: contiguous ingest, recovery from a fork staged while the crawler was down, `getStatus`; self-skips when Ogmios is unreachable or behind the tip, so it runs in both CI lanes).
- **HarmonicLabs stack bumped**: `buildooor` 0.2.9, `cardano-ledger-ts` ^0.5.6, `cardano-costmodels-ts` ~1.6.1 (Plutus V3 cost model at `N_COST_MODEL_PLUTUS_V3` = 350, post-Plomin²).
- **Vendored patches removed** — upstream releases contain both fixes: `keep-relevant.ts` (buildooor keepRelevant) and `auxiliary-data-patch.ts` (ledger-ts Conway tag-259 AuxiliaryData decode).
- Dependency security pass: `axios` ^1.17.1, `fast-uri` ^3.1.5, approuter `body-parser` override — `npm audit` clean (prod + dev).

### Fixed

- Hardening pass from the full-branch review: wallet-worker request transformation for all job kinds (shared parsers in `srv/utils/tx-request-parsers.ts`), crawler reorg guards (null-slot fork point, Blockfrost `CHAIN_POINT_MISMATCH` signal, Koios partial-batch rejection), confirmation-depth correctness across rollbacks, multi-instance-safe crash recovery and lease CAS, idempotency-key release for cancelled jobs.

#### Wallet worker — payment safety (pre-RC review)

- **HSM-backed wallet jobs now require the configured signing role.** `SubmitWalletJob` was gated on `authenticated-user` only, so any authenticated account could queue a value transfer with an arbitrary recipient and amount that the server-held HSM key would sign — bypassing the `hsm.requiresRole` gate the synchronous `SignWithHsm` path enforces. The role is now checked against both the instance's wallet config and the registered wallet row (403, new `ODATANO_FORBIDDEN` code).
- **A crash around submit can no longer cause a duplicate payment.** New durable pre-submit state **`submitting`**: the signed CBOR and its hash are committed *before* the transaction can reach a backend, and the row stays non-terminal so it keeps holding its idempotency key. Interrupted submits are reconciled against the chain — the exact stored bytes are re-submitted, never a rebuild — instead of being failed as `PROCESS_RESTART`, which released the key and let the documented caller retry build and pay a *second* transaction.
- **The per-wallet lease survives long builds.** Only one renewal happened before the build, so a build+sign exceeding `WORKER_LEASE_TTL_MS` (15s — routine with a multi-backend build plus an HSM round-trip) let another instance adopt the wallet while the first kept working. A heartbeat now renews for the whole execution, and ownership is fenced again immediately before the irreversible submit.
- **Idempotency is enforced by the database, not by a lookup.** Unique constraint `(walletId, kind, dedupKey)` via `@assert.unique.dedup` — two concurrent retries of the same key could both read "no such job" and both insert. The loser of the race now returns the winner's job. `dedupKey` carries the caller key while the job owns it and the job's own ID otherwise, so keyless jobs never contend and terminal jobs release the key without depending on per-database NULL semantics.

#### Chain crawler — reorg across a restart

- **Chain-sync recovers from a fork it slept through.** Only a single intersection point (the cursor) was offered to Ogmios, so a cursor orphaned while the crawler was down produced `No intersection found` and killed the ingest pipeline. The crawler now offers a ladder of its own crawled ancestors — dense over the last 10 blocks, doubling out to −16384 — so the node intersects at the last common block and reports an ordinary `rollBackward`, which the existing reorg handling resolves. The dense head keeps shallow rollbacks (the common case) exact instead of rolling back further than necessary.
- **A crashed crawler no longer stays down across restarts.** Every terminal error cleared `desiredRunning`, which no restart undoes — a dropped chain-sync socket (a routine node restart) silently disabled the pre-sync until an operator called `resumeCrawler`. Only unrecoverable configuration failures latch the cluster now; runtime failures leave `syncStatus: error` with `desiredRunning: true` so coming back up resumes.

## [v1.11.0] - 08-08-2026: Coin-selection + error-handling improvements

### Changed

- Enhanced coin-selection logic and error handling in the Buildooor transaction path; Plutus V3 cost-model handling updated to the current parameter count (`N_COST_MODEL_PLUTUS_V3`).
- Vendored `keep-relevant.ts` removed — buildooor 0.2.9 ships the fixed `keepRelevant` upstream.

## [v1.10.0] - 16-07-2026: Deadlock guard + deferred submit

### Added

- **Deferred submit** for in-process consumers: `SubmitVerifiedTransaction`/HSM flows can persist the signed tx and hand the network submit to a detached transaction, with restart re-drive (`redriveInterruptedSubmissions`).
- **Nested-transaction deadlock guard** (`srv/utils/tx-utils.ts`): `detachedTx` with pool-timeout diagnosis and abort fencing; `runWithoutAmbientTx` for CAP ambient-tx isolation.

## [v1.9.2] - 26-06-2026: Typed script-parameter application

### Added

- **Typed script parameters in `applyScriptParameters`** (`srv/utils/tx-build-helper.ts`, new exported `encodeScriptParam` + `ScriptParamUplcType`). A parameter entry may now be `{ "uplc": "data" | "bytes" | "int" | "bool" | "unit", "value": … }`, applied to the parameterized script as a UPLC constant of that **native type** instead of always as `Data`:
  - `data` → `UPLCConst.data(jsonToPlutusData(value))` (value: PlutusData JSON)
  - `bytes` → `UPLCConst.byteString(value)` (value: even-length hex string)
  - `int` → `UPLCConst.int(value)` (value: number | numeric string)
  - `bool` → `UPLCConst.bool(value)` / `unit` → `UPLCConst.unit`

  **Why:** some compilers type scalar parameters natively rather than as `Data` — e.g. Pebble, where `param owner: PubKeyHash` expects a native `bytestring`; applying it as a `Data`-wrapped bytestring makes the validator reject (`case: expected constr or constant value`). The previous Data-only application could not parameterize such scripts. The off-chain side must know each param's UPLC type (which it does — it authors/consumes the contract), and can now mix native and Data params in one call (e.g. a native `PubKeyHash` plus a `Data` `TxOutRef`).

### Changed

- **`applyScriptParameters` is fully backward-compatible in effect.** A **bare PlutusData entry** (e.g. `{ "bytes": "ab.." }`, `{ "constructor": 0, … }`) is treated as shorthand for `{ "uplc": "data", … }` — the Aiken / CIP-57 blueprint convention where every parameter is `Data`. Existing `scriptParamsJson` inputs produce **byte-identical** applied scripts; no consumer or on-chain behavior changes.

## [v1.9.0] - 14-06-2026: Hardening pass — backend resilience, schema correctness, durable signing & tx-build robustness

A broad correctness-and-resilience pass across every layer (PR #60, `dev/general-improvements`). No new OData actions, but several **schema data-type changes**, **error-status changes**, and **public-surface tightenings** that consumers should be aware of. Highlights: all read entities are now `@readonly` (writes → 405), Epoch/Metadata time/label columns widened to avoid overflow/truncation, Ogmios stops fabricating placeholder data and is skipped for unsupported methods, the signing/submit flow is now crash-durable, and Buildooor protocol-param/datum/collateral/metadata handling is hardened.

### Added

- **UTxO-only indexing fallback for `GetUTxOsByAddress`** (`srv/blockchain/cardano-indexer.ts`, `srv/cardano-service.ts`). New `CardanoIndexer.indexAddressUtxos(tx, addr)` indexes only the live UTxO set via `getAddressUtxos` — no `getAddress` (address-aggregation) call and no parent `Addresses` row (same pattern as `indexCredentialUtxos`). `GetUTxOsByAddress` now falls back to it when **no** configured backend supports `getAddress` (detected as `AllBackendsFailedError` with zero collected errors — every backend skipped the method). Net effect: an **Ogmios-only deployment can now serve `GetUTxOsByAddress`** (Ogmios has the live UTxO set but not address aggregation) instead of failing.
- **`SigningInstructions.cardanoCliCommand`** (`srv/utils/types.ts`, `srv/cardano-sign-service.ts`): signing instructions now include a copy-pasteable `cardano-cli` signing recipe for CLI / hardware signers.
- **`extractPaymentCredential(address)`** (`srv/utils/validators.ts`): decodes a Shelley bech32 address to its 28-byte payment-credential hash + an `isScript` flag, or `null` for undecodable / stake addresses. Used to bind signature verification to the build's fee-payer key.
- **`getStatus().backends`** (`src/index.ts`): the programmatic status object now reports the configured backend list via `cardanoClient.listBackends()`.
- **`CardanoBackend.unsupportedMethods?: ReadonlySet<string>`** (`srv/blockchain/backends/cardano-backend.ts`): backends can declare methods they don't support; the orchestrator skips them without counting a circuit-breaker failure.

### Changed

- **All 20 read-service entity projections are now `@readonly`** (`srv/cardano-service.cds`). External `CREATE` / `UPDATE` / `DELETE` against `CardanoODataService` entities now return **HTTP 405** instead of mutating the cache that is served as authoritative blockchain data. Behavior change for any consumer that was (incorrectly) writing to these projections.
- **Schema data-type corrections** (`db/schema.cds`, `db/types.cds`) — these change the OData `$metadata` types consumers see:
  - `Epochs.startTime` / `endTime` / `firstBlockTime` / `lastBlockTime`, `Transactions.blockTime` / `slot`, `Assets.initialMintTime`, `AssetHistory.blockTime`: `Integer` → **`Integer64`** (32-bit Integer overflows for Unix-second timestamps after 2038-01-19).
  - `TransactionMetadata.id`: `Integer` → **`Integer64`** (the metadata label is a uint64; the 32-bit column overflowed for labels > 2³¹).
  - `MetadataLabel` type: `String(5)` → **`String(20)`** (a uint64 label is up to 20 digits; `String(5)` truncated any label above 5 digits).
  - `Assets.assetNameHex`: `HexBytes` (`String(5000)`) → **`String(64)`** (32-byte ledger cap = 64 hex).
  - Key columns `Pools.poolId`, `Dreps.drepId`, `Accounts.stakeAddress`, address fields: `String` → **`Bech32`** (bounded type).
  - `Pools`, `Dreps` and `Assets` entities are now **`temporal`**, so live pool/drep/asset stats refresh on TTL lapse instead of freezing on first index.
- **`ASSET_UNIT_REGEX` tightened to the 32-byte ledger cap** (`srv/utils/const.ts`): asset-name portion bounded to 0-64 hex. `GetAssetInfo` / `GetAssetHistory` descriptions updated from "0-128 hex" to "0-64 hex; ledger caps asset names at 32 bytes". Over-long asset names now reject with a clear 400.
- **`GetAssetHistory` `limit` is clamped to 1-100** (`srv/cardano-service.ts`, `srv/cardano-service.cds`): previously unbounded; now `Math.min(Math.max(limit, 1), 100)`.
- **`SubmitSignedTransaction` now verifies its `network` parameter** against the deployment network (previously silently ignored).
- **Error-status corrections** (consumer-visible HTTP codes):
  - Missing build / submission record → **404 `NotFoundError`**.
  - Malformed tx CBOR → **400 `TX_PARSE_FAILED`**.
  - Script-parameter application failures in `BuildMintTransaction` / `BuildPlutusSpendTransaction` → field-attributed **400**.
  - `AllBackendsFailedError` with no collected errors (every backend skipped the method) now surfaces **503** instead of **502**.
  - `normalizeBackendError`: address-shaped hints (`invalid address` / `malformed address`) now classify as **404** before the generic validation hints; removed `not available` / bare `no data` from the not-found hints so provider **outages** stay **503** (and circuit-breaker-eligible) instead of being mislabeled 404.
- **Durable, crash-safe signing/submit flow** (`srv/cardano-sign-service.ts`):
  - `SubmitVerifiedTransaction` now submits in **3 committed phases** (claim → `submitting`, network submit outside any open DB lock, finalize → `submitted`). A post-accept crash leaves a durable `submitting` record instead of silently reverting to `pending`/`verified` with no on-chain trace.
  - `VerifySignature` atomically claims `pending` → `signed` before verifying, fixing a concurrent-verify double-insert race.
  - Expiry transitions are now status-filtered (only `pending` requests may expire).
  - Signature verification is now **bound to the unsigned tx body's `required_signers` (extra_signatories) plus the build's fee-payer key**, not just any present witness.
- **HSM hardening** (`srv/blockchain/signing/hsm-signer.ts`): rejects on failed verification, fully clears the PIN across singleton + env + config, slot documented as an index.
- **Buildooor tx-build hardening** (`srv/blockchain/transaction-building/buildooor-tx.ts`, `srv/blockchain/cardano-tx-builder.ts`):
  - All protocol parameters mapped with null guards; backend cost-model **arrays converted to named-key form** (raw arrays crash Buildooor's CEK machine); the `TxBuilder` is rebuilt per request when the `network#epoch` fingerprint changes.
  - `datumHash` now carried into resolved `TxOut`s and fabricated script UTxOs so datum preimages reach the witness set (fixes `MissingRequiredDatums` on hash-locked spends).
  - **Collateral**: picks the smallest ADA-only UTxO covering the 5-ADA floor and returns the excess via explicit `collateralReturn`.
  - **Metadata**: text/bytes > 64 bytes are chunked (UTF-8-safe), `0x` byte strings supported, non-integer numbers and invalid labels/keys rejected with clear **400s**.
  - **UPLC 1.0.0 (Plutus V1/V2) scripts are now rejected** at build time instead of being silently hashed as V3 (which produced a wrong policy ID / unspendable address).
  - Force / reference / script UTxOs are verified unspent before building (clear **400** instead of a node-side rejection).
- **`TxBuildRequest.lovelaceAmount` is now typed `string`** (`srv/utils/types.ts`): OData `Lovelace` is `Decimal(20,0)` and arrives as a string at runtime (CAP preserves precision); validators accept `string | number | bigint`.
- **Backend pagination fixes** (`srv/blockchain/backends/*`):
  - Blockfrost: `getAddressUtxos` / account-addresses use the `...All` variants — the plain variants capped at 100 entries and **silently truncated larger wallets**.
  - Koios: `address_txs` sorted newest-first before limiting; transactions fetched via `getTransactionsBatch` instead of an unbounded `Promise.all`; extended `reference_script` object unwrapped.
- **Ogmios data-correctness fixes** (`srv/blockchain/backends/ogmios-backend.ts`):
  - Protocol-parameter **Ratio strings** (e.g. `"3/1000"`) parsed properly — `Number()` previously yielded `NaN` for `rho`, `tau`, `a0` and exec-unit prices; the `rho`/`tau` swap is fixed.
  - `getAccount` extracts lovelace from `{ ada: { lovelace } }` value objects (was rendering `"[object Object]"`).
  - Network-aware epoch geometry via new `EPOCH_CONFIG_BY_NETWORK` and Shelley-anchored slot times from the genesis infos the tx builder uses.
  - Ogmios **no longer fabricates `getAddress` / `getNetworkInformation` placeholder data** (which `preferLive` routing then preferred over correct historical data) and now maps inline datums onto UTxOs.
- **Backend capability routing & resilience** (`srv/blockchain/cardano-client.ts`, `srv/blockchain/circuit-breaker.ts`):
  - Orchestrator skips a backend for any method in its `unsupportedMethods` set without counting a circuit-breaker failure.
  - **All 4xx responses are exempted from the circuit breaker** — a definitive answer from a healthy backend must not take it out of rotation.
  - New `callWithResilience` wraps every single-backend path with a breaker gate + timeout — most importantly `evaluateTransaction`, which previously hung Plutus builds indefinitely on a dead Ogmios socket.
  - Lazy Ogmios reconnect on dead sockets, retryable client init, half-open probe cap.
- **Caching / lifecycle / config robustness** (`srv/server.ts`, `src/plugin.ts`, `srv/blockchain/cardano-indexer.ts`, `srv/blockchain/cardano-client.ts`):
  - `indexTtlMs` is now wired into the indexer's cache TTL (was hardcoded 60s).
  - Config loading moved inside the served-hook `try` (a malformed config previously crashed the **plugin-mode** bootstrap); `bootstrapError` is now set in plugin mode too.
  - Plugin mode now honors `SKIP_AUTO_INIT=true` (matches `srv/server.ts`), so consumer test suites can mount the plugin without opening real backend connections.

### Fixed

- **`mapBlock` stores a real `null` `slotLeader`** instead of a placeholder; BigInt asset-quantity fallback added (`srv/utils/mappers.ts`).
- **Hash-length-only `scriptRef` written into the `Blake2b256` column** for Koios CBOR-truncation cases (`srv/utils/mappers.ts`).
- **Falsy-key guard** in `indexOnMissRead` (`srv/cardano-service.ts`): `key &&` skipped validation for falsy keys like `epoch=0` or an empty string; now an explicit `null`/`undefined` check.
- **`READ AssetHistory` now runs through `handleRequest`** (was returning `req.query` raw, bypassing error handling).
- Malformed witness sets now produce a warning instead of an opaque failure during signing.

### Internal

- **Type-aware ESLint enabled** (`eslint.config.mjs`): `projectService` + curated typed rules, CAP lifecycle hooks exempted, generated/repro artifacts ignored; `src/**` added to `tsconfig.json` include.
- **Dead code removed**: unused exports/request fields (`parseOptionalJson*`, `containsIndexPlaceholder`, `feeLovelace`, `executionUnits`) and their tests; `ProtocolParameters` type imported from the package root; `__INPUT_IDX__` regex made case-insensitive.
- **Tx-building paths consolidated**: shared `_resolveInputRefs`, `_buildSimpleTransfer`, and `_buildMintEntries` across `cardano-tx-builder.ts` and `buildooor-tx.ts`.
- **Test additions**: `indexAddressUtxos` unit tests, OgmiosBackend `unsupportedMethods` cases, and updated error-handling expectations across the unit and integration suites. Suite total now **35 suites (25 unit + 10 integration)**, 1549 tests, 96.58% statement coverage.
- Version bumped `1.8.0` → `1.9.0`.


## [v1.8.0] - 09-06-2026: Drop CSL and make Buildooor the sole transaction builder

Removes the `@emurgo/cardano-serialization-lib-nodejs` (CSL) dependency entirely. Buildooor (`@harmoniclabs/buildooor`) becomes the single transaction-building engine, and all hashing / signature-verification work moves onto the HarmonicLabs raw-CBOR stack. Net effect: **−2806 lines**, one fewer native WASM dependency, and the long-standing Plutus V3 `PPViewHashesDontMatch` bug is resolved by construction.

### Changed

- **Buildooor is now the only transaction builder.** `TxBuilderRegistry` and the builder-factory indirection are gone — `CardanoTransactionBuilder` constructs `BuildooorTxBuilder` directly. `TransactionBuilderName` is narrowed to the single literal `'buildooor'`; the `TX_BUILDERS` env var / `txBuilders` config key is still accepted for backward compatibility but is effectively a no-op (any value resolves to Buildooor). No public read/write OData action signatures changed.
- **Transaction-body hash and Ed25519 signature verification ported off CSL** to `@harmoniclabs/cbor` + `@harmoniclabs/crypto` (`srv/blockchain/signing/signature-verifier.ts`, `srv/utils/tx-build-helper.ts`, `srv/utils/signing-helper.ts`). The body hash is now computed as `blake2b_256` over the **original** transaction-body bytes (`CborArray` index 0, via `subCborRef`) with no re-serialization — so the hash always matches what was signed, and operating at the raw-CBOR level also sidesteps the `@harmoniclabs/cardano-ledger-ts` `AuxiliaryData.fromCbor` bug on metadata-only `aux_data`.

### Fixed

- **CSL `PPViewHashesDontMatch` on Plutus V3 — resolved.** With CSL removed, Buildooor computes the correct `scriptDataHash` for both mint and spend builds (raw-CBOR, byte-preserving body hash), so Plutus V3 transactions no longer fail script-data-hash validation on submit.
- **Buildooor no longer aborts unsigned-tx builds on local script evaluation failure** (`srv/blockchain/transaction-building/buildooor-tx.ts`, commit `8a77cbf`). Buildooor evaluates every Plutus script locally inside `build()`; unlike CSL it would throw if that evaluation errored, turning script-bearing builds (e.g. parameterized validators applied via `scriptParamsJson` + `lockOnScript`) into HTTP 500s. A shared `SCRIPT_BUILD_OPTS` with an `onScriptInvalid` handler now downgrades a local evaluation failure to a warning and still returns the unsigned CBOR + fee estimate — restoring the pre-Buildooor contract where on-chain validation at submit time is authoritative. Validators that pass local evaluation are unaffected, so genuine failures surfaced by Ogmios (`ctx.evaluateTransaction`) are still reported. Fixes the two `tx-handler-validation` cases (`scriptParams + lockOnScript + fingerprint`, `BuildPlutusSpendTransaction — lockOnScript`).
- **`extractVkeyWitnesses` parses witness pairs defensively** (`signature-verifier.ts`): a malformed or unexpected witness structure previously threw a runtime `TypeError` via unchecked CBOR casts and surfaced as an opaque internal error. Entries that are not a `[vkey, signature]` pair of byte strings are now skipped via `instanceof` guards.
- **`getTxHashFromCbor` hex validation rejects odd-length input** (`tx-build-helper.ts`): a hex byte string must be even-length, so `"abc"` now fails with the clear `Invalid input: txCbor must be a valid hex string` instead of a confusing downstream `Failed to parse transaction CBOR`.

### Removed

- **Dependency `@emurgo/cardano-serialization-lib-nodejs`** dropped from `package.json` (it remains only as a transitive, never-imported dependency of `@blockfrost/blockfrost-js`).
- **Source**: `srv/blockchain/transaction-building/csl-tx.ts` (1064 lines) and `srv/blockchain/transaction-building/tx-builder-registry.ts` (69 lines).
- **Tests**: `test/unit/csl-tx-builder.test.ts` (767 lines), `test/unit/tx-builder-registry.test.ts` (172 lines), `test/integration/tx.csl.test.ts`.

### Added

- **Dependencies** promoted to direct: `@harmoniclabs/cbor`, `@harmoniclabs/crypto`, `@harmoniclabs/uint8array-utils` (previously transitive via Buildooor; now imported directly for hashing + signature verification).

### Internal

- **`scripts/testing/lock-ada-at-script-preview.ts`** ported off CSL — `deriveScriptAddress` now uses the same server path (`Script.fromCbor(...).hash` → `scriptHashToEnterpriseAddress`) so a fresh install with CSL removed still resolves all imports and derives an identical enterprise script address.
- **Docs** refreshed to reflect the single-builder architecture: `DEVELOPER_GUIDE.md` source tree (lists `cardano-tx.ts` interface + `buildooor-tx.ts`, registry line removed), plus `QUICK_START.md`, `BACKEND_CONFIGURATION.md`, `PRODUCTION_DEPLOYMENT.md`, `TRANSACTION_WORKFLOW.md`, `INDEXING.md`, and `README.md`.
- **Test suite** migrated off the CSL/registry fixtures across `tx-handler-validation`, `signing-services`, `signing`, `cardano-tx-builder`, `server`, and the shared `tx-test-suite` harness; CI workflows (`test.yaml`, `ogmios-sync.yaml`) updated.
- Version bumped `1.7.9` → `1.8.0`.


## [v1.7.9] - 15-05-2026: Koios getCurrentSlot — wire-shape fix + /tip simplification

### Fixed

- **Koios `/block_info` mapper read `slot_no` / `epoch_slot_no`** — fields that Koios has never returned. The real wire keys are `abs_slot` and `epoch_slot` (stable since Koios v1). Symptom: every call through `KoiosBackend.getLatestBlock()` produced a `BlockData` whose `.slot` and `.epochSlot` were `undefined`, which made the v1.7.8 `getCurrentSlot()` implementation throw `ProviderUnavailableError: koios: latest block has no slot` on every chain-tip query. Cascaded into anything ttl-bounded: x402 nonce checks, ttl-bounded tx builds, `getCurrentSlot`-routed paths on Koios-only deployments. One-line mapping correction at `srv/blockchain/backends/koios-backend.ts:214-216` (`epoch_no` was already correct). Direct `getBlock(hash)` callers also benefit — previously they received a `BlockData` with `undefined` slot fields silently.

### Changed

- **`KoiosBackend.getCurrentSlot()` rewritten to read `/tip` directly.** Previously it called `getLatestBlock()`, which fetched `/tip` and then `/block_info` for that tip's hash — two round-trips for a single integer. The new implementation reads `abs_slot` straight off `/tip`. Side benefits: avoids a real race where `/tip` returns a freshly-minted hash that `/block_info` then returns `[]` for several seconds while Koios's read replicas catch up (was surfacing as a spurious `NotFoundError` propagating out of `getCurrentSlot`), and removes the chain-tip-only path's dependency on `getLatestBlock`'s mapper. Negative-path behavior preserved: empty `/tip` → `NotFoundError`, `/tip` row missing `abs_slot` → `ProviderUnavailableError`.

### Internal

- **Test fixture corrected** in `test/unit/koios-backend.test.ts`: `getCurrentSlot` mock now uses the real Koios `/tip` shape (`abs_slot` / `epoch_slot`) instead of the never-real `slot_no` / `epoch_slot_no`, which is the reason the original mapper bug slipped through unit tests. Two new negative cases added (empty `/tip` returning `NotFoundError` after 3 retries; `/tip` row missing `abs_slot` returning `ProviderUnavailableError`).
- Version bumped `1.7.8` → `1.7.9`.




## [v1.7.8] - 13-05-2026: getCurrentSlot() and isUtxoUnspent() with Multi-Backend Implementations

### Added

- **`CardanoClient.getCurrentSlot(): Promise<number>`** — convenience wrapper over `getLatestBlock().slot` with a guaranteed non-null return. Throws `ProviderUnavailableError` when the backend's latest block reports a null slot (very early chain or backend lag). Centralizes the `null` → error translation that consumers were re-inventing per call site. Method routing: `preferLive: true`.
- **`CardanoClient.isUtxoUnspent(txHash, outputIndex): Promise<boolean>`** — checks whether a UTxO is still spendable. Returns `false` for both spent UTxOs and txs that never existed on chain; throws on transport/provider failure. Replaces x402's prior 3-arg shim (`(txHash, outputIndex, holdingAddress)`) which required a separate `getTransactionByHash` to resolve the address first — saves one chain round-trip per nonce check on the facilitator happy path. Method routing: `preferLive: true`.
- **Per-backend implementations** with edge-case parity across all three providers:
  - **Blockfrost** — `/txs/{hash}/utxos` → `outputs[].consumed_by_tx` (null ⇒ unspent, string ⇒ spent). Output entries are matched by `output_index` (not array position) for defensive ordering. `consumed_by_tx` is an optional field on the Blockfrost openapi type (added in server v0.1.59, mid-2024) — if absent, ODATANO throws `ProviderUnavailableError` so the router falls through to the next backend rather than silently lying with "always true".
  - **Koios** — `POST /utxo_info` with `_utxo_refs: ["<txHash>#<index>"]` and `_extended: false` → `is_spent === false`. Empty response array maps to `false` (nonexistent UTxO). `txHash` is lowercased before building the ref to match Koios's case-sensitive lookups.
  - **Ogmios** — `queryLedgerState/utxo` with `{ outputReferences: [{ transaction: { id: txHash }, index }] }` (schema-typed param shape). Non-empty result ⇒ unspent; empty ⇒ spent OR nonexistent (Ogmios can't distinguish).
- **Fast-path on invalid `outputIndex`** — negative or non-integer values short-circuit to `false` without a network round-trip on all three backends.

### Changed

- **Error semantics for unsupported / provider-down paths** (commit `af17b46`): generic `Error` throws upgraded to typed `ProviderUnavailableError` so callers can branch on the error class and the router's circuit breaker registers them as backend failures rather than uncategorized exceptions. Affected sites:
  - `OgmiosBackend.getDrep`, `getAssetInfo`, `ensureNotShutdown` — capability mismatch + shutdown guard now carry the `ogmios` backend name on the typed error.
  - `CardanoClient.evaluateTransaction` — missing evaluating backend now throws `ProviderUnavailableError` instead of bare `Error`.
- **Transaction-validation errors in tx builders** (commit `af17b46`): missing-script-UTxO throws in `CardanoTransactionBuilder._resolveReferenceInputs` and `BuildooorTxBuilder` are now `TransactionValidationError` instead of generic `Error`. Surfaces as HTTP 400 with a structured code through `handleRequest()` rather than a generic 500.

### Fixed

- **Test typecheck cleanups** (pre-existing on `main`, unblocking `tsc --noEmit`):
  - `test/unit/cardano-tx-builder.test.ts:298` — `ScriptValidator` requires `purpose`; mock validator object was missing it.
  - `test/unit/errors.test.ts:614` — `BackendInitError.originalError` is typed `unknown`; access narrowed via `as Error | undefined`.
  - `test/unit/ogmios-backend.test.ts:500` — `ScriptValidator` is `string | { purpose, index }`; structured branch narrowed via type assertion.
  - `test/unit/plugin.test.ts` — `cds.listeners` / `cds.emit` / `cds.removeAllListeners` are runtime EventEmitter methods not on the public typed `cds` import; single typed alias `cdsBus = cds as unknown as EventEmitter` added.

### Internal

- **`CardanoBackend` interface** (`srv/blockchain/backends/cardano-backend.ts`): two new required method signatures inserted after `getLatestBlock()`. All three backends implement them — no `?:` optional escape hatch.
- **`CardanoClient` routing**: two new `METHOD_ROUTING` entries (`getCurrentSlot`, `isUtxoUnspent`, both `preferLive: true`). No request-coalescing (consistent with other live-tip methods like `getLatestBlock`).
- **Test additions** (mocked, no live preprod): `test/unit/blockfrost-backend.test.ts` (+9 cases — slot null, consumed states, out-of-range/negative index, 404, missing field), `test/unit/koios-backend.test.ts` (+7 cases — is_spent true/false/empty, lowercasing, negative + non-integer index), `test/unit/ogmios-backend.test.ts` (+5 cases — non-empty/empty result, outputReferences shape assertion, negative index), `test/unit/cardano-client.test.ts` (+4 cases — Ogmios-preferred routing + historical fallback for both methods).
- Version bumped `1.7.7` → `1.7.8`.




## [v1.7.7] - 06-05-2026: Self-Hosted Blockfrost-Compatible Backends

### Added

- **`blockfrostCustomBackend` config + `BLOCKFROST_CUSTOM_BACKEND` env var**: optional base URL that redirects ODATANO's Blockfrost backend at a Blockfrost-wire-compatible self-hosted node — Dolos MiniBF, Demeter Self-Hosted, or any compatible proxy. Forwarded straight through to `@blockfrost/blockfrost-js`'s upstream `customBackend` option; the entire Blockfrost surface (blocks, txs, utxos, assets, governance, mint history) works against the self-hosted node with zero ODATANO-side mapping changes.
- **API key becomes optional** when `BLOCKFROST_CUSTOM_BACKEND` is set: the `BlockfrostBackend` constructor now accepts `(network, timeoutMs, projectId, customBackend?)` and requires only `projectId OR customBackend` (matching the upstream SDK validator at `@blockfrost/blockfrost-js/lib/utils/index.js`). When pointed at a customBackend without a key, ODATANO sends `self-hosted` as the `project_id` header — Dolos rejects empty header values even though it doesn't authenticate against them. Startup-log line `Blockfrost will use customBackend: <url>` makes the redirect visible to operators.
- **`CardanoClientConfig.blockfrostCustomBackend?: string`** added to the public TypeScript surface (re-exported from `src/index.ts`). Additive — non-breaking.

### Changed

- **`loadConfigFromEnv` warning** at `srv/server.ts`: the `BLOCKFROST_API_KEY is not set` warning now fires only when both `BLOCKFROST_API_KEY` AND `BLOCKFROST_CUSTOM_BACKEND` are empty — previously a confusing warning would appear for self-hosted setups that only set the URL.

### Internal

- **Light URL validation**: `loadConfigFromEnv` rejects `BLOCKFROST_CUSTOM_BACKEND` values that do not begin with `http://` or `https://` upfront, with a clear error message — matches the existing throw style used for timeout validation.
- **Test additions**: `test/unit/blockfrost-backend.test.ts` constructor describe block expanded to 6 cases (missing-both error path, projectId-only, customBackend-only, customBackend forwarded into SDK, dummy `'self-hosted'` substitution, customBackend omitted when absent). New `test/integration/blockfrost-custom-backend.test.ts` (4 cases) exercises the real SDK against `nock` — the only way to prove URL forwarding actually works end-to-end vs. just being stored on the options object.
- Version bumped `1.7.6` → `1.7.7`.


## [v1.7.6] - 02-05-2026: Inline Datums, Credential Queries, Asset Info, Mint/Burn History

Driven by CHAINFEED's Sprint-1 oracle-adapter integration feedback. Goal: every direct Koios/Blockfrost call CHAINFEED currently bypasses the bridge with should be routable through ODATANO instead.

### Added

- **Inline-datum hydration on `AddressUTxOs`**: `utxodata.inlineDatum` is now populated for every UTxO returned by `GetUTxOsByAddress` / `Addresses.utxos` / cached child rows. Previously the field existed in the schema but was discarded by the Blockfrost mapper, which forced consumers (e.g. Indigo CDP / Liqwid / Minswap V2 readers) to issue ~500 extra `GetTransactionByHash` calls per protocol-state read. New helper `inlineDatumToHex(datum)` in `srv/utils/tx-build-helper.ts` normalizes Blockfrost's CBOR-hex strings, Koios's `_extended` `{bytes, value}` wrapper, and raw `PlutusData` JSON forms to a single canonical lowercase hex CBOR — consistent regardless of which backend served the row.
- **`GetUTxOsByCredential` action** on `CardanoODataService`: returns UTxOs across **all** bech32 forms sharing a 28-byte payment credential (key hash or script hash). Solves the Indigo-style "two bech32 variants of the same script" problem (`addr1z…` with stake-cred vs `addr1w…` without) with a single round-trip. Always-fresh fetch (no cache check) — credential queries serve dApp state-read use cases that need current data. New backend method `getCredentialUtxos(credHash)`, new indexer method `indexCredentialUtxos`, new validator `isValidCredential(s)` (56-char lowercase hex) backed by `HEX_56_REGEX` in `srv/utils/const.ts`. **Koios-only** — `CardanoClient.getCredentialUtxos` throws `ProviderUnavailableError` on Blockfrost-/Ogmios-only deployments rather than silently returning incomplete results from a one-bech32 fallback. Concurrent calls for the same credential are deduplicated through a new `credCoalescer` (analogous to the existing `txCoalescer` / `addrCoalescer`).
- **`Assets` entity + `GetAssetInfo` action**: native-asset metadata lookup (total supply, mint/burn count, initial mint tx, CIP-25 on-chain metadata, CIP-26 off-chain Cardano-Foundation registry fields). Closes the gap that previously forced consumers to call Blockfrost / Minswap directly for supply telemetry. Multi-backend (Blockfrost via `assetsById`, Koios via `POST /asset_info`); Ogmios throws "not supported". Backend divergence is documented in the action description: Blockfrost lacks `initialMintTime` (would need an extra tx fetch), Koios provides it from `creation_time`. New `mapAsset(providerData, max_age)` mapper, new `indexAsset(tx, unit)` indexer method.
- **`AssetHistory` entity + `GetAssetHistory(unit, limit)` action**: paged mint/burn-event lookup for "supply growth rate" telemetry (CHAINFEED Sprint-2 use case for DJED / iUSD adapters). Free-standing (not a Composition) and `@readonly` because mint events are immutable on-chain — UPSERT keyed on `(unit, txHash)` is idempotent. **Koios-preferred routing** in `CardanoClient.getAssetHistory` (provides block timestamps via `block_time`); Blockfrost is the fallback and now backfills `blockTime` / `blockHeight` via concurrent `api.txs(...)` calls (cost: 1 extra API call per history entry, capped at `MAX_CONCURRENT = 10`; failed fetches leave the timestamp fields null rather than aborting the whole call). Both backends derive `action: 'mint' | 'burn'` and absolute `quantity`: Blockfrost from the `action: 'minted'/'burned'` enum, Koios from the sign of `quantity`.
- **`Addresses.utxoCount`**: pre-aggregated UTxO count on the `Addresses` entity. Removes the need for dashboard / health-check consumers to fetch and `.length` the full UTxO array client-side. Populated from the existing `getAddress` response — no extra API call.

### Changed

- **Inline-datum format harmonized across backends**. Previously `AddressUTxOs.utxodata.inlineDatum` and `TransactionInputs/Outputs.utxoData.inlineDatum` could carry hex CBOR (Blockfrost), JSON-stringified PlutusData (Koios `getAddressUtxos`), or a raw object wrapper (Koios `getTransaction`). All three paths now route through `inlineDatumToHex(...)` and produce hex CBOR or `null`. Cached rows from before this release have stale formats until their TTL expires.
- **`Buildooor _parseInlineDatum` removed** from `srv/blockchain/transaction-building/buildooor-tx.ts` — the JSON-string and raw-object branches became defensive dead code after the inline-datum normalization. The remaining call site at `_mapMultiAssetUtxoToLedgerUtxo` now invokes `dataFromCbor(utxo.inlineDatum)` directly. Corresponding branch-coverage tests removed from `test/unit/buildooor-tx-builder.test.ts`.
- **CDS using-clauses**: `db/schema.cds` now imports `Blake2b224` and `HexBytes` (used by the new `Assets` entity); `srv/cardano-service.cds` now imports `AssetUnit` (used as parameter type on the two new asset actions).

### Internal

- **CardanoClient routing matrix expanded** — `getAssetInfo` (preferLive: false, both Blockfrost + Koios), `getAssetHistory` (Koios-preferred, Blockfrost-fallback), `getCredentialUtxos` (Koios-required, throws otherwise). The Koios-/Blockfrost-/Ogmios-feature matrix is now documented in `.claude/CLAUDE.md` under "Backend-Specific Features (no fallback)".
- **Test additions**: `test/unit/tx-build-helper.test.ts` (12 cases for `inlineDatumToHex`), `test/unit/validators.test.ts` (5 cases for `isValidCredential`), `test/unit/blockfrost-backend.test.ts` (+8 cases: address-utxos hydration + asset-info + asset-history), `test/unit/koios-backend.test.ts` (+12 cases: credential-utxos + asset-info + asset-history), `test/unit/cardano-client.test.ts` (4 cases for credential-routing hard-fail), `test/unit/cardano-indexer.test.ts` (+8 cases for `indexCredentialUtxos` / `indexAsset` / `indexAssetHistory`), `test/unit/mappers.test.ts` (+5 cases for `mapAsset`, `mapAssetHistory`, `Address.utxoCount`).
- Version bumped `1.7.5` → `1.7.6`.

### Known limitations

- **Asset entity field availability differs per backend**: `initialMintTime` is null on Blockfrost (would require 1 extra tx fetch per asset); CIP-25 `onchainMetadata` shape varies per minter and is stored as a JSON-stringified `LargeString` (consumers parse it). The action `@description` calls this out.
- **`AddressUTxOs` rows from before this release**: `utxoCount` and the new normalized `inlineDatum` only appear after the parent address's TTL (`indexTtlMs`, default 1 h) lapses and `indexAddress` re-runs.
- **`AssetHistory` Blockfrost cost**: backfilling block metadata costs 1 extra `api.txs(...)` call per entry (see `Added`). For `limit=100`, that's ≤101 Blockfrost calls; consumers paying per-call should size `limit` appropriately. Concurrency capped at `MAX_CONCURRENT = 10`.


## [v1.7.5] - 27-04-2026 - CBOR Tx Parsing + Script Address Utilities + Validity Bounds

### Added

- **`ParseTransactionCbor` action** on `CardanoODataService`: decodes a hex-encoded transaction CBOR (signed or unsigned) into a structured representation (inputs/outputs/fee/witnesses/auxiliary data). Implementation lives in pure utilities at `srv/cbor/parse.ts` and is re-exported from `src/index.ts` for direct programmatic use.
- **CBOR hex validation** for `ParseTransactionCbor`: explicit length cap and hex-shape checks reject oversized payloads upfront (memory-exhaustion guard) and surface dedicated error codes from `srv/utils/error-codes.ts`.
- **`lockOnScript` flag** on `BuildPlutusSpendTransaction`: when `true`, change is sent back to the script address instead of the sender — required for stateful validators that must keep their UTxO under the script.
- **`DeriveScriptAddress` action**: derives the bech32 script address (network-aware) from a Plutus V3 validator hex, optionally applying script parameters first. Useful for clients that need the address before locking funds.
- **`ExtractPaymentKeyHash` action**: bech32-decodes a payment address and returns the 28-byte payment credential hash — convenience for building required-signers / datum fields client-side.
- **Validity-window bounds** (`validityStartMs` / `validityEndMs`): both Build endpoints accept Posix-ms validity bounds. Buildooor converts via `posixToSlot()` using `GENESIS_INFOS_BY_NETWORK` (const.ts); CSL still ignores them pending the PPViewHashesDontMatch fix.

### Changed

- **Buildooor validity-window passthrough**: when no explicit bounds are provided, Buildooor falls back to `DEFAULT_VALIDITY_START_OFFSET_MS` (-2 min) / `DEFAULT_VALIDITY_END_OFFSET_MS` (+1 h) to absorb clock skew while staying generous for human sign+submit latency.
- **`getTxHashFromCbor` parameter rename**: `signedTxCbor` → `txCbor`. The function accepts both signed and unsigned CBOR (hash is body-only). JSDoc and validation error messages updated accordingly.
- **`BlockfrostBackend` constructor**: network is now passed explicitly into `BlockFrostAPI` to fix preprod initialization, which previously fell back to mainnet under certain `cardanoNetwork` resolution paths.
- **Validity-bounds validation** added to `validateTransactionInputs()`: rejects non-numeric values, negative timestamps, more than `MAX_POSIX_MS_DIGITS` (13) digits, and `validityStartMs > validityEndMs`.

### Fixed

- **Forced/reference input UTxO synthesis**: `_resolveForceInputs` and `_resolveReferenceInputs` now copy `dataHash` and `referenceScriptHash` from `Transaction.outputs[]` into the synthesized `UTxO`'s `datumHash` / `scriptRef` fields. Previously dropped, which prevented Buildooor input-side ref-script preservation from seeing them on resolved (non-sender) UTxOs.
- **`forcedInputsUsed` accuracy** (CSL): mint and Plutus-spend paths now derive the count from the actual `_partitionForcedInputs` result instead of `req.forceInputs.length`. Eliminates over-count from request-side duplicates and refs not present in `ctx.utxos`. The Plutus-spend path additionally subtracts the script-UTxO ref so it never counts toward forced inputs.
- **`MAX_POSIX_MS_DIGITS` doc**: corrected the comment ("year 9999" → "Unix ms timestamps through ~Nov 2286"). The 13-digit cap itself is unchanged.

### Internal

- New `srv/cbor/` module: `parse.ts` (decoder) + `index.ts` (barrel). Pure utilities — no CSL or Buildooor dependency.
- Version bumped `1.6.1` → `1.7.5`. Intermediate `1.7.0`–`1.7.3` were not released externally.

## [v1.6.1] - 18-04-2026 - CIP-33 Reference Scripts + Buildooor 0.2.6 Upgrade

### Added

- **CIP-33 reference script deploy** (`referenceScriptHex` parameter): attach a Plutus V3 validator as a referenceScript on the primary output so consumers can deploy ref-scripts through ODATANO instead of bypassing it.
  - Available on `BuildSimpleAdaTransaction`, `BuildMultiAssetTransaction`, `BuildMintTransaction`, `BuildPlutusSpendTransaction`.
  - Supported by both Buildooor and CSL builders. CSL uses `PlutusScript.new_v3()` (CBOR-wrapped) per the v15 hashing rule.
  - Note: attaching a ref script inflates output min-ADA significantly (typically 15–30+ ADA depending on script size). Consumers must supply enough `lovelaceAmount` to cover it — a `TransactionValidationError` is thrown upfront with the required min-ADA if underfunded.
- **Per-extraOutput `referenceScriptHex`**: each entry in `extraOutputsJson` may now carry its own `referenceScriptHex`, enabling "spend + deploy ref-script on a dedicated extra output" flows in a single atomic transaction.
- **Input-side `refScript` preservation** (Buildooor only, Koios-sourced UTxOs): when a forced or reference input carries its ref-script bytes, the Buildooor UTxO mapper now passes them through for local Plutus evaluation. Blockfrost and Ogmios backends return hash-only `scriptRef` today — those UTxOs continue to resolve server-side at validation.

### Changed

- **Buildooor upgrade**: `@harmoniclabs/buildooor` bumped from `^0.1.28` to `^0.2.6`. Buildooor's public API is byte-identical between these versions; the migration is driven entirely by transitive deps.
- **Cardano ledger types**: `@harmoniclabs/cardano-ledger-ts` bumped from `^0.4.6` to `^0.5.1`.
- **Cost models**: `@harmoniclabs/cardano-costmodels-ts` bumped from `~1.3.0` to `~1.4.0`. The 1.4.0 API dropped `.toBuffer()` on `costModelsToLanguageViewCbor()` return values, now a raw `Uint8Array`.
- **CBOR / UPLC encoding sites**: removed `.toBuffer()` on nine call sites in `buildooor-tx.ts`, `csl-tx.ts`, `signing-helper.ts`, `hsm-signer.ts`, `tx-build-helper.ts`, and two integration test sites. The `@harmoniclabs/cbor` 2.x and `@harmoniclabs/uplc` 2.x packages now return `Uint8Array` directly, matching `toHex()` consumption.
- **`applyScriptParameters` (tx-build-helper.ts)**: rewritten for uplc 2.x — `compileUPLC()` now returns `Uint8Array` directly; output `toString()` replaced with `toHex()` (needed because `Uint8Array.toString()` returns a CSV of bytes, not hex).
- **Blockfrost-js pin**: `@blockfrost/blockfrost-js` narrowed from `^6.0.0` to `~6.0.0` to keep nock-based test mocks aligned with the 6.0.x HTTP behaviour (6.1.x retries trigger `times()` mock exhaustion).

### Fixed

- **Buildooor transaction build crashes** with `costModelsToLanguageViewCbor(...).toBuffer is not a function` — root cause was the v1.5.x `cardano-costmodels-ts` pin leaking 1.4.0 through the `^` range. The Buildooor upgrade + removed `.toBuffer()` calls close this permanently.
- **Test suite hygiene** (caused by transitive-dep drift, not production regressions):
  - `cardano-client.test.ts`: `setupBlockfrostHealthMock` was mocking `/api/health`, but `BlockfrostBackend.init()` hits `/api/v0/blocks/latest`. Corrected, plus added `.times(5)` on 500-response mocks to absorb got's default 5xx retries during init.
  - `koios-backend.test.ts`: `fetchWithRetryOnEmpty` performs 1 initial + 3 retries = 4 attempts. Two tests that mocked `.times(2)` were leaking unhandled async errors (via the 2000 ms retry `setTimeout`) into subsequent tests. Corrected to `.times(4)`.
  - `error-paths.test.ts` circuit-breaker test: `nock.pendingMocks()` counting was unreliable because got's internal retries consume multiple HTTP requests per backend-level call. Replaced with `jest.spyOn(backend, 'getNetworkInformation')` to count backend invocations directly.
  - `hsm-signer.test.ts`: `jest.mock('pkcs11js', ...)` now uses `{ virtual: true }` so the suite runs on machines without the optional `pkcs11js` native module installed.
  - `server.test.ts`: removed the stale "should rethrow served hook initialization errors" test — contradicts the served hook's intentional error-swallow (plugin contract: host app must not crash on plugin init failure).

### Internal

- CDS `extraOutputsJson` `@description` expanded to document the new per-entry `referenceScriptHex` field.
- Version bumped `1.5.2` → `1.6.1` (first 1.6.x release).

### Known limitations

- **Hash-only `scriptRef` resolution**: Blockfrost and Ogmios return `referenceScriptHash` only, not the script bytes. A future release may add a `/scripts/{hash}/cbor` resolver so hash-only UTxOs reach Koios parity for local Plutus evaluation.
- **CSL still rejects `__INPUT_IDX__` placeholders**: input-index placeholder substitution remains Buildooor-only (CSL's coin selection is opaque to enumeration).

### Follow-ups (deferred)

- `/scripts/{hash}/cbor` resolver across all three backends.
- Normalizing `UTxO.scriptRef` into separate `referenceScriptHash` and `referenceScript` fields (currently overloaded).
- Upgrading Buildooor beyond 0.2.6.

---

## [v1.0] - 12-03-2026 - Production Release

### Added

- **Request Coalescing**: Deduplicates concurrent backend requests for the same resource, reducing redundant API calls and improving performance under load
- **CardanoIndexer Unit Tests**: 19 new tests covering entity mapping, cache TTL validation, error handling, and metadata indexing edge cases
- **Request Coalescer Tests**: 3 new tests for concurrent deduplication, retry-after-failure, and key isolation
- **Expanded Test Coverage**: Additional branch coverage tests for validators, backends, transaction handlers, and builders

### Changed

- **Hardened Error Handling**: Improved null/undefined guards across service layer, address flags, and debug logging
- **Protocol Parameters Refresh**: Hardened refresh logic with improved input validation and datum mapping
- **Koios Backend Resilience**: Added retry-on-empty-array for block and epoch queries, null/array validation before array access
- **Service Layer Resilience**: Strengthened error propagation, edge case handling, and fallback behavior
- **Performance Optimizations**: Batch methods and request coalescing for transaction fetching (N+1 query elimination)
- **Authentication**: Added `@requires: 'authenticated-user'` on all 3 services with XSUAA production configf

### Fixed

- Type safety improvements across codebase
- Edge cases in protocol parameter parsing and cost model handling
- Plutus datum mapping errors for spend transactions with Koios/Buildooor combination
- Various small bugs in backend logic and service handlers

### Documentation

- Updated all documentation to v1.0
- Reworked performance report with raw benchmark result files
- Updated test statistics: 31 test suites (21 unit + 10 integration), 1285 tests, 99% statement coverage

### Stats

- **Test Suites**: 31 (21 unit + 10 integration)
- **Tests**: 1285 (all passing)
- **Statement Coverage**: 99%
- **CDS Entities**: 29
- **Actions**: 34 (15 read + 11 transaction + 8 signing)
- **Services**: 3 (CardanoODataService, CardanoTransactionService, CardanoSignService)
- **Backends**: 3 (Blockfrost, Koios, Ogmios)

---

## [v0.3-milestone3] - 26-02-2026 - Milestone 3: External Signing & SAP Integration

### Added

- **External Signing Module**: Complete external signing workflow with private key isolation
  - `ExternalSignerModule` - Signing request creation and workflow management
  - `SignatureVerifier` - Cryptographic signature verification
  - CIP-30 browser wallet support (Nami, Eternl, Yoroi, etc.)
  - Cardano CLI signing support
  - HSM signing support (PKCS#11 compatible hardware wallets)

- **CardanoSignService** (`/odata/v4/cardano-sign/`): New dedicated signing workflow service (3rd CDS service)

- **5 New Entities** for signing workflow:
  - `SigningRequests` - Unsigned transaction export with TTL-based expiration
  - `SignatureVerifications` - Cryptographic verification results and audit trail
  - `AddressSigningRequests` - Address-to-signing-request associations
  - `AddressTransactionBuilds` - Address-to-build associations
  - `AddressTransactions` - Address transaction history with net amounts

- **5 External Signing Actions** (OData POST endpoints on CardanoSignService):
  - `CreateSigningRequest` - Create signing request for external signing
  - `GetSigningRequest` - Retrieve signing request (auto-expires if TTL exceeded)
  - `VerifySignature` - Cryptographically verify signed transaction
  - `SubmitVerifiedTransaction` - Verify and submit in one step
  - `GetSigningRequestsByAddress` - Get signing requests for an address

- **Centralized App Context Architecture**: Refactored initialization in `server.ts`
  - `getAppContext()` - Get singleton application context
  - `getCardanoIndexer()` - Convenience function for services
  - `getCardanoClient()` - Convenience function for services
  - `createTestContext()` - Create isolated test contexts
  - `shutdownAppContext()` - Graceful connection cleanup

- **CIP-30 Wallet Integration**:
  - `combineTransactionWithWitnesses()` - Combine unsigned TX with CIP-30 witness set
  - `isWitnessSetCbor()` - Detect witness set vs full transaction
  - Automatic handling in SubmitVerifiedTransaction

- **HSM Signing Integration** (Hardware Security Module):
  - `SignWithHsm` - Sign transaction using configured HSM (PKCS#11)
  - `SignAndSubmitWithHsm` - Sign and submit transaction atomically via HSM
  - `GetHsmStatus` - Check HSM connection status, key info, and Cardano address

- **Signing Workflow States**: `SigningStatus` enum
  - `pending` - Request created, awaiting signing
  - `signed` - Transaction has been signed
  - `verified` - Signature verified, ready for submission
  - `submitted` - Transaction submitted to network
  - `expired` - Request expired (30 minute default TTL)
  - `failed` - Signing or verification failed

- **New Test Suites** (5 new test files):
  - `signing-services.test.ts` - External signing integration tests
  - `signing.test.ts` - SignatureVerifier and ExternalSignerModule unit tests
  - `hsm-signer.test.ts` - HSM signer unit tests
  - `cip14-fingerprint.test.ts` - CIP-14 asset fingerprint computation tests
  - `tx-build-helper.test.ts` - Transaction build helper utility tests

- **Production Deployment Guide**: `PRODUCTION_DEPLOYMENT.md` with deployment patterns (incl. BTP)

- **SAP Integration Examples**: New guide with detailed examples of SAP workflows integrated with ODATANO, including screenshots and ABAP code snippets for real-world use cases (e.g., invoice payment verification, tokenized asset management)

- **Security Guide**: `SECURITY.md` with best practices for secure deployment, key management, and external signing workflows

- **Postman Collection M3**: Pre-configured requests for all M3 endpoints (signing, Plutus, HSM)

- **2 New Transaction Actions** (Plutus Smart Contracts & Collateral):
  - `BuildPlutusSpendTransaction` - Spend UTxO locked at a Plutus validator script address (supports PlutusV3, redeemer/datum JSON, Ogmios execution unit evaluation, optional `inlineDatumJson` for state-machine continuing outputs)
  - `SetCollateral` - Ensure a dedicated ADA-only collateral UTxO exists for Plutus transactions (auto-checks address UTxOs, builds self-send if needed)

- **End-to-End Plutus Scripts**:
  - `lock-ada-at-script-preview.ts` - Lock ADA at a PlutusV3 script address with inline datum
  - `plutus-spend-preview.ts` - Spend locked UTxO with redeemer, verified on Preview testnet
  - `send-ada-hsm-preview.ts` - HSM signing workflow on Preview testnet
  - `sign-cbor.ts` - Offline CBOR signing (Cardano CLI pattern)

- **Plutus Parameterized Validator Support**:
  - `scriptParamsJson` on `BuildMintTransaction` and `BuildPlutusSpendTransaction` — apply UPLC parameters to unapplied validators, returns `scriptHash` (= policy ID)
  - `requiredSignersJson` — set `required_signers` in tx body for Plutus `extra_signatories` checks
  - `inlineDatumJson` on `BuildMintTransaction` — attach inline datum on minted token output (for spend validators that read `InlineDatum`)
  - `inlineDatumJson` on `BuildPlutusSpendTransaction` — attach inline datum on continuing output (state-machine patterns)
  - `mintRedeemerJson` — custom redeemer for minting policy (defaults to integer 0)
  - `fingerprint` — CIP-14 asset fingerprint (`asset1...`) returned in `BuildMintTransaction` response

- **`lockOnScript`** on `BuildMintTransaction` and `BuildPlutusSpendTransaction`:
  - When `true` and `scriptParamsJson` is provided, routes the output to the enterprise script address derived from the applied script hash
  - Returns `scriptAddress` (bech32) in the response — eliminates consumer-side script address computation
  - New `scriptAddress` field on `TransactionBuilds` entity

- **Extended Transaction Actions for Script Locking**:
  - `BuildSimpleAdaTransaction` now supports optional `outputDatumJson` and `assetsJson` — send ADA + native assets with inline datum to script addresses
  - `BuildMultiAssetTransaction` now supports optional `outputDatumJson` — attach inline datum when sending assets to script addresses

### Changed

- Architecture refactored to centralized App Context pattern
- Services now use `getCardanoIndexer()` instead of direct instantiation
- Test suite updated: 29 test files (19 unit + 10 integration), 1122 tests
- Enhanced error handling with signing-specific error cases

---

## [v0.2-milestone2] - 2025-01-25 - Milestone 2: Transaction Build & Submit

### Added

- **Transaction Builder Module**: Dual-builder architecture with CSL (Cardano Serialization Lib) and Buildooor engines
- **Transaction Types**: Support for 4 transaction types
  - Simple ADA transfers
  - Token minting with policy scripts
  - Multi-asset transfers (ADA + native tokens)
  - Transactions with metadata
- **6 Transaction Actions** (OData POST endpoints):
  - `BuildSimpleAdaTransaction` - Build simple ADA transfer
  - `BuildTransactionWithMetadata` - Build ADA transfer with metadata
  - `BuildMintTransaction` - Build token minting transaction
  - `BuildMultiAssetTransaction` - Build multi-asset transfer
  - `SubmitTransaction` - Submit signed transaction to Cardano
  - `SubmitSignedTransaction` - Submit externally built transaction
- **Ogmios Live Backend**: WebSocket-based real-time data access for protocol parameters, UTxO queries, and transaction submission
- **TX Builder Registry**: Factory pattern for runtime builder selection and initialization
- **End-to-End Example Scripts**:
  - `send-ada-preview.ts` - Simple ADA transfer workflow
  - `mint-token-preview.ts` - Token minting workflow
  - `send-ada-with-metadata-preview.ts` - Metadata transaction workflow
  - `send-multi-asset-preview.ts` - Multi-asset transfer workflow
- **Postman Collection M2**: Pre-configured requests for all transaction endpoints
- **Transaction Error Handling**: 5 specialized error scenarios
  - Insufficient funds (`ODATANO_INSUFFICIENT_FUNDS`)
  - Invalid input data (`ODATANO_INVALID_INPUT`)
  - Invalid signature (`ODATANO_TX_VALIDATION_FAILED`)
  - Network failure (`ODATANO_PROVIDER_UNAVAILABLE`)
  - Duplicate transaction (`ODATANO_TX_ALREADY_SUBMITTED`)
- **327 new tests** (6 new test suites): Ogmios Tests, Transaction builder tests (CSL, Buildooor), mocked submission tests, error handling tests
- **Transaction Workflow Documentation**: Build → Sign → Submit flow guide

### Changed

- Extended multi-provider architecture: Ogmios (live) + Blockfrost (primary historical) + Koios (fallback)
- Updated test suite: 692 tests across 19 test suites (from 340 tests / 11 suites)
- Enhanced error handling with 8 specialized error classes

### Technical Details

- UTXO selection: LargestFirstMultiAsset strategy
- Fee calculation: Based on current protocol parameters
- Output format: CBOR hex (unsigned transactions)
- External signing: Cardano CLI, browser wallets, hardware wallets supported

---

## [v0.1-milestone1] - 2024-12-29 - Milestone 1: OData Read Service

### Added

- **Project Infrastructure**
  - Public GitHub repository with Apache 2.0 license
  - SAP CAP project structure with complete scaffolding
  - CI/CD pipeline with automated tests on Node.js 20.x and 22.x
  - Code coverage reporting via Codecov (96%+ statement, 81%+ branch)
  - Docker deployment support

- **OData V4 Service** (`/odata/v4/cardano-odata`)
  - Full OData V4 query support: `$filter`, `$select`, `$expand`, `$top`, `$skip`, `$count`, `$orderby`
  - SAP Fiori UI annotations for rapid UI development
  - Multi-network support: mainnet, preview, preprod

- **18 Entities** defining Cardano Core Components:
  - `NetworkInformation` - Network statistics (supply, stake)
  - `Blocks` - Block headers
  - `Epochs` - Epoch summaries
  - `Transactions` - Transaction details with inputs/outputs
  - `TransactionInputs` - Inputs of a transaction
  - `TransactionOutputs` - Outputs of a transaction
  - `TransactionInputAssets` - Assets per transaction input
  - `TransactionOutputAssets` - Assets per transaction output
  - `TransactionMetadata` - Transaction metadata by tx + label
  - `Addresses` - Address balances and metadata
  - `AddressAssets` - Native assets at an address
  - `AddressUTxOs` - Unspent outputs at an address
  - `UTxOAssets` - Assets contained in a specific UTxO
  - `Pools` - Stake pools
  - `Accounts` - Stake accounts
  - `Dreps` - Delegated representatives
  - `AddressTransactions` - Address transaction history
  - `LedgerProtocolParameters` - Protocol parameters

- **15 Read Actions** (OData POST endpoints):
  - `GetNetworkInformation`
  - `GetBlockByHash`
  - `GetEpochByNumber`
  - `GetTransactionByHash`
  - `GetMetadataByTxHash`
  - `GetAddressByBech32`
  - `GetUTxOsByAddress`
  - `GetAssetsByAddress`
  - `GetPoolById`
  - `GetAccountByStakeAddress`
  - `GetDrepById`
  - `GetLatestTransactionsByAddress`
  - `GetLatestBlock`
  - `GetLatestEpoch`
  - `GetLedgerProtocolParameters`

- **Multi-Provider Architecture**
  - Blockfrost (primary, 8s timeout)
  - Koios (fallback, 10s timeout)
  - Automatic failover on timeout, network error, or backend error
  - Response normalization into canonical internal data model

- **Lazy On-Demand Indexing**
  - Data fetched from Cardano on first access
  - Persisted with TTL-based refresh (configurable via `INDEX_TTL_MS`)
  - Temporal entities: only currently valid rows returned
  - No background jobs; all refresh is request-driven

- **Input Validation**
  - Transaction/pool/drep IDs: 64-char hex validation
  - Addresses: network-aware bech32 validation
  - Stake addresses: network-aware bech32 stake HRP validation

- **340 Tests** across 11 test suites:
  - Integration tests for Blockfrost and Koios backends
  - OData query feature tests
  - Error handling and failover tests
  - Input validation tests

- **Documentation Package**
  - Quick Start Guide
  - Developer Guide (architecture, setup, development)
  - User Guide (deployment, querying, examples)
  - Docker Deployment Guide
  - Data Model Documentation
  - Indexing Concept Documentation
  - Error Handling Documentation
  - Postman Collection M1

### Technical Stack

- SAP CAP v9.x
- TypeScript v5.9
- Node.js v20.x / v22.x
- SQLite (persistent caching via @cap-js/sqlite)
- Jest v29.x (testing)

---

## Links

- [GitHub Repository](https://github.com/ODATANO/ODATANO)
- [v1.0 Release](https://github.com/ODATANO/ODATANO/releases/tag/v1.0)
- [Milestone 1 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1)
- [Milestone 2 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.2-milestone2)
- [Milestone 3 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.3-milestone3)
- [Catalyst Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk)
