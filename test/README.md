# ODATANO Test Suite

This repository contains comprehensive  **integration tests**  and **unit tests** for the ODATANO project. The tests ensure that all validators, error handling, blockchain backend integrations, and OData service endpoints work correctly.

---

## Test Structure

```
test/
├── integration/                    # Integration tests (live backend testing)
│   ├── core-test-suite.ts          # Shared test suite for all backends
│   ├── core.blockfrost.test.ts     # Blockfrost backend test entry
│   ├── core.koios.test.ts          # Koios backend test entry
│   ├── error-handling-service.test.ts # Service-level error validation
│   ├── error-handling.backend.ts   # Backend-level error handling
│   ├── odata_features.test.ts      # OData query feature tests
│   └── backend-test-helper.ts      # Backend configuration helper
├── unit/                           # Unit tests (isolated component testing)
│   ├── validators.test.ts          # Validator type guards and helpers
│   ├── errors.test.ts              # Error classes and utilities
│   ├── cardano-client.test.ts      # CardanoClient configuration
│   └── blockfrost-backend.test.ts  # Blockfrost backend initialization
└── README.md                       # This file
```

---

## Integration Tests

Integration tests run against **real Cardano blockchain backends** on the **preview network**. All tests are executed **in parallel against both Blockfrost and Koios backends**, ensuring consistent behavior across different data providers.

### **Test Execution Model**

The integration test suite uses a **shared test suite pattern**:
- The same test suite (`core-test-suite.ts`) runs against **both backends**
- Each backend has its own test entry file (`core.blockfrost.test.ts`, `core.koios.test.ts`)
- Tests cover **both GET (collection/key reads) and POST (action/function) scenarios**
- All tests validate **cold indexing** (blockchain fetch + DB persistence) and **warm reads** (cached DB retrieval)

### **Supported Backends**

- **Blockfrost** (`core.blockfrost.test.ts`): Requires `BLOCKFROST_KEY` environment variable
- **Koios** (`core.koios.test.ts`): No API key required, uses `https://preview.koios.rest/api/v1`

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

#### **Test Patterns**
Each entity is tested with:
- **GET operations**: Collection reads, key-based reads
- **POST operations**: Bound actions and functions
- **Cold indexing**: First-time blockchain fetch with DB persistence
- **Warm reads**: Cached retrieval from database without re-indexing
- **Data validation**: Response structure and field verification

### **error-handling-service.test.ts** (34 tests) (runs against both backends)
Service-level input validation and OData error handling:

- Invalid transaction hashes (format, length, characters)
- Invalid block hashes
- Invalid epoch numbers
- Parameter validation (missing, null, empty)
- OData key validation
- Error code 400 scenarios

### **error-handling.backend.ts**
Backend-level error handling tests (runs against both backends):

- 404 errors (nonexistent resources)
- Backend unavailability
- Timeout handling
- Multi-backend fallback

### **odata_features.test.ts** (28 tests) (runs against both backends)
OData query feature compliance tests:

- **$filter** - Comparison operators (gt, lt, eq, and, or)
- **$select** - Field selection and projection
- **$top** - Result count limiting
- **$skip** - Pagination offset
- **$orderby** - Sorting (asc/desc)
- **$count** - Result counting
- **$expand** - Navigation property expansion
- Complex query combinations

### **Test Fixtures (Preview Network)**
```typescript
{
  validTxHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
  txWithMetadata: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
  validAddress: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
  validBlockHash: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39',
  validDrepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
  validStakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
  validPoolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
}
```

---

## Unit Tests

Unit tests verify individual components in isolation without external dependencies.

### **validators.test.ts** (48 tests)
Tests for validation type guards and helper functions:

- **isTxHash** (7 tests) - Transaction hash validation (64-char hex)
- **isAssetUnit** (8 tests) - Asset unit validation (policy ID + asset name)
- **isBlockHash** (4 tests) - Block hash validation
- **isValidPoolId** (7 tests) - Pool ID bech32 validation with HRP checking
- **isValidDrepId** (4 tests) - DRep ID bech32 validation
- **isValidBech32Address** (6 tests) - Cardano address validation (mainnet/testnet)
- **isValidBech32StakeAddress** (4 tests) - Stake address validation
- **isEpochNumber** (8 tests) - Epoch number range and type validation

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
- **Error utilities** - `getErrorStatus`, `getErrorMessage`, `normalizeBackendError`

### **cardano-client.test.ts** (15 tests)
CardanoClient configuration and initialization tests:

- Constructor validation (empty backends, null/undefined handling)
- Backend initialization sequencing
- Fallback mechanism when primary backend fails
- Multiple backend configuration
- Error propagation and handling

### **blockfrost-backend.test.ts** (1 test)
Backend-specific initialization tests:

- Missing API key error handling
- `BackendInitError` validation
- Configuration mocking and isolation

---

## Running Tests

### **All Tests**
```bash
npm test
```

### **Integration Tests Only**
```bash
npm run test:integration
```

### **Unit Tests Only**
```bash
npm test -- test/unit/
```

### **Specific Test Files**
```bash
# Run Koios integration tests
npm test -- test/integration/core.koios.test.ts

# Run Blockfrost integration tests (requires BLOCKFROST_KEY)
npm test -- test/integration/core.blockfrost.test.ts

# Run OData feature tests
npm test -- test/integration/odata_features.test.ts

# Run validators unit tests
npm test -- test/unit/validators.test.ts
```

---

## Prerequisites

- **Node.js** 20+ (or 22+)
- **SQLite** (automatically used by CAP/Jest)
- **For Blockfrost tests**: `BLOCKFROST_KEY` environment variable
- **For Koios tests**: No additional variables needed (URL auto-configured)

---

## Test Coverage

- **Integration Tests**: All OData entities, indexing patterns, error handling, query features
- **Unit Tests**: Validators, errors, client configuration, backend initialization
- **Total Tests**: 249 test cases
- **Backend Coverage**: Blockfrost and Koios with shared test suite
- **Network**: Cardano Preview testnet

## Fixtures

Backend-specific testing preview data

```ts
const FIXTURE = {
  // valid hash of a preview transaction
  validTxHash:
    "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
  // valid preview hash of a preview transaction with metadata
  txWithMetadata:
    "95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1",
  // valid preview address
  validAddress:
    "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8",
  // valid preview block hash
  validBlockHash:
    "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39",
  // valid preview drep id
  validDrepId: "drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0",
  // valid preview stake address
  validStakeAddress:
    "stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p",
  // valid Metadata label
  transactionMetadataLabel: "1990",
  //  valid preview pool id
  validPoolId: "pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r",
};
```
