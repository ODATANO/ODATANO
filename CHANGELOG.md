# Changelog

All notable changes to ODATANO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
