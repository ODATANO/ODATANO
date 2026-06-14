# ODATANO Test Suite

This repository contains comprehensive **integration tests** and **unit tests** for the ODATANO project. The tests ensure that all validators, error handling, blockchain backend integrations, transaction builders, signing workflows, and OData service endpoints work correctly.

---

## Test Statistics

- **Total Tests**: 1549 (1545 passed, 4 skipped)
- **Total Test Suites**: 35 (25 unit + 10 integration)
- **Statement Coverage**: 96.58%
- **Branch Coverage**: 88.31%
- **Function Coverage**: 97.68%
- **Line Coverage**: 97.26%
- **Networks**: Cardano Preview testnet
- **Backends**: Blockfrost, Koios, Ogmios
- **TX Builder**: Buildooor (sole builder; CSL was removed in v1.8.0)
- **Milestones Covered**: M1 (Read), M2 (Transaction Build), M3 (External Signing + Plutus Smart Contracts)

---

## Test Structure

```
test/
├── integration/                           # Integration tests (live backend testing)
│   ├── core-test-suite.ts                 # Shared test suite for all backends (76 tests)
│   ├── core.blockfrost.test.ts            # Blockfrost backend test entry
│   ├── core.koios.test.ts                 # Koios backend test entry
│   ├── core-ogmios.test.ts                # Ogmios backend tests (27 tests)
│   ├── error-handling-service.test.ts     # Service-level error validation (96 tests)
│   ├── error-handling.backend.ts          # Backend-level error handling (11 tests)
│   ├── odata_features.test.ts             # OData query feature tests (41 tests)
│   ├── tx-test-suite.ts                   # Transaction builder shared tests (117 tests)
│   ├── tx.buildooor.test.ts               # Buildooor builder integration tests
│   ├── tx-submission-mock.test.ts         # Transaction submission tests (7 tests)
│   ├── tx-error-handling.builder.ts       # TX builder error scenarios (20 tests)
│   ├── tx-handler-validation.test.ts      # Handler input validation (24 tests)
│   ├── signing-services.test.ts           # External signing integration tests (33 tests)
│   ├── test-fixtures.ts                   # Test constants, mock data, CBOR samples
│   ├── mock-helpers.ts                    # Nock-based HTTP mocking for Koios
│   └── backend-test-helper.ts             # Backend configuration helper
├── unit/                                  # Unit tests (isolated component testing)
│   ├── validators.test.ts                 # Validator type guards and helpers (96 tests)
│   ├── errors.test.ts                     # Error classes and utilities (74 tests)
│   ├── cardano-client.test.ts             # CardanoClient configuration (32 tests)
│   ├── cardano-tx-builder.test.ts         # CardanoTransactionBuilder tests (22 tests)
│   ├── blockfrost-backend.test.ts         # Blockfrost backend initialization (11 tests)
│   ├── koios-backend.test.ts              # Koios backend unit tests (7 tests)
│   ├── ogmios-backend.test.ts             # Ogmios backend tests
│   ├── buildooor-tx-builder.test.ts       # Buildooor transaction builder tests
│   ├── tx-build-helper.test.ts            # Transaction helper utilities
│   ├── plutus-placeholders.test.ts        # __INPUT_IDX__ placeholder substitution tests
│   ├── cbor-parse.test.ts                 # ParseTransactionCbor decoder tests
│   ├── derive-script-address.test.ts      # DeriveScriptAddress action tests
│   ├── extract-payment-key-hash.test.ts   # ExtractPaymentKeyHash action tests
│   ├── cardano-service-readonly.test.ts   # @readonly projection enforcement tests
│   ├── signing.test.ts                    # External signing unit tests
│   ├── hsm-signer.test.ts                 # HSM signer unit tests
│   ├── server.test.ts                     # Server initialization & config tests
│   ├── plugin.test.ts                     # CAP plugin bootstrap tests
│   ├── mappers.test.ts                    # Data mappers & address utilities
│   ├── cip14-fingerprint.test.ts          # CIP-14 asset fingerprint tests (11 tests)
│   ├── circuit-breaker.test.ts            # Circuit breaker logic tests (15 tests)
│   ├── concurrency.test.ts                # Concurrency & race condition tests (5 tests)
│   ├── request-coalescer.test.ts          # Request coalescing tests (3 tests)
│   ├── cardano-indexer.test.ts            # Cardano indexer unit tests (19 tests)
│   └── error-paths.test.ts                # Error path coverage tests (8 tests)
└── README.md                              # This file
```

---

## Integration Tests

Integration tests run against **real Cardano blockchain backends** on the **preview network**. Tests are executed against Blockfrost, Koios, and Ogmios backends.

### Test Execution Model

The integration test suite uses a **shared test suite pattern**:
- The same test suite (`core-test-suite.ts`) runs against **multiple backends**
- Transaction tests (`tx-test-suite.ts`) run against the **Buildooor builder**
- Each backend/builder has its own test entry file
- Tests cover **GET (collection/key reads)**, **POST (action/function)**, and **transaction building** scenarios
- All tests validate **cold indexing** (blockchain fetch + DB persistence) and **warm reads** (cached DB retrieval)

### Supported Backends

- **Blockfrost** (`core.blockfrost.test.ts`): Requires `BLOCKFROST_KEY` environment variable
- **Koios** (`core.koios.test.ts`): No API key required, uses `https://preview.koios.rest/api/v1`
- **Ogmios** (`core-ogmios.test.ts`): Requires running Ogmios instance at `OGMIOS_URL`

---

### core-test-suite.ts (76 tests)

Comprehensive shared test suite covering all OData entities with GET and POST operations:

#### M1 — Tested Entities
- **NetworkInformation** (6 tests) — GET collection, POST action, cold/warm indexing
- **Blocks** (6 tests) — GET collection, POST GetBlockByHash, cold/warm indexing
- **Epochs** (6 tests) — GET collection, POST GetEpochByNumber, cold/warm indexing
- **Transactions** (8 tests) — GET collection/key, POST GetTransactionByHash, metadata handling
- **TransactionMetadata** (7 tests) — GET collection/key, POST GetMetadataByTxHash, composite keys
- **Addresses** (18 tests) — GET collection, POST GetAddressByBech32, UTxO and Asset indexing
- **Accounts** (6 tests) — GET collection/key, POST GetAccountByStakeAddress, cold/warm indexing
- **Pools** (6 tests) — GET collection/key, POST GetPoolById, pool metadata
- **Dreps** (6 tests) — GET collection/key, POST GetDrepById, governance data

#### M2/M3 — Related Entities
- TransactionInputs, TransactionOutputs, AddressAssets, AddressUTxOs, UTxOAssets
- TransactionBuilds, SigningRequests

### error-handling-service.test.ts (96 tests)

Service-level input validation and OData error handling across M1, M2, and M3:

- **Transaction errors** (13 tests) — Invalid hashes, format, length, characters
- **Block errors** (5 tests) — Invalid block hashes
- **Epoch errors** (4 tests) — Invalid epoch numbers
- **Address errors** (9 tests) — Invalid/missing addresses, format validation
- **GetLatestTransactionsByAddress** (3 tests) — Address query validation
- **Account errors** (3 tests) — Invalid stake addresses
- **Pool errors** (5 tests) — Invalid pool IDs
- **DRep errors** (3 tests) — Invalid DRep IDs
- **Service availability** (3 tests) — 503 scenarios
- **M2 transaction building errors** — BuildSimpleAdaTransaction, BuildMultiAssetTransaction, BuildMintTransaction, SubmitTransaction, CheckSubmissionStatus
- **M3 signing errors** — CreateSigningRequest, VerifySignature, SubmitVerifiedTransaction

### odata_features.test.ts (41 tests)

OData query feature compliance tests for M1 and M2 entities:

- **$filter** — Comparison operators (gt, lt, eq, and, or)
- **$select** — Field selection and projection
- **$top / $skip** — Pagination with offset
- **$count** — Result counting
- **$orderby** — Sorting (asc/desc)
- **$expand** — Navigation property expansion
- **Combined queries** — Complex query combinations
- **OData query capabilities** — Standard compliance checks
- **M2 entity queries** — TransactionBuilds, SigningRequests query features

---

## Transaction Builder Tests (M2)

M2 milestone adds comprehensive transaction building and submission tests.

### tx-test-suite.ts (117 tests)

Shared test suite for the transaction builder, instantiated by `tx.buildooor.test.ts`:

#### Entity READ Operations (5 tests)
- TransactionBuilds collection reads and key access

#### BuildSimpleAdaTransaction (7 tests)
- Simple ADA transfers, assetsJson multi-asset outputs

#### BuildTransactionWithMetadata (1 test)
- Metadata transaction building

#### BuildMultiAssetTransaction (10 tests)
- Multi-asset transfers, outputDatumJson support

#### BuildMintTransaction (16 tests)
- Token minting with Plutus scripts
- requiredSignersJson — Ed25519 key hash signers
- scriptParamsJson — Parameterized validator support
- inlineDatumJson — Inline datum on recipient output
- mintRedeemerJson — Custom minting redeemer

#### BuildPlutusSpendTransaction (16 tests)
- Plutus spend with validator script + redeemer + script UTxO
- requiredSignersJson, scriptParamsJson, inlineDatumJson support
- lockOnScript — Lock output at enterprise script address

#### SetCollateral (4 tests)
- Collateral selection for Plutus transactions

#### GetBuildDetails / CheckSubmissionStatus (2 tests)
- Build record lookup and submission status checks

#### M3 Signing Operations (4 tests)
- AddressTransactionBuilds reads, GetTransactionBuildsByAddress action

### tx.buildooor.test.ts

Builder integration tests:
- **Buildooor** builder — via Koios backend (the sole transaction builder since v1.8.0)
- Tested with the full case set from `tx-test-suite.ts` + `tx-error-handling.builder.ts`

### tx-error-handling.builder.ts (20 tests)

Transaction-specific error scenarios shared across builders:

- BuildSimpleAdaTransaction — insufficient funds
- BuildTransactionWithMetadata — metadata edge cases
- BuildMultiAssetTransaction — invalid assets, insufficient funds
- BuildMintTransaction — invalid scripts, missing parameters, Plutus failures

### tx-handler-validation.test.ts (24 tests)

Handler-level input validation for M2 and M3 actions:

- **BuildSimpleAdaTransaction validations** — Invalid JSON, missing fields
- **BuildMultiAssetTransaction validations** — Non-array assetsJson
- **BuildMintTransaction validations** — Invalid requiredSignersJson, scriptParams + lockOnScript + fingerprint
- **BuildPlutusSpendTransaction validations** — Invalid scriptParamsJson, lockOnScript
- **CheckSubmissionStatus validations** — Status queries
- **VerifySignature validations** — Input validation
- **SubmitVerifiedTransaction validations** — Missing build_id, full signed tx
- **SetCollateral validations** — No UTxOs at address
- **SubmitTransaction validations** — Submission failure

### tx-submission-mock.test.ts (7 tests)

Transaction submission flow tests with mocked Koios backend:

- Successful submission with and without prior build records
- CBOR handling and transaction hash verification

---

## External Signing Tests (M3)

M3 milestone adds comprehensive external signing and HSM signing workflow tests.

### signing-services.test.ts (33 tests)

External signing service integration tests:

- **CreateSigningRequest** — Create signing request from build record
- **GetSigningRequest** — Retrieve signing request status
- **VerifySignature** — Cryptographic signature verification
- **SubmitVerifiedTransaction** — Verify and submit combined workflow
- **GetSigningRequestsByAddress** — Address-based request lookup
- **GetTransactionBuildsByAddress** — Address-based build lookup
- **HSM Signing Flow** — Hardware Security Module signing integration
- TTL expiration handling (auto-mark as expired)
- CIP-30 witness set combination

### signing.test.ts (62 tests)

External signing module unit tests:

- **SignatureVerifier** — Signature verification, witness extraction, VKey validation
- **ExternalSignerModule** — Signing request creation, status updates, state management
- **combineTransactionWithWitnesses()** — CIP-30 witness set merging (VKeys + scripts)
- **isWitnessSetCbor()** — Witness set vs full transaction CBOR detection
- **Utility Functions** — CBOR helpers, hex validation
- Signing status state transitions (pending → verified → submitted)
- Expired request handling, invalid signature detection

### hsm-signer.test.ts (33 tests)

Hardware Security Module signer unit tests:

- **Constructor** — Initialization and configuration
- **init()** — HSM backend connection, key loading, error scenarios (7 tests)
- **sign()** — Raw payload signing (3 tests)
- **signTransaction()** — Full transaction signing with witness generation (5 tests)
- **getStatus()** — HSM connection status reporting (2 tests)
- **shutdown()** — Graceful HSM disconnection (2 tests)
- **Error codes** — HSM-specific error handling (2 tests)
- **HSM Signer Singleton** — Singleton pattern for HSM module (1 test)

---

## Unit Tests

Unit tests verify individual components in isolation without external dependencies.

### validators.test.ts (96 tests)

Tests for validation type guards and helper functions:

- **isTxHash** — Transaction hash validation (64-char hex)
- **isAssetUnit** — Asset unit validation (policy ID + asset name)
- **isBlockHash** — Block hash validation
- **isValidPoolId** — Pool ID bech32 validation with HRP checking
- **isValidDrepId** — DRep ID bech32 validation (29-byte payload)
- **isValidBech32Address** — Cardano address validation (mainnet/testnet)
- **isValidBech32StakeAddress** — Stake address validation
- **isEpochNumber** — Epoch number range and type validation
- **isValidCbor** — CBOR format validation (even-length hex)
- **validateTransactionInputs** — Composite transaction input validation
- **validateJsonWithLimits** — JSON DoS prevention
- **safeTrimString** — Safe string trimming

### errors.test.ts (74 tests)

Comprehensive error handling tests:

- **BackendError** — Base error class with status codes and error codes
- **NotFoundError** — 404 errors for missing resources
- **ProviderUnavailableError** — 503 errors for backend unavailability
- **RateLimitError** — 429 errors for rate limiting
- **AllBackendsFailedError** — Multi-backend failure scenarios
- **ConfigError** — Configuration validation errors
- **BackendInitError** — Backend initialization failures
- **AllBackendsInitFailedError** — Complete initialization failure
- **InsufficientFundsError** — Insufficient funds for transaction (M2)
- **TransactionValidationError** — Invalid signature/CBOR (M2)
- **TransactionAlreadySubmittedError** — Duplicate transaction (M2)
- **Error utilities** — `getErrorStatus`, `getErrorMessage`, `normalizeBackendError`, `rejectInvalid`, `rejectMissing`

### cardano-client.test.ts (32 tests)

CardanoClient configuration and orchestration tests:

- Constructor validation (empty backends, null/undefined handling)
- Backend initialization sequencing
- Fallback mechanism when primary backend fails
- Multiple backend configuration
- Error propagation and handling
- **evaluateTransaction** — Transaction evaluation via EvaluatingBackend (Ogmios)
- **isEvaluatingBackend** — Type guard for EvaluatingBackend interface

### cardano-tx-builder.test.ts (22 tests)

CardanoTransactionBuilder unit tests:

- **init()** — Builder initialization (constructs `BuildooorTxBuilder` directly), idempotent init, error propagation
- **ensureInitialized()** — Lazy initialization pattern, auto-init on first use
- **reset() / setBuilder()** — Builder state management, custom builder injection
- **buildSimpleAdaTransaction()** — ADA transfer building, UTxO fetching
- **buildTransactionWithMetadata()** — Metadata transaction building
- **buildMultiAssetTransaction()** — Multi-asset transaction building
- **buildMintTransaction()** — Token minting with/without Ogmios evaluator
- **resetTransactionBuilder()** — Factory function for builder reset
- Error handling — UTxO fetch errors, builder errors propagation

### buildooor-tx-builder.test.ts

Buildooor transaction builder unit tests:

- Transaction body construction, CBOR serialization, and coin selection
- Fee calculation and change output creation
- Minting transactions and Plutus spend transactions
- Plutus script handling (V3; V1/V2 rejected at build time)
- Edge cases and error handling

### tx-build-helper.test.ts

Transaction helper utility tests:

- TX hash extraction from CBOR
- PlutusData JSON conversion to Buildooor format
- `normalizeConstructorKey()` — `"constructor"` ↔ `"constr"` recursive conversion
- Address validation and amount conversion utilities
- Script parameter application helpers

### mappers.test.ts (13 tests)

Data mapper and utility tests:

- **mapTransactionInputAssets** (3 tests) — Input asset mapping from blockchain data
- **mapTransactionOutputAssets** (2 tests) — Output asset mapping with fingerprints
- **normalizeCostModels** (5 tests) — Plutus cost model array normalization (V1/V2/V3)
- **scriptHashToEnterpriseAddress** (6 tests) — Script hash → enterprise address derivation (preview/mainnet)

### cip14-fingerprint.test.ts (11 tests)

CIP-14 asset fingerprint computation tests:

- **Official CIP-14 test vectors** (8 tests) — Verified against reference implementation
- **Output format validation** (2 tests) — Bech32 prefix `asset`, length checks
- **Determinism** (2 tests) — Same input always produces same fingerprint

### ogmios-backend.test.ts (39 tests)

Ogmios WebSocket backend unit tests:

- **Constructor** — Connection configuration, URL handling
- **convertOgmiosValue** — Ogmios value format → standard format conversion
- Protocol parameter fetching and normalization
- Transaction submission via WebSocket
- UTxO retrieval and conversion
- Error scenarios and timeout handling

### blockfrost-backend.test.ts (11 tests)

Blockfrost backend unit tests:

- Constructor and initialization with API key
- Transaction submission (mocked)
- Pool query handling
- Address UTxO retrieval
- Protocol parameter fetching

### koios-backend.test.ts (7 tests)

Koios backend unit tests:

- Initialization and configuration
- Basic API operation handling
- Error scenarios

### server.test.ts (23 tests)

Server initialization and configuration tests:

- AppContext creation and lifecycle
- `loadConfigFromEnv()` — Dual config: `cds.env.requires` + environment variables
- `initializeFromConfig()` — Backend and builder initialization sequencing
- Shutdown procedures and cleanup
- Guard logic (`if (appContext) return;`)

### circuit-breaker.test.ts (15 tests)

Circuit breaker pattern tests:

- State transitions: closed → open → half-open → closed
- Failure threshold counting
- Timeout-based recovery
- Backend fault tolerance

### concurrency.test.ts (5 tests)

Concurrency and race condition tests:

- Concurrent backend requests
- Parallel execution safety
- Race condition guards

### request-coalescer.test.ts (3 tests)

Request coalescing pattern tests:

- Concurrent request deduplication for same key
- Failed request cleanup and retry
- Independent key isolation

### cardano-indexer.test.ts (19 tests)

CardanoIndexer edge case and branch coverage tests:

- Entity mapping and UPSERT logic
- Cache TTL validation and refresh
- Error handling for backend failures
- Transaction metadata indexing edge cases

### error-paths.test.ts (8 tests)

Error path coverage tests for edge cases not covered by other test files.

---

## Test Infrastructure

### test-fixtures.ts

Shared test constants and mock data:
- Valid addresses (6 variants), transaction hashes, block hashes
- Test CBOR data (unsigned/signed transactions, witness sets)
- Script fixtures (PlutusV1/V2/V3)
- Mock UTxO arrays (ADA-only, multi-asset, burn scenarios)
- Mock protocol parameters (Koios format)
- `configureBackendForTest()` helper function

### mock-helpers.ts

Nock-based HTTP mocking utilities for Koios backend:
- `setupKoiosMocks()` / `teardownKoiosMocks()` / `resetKoiosMocks()`
- `setupTxResponseMock()`, `setupUtxoMock()`, `setupTxInfoMock()`
- Re-exports `nock` for direct test use

### backend-test-helper.ts

Backend configuration helper for integration test setup.

---

## Running Tests

### All Tests
```bash
npm test
```

### With Coverage Report
```bash
npm run test:coverage
```

### Integration Tests Only
```bash
npm run test:integration
```

### Unit Tests Only
```bash
npm run test:unit
```

### Backend-Specific Tests
```bash
# Blockfrost integration tests (requires BLOCKFROST_KEY)
npm run test:integration:blockfrost

# Koios integration tests
npm run test:integration:koios

# Ogmios integration tests (requires running Ogmios)
npm run test:integration:ogmios
```

### Specific Test Files
```bash
# Run OData feature tests
npm test -- test/integration/odata_features.test.ts

# Run validators unit tests
npm test -- test/unit/validators.test.ts

# Run transaction builder tests
npm test -- test/integration/tx.buildooor.test.ts
```

---

## Prerequisites

- **Node.js** 20+ (or 22+)
- **SQLite** (automatically used by CAP/Jest)
- **For Blockfrost tests**: `BLOCKFROST_KEY` environment variable
- **For Koios tests**: No additional variables needed (URL auto-configured)
- **For Ogmios tests**: Running Ogmios instance at `OGMIOS_URL`

---

## Test Fixtures (Preview Network)

```typescript
const FIXTURE = {
  // Valid transaction hash
  validTxHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
  // Transaction with metadata
  txWithMetadata: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
  // Valid preview address
  validAddress: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
  // Valid block hash
  validBlockHash: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39',
  // Valid DRep ID
  validDrepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
  // Valid stake address
  validStakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
  // Valid pool ID
  validPoolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
  // Metadata label
  transactionMetadataLabel: '1990',
};
```

---

## CI/CD Integration

Tests run automatically on:
- Push to `main` branch
- Pull requests
- Node.js 20.x and 22.x matrix

See [.github/workflows/test.yaml](../.github/workflows/test.yaml) for configuration.
