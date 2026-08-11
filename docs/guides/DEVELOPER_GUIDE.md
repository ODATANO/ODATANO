# ODATANO Developer Guide

**Version:** v2.0.0-rc.1 | **Last Updated:** August 2026

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Setup](#quick-setup)
3. [Plugin Architecture](#plugin-architecture)
4. [Core Components](#core-components)
5. [App Context Pattern](#app-context-pattern)
6. [External Signing Module](#external-signing-module)
7. [Error Handling](#error-handling)
8. [Testing](#testing)
9. [Deployment](#deployment)

---

## Architecture

### Service Surface

**35 Entities:** NetworkInformation, Blocks, Epochs, Pools, Assets, AssetHistory, Dreps, Transactions, TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionOutputAssets, TransactionMetadata, Accounts, Addresses, AddressAssets, AddressUTxOs, AddressTransactions, UTxOAssets, LedgerProtocolParameters, TransactionBuilds, TransactionBuildInputs, TransactionBuildOutputs, TransactionBuildInputAssets, TransactionBuildOutputAssets, TransactionSubmissions, TransactionSubmissionErrors, SigningRequests, SignatureVerifications, AddressSigningRequests, AddressTransactionBuilds, CardanoSyncState, CardanoReorgLog (v2.0 crawler cursor + reorg audit, exposed via CardanoIndexerService), CardanoWorkerWallets, CardanoWalletJobs (v2.0 wallet worker, exposed via CardanoWorkerService)

**19 Read Actions:** GetNetworkInformation, GetBlockByHash, GetEpochByNumber, GetPoolById, GetDrepById, GetAccountByStakeAddress, GetTransactionByHash, GetMetadataByTxHash, GetAddressByBech32, GetUTxOsByAddress, GetUTxOsByCredential, GetAssetsByAddress, GetAssetInfo, GetAssetHistory, GetLatestTransactionsByAddress, GetLatestBlock, GetLatestEpoch, GetLedgerProtocolParameters, ParseTransactionCbor

**13 Transaction Actions:** BuildSimpleAdaTransaction, BuildTransactionWithMetadata, BuildMultiAssetTransaction, BuildMintTransaction, BuildPlutusSpendTransaction, SubmitTransaction, SubmitSignedTransaction, SetCollateral, DeriveScriptAddress, ExtractPaymentKeyHash, GetBuildDetails, CheckSubmissionStatus, GetTransactionBuildsByAddress

**9 External Signing Actions:** CreateSigningRequest, GetSigningRequest, GetSigningRequestsByAddress, VerifySignature, VerifyDataSignature, SubmitVerifiedTransaction, SignWithHsm, SignAndSubmitWithHsm, GetHsmStatus

**Crawler control (CardanoIndexerService):** `getStatus` (function) + `pauseCrawler` / `resumeCrawler` (actions, Admin)

**Wallet worker (CardanoWorkerService):** `SubmitWalletJob`, `CancelJob`, `PauseWorker` / `ResumeWorker` (actions, the latter two Admin) + `GetJobStatus`, `GetWorkerStatus` (functions)

**Events:** `CardanoIndexerService` publishes `blockIndexed` / `reorg`, `CardanoWorkerService` the terminal `jobConfirmed` / `jobFailed`. They are emitted after the corresponding commit, fire-and-forget, and do not appear in `$metadata` (OData V4 has no event concept).

> OData **functions** (`getStatus`, `GetJobStatus`, `GetWorkerStatus`) are invoked with HTTP **GET** and their parameters in the URL — `GET .../GetJobStatus(jobId=<uuid>)`. POSTing to them returns 405.

### Layered Architecture

```
HTTP Client → OData Service (cardano-service.ts / cardano-tx-service.ts / cardano-sign-service.ts /
                             cardano-indexer-service.ts / cardano-worker-service.ts)
    ↓
App Context (server.ts: getCardanoIndexer(), getCardanoClient())
    ↓
CardanoIndexer + CardanoTransactionBuilder + CardanoCrawler (crawler/) + CardanoWalletWorker (wallet-worker/)
    ↓
CardanoClient (Multi-Backend Orchestrator)
    ↓
Backends: Ogmios (live) + Blockfrost → Koios Fallback
    ↓
Transaction Builder: Buildooor
    ↓
External Signing Module: ExternalSignerModule + SignatureVerifier
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
# Edit .env: Set BLOCKFROST_API_KEY, NETWORK=preview

# Development (TypeScript, live reload)
npm run cds:watch

# Production (build first — `start` does NOT compile)
npm run build
npm start

# Testing
npm test             # Run tests
npm run test:coverage # Coverage report
```

**Development vs Production:**

- **`npm run cds:watch`** - Development mode using `ts-node`, runs TypeScript directly, auto-reloads on changes
- **`npm start`** - Runs `cds-serve` against the **already compiled** output. It does not compile: run `npm run build` (or `npm run build:plugin`) first; the emitted `.js` files are gitignored

### Key Files

```
srv/
  server.ts                     # App Context initialization (M3)
  cardano-service.cds           # Read entity/action definitions
  cardano-service.ts            # Read handler implementations
  cardano-tx-service.cds        # Transaction service definitions (build, submit)
  cardano-tx-service.ts         # Transaction handler implementations (build, submit)
  cardano-sign-service.cds      # Signing service definitions (signing requests, verification)
  cardano-sign-service.ts       # Signing handler implementations
  cardano-indexer-service.{cds,ts}  # Crawler control surface (v2.0)
  cardano-worker-service.{cds,ts}   # Wallet job control surface (v2.0)
  blockchain/
    cardano-client.ts           # Multi-backend orchestrator
    cardano-indexer.ts          # Lazy indexing & caching
    cardano-tx-builder.ts       # Transaction builder coordinator (M2)
    backends/
      blockfrost-backend.ts     # Historical provider
      koios-backend.ts          # Fallback provider
      ogmios-backend.ts         # Live WebSocket provider (M2)
    transaction-building/       # M2 Transaction Builders
      cardano-tx.ts             # Builder interface (CardanoTxBuilder)
      buildooor-tx.ts           # Buildooor builder (sole builder)
    signing/                    # M3 External Signing
      external-signer.ts        # Signing request creation & workflow
      signature-verifier.ts     # Cryptographic signature verification
      hsm-signer.ts             # PKCS#11 signing (key never leaves the module)
      cose-verifier.ts          # CIP-8/COSE data signatures (wallet login)
      submission-finalizer.ts   # Shared submit + bookkeeping, incl. deferred submit
    crawler/                    # v2.0 chain crawler / pre-sync
      crawler.ts                # Engine: chain-sync + pagination, reorg handling
      sync-state.ts             # Cursor singleton + DB lease
      hooks.ts                  # blockIndexed / reorg listeners
    wallet-worker/              # v2.0 async wallet job engine
      wallet-worker.ts          # Dispatch loop, build -> sign -> submit
      job-store.ts              # Job state machine + idempotency + leases
      signers.ts                # hsm / software WorkerSigner
      lease-heartbeat.ts        # Keeps the per-wallet lease alive during execution
      confirmation-tracker.ts   # Depth tracking + rollback re-submit
      build-request.ts          # Job payload -> TxBuildRequest
  utils/
    validators.ts               # Input validation (10+ functions)
    errors.ts                   # Error hierarchy (14 classes)
    error-codes.ts              # ODATANO_* error-code contract
    service-events.ts           # Mirrors internal notifications onto CAP services (v2.0 events)
    mappers.ts                  # API → OData transformations
    tx-build-helper.ts          # Transaction utilities (M2)
    signing-helper.ts           # CIP-30 witness combination (M3)
    backend-request-handler.ts  # DB transaction wrapper

db/schema.cds                   # 35 entities with temporal support
config/config.ts                # Timeouts, network, TTL, builders
test/                           # 43 unit + 12 integration test files (vitest)
```
---

## Plugin Architecture

ODATANO is published as [`@odatano/core`](https://www.npmjs.com/package/@odatano/core) — a standard SAP CAP plugin that any CAP project can install and auto-configure.

### How It Works

CAP automatically detects packages with a `cds-plugin.js` file at their root. When a consumer installs `@odatano/core`, the following happens at startup:

```
1. CAP finds cds-plugin.js in node_modules/@odatano/core/
2. cds-plugin.js requires src/plugin.js
3. src/plugin.ts registers the 'odatano-core' service kind
4. cds.on('served') → src/index.ts initialize() → srv/server.ts initializeFromConfig()
5. CDS models from db/schema.cds and srv/*.cds are merged into the consumer's model
6. All five OData services become available automatically
```

### Plugin File Structure

```
@odatano/core (npm package)
├── cds-plugin.js                # CAP entry point → require('./src/plugin')
├── src/
│   ├── plugin.ts                # Register kind, cds.on('served'), cds.on('shutdown')
│   └── index.ts                 # Public API: initialize(), shutdown(), getStatus()
├── srv/
│   ├── cardano-service.cds      # CardanoODataService definition
│   ├── cardano-service.js       # Compiled handler
│   ├── cardano-tx-service.cds   # CardanoTransactionService definition
│   ├── cardano-tx-service.js    # Compiled handler
│   ├── cardano-sign-service.cds # CardanoSignService definition
│   ├── cardano-sign-service.js  # Compiled handler
│   ├── cardano-indexer-service.cds # CardanoIndexerService definition (v2.0)
│   ├── cardano-indexer-service.js  # Compiled handler
│   ├── cardano-worker-service.cds  # CardanoWorkerService definition (v2.0)
│   ├── cardano-worker-service.js   # Compiled handler
│   ├── server.js                # AppContext, loadConfigFromEnv()
│   ├── blockchain/              # Backends, indexer, tx builder, signing, crawler/, wallet-worker/
│   └── utils/                   # Validators, errors, mappers
├── db/
│   └── schema.cds               # 35 entities (namespace: odatano.cardano)
└── config/                      # Network genesis configurations
```

### Plugin Bootstrap (src/plugin.ts)

```typescript
import cds from '@sap/cds';
let initialized = false;

// Register the 'odatano-core' service kind
cds.env.requires.kinds['odatano-core'] = { impl: '@odatano/core' };

// Initialize on served
cds.on('served', async () => {
  if (initialized) return;
  try {
    const core = await import('./index');
    await core.initialize();
    initialized = true;
  } catch (err) {
    logger.error('Failed to initialize plugin:', err);
  }
});

// Graceful shutdown (closes Ogmios WebSocket, etc.)
cds.on('shutdown', async () => {
  if (!initialized) return;
  const core = await import('./index');
  await core.shutdown();
});
```

### Dual-Mode Config Loading (srv/server.ts)

`loadConfigFromEnv()` supports both plugin and standalone modes:

```
Priority: cds.env.requires["odatano-core"].X  >  process.env.X  >  default value
```

**Plugin mode** — consumer configures via `package.json`:

```json
{
  "cds": {
    "requires": {
      "odatano-core": {
        "network": "preview",
        "backends": ["blockfrost", "koios"],
        "blockfrostApiKey": "preview_KEY",
        "primaryTimeoutMs": 30000,
        "fallbackTimeoutMs": 60000,
        "indexTtlMs": 3600000
      }
    }
  }
}
```

**Standalone mode** — configured via environment variables (unchanged from previous behavior):

```env
NETWORK=preview
BACKENDS=blockfrost,koios
BLOCKFROST_API_KEY=preview_KEY
```

### Dual-Mode Initialization Guard

The `cds.on('served')` hook in `srv/server.ts` has a guard to prevent double-initialization:

```typescript
cds.on('served', async () => {
  if (appContext) return;  // Already initialized by plugin
  if (env.SKIP_AUTO_INIT === 'true') return;  // Tests
  // ... normal standalone initialization
});
```

When running as a plugin, `src/plugin.ts` hooks `served` first (plugins load before app code), sets `appContext` via `initializeFromConfig()`, and then `server.ts`'s hook sees `appContext` is already set and skips.

### Public API (src/index.ts)

```typescript
import { initialize, shutdown, getStatus } from '@odatano/core';
import { getCardanoClient, getCardanoIndexer, getCardanoTxBuilder } from '@odatano/core';
import type { CardanoClientConfig, Network, BackendName } from '@odatano/core';
```

| Export | Description |
|--------|-------------|
| `initialize()` | Load config and start blockchain components |
| `shutdown()` | Close all backend connections |
| `getStatus()` | Returns `{ initialized, network }` |
| `getCardanoClient()` | Multi-backend orchestrator instance |
| `getCardanoIndexer()` | Lazy indexing instance |
| `getCardanoTxBuilder()` | Transaction builder instance |
| `CardanoClient` | Client class (for advanced use) |
| `CardanoIndexer` | Indexer class |
| `CardanoTransactionBuilder` | Tx builder class |
| `loadConfigFromEnv()` | Config loader (dual CDS/env) |

### Building & Publishing the Plugin

```bash
# Build (compiles TS in-place for @impl resolution)
npm run build:plugin

# Dry-run to check contents
npm pack --dry-run

# Publish to npm
npm publish --access public
```

The `tsconfig.build.json` uses `outDir: "."` so compiled `.js` files sit alongside `.cds` files — this is required for CAP's `@impl` annotation resolution when installed from `node_modules`.

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
// Transaction hash: 64 lowercase hex characters
export function isTxHash(s: unknown): s is string {
    return typeof s === "string" && TX_HASH_REGEX.test(s);   // /^[a-f0-9]{64}$/
}

// Block hash: separate regex (HEX_64_REGEX) for semantic clarity
export function isBlockHash(s: unknown): s is string {
    return typeof s === "string" && HEX_64_REGEX.test(s);    // /^[a-f0-9]{64}$/
}

// Bech32 address validation (network-aware)
export function isValidBech32Address(s: unknown): s is string { ... }

// Bech32 stake address validation
export function isValidBech32StakeAddress(s: unknown): s is string { ... }
```

**Usage:** Always validate input BEFORE `handleRequest()` to prevent unnecessary API requests. Prefix reject calls with `return`.

### 3. Error Hierarchy (srv/utils/errors.ts)

```typescript
BackendError                            // Base class (500)
├── NotFoundError                       // Resource not found (404)
├── ProviderUnavailableError            // Timeout/unavailable (503)
├── RateLimitError                      // Rate limit exceeded (429)
├── BackendInitError                    // Init failed (500)
├── AllBackendsFailedError              // All backends failed (503)
├── InsufficientFundsError              // Not enough UTxOs (400) - M2
├── MixedAssetsError                    // Mixed asset types (400) - M2
├── TransactionValidationError          // Invalid signature/CBOR (400) - M2
├── TransactionAlreadySubmittedError    // Duplicate TX (409) - M2
└── HsmError                            // HSM operation failed (503) - M3
ConfigError                             // Configuration error (standalone)
AllBackendsInitFailedError              // All init failed (standalone)

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
resetAppContext(context: AppContext | null): void  // Throws if NODE_ENV=production
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

// In cardano-sign-service.ts (CardanoSignService)
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
  const testContext = await createTestContext(['koios']);
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

See [test/README.md](../../test/README.md) for complete test documentation.

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

    // `fail()` is a Jest/Jasmine global and does NOT exist in vitest — assert on
    // the rejection instead, which also keeps the failure message useful.
    test('GetTransactionByHash - invalid hash', async () => {
        await expect(
            POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'invalid' })
        ).rejects.toMatchObject({
            response: { status: 400, data: { error: { message: expect.stringContaining('Invalid') } } },
        });
    });
});
```

---

## Deployment

### Environment Configuration

**.env (Development)**
```env
LOG_LEVEL=debug
NETWORK=preview
BLOCKFROST_API_KEY=your_preview_key
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000
INDEX_TTL_MS=60000
```

**.env (Production)**
```env
LOG_LEVEL=info
NETWORK=mainnet
BLOCKFROST_API_KEY=your_mainnet_key
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

**BLOCKFROST_API_KEY not set:**
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
- [Production Deployment](PRODUCTION_DEPLOYMENT.md) - Production & BTP deployment

