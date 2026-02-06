# ODATANO Developer Guide

**Project:** ODATANO - OData V4 Service for Cardano Blockchain\
**Version:** 0.3.0 (Milestone 3)\
**Status:** Production-Ready - 25 test files, 96%+ coverage\
**Last Updated:** February 2026

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Setup](#quick-setup)
3. [Core Components](#core-components)
4. [App Context Pattern](#app-context-pattern)
5. [External Signing Module](#external-signing-module)
6. [Error Handling](#error-handling)
7. [Testing](#testing)
8. [Deployment](#deployment)

---

## Architecture

### Service Surface

**25+ Entities:** NetworkInformation, Blocks, Epochs, Pools, Dreps, Transactions, TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionOutputAssets, TransactionMetadata, Accounts, Addresses, AddressAssets, AddressUTxOs, UTxOAssets, TransactionBuilds, TransactionBuildInputs, TransactionBuildOutputs, TransactionSubmissions (M2), SigningRequests, SignatureVerifications, AddressSigningRequests, AddressTransactionBuilds, AddressTransactions (M3)

**11 Read Actions:** GetNetworkInformation, GetBlockByHash, GetEpochByNumber, GetPoolById, GetDrepById, GetAccountByStakeAddress, GetTransactionByHash, GetMetadataByTxHash, GetAddressByBech32, GetUTxOsByAddress, GetAssetsByAddress

**6 Transaction Actions (M2):** BuildSimpleAdaTransaction, BuildTransactionWithMetadata, BuildMultiAssetTransaction, BuildMintTransaction, SubmitTransaction, SubmitSignedTransaction

**8 External Signing & Plutus Actions (M3):** CreateSigningRequest, GetSigningRequest, VerifySignature, SubmitVerifiedTransaction, GetSigningRequestsByAddress, GetTransactionBuildsByAddress, BuildPlutusSpendTransaction, SetCollateral

### Layered Architecture

```
HTTP Client → OData Service (cardano-service.ts / cardano-tx-service.ts)
    ↓
App Context (server.ts: getCardanoIndexer(), getCardanoClient())
    ↓
CardanoIndexer + CardanoTransactionBuilder
    ↓
CardanoClient (Multi-Backend Orchestrator)
    ↓
Backends: Ogmios (live) + Blockfrost → Koios Fallback
    ↓
Transaction Builders: CSL / Buildooor
    ↓
External Signing Module (M3): ExternalSignerModule + SignatureVerifier
    ↓
SQLite Cache (temporal entities)
```

### Data Flow

```
1. HTTP Request → Service Handler
2. Input Validation (isTxHash, isBech32Address, etc.)
3. Cache Check (SELECT from DB)
4. On miss: Fetch from blockchain (Blockfrost/Koios)
5. Transform & Store (mappers → UPSERT)
6. Return OData response
```

---

## Quick Setup

```bash
# Install
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci

# Configure
cp .env.example .env
# Edit .env: Set BLOCKFROST_KEY, NETWORK=preview

# Development (TypeScript, live reload, no .js files)
npm run cds:watch

# Production (compiles TypeScript → JavaScript)
npm start

# Testing
npm test             # Run tests
npm run test:coverage # Coverage report
```

**Development vs Production:**

- **`npm run cds:watch`** - Development mode using `ts-node`, runs TypeScript directly, no `.js` files generated, auto-reloads on changes
- **`npm start`** - Production mode, compiles TypeScript to JavaScript (`.js` files gitignored), optimized for deployment

### Key Files

```
srv/
  server.ts              # App Context initialization (M3)
  cardano-service.cds    # Read entity/action definitions
  cardano-service.ts     # Read handler implementations
  cardano-tx-service.cds # Transaction + Signing service definitions
  cardano-tx-service.ts  # Transaction + Signing handler implementations
  blockchain/
    cardano-client.ts    # Multi-backend orchestrator
    cardano-indexer.ts   # Lazy indexing & caching
    cardano-tx-builder.ts # Transaction builder coordinator (M2)
    backends/
      blockfrost-backend.ts  # Historical provider
      koios-backend.ts       # Fallback provider
      ogmios-backend.ts      # Live WebSocket provider (M2)
    transaction-building/    # M2 Transaction Builders
      csl-tx.ts              # Cardano Serialization Lib builder
      buildooor-tx.ts        # Buildooor builder
      tx-builder-registry.ts # Builder factory
    signing/                 # M3 External Signing
      external-signer.ts     # Signing request creation & workflow
      signature-verifier.ts  # Cryptographic signature verification
  utils/
    validators.ts        # Input validation (10+ functions)
    errors.ts            # Error hierarchy (11 classes)
    mappers.ts           # API → OData transformations
    tx-build-helper.ts   # Transaction utilities (M2)
    signing-helper.ts    # CIP-30 witness combination (M3)
    backend-request-handler.ts  # DB transaction wrapper

db/schema.cds          # 25+ entities with temporal support
config/config.ts       # Timeouts, network, TTL, builders
test/                  # 20 test files (integration + unit)
```

---

## Core Components

### 1. Service Handler (srv/cardano-service.ts)

**Entity Handler Pattern:**

```typescript
this.on('READ', Transactions, async (req: Request) => {
    const hash = req.data?.hash;
    
    // Validate input
    if (hash && !isTxHash(hash)) {
        return rejectInvalid(req, 'Transactions', 'Invalid hash format', 'hash');
    }
    
    // Use handleRequest wrapper for automatic error handling
    return handleRequest(req, async (db) => {
        if (hash) {
            const existing = await db.run(SELECT.one.from(Transactions).where({ hash }));
            if (existing) return existing; // Cache hit
            return await indexer.indexTransaction(db, hash); // Index from blockchain
        }
        return db.run(req.query);
    });
});
```

**Action Handler Pattern:**

```typescript
this.on('GetTransactionByHash', async (req: Request) => {
    const hash = req.data?.hash;
    
    if (!hash) return rejectMissing(req, 'Transactions', 'hash');
    if (!isTxHash(hash)) return rejectInvalid(req, 'Transactions', 'Invalid hash', 'hash');
    
    return handleRequest(req, async (db) => {
        let row = await db.run(SELECT.one.from(Transactions).where({ hash }));
        if (!row) row = await indexer.indexTransaction(db, hash);
        return row;
    });
});
```

### 2. Input Validators (srv/utils/validators.ts)

```typescript
// Transaction hash: 64 hex characters
export const isTxHash = (s: string): boolean => /^[a-fA-F0-9]{64}$/.test(s);

// Bech32 address validation
export const isBech32Address = (s: string): boolean =>
    /^(addr1|stake1|addr_test1|stake_test1)[0-9a-z]+$/.test(s);

// Policy ID: 56 hex characters
export const isPolicyId = (s: string): boolean => /^[a-fA-F0-9]{56}$/.test(s);
```

**Usage:** Always validate input BEFORE blockchain calls to prevent unnecessary API requests.

### 3. Error Hierarchy (srv/utils/errors.ts)

```typescript
BackendError              // Base class (500)
├── NotFoundError         // Resource not found (404)
├── ProviderUnavailableError  // Timeout/unavailable (503)
├── RateLimitError        // Rate limit exceeded (429)
├── ConfigError           // Configuration error (500)
├── BackendInitError      // Init failed (500)
├── AllBackendsFailedError    // All backends failed (503)
├── AllBackendsInitFailedError // All init failed (500)
├── InsufficientFundsError    // Not enough UTxOs (400) - M2
├── TransactionValidationError // Invalid signature/CBOR (400) - M2
└── TransactionAlreadySubmittedError // Duplicate TX (409) - M2

// Helper functions
rejectMissing(req, entity, field)       // Missing parameter (400)
rejectInvalid(req, entity, msg, field)  // Invalid input (400)
```

### 4. Indexing Layer (srv/blockchain/cardano-indexer.ts)

**Lazy On-Demand Indexing:**
- Data fetched from blockchain only when first requested
- Temporal entities (Addresses, Accounts) with TTL-based refresh
- Non-temporal entities (Transactions, Blocks) persist permanently
- UPSERT operations for automatic insert/update
- Related entities indexed atomically

See [Indexing Concept](../concepts%20&%20architecture/INDEXING.md) for details.

---

## App Context Pattern

### Overview (srv/server.ts)

M3 introduced a centralized App Context pattern that manages all blockchain components as a singleton:

```typescript
interface AppContext {
  cardanoClient: CardanoClient;
  cardanoIndexer: CardanoIndexer;
  cardanoTxBuilder: CardanoTransactionBuilder;
}
```

### Key Functions

```typescript
// Get the singleton context (must be called after CAP bootstrap)
getAppContext(): AppContext

// Convenience functions for services
getCardanoIndexer(): CardanoIndexer
getCardanoClient(): CardanoClient

// Test utilities
createTestContext(backends, txBuilderName?, protocolParams?): Promise<AppContext>
resetAppContext(context: AppContext | null): void
shutdownAppContext(): Promise<void>
```

### Usage in Services

```typescript
// In cardano-service.ts or cardano-tx-service.ts
import { getCardanoIndexer, getCardanoClient } from './server';

srv.on('GetTransactionByHash', async (req: Request) => {
  return handleRequest(req, async (db) => {
    // Use shared indexer instance
    return await getCardanoIndexer().indexTransaction(db, hash);
  });
});

srv.on('SubmitVerifiedTransaction', async (req: Request) => {
  return handleRequest(req, async (db) => {
    // Use shared client instance
    await getCardanoClient().submitTransaction(signedTxCbor);
  });
});
```

### Bootstrap Process

The context is automatically initialized when CAP starts:

```typescript
cds.on('served', async () => {
  if (env.SKIP_AUTO_INIT === 'true') return; // For tests

  const config: CardanoClientConfig = {
    network: env.NETWORK || 'preview',
    backends: env.BACKENDS?.split(',') || ['koios'],
    // ... other config from environment
  };

  appContext = await initializeAppContext(config);
});
```

### Test Context Management

```typescript
// In test setup
beforeAll(async () => {
  const testContext = await createTestContext(['koios'], 'csl');
  resetAppContext(testContext);
});

afterAll(async () => {
  await shutdownAppContext(); // Clean up connections
});
```

---

## External Signing Module

### Overview (srv/blockchain/signing/)

M3 provides complete external signing workflow with private key isolation:

### ExternalSignerModule

```typescript
// Create signing request for external signing
createSigningRequest(buildId, unsignedTxCbor, txBodyHash, network, message): UnsignedTxExportPayload

// Verify signed transaction cryptographically
verifySignedTransaction(signedTxCbor, expectedTxBodyHash): SignatureVerificationResult

// Workflow state management
createWorkflowState(request): SigningWorkflowState
markAsSigned(state, signedTxCbor): SigningWorkflowState
markAsVerified(state, result): SigningWorkflowState
markAsSubmitted(state, txHash): SigningWorkflowState
```

### SignatureVerifier

```typescript
// Verify without throwing
verify(signedTxCbor, options?): SignatureVerificationResult

// Verify with throwing on failure
verifyOrThrow(signedTxCbor, options?): SignatureVerificationResult

// Utility functions
extractTxBodyHash(txCbor): string
isSigned(txCbor): boolean
getWitnessCount(txCbor): number
```

### Signing Workflow States

```typescript
enum SigningStatus {
  PENDING = 'pending',      // Request created, awaiting signing
  SIGNED = 'signed',        // Transaction signed externally
  VERIFIED = 'verified',    // Signature cryptographically verified
  SUBMITTED = 'submitted',  // Transaction submitted to blockchain
  EXPIRED = 'expired',      // TTL exceeded (30 minutes default)
  FAILED = 'failed',        // Signing or verification failed
}
```

### CIP-30 Wallet Support (srv/utils/signing-helper.ts)

```typescript
// Combine unsigned TX with CIP-30 wallet witness set
combineTransactionWithWitnesses(unsignedTxCbor, witnessSetCbor): string

// Detect if CBOR is witness set (CIP-30) or full transaction
isWitnessSetCbor(cborHex): boolean
```

---

### 5. Multi-Backend Failover (srv/blockchain/cardano-client.ts)

```typescript
async getTransaction(hash: string): Promise<Transaction> {
    await this.ensureInitialized();
    const errors: BackendError[] = [];

    for (let i = 0; i < this.backends.length; i++) {
        const backend = this.backends[i];
        const timeout = i === 0 ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;

        try {
            return await Promise.race([
                backend.getTransaction(hash),
                new Promise((_, reject) => setTimeout(() => 
                    reject(new ProviderUnavailableError(`Timeout ${timeout}ms`)), timeout))
            ]);
        } catch (err) {
            errors.push(normalizeBackendError(err, backend.constructor.name));
        }
    }
    throw new AllBackendsFailedError('getTransaction', errors);
}
```

---

## Error Handling

### Status Code Mapping

| HTTP | Scenario | Example |
|------|----------|---------|
| 200 | Success | Transaction found |
| 400 | Bad Request | Invalid hash format, missing parameter |
| 404 | Not Found | Transaction/address doesn't exist |
| 429 | Rate Limit | Too many requests |
| 500 | Internal Error | Configuration error |
| 503 | Service Unavailable | Provider timeout, all backends failed |

### Error Flow

```
HTTP Request
    ↓
Input Valid? → NO → 400 (rejectInvalid/rejectMissing)
    ↓ YES
Cache Hit? → YES → 200 OK
    ↓ NO
Provider Request
    ├─→ 200 OK (success)
    ├─→ 404 Not Found
    ├─→ 429 Rate Limit
    ├─→ 503 Timeout/Unavailable
    └─→ 500 Internal Error
```

### Implementation

```typescript
// Validation errors (400)
if (!hash) return rejectMissing(req, 'Transactions', 'hash');
if (!isTxHash(hash)) return rejectInvalid(req, 'Transactions', 'Invalid hash', 'hash');

// Backend errors (automatic via handleRequest wrapper)
return handleRequest(req, async (db) => {
    // All BackendErrors caught and normalized automatically
    const tx = await indexer.indexTransaction(db, hash);
    return tx;
});
```

---

## Testing

### Test Structure

```
test/
├── integration/                        # Integration tests (live backend)
│   ├── core-test-suite.ts              # Shared read tests
│   ├── core.blockfrost.test.ts         # Blockfrost execution
│   ├── core.koios.test.ts              # Koios execution
│   ├── core-ogmios.test.ts             # Ogmios execution (M2)
│   ├── error-handling-service.test.ts  # Error validation tests
│   ├── odata_features.test.ts          # OData V4 query tests
│   ├── tx-test-suite.ts                # Transaction builder tests (M2)
│   ├── tx.csl.test.ts                  # CSL builder tests (M2)
│   ├── tx.buildooor.test.ts            # Buildooor builder tests (M2)
│   ├── tx-submission-mock.test.ts      # Submission tests (M2)
│   └── signing-services.test.ts        # External signing tests (M3)
└── unit/                               # Unit tests (isolated)
    ├── validators.test.ts              # Validator tests
    ├── errors.test.ts                  # Error class tests
    ├── cardano-client.test.ts          # Client tests
    ├── cardano-tx-builder.test.ts      # TX Builder tests
    ├── blockfrost-backend.test.ts      # Blockfrost backend tests
    ├── koios-backend.test.ts           # Koios backend tests
    ├── ogmios-backend.test.ts          # Ogmios backend tests (M2)
    ├── csl-tx-builder.test.ts          # CSL builder tests (M2)
    ├── tx-builder-registry.test.ts     # Registry tests (M2)
    ├── tx-build-helper.test.ts         # TX Helper tests (M2)
    └── signing.test.ts                 # Signing module tests (M3)
```

**Current Status:** 25 test files, 96%+ coverage

### Running Tests

```bash
npm test                          # All tests
npm run test:coverage             # With coverage report
npm run test:integration          # Integration only
npm run test:unit                 # Unit only
npm test -- core.blockfrost.test.ts  # Specific file
npm test -- --watch               # Watch mode
```

### Test Example

```typescript
import cds from '@sap/cds';

describe('CardanoODataService', () => {
    let GET: Function, POST: Function;

    beforeAll(async () => {
        const server = await cds.test('serve', '--in-memory');
        ({ GET, POST } = server);
    });

    test('GetTransactionByHash - valid tx', async () => {
        const { data } = await POST('/odata/v4/cardano-odata/GetTransactionByHash', {
            hash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83'
        });

        expect(data.hash).toBe('2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83');
        expect(data.fee).toBeDefined();
    });

    test('GetTransactionByHash - invalid hash', async () => {
        try {
            await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'invalid' });
            fail('Should have thrown error');
        } catch (error) {
            expect(error.response.status).toBe(400);
            expect(error.response.data.error.message).toContain('Invalid');
        }
    });
});
```

See [test/README.md](../../test/README.md) for complete documentation.

---

## Deployment

### Environment Configuration

**.env (Development)**
```env
LOG_LEVEL=debug
NETWORK=preview
BLOCKFROST_KEY=your_preview_key
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000
INDEX_TTL_MS=60000
```

**.env (Production)**
```env
LOG_LEVEL=info
NETWORK=mainnet
BLOCKFROST_KEY=your_mainnet_key
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000
PORT=4004
```

### Production Build

```bash
npm run build
NODE_ENV=production npm start
```

### Docker (via docker-compose.yml)

```bash
# Start
docker-compose up -d

# Logs
docker-compose logs -f

# Stop
docker-compose down
```

See [Docker Deployment Guide](DOCKER_DEPLOYMENT.md) for details.

---

## Troubleshooting

### Common Issues

**Port 4004 in use:**
```bash
# Windows
netstat -ano | findstr :4004
taskkill /PID <PID> /F

# Linux/Mac
lsof -i :4004
kill -9 <PID>
```

**Tests failing:**
```bash
# Ensure server is running
npm run cds:watch  # Terminal 1
npm test           # Terminal 2 (wait 3s)
```

**Slow responses:**
- Check provider timeouts (config/config.ts)
- Verify network connectivity
- Check Blockfrost status: https://status.blockfrost.io

**BLOCKFROST_KEY not set:**
- Koios tests run without key (always available)
- Blockfrost tests require valid key
- Get key: https://blockfrost.io

---

## Development Best Practices

1. **Always validate input** before calling providers
2. **Use handleRequest wrapper** for automatic error handling
3. **Test edge cases** including error scenarios
4. **Log important operations** for debugging
5. **Implement timeouts** to prevent hanging requests
6. **Check cache/db first for immutable data** to reduce API calls
7. **Document changes** in relevant files

---

**Additional Resources:**
- [User Guide](USER_GUIDE.md) - API documentation
- [Transaction Workflow](TRANSACTION_WORKFLOW.md) - Build, sign & submit transactions (M2/M3)
- [Test Documentation](../../test/README.md) - Complete test reference
- [Error Handling](../concepts%20&%20architecture/ERROR_HANDLING.md) - Error architecture
- [Indexing Concept](../concepts%20&%20architecture/INDEXING.md) - Caching strategy
- [Backend Configuration](BACKEND_CONFIGURATION.md) - Multi-backend setup
- [BTP Deployment Learnings](BTP-DEPLOYMENT-LEARNINGS.md) - SAP BTP deployment patterns

