# ODATANO Test Suite

This repository contains comprehensive **integration tests** and **unit tests** for the ODATANO project. The tests ensure that all validators, error handling, blockchain backend integrations, transaction builders, and OData service endpoints work correctly.

---

## Test Statistics

- **Total Tests**: 692 tests across 19 test suites
- **Statement Coverage**: 96.28%
- **Branch Coverage**: 81.97%
- **Networks**: Cardano Preview testnet
- **Backends**: Blockfrost, Koios, Ogmios

---

## Test Structure

```
test/
├── integration/                        # Integration tests (live backend testing)
│   ├── core-test-suite.ts              # Shared test suite for all backends (71 tests)
│   ├── core.blockfrost.test.ts         # Blockfrost backend test entry
│   ├── core.koios.test.ts              # Koios backend test entry
│   ├── core-ogmios.test.ts             # Ogmios backend test entry
│   ├── error-handling-service.test.ts  # Service-level error validation (34 tests)
│   ├── error-handling.backend.ts       # Backend-level error handling
│   ├── odata_features.test.ts          # OData query feature tests (28 tests)
│   ├── tx-test-suite.ts                # Transaction builder shared tests (M2)
│   ├── tx.csl.test.ts                  # CSL builder integration tests (M2)
│   ├── tx.buildooor.test.ts            # Buildooor builder integration tests (M2)
│   ├── tx-submission-mock.test.ts      # Transaction submission tests (M2)
│   ├── tx-error-handling.builder.ts    # TX builder error scenarios (M2)
│   └── backend-test-helper.ts          # Backend configuration helper
├── unit/                               # Unit tests (isolated component testing)
│   ├── validators.test.ts              # Validator type guards and helpers
│   ├── errors.test.ts                  # Error classes and utilities
│   ├── cardano-client.test.ts          # CardanoClient configuration & evaluateTransaction
│   ├── cardano-tx-builder.test.ts      # CardanoTransactionBuilder tests (M2)
│   ├── blockfrost-backend.test.ts      # Blockfrost backend initialization
│   ├── ogmios-backend.test.ts          # Ogmios backend tests (M2)
│   ├── csl-tx-builder.test.ts          # CSL transaction builder tests (M2)
│   ├── tx-builder-registry.test.ts     # Builder registry tests (M2)
│   └── tx-build-helper.test.ts         # Transaction helper utilities (M2)
└── README.md                           # This file
```

---

## Integration Tests

Integration tests run against **real Cardano blockchain backends** on the **preview network**. Tests are executed against Blockfrost, Koios, and Ogmios backends.

### **Test Execution Model**

The integration test suite uses a **shared test suite pattern**:
- The same test suite (`core-test-suite.ts`) runs against **multiple backends**
- Each backend has its own test entry file
- Tests cover **both GET (collection/key reads) and POST (action/function) scenarios**
- All tests validate **cold indexing** (blockchain fetch + DB persistence) and **warm reads** (cached DB retrieval)

### **Supported Backends**

- **Blockfrost** (`core.blockfrost.test.ts`): Requires `BLOCKFROST_KEY` environment variable
- **Koios** (`core.koios.test.ts`): No API key required, uses `https://preview.koios.rest/api/v1`
- **Ogmios** (`core-ogmios.test.ts`): Requires running Ogmios instance at `OGMIOS_URL`

### **core-test-suite.ts** (71 tests)

Comprehensive shared test suite covering all OData entities with GET and POST operations:

#### **Tested Entities**
- **NetworkInformation** (6 tests) - GET collection, POST action, cold/warm indexing
- **Blocks** (6 tests) - GET collection, POST GetBlockByHash, cold/warm indexing
- **Epochs** (6 tests) - GET collection, POST GetEpochByNumber, cold/warm indexing
- **Transactions** (7 tests) - GET collection/key, POST GetTransactionByHash, metadata handling
- **Addresses** (12 tests) - GET collection, POST GetAddressByBech32, UTxO and Asset indexing
- **TransactionMetadata** (6 tests) - GET collection/key, POST GetMetadataByTxHash, composite keys
- **Accounts** (6 tests) - GET collection/key, POST GetAccountByStakeAddress, cold/warm indexing
- **Pools** (6 tests) - GET collection/key, POST GetPoolById, pool metadata
- **Dreps** (6 tests) - GET collection/key, POST GetDrepById, governance data
- **Related Entities** - TransactionInputs, TransactionOutputs, AddressAssets, AddressUTxOs, UTxOAssets

### **error-handling-service.test.ts** (34 tests)
Service-level input validation and OData error handling:

- Invalid transaction hashes (format, length, characters)
- Invalid block hashes
- Invalid epoch numbers
- Parameter validation (missing, null, empty)
- OData key validation
- Error code 400 scenarios

### **odata_features.test.ts** (28 tests)
OData query feature compliance tests:

- **$filter** - Comparison operators (gt, lt, eq, and, or)
- **$select** - Field selection and projection
- **$top** - Result count limiting
- **$skip** - Pagination offset
- **$orderby** - Sorting (asc/desc)
- **$count** - Result counting
- **$expand** - Navigation property expansion
- Complex query combinations

---

## Transaction Builder Tests (M2)

M2 milestone adds comprehensive transaction building and submission tests.

### **tx-test-suite.ts**
Shared test suite for transaction builders covering:

- Simple ADA transfers
- Multi-asset transactions
- Token minting transactions
- Metadata transactions
- UTXO selection
- Fee calculation
- Change output creation

### **tx.csl.test.ts** & **tx.buildooor.test.ts**
Builder-specific integration tests:

- CSL (Cardano Serialization Lib) builder tests
- Buildooor builder tests
- Both builders tested with identical test cases

### **tx-submission-mock.test.ts**
Transaction submission flow tests:

- Submission to Ogmios
- Submission to Blockfrost
- Submission to Koios
- Failover scenarios
- Error handling (duplicate TX, invalid signature, etc.)

### **tx-error-handling.builder.ts**
Transaction-specific error scenarios:

- Insufficient funds (ODATANO_INSUFFICIENT_FUNDS)
- Invalid input data (ODATANO_INVALID_INPUT)
- Invalid signature (ODATANO_TX_VALIDATION_FAILED)
- Network failure (ODATANO_PROVIDER_UNAVAILABLE)
- Duplicate transaction (ODATANO_TX_ALREADY_SUBMITTED)

---

## Unit Tests

Unit tests verify individual components in isolation without external dependencies.

### **validators.test.ts** (48 tests)
Tests for validation type guards and helper functions:

- **isTxHash** - Transaction hash validation (64-char hex)
- **isAssetUnit** - Asset unit validation (policy ID + asset name)
- **isBlockHash** - Block hash validation
- **isValidPoolId** - Pool ID bech32 validation with HRP checking
- **isValidDrepId** - DRep ID bech32 validation
- **isValidBech32Address** - Cardano address validation (mainnet/testnet)
- **isValidBech32StakeAddress** - Stake address validation
- **isEpochNumber** - Epoch number range and type validation
- **isValidCbor** - CBOR format validation
- **validateTransactionInputs** - Transaction input validation

### **errors.test.ts** (52 tests)
Comprehensive error handling tests:

- **BackendError** - Base error class with status codes and error codes
- **NotFoundError** - 404 errors for missing resources
- **ProviderUnavailableError** - 503 errors for backend unavailability
- **RateLimitError** - 429 errors for rate limiting
- **AllBackendsFailedError** - Multi-backend failure scenarios
- **ConfigError** - Configuration validation errors
- **BackendInitError** - Backend initialization failures
- **AllBackendsInitFailedError** - Complete initialization failure
- **InsufficientFundsError** - Insufficient funds for transaction (M2)
- **TransactionValidationError** - Invalid signature/CBOR (M2)
- **TransactionAlreadySubmittedError** - Duplicate transaction (M2)
- **Error utilities** - `getErrorStatus`, `getErrorMessage`, `normalizeBackendError`

### **cardano-client.test.ts** (24 tests)
CardanoClient configuration and initialization tests:

- Constructor validation (empty backends, null/undefined handling)
- Backend initialization sequencing
- Fallback mechanism when primary backend fails
- Multiple backend configuration
- Error propagation and handling
- **evaluateTransaction** - Transaction evaluation via EvaluatingBackend (Ogmios)
- **isEvaluatingBackend** - Type guard for EvaluatingBackend interface

### **cardano-tx-builder.test.ts** (17 tests)
CardanoTransactionBuilder unit tests:

- **init()** - Builder initialization from registry, idempotent init, error propagation
- **ensureInitialized()** - Lazy initialization pattern, auto-init on first use
- **reset() / setBuilder()** - Builder state management, custom builder injection
- **buildSimpleAdaTransaction()** - ADA transfer building, UTxO fetching
- **buildTransactionWithMetadata()** - Metadata transaction building
- **buildMultiAssetTransaction()** - Multi-asset transaction building
- **buildMintTransaction()** - Token minting with/without Ogmios evaluator
- **resetTransactionBuilder()** - Factory function for builder reset
- **Error handling** - UTxO fetch errors, builder errors propagation

### **ogmios-backend.test.ts** (M2)
Ogmios WebSocket backend tests:

- Connection handling
- Protocol parameter fetching
- Transaction submission
- Error scenarios

### **csl-tx-builder.test.ts** (M2)
CSL transaction builder unit tests:

- Transaction body construction
- UTXO selection logic
- Fee calculation
- Witness set handling

### **tx-builder-registry.test.ts** (M2)
Builder registry pattern tests:

- Builder registration
- Builder selection
- Fallback handling

### **tx-build-helper.test.ts** (M2)
Transaction helper utility tests:

- TX hash extraction from CBOR
- Address validation
- Amount conversion

---

## Running Tests

### **All Tests**
```bash
npm test
```

### **With Coverage Report**
```bash
npm run test:coverage
```

### **Integration Tests Only**
```bash
npm run test:integration
```

### **Unit Tests Only**
```bash
npm run test:unit
```

### **Backend-Specific Tests**
```bash
# Blockfrost integration tests (requires BLOCKFROST_KEY)
npm run test:integration:blockfrost

# Koios integration tests
npm run test:integration:koios

# Ogmios integration tests (requires running Ogmios)
npm run test:integration:ogmios
```

### **Specific Test Files**
```bash
# Run OData feature tests
npm test -- test/integration/odata_features.test.ts

# Run validators unit tests
npm test -- test/unit/validators.test.ts

# Run transaction builder tests
npm test -- test/integration/tx.csl.test.ts
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
