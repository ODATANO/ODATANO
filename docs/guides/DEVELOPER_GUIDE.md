# ODATANO Developer Guide

**Project:** ODATANO - OData V4 Service for Cardano Blockchain\
**Version:** 0.1.0 (Milestone 1 Complete)\
**Status:** Production-Ready - 249 tests, ~99% coverage\
**Last Updated:** December 2025

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Setup & Development Environment](#setup--development-environment)
4. [Core Components](#core-components)
5. [Adding New Endpoints](#adding-new-endpoints)
6. [Error Handling Strategy](#error-handling-strategy)
7. [Testing](#testing)
8. [Deployment](#deployment)
9. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### Service Surface (entities & actions)

- Entities: NetworkInformation, Blocks, Epochs, Transactions, TransactionInputs,
  TransactionOutputs, TransactionInputAssets, TransactionOutputAssets,
  TransactionMetadata, Addresses, AddressAssets, AddressUTxOs, UTxOAssets,
  Pools, Accounts, Dreps.
- Actions: GetNetworkInformation, GetBlockByHash, GetEpochByNumber,
  GetTransactionByHash, GetMetadataByTxHash, GetAddressByBech32,
  GetUTxOsByAddress, GetAssetsByAddress, GetPoolById,
  GetAccountByStakeAddress, GetDrepById.

### Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     HTTP Client / OData                     │
│                                                             │
│         GET /Transactions, POST /GetTransactionByHash       │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                     OData Service Layer                     │
│                                                             │
│                    srv/cardano-service.ts                   │
│                                                             │
│ - Entity READ handlers (Transactions, Addresses, etc.)      │
│ - Action handlers (GetTransactionByHash, etc.)              │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│              Business Logic & Validation Layer              │
│                                                             │
│  - Input validators (srv/utils/validators.ts)               │
│  - Data mappers (srv/utils/mappers.ts)                      │
│  - Error mapping (srv/utils/errors.ts)                      │
│  - Structured logging (srv/utils/logger.ts)                 │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│           Blockchain Provider Adapter Layer                 │
│                                                             │
│              srv/blockchain/cardano-client.ts               │
│                                                             │
│  - Primary: Blockfrost (srv/blockchain/blockfrost-backend.ts)│
│  - Fallback: Koios (srv/blockchain/koios-backend.ts)        │
│  - Timeouts & failover logic (8s each)                      │
│  - Caching via cardano-indexer.ts (SQLite temporal)         │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  Cardano Network                            │ 
│                                                             │
│            Blockfrost / Koios HTTP APIs                     │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow Example: GetTransactionByHash

```
HTTP POST /GetTransactionByHash
        ↓
Service handler receives request
        ↓
Validators.isTxHash(hash) - Input validation
        ↓ (if valid)
Check On DataView (SQL, HANA) if allready indexed
        ↓ (if miss)
CardanoClient.getTransaction(hash) - Fetch from blockchain
        ↓
BlockfrostAPI or KoiosAPI - Try primary, fallback if timeout/error
        ↓
mapTransaction(rawData) - Format for OData response
        ↓
Store Result in DataView
        ↓
HTTP 200 + formatted transaction JSON
```

---

## Project Structure

```
ODATANO/
├── @cds-models/                    # Generated TypeScript types from CDS models
│   ├── index.ts
│   ├── _/                          # CAP internal types
│   ├── CardanoODataService/        # Service type definitions
│   ├── cds/outbox/                 # CAP outbox types
│   ├── odatano/cardano/            # Domain types
│   └── sap/common/                 # SAP common types
├── config/
│   └── config.ts                   # Application configuration (timeouts, TTL, network)
├── coverage/                       # Test coverage reports (generated)
│   ├── lcov.info
│   ├── coverage-final.json
│   └── lcov-report/                # HTML coverage report
├── db/
│   └── schema.cds                  # Database entity definitions (temporal tables)
├── docs/
│   ├── QUICK_START.md              # 5-minute setup guide
│   ├── concepts & architecture/
│   │   ├── ERROR_HANDLING.md       # Error normalization architecture
│   │   ├── INDEXING.md             # Lazy indexing & caching strategy
│   │   └── MM_DATAMODEL.md         # Milestone data model documentation
│   ├── guides/
│   │   ├── DEVELOPER_GUIDE.md      # This file - developer reference
│   │   └── USER_GUIDE.md           # End-user API documentation
│   └── requirments & milestones/
│       └── MILESTONES_FINAL.md     # Milestone 1 completion report
├── scripts/
│   └── request_examples.ts         # Example API requests for testing
├── srv/
│   ├── cardano-service.cds         # OData service definition (entities & actions)
│   ├── cardano-service.ts          # Service implementation (TypeScript handlers)
│   ├── cardano-ui.cds              # UI annotations (future)
│   ├── blockchain/
│   │   ├── backends/
│   │   │   ├── cardano-backend.ts      # Backend interface definition
│   │   │   ├── blockfrost-backend.ts   # Blockfrost API adapter
│   │   │   └── koios-backend.ts        # Koios API adapter (fallback)
│   │   ├── cardano-client.ts       # Multi-backend failover orchestrator
│   │   └── cardano-indexer.ts      # Temporal caching layer (SQLite)
│   └── utils/
│       ├── backend-request-handler.ts  # HTTP request wrapper with error handling
│       ├── error-codes.ts          # HTTP status code constants
│       ├── errors.ts               # Error class hierarchy (8 classes)
│       ├── logger.ts               # Pino structured logging
│       ├── mappers.ts              # Raw API → OData transformations (14 mappers)
│       ├── types.ts                # TypeScript type definitions
│       └── validators.ts           # Input validation functions (8 validators)
├── test/
│   ├── README.md                   # Complete test documentation (249 tests)
│   ├── integration/                # 135 integration tests (live backend testing)
│   │   ├── backend-test-helper.ts      # Backend configuration helper
│   │   ├── core-test-suite.ts          # Shared test suite (71 tests)
│   │   ├── core.blockfrost.test.ts     # Blockfrost backend execution
│   │   ├── core.koios.test.ts          # Koios backend execution
│   │   ├── error-handling-service.test.ts  # Service error validation (34 tests)
│   │   ├── error-handling.backend.ts   # Backend error handling tests
│   │   └── odata_features.test.ts      # OData V4 features (28 tests)
│   └── unit/                       # 116 unit tests (isolated component testing)
│       ├── validators.test.ts          # Validator functions (48 tests)
│       ├── errors.test.ts              # Error classes & utilities (52 tests)
│       ├── cardano-client.test.ts      # CardanoClient config (15 tests)
│       └── blockfrost-backend.test.ts  # Blockfrost init (1 test)
├── .env.example                    # Environment configuration template
├── codecov.yml                     # Codecov configuration
├── eslint.config.mjs               # ESLint 9.x flat config
├── jest.config.cjs                 # Jest test configuration
├── LICENSE                         # MIT License
├── package.json                    # Dependencies & npm scripts
├── README.md                       # Project overview & quick start
└── tsconfig.json                   # TypeScript compiler configuration
```

**Key Directories:**

- **@cds-models/**: Auto-generated from CDS schemas (run `npm run cds:types`) 
- **srv/blockchain/**: Multi-backend architecture with failover (Blockfrost → Koios)
- **srv/utils/**: Reusable components (validators, errors, mappers, logger)
- **test/**: 249 tests with ~99% coverage (integration prioritized over unit)
- **docs/**: Complete documentation suite (7 documents)

---

## Setup & Development Environment

### Prerequisites

- Node.js 20+ (or 22+) and npm 10+
- Git
- Windows PowerShell, cmd, or Unix shell
- Blockfrost API key (for live provider tests)

### Initial Setup

```bash
# 1. Clone repository
git clone https://github.com/ODATANO/ODATANO
cd ODATANO

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env   # PowerShell: Copy-Item .env.example .env
# Edit .env and add BLOCKFROST_KEY

# 4. Verify setup
npm test

# 5. Start development server
npm run cds:watch
```

### Development Workflow

```bash
# Terminal 1: Watch for changes & auto-restart
npm run cds:watch     # or: cds watch

# Terminal 2: Run tests in watch mode
npm test -- --watch

# Terminal 3: Manual testing
curl http://localhost:4004/odata/v4/cardano-odata/$metadata
```

### NPM Scripts

```json
{
    "scripts": {
        "start": "cds-serve",
        "cds:watch": "cds watch",
        "cds:serve": "cds serve --with-mocks",
        "cds:types": "cds-typer \"*\" --outputDirectory @cds-models",
        "db:deploy": "cds deploy",
        "pretest": "npm run cds:types && npm run db:deploy",
        "test": "jest --runInBand",
        "test:coverage": "jest --runInBand --coverage",
        "test:integration": "npm test -- --testPathPattern=integration",
        "test:integration:blockfrost": "npm test -- --testPathPattern=core.blockfrost.test.ts",
        "test:integration:koios": "npm test -- --testPathPattern=core.koios.test.ts",
        "test:unit": "npm test -- --testPathPattern=unit"
    }
}
```

**Script Notes:**

- `--runInBand`: Run tests serially (required for database operations)
- `pretest`: Automatically generates TypeScript types and deploys database
  schema before tests
- Integration tests run against both Blockfrost and Koios backends (see
  [Test Documentation](../../test/README.md))
- Koios tests run always; Blockfrost tests run only when `BLOCKFROST_KEY` is set

---

## Core Components

### 1. OData Service Handler (srv/cardano-service.ts)

The main service file contains entity handlers and OData actions.

#### Structure (TypeScript)

```typescript
import cds, { Request } from '@sap/cds';
import indexer from './blockchain/cardano-indexer';
import { isTxHash, isValidBech32Address } from './utils/validators';
import { rejectInvalid, rejectMissing } from './utils/errors';
import { handleRequest } from './utils/backend-request-handler';
import logger from './utils/logger';

const { SELECT } = cds.ql;

export default class CardanoService extends cds.ApplicationService {
    public init() {
        const { Transactions, Addresses } = require('#cds-models/CardanoODataService');

        // Register entity READ handlers
        this.on('READ', Transactions, async (req: Request) => {
            // Handler logic
        });

        // Register action handlers
        this.on('GetTransactionByHash', async (req: Request) => {
            // Action logic
    }
}

export default CardanoService;
```

#### Entity Handler Pattern (TypeScript)

```typescript
this.on('READ', Transactions, async (req: Request) => {
    const hash = (req.data as { hash?: string })?.hash;
    
    // 1. Validate input
    if (hash && !isTxHash(hash)) {
        return rejectInvalid(req, 'Transactions', 'Invalid hash format', 'hash');
    }
    
    // 2. Use handleRequest wrapper for database transaction
    return handleRequest(req, async (db) => {
        if (hash) {
            // Check if already in database
            const existing = await db.run(SELECT.one.from(Transactions).where({ hash }));
            if (existing) {
                return existing;
            }
            // Index from blockchain if not found
            logger.debug({ hash }, '[CardanoService] Indexing transaction via indexer');
            return await indexer.indexTransaction(db, hash);
        }
        // Return query results if no specific hash
        return db.run(req.query);
    });
});
```

#### Action Handler Pattern (TypeScript)

```typescript
this.on('GetTransactionByHash', async (req: Request) => {
    const hash = (req.data?.hash as string | undefined) ?? undefined;
    
    // Validate parameters
    if (!hash) {
        return rejectMissing(req, 'Transactions', 'hash');
    }
    if (!isTxHash(hash)) {
        return rejectInvalid(req, 'Transactions', 'hash has invalid format', 'hash');
    }
    
    // Execute action with database transaction
    return handleRequest(req, async (db) => {
        let row = await db.run(SELECT.one.from(Transactions).where({ hash }));
        if (!row) {
            row = await indexer.indexTransaction(db, hash);
        }
        return row;
    });
});
```

### 2. Input Validators (srv/utils/validators.ts)

Validate blockchain data formats before provider calls.

```typescript
// Transaction hash: 64 hex characters
export const isTxHash = (s: string): boolean => /^[a-fA-F0-9]{64}$/.test(s);

// Policy ID: 56 hex characters
export const isPolicyId = (s: string): boolean => /^[a-fA-F0-9]{56}$/.test(s);

// Bech32 address: Cardano addresses (mainnet and testnet)
export const isBech32Address = (s: string): boolean =>
    /^(addr1|stake1|addr_test1|stake_test1)[0-9a-z]+$/.test(s);

// Asset name: hex string
export const isAssetName = (s: string): boolean => /^[a-fA-F0-9]*$/.test(s);
```

**When to validate:**

- Always validate user input BEFORE calling blockchain adapters
- Use `rejectInvalid(req, entity, message, field)` for invalid input
- Use `rejectMissing(req, entity, field)` for missing required fields
- Prevents unnecessary API calls to providers

### 3. Error Handling (srv/utils/errors.ts)

Comprehensive error class hierarchy for blockchain-related errors.

```typescript
export class BackendError extends Error {
    constructor(
        message: string,
        public status: number = 500,
        public code?: string,
        public original?: unknown
    ) {
        super(message);
        this.name = "BackendError";
    }
}

// Specific error classes
export class NotFoundError extends BackendError { /* 404 */ }
export class ProviderUnavailableError extends BackendError { /* 503 */ }
export class RateLimitError extends BackendError { /* 429 */ }
export class AllBackendsFailedError extends BackendError { /* 503 with multiple failures */ }
export class ConfigError extends BackendError { /* 500 - configuration errors */ }
export class BackendInitError extends BackendError { /* 500 - init failures */ }
export class AllBackendsInitFailedError extends BackendError { /* 500 - all backends failed to init */ }

// Utility functions
export function getErrorStatus(err: unknown): number { /* ... */ }
export function getErrorMessage(err: unknown): string { /* ... */ }
export function normalizeBackendError(err: unknown, backendName: string): BackendError { /* ... */ }
```

**Usage:**

```typescript
import { rejectInvalid, rejectMissing, normalizeBackendError } from './utils/errors';
import { handleRequest } from './utils/backend-request-handler';

// In action handler:
if (!hash) {
    return rejectMissing(req, 'Transactions', 'hash');
}

if (!isTxHash(hash)) {
    return rejectInvalid(req, 'Transactions', 'Invalid hash format', 'hash');
}

// All backend errors are automatically normalized via handleRequest wrapper
return handleRequest(req, async (db) => {
    // Database operations here
    // Errors are caught and normalized automatically
});
```

### 4. Indexing & Caching Layer (srv/blockchain/cardano-indexer.ts)

ODATANO uses a **Lazy On-Demand Indexing** strategy for blockchain data persistence.

**Key Concepts:**

- **Lazy indexing**: Data is fetched from blockchain only when first requested
- **Temporal entities**: Addresses, Accounts with TTL-based refresh (configurable via `INDEX_TTL_MS`)
- **Non-temporal entities**: Transactions, Blocks, Epochs remain permanently after indexing
- **UPSERT operations**: Automatically inserts new data or updates existing records
- **Nested indexing**: Related entities (inputs, outputs, assets) indexed atomically

**Example Implementation:**

```typescript
// In service handler - transparent indexing
this.on('READ', Transactions, async (req: Request) => {
    return handleRequest(req, async (db) => {
        const hash = req.data?.hash;
        if (hash) {
            // Check database first
            const existing = await db.run(SELECT.one.from(Transactions).where({ hash }));
            if (existing) {
                return existing; // Cached - instant response
            }
            // Not found - index from blockchain
            return await indexer.indexTransaction(db, hash);
        }
        return db.run(req.query);
    });
});
```

📚 **For detailed architecture and data flow diagrams, see:** [Lazy On-Demand Indexing Concept](../concepts%20&%20architecture/INDEXING.md)

### 5. Blockchain Adapters

#### Blockfrost Backend (srv/blockchain/blockfrost-backend.ts)

```typescript
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { CardanoBackend } from './cardano-backend';
import { CONFIG } from '../../../config/config';
import { BackendInitError } from '../../utils/errors';

export class BlockfrostBackend implements CardanoBackend {
    private api?: BlockFrostAPI;

    async init(): Promise<void> {
        const apiKey = CONFIG.blockfrostKey;
        if (!apiKey || apiKey === 'your_blockfrost_key_here') {
            throw new BackendInitError(
                'Blockfrost',
                'BLOCKFROST_KEY not configured'
            );
        }

        this.api = new BlockFrostAPI({
            projectId: apiKey,
            network: CONFIG.network as 'preview' | 'mainnet' | 'preprod',
        });
    }

    async getTransaction(hash: string): Promise<any> {
        return await this.api.txs(hash);
    }

    async getAddress(address: string): Promise<any> {
        return await this.api.addresses(address);
    }

    async getTransactionMetadata(hash: string): Promise<any> {
        return await this.api.txsMetadata(hash);
    }
}
```

#### CardanoClient (srv/blockchain/cardano-client.ts)

Orchestrates failover between primary and fallback providers.

```typescript
export class CardanoClient {
    private backends: CardanoBackend[];
    private initialized = false;

    constructor(backends: CardanoBackend[]) {
        if (!backends || backends.length === 0) {
            throw new ConfigError(
                'CardanoClient misconfigured: no backend available.'
            );
        }
        this.backends = backends;
    }

    // Lazy initialization of backends
    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        await this.initBackends();
    }

    async getTransaction(hash: string): Promise<Transaction> {
        await this.ensureInitialized();
        const errors: BackendError[] = [];

        for (let i = 0; i < this.backends.length; i++) {
            const backend = this.backends[i];
            const isPrimary = i === 0;
            const timeout = isPrimary ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;

            try {
                const result = await Promise.race([
                    backend.getTransaction(hash),
                    new Promise<Transaction>((_, reject) =>
                        setTimeout(() => reject(
                            new ProviderUnavailableError(
                                `Timeout after ${timeout}ms`,
                                backend.constructor.name,
                                timeout
                            )
                        ), timeout)
                    ),
                ]);
                return result;
            } catch (err) {
                const normalized = normalizeBackendError(err, backend.constructor.name);
                errors.push(normalized);
                logger.warn({ error: normalized }, `Backend ${backend.constructor.name} failed`);
            }
        }

        throw new AllBackendsFailedError('getTransaction', errors);
    }
}
```

---

## Adding New Endpoints

### Example: Add a New Endpoint "GetAddressTransactions"

#### Step 1: Update Database Schema (db/schema.cds)

```cds
namespace cardano;

type TransactionSummary {
  txHash: String;
  blockHeight: Integer;
  timestamp: Timestamp;
}

entity AddressTransactionList {
  key ID: String;
  address: String;
  transactions: array of TransactionSummary;
}
```

#### Step 2: Update OData Service Definition (srv/cardano-service.cds)

```cds
service CardanoOData {
  // Add the new action
  action GetAddressTransactions(bech32: String) returns AddressTransactionList;
}
```

#### Step 3: Implement Handler (srv/cardano-service.ts)

```javascript
this.on("GetAddressTransactions", async (req) => {
    const { bech32 } = req.data || {};

    // Step 1: Validate input
    if (!bech32) return req.error(400, "Missing bech32 parameter");
    if (!isBech32Address(bech32)) {
        return req.error(400, "Invalid address format");
    }

    return handleRequest(req, async (db) => {
        // Database operations - fetch or index transaction
        const txs = await indexer.getAddressTransactions(db, bech32);

        // Format response
        const result = {
            address: bech32,
            transactions: txs.map((tx) => ({
                txHash: tx.tx_hash,
                blockHeight: tx.block_height,
                timestamp: new Date(tx.block_time * 1000).toISOString(),
            })),
        };

        return result;
    } catch (error) {
        const { status, message } = mapProviderError(error);
        return req.error(status, message);
    }
});
```

#### Step 4: Add Provider Method

```javascript
// In blockfrost.js
async getAddressTransactions(address) {
  const api = this._ensureInitialized();
  return await api.addresses_txs(address);
}

// In cardano-client.js
async getAddressTransactions(address) {
  // Try primary, fallback on error (same pattern as getTransaction)
}
```

#### Step 5: Test the Endpoint

```javascript
// In test/integration/new_endpoints.test.js
describe("New Endpoints", () => {
    test("GetAddressTransactions accepts valid bech32", async () => {
        const response = await supertest(app)
            .post("/odata/v4/cardano-odata/GetAddressTransactions")
            .send({ bech32: "addr_test1abc123..." });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("transactions");
    });
});
```

---

## Error Handling Strategy

### Error Hierarchy

```
┌─────────────────────────────────────────┐
│        HTTP Client Request              │
└────────────────┬────────────────────────┘
                 │
        ┌────────▼────────┐
        │   Input Valid?  │
        └────────┬────────┘
               NO│ → 400 Bad Request
                 │   (isTxHash fails, etc.)
                 │
        ┌────────▼────────┐
        │  Cache Hit?     │
        └────────┬────────┘
              YES│ → 200 OK (from cache)
                 │
        ┌────────▼────────┐
        │Provider Request │
        └────────┬────────┘
               ├─→ 200 OK (success)
               ├─→ 404 Not Found
               ├─→ 401 Unauthorized
               ├─→ 503 Service Unavailable (timeout)
               └─→ 500 Internal Error
```

### Status Code Mapping

| HTTP Status | Scenario            | Example                                         |
| ----------- | ------------------- | ----------------------------------------------- |
| **200**     | Success             | Transaction found, returned with data           |
| **400**     | Bad Request         | Invalid hash format, missing required parameter |
| **404**     | Not Found           | Transaction/address doesn't exist               |
| **429**     | Rate Limit          | Too many requests to provider                   |
| **500**     | Internal Error      | Configuration error, unknown provider error     |
| **503**     | Service Unavailable | Provider timeout, all backends failed           |

### Implementing Custom Error Handling

```typescript
// Error classes (srv/utils/errors.ts)
// BackendError - Base class for all backend errors
// NotFoundError - Resource not found (404)
// ProviderUnavailableError - Provider timeout/unavailable (503)
// RateLimitError - Rate limit exceeded (429)
// ConfigError - Configuration errors (500)
// BackendInitError - Backend initialization failed (500)
// AllBackendsFailedError - All backends failed (503)
// AllBackendsInitFailedError - All backends init failed (500)

// Helper functions for validation errors
// rejectMissing(req, entity, field) - Missing required field (400)
// rejectInvalid(req, entity, message, field) - Invalid input (400)

// Usage in handler
if (!hash) {
    return rejectMissing(req, 'Transactions', 'hash');
}

if (!isTxHash(hash)) {
    return rejectInvalid(req, 'Transactions', 'Invalid hash format', 'hash');
}

// Error handling with handleRequest wrapper
return handleRequest(req, async (db) => {
    // All BackendErrors are automatically caught and normalized
    const tx = await indexer.indexTransaction(db, hash);
    return tx;
});
```

---

## Testing

### Test Structure

```
test/
├── integration/                    # 135 integration tests (live backend testing)
│   ├── core-test-suite.ts          # Shared test suite (71 tests)
│   ├── core.blockfrost.test.ts     # Blockfrost backend tests
│   ├── core.koios.test.ts          # Koios backend tests
│   ├── error-handling-service.test.ts # Service-level error validation (34 tests)
│   ├── error-handling.backend.ts   # Backend-level error handling
│   ├── odata_features.test.ts      # OData query feature tests (28 tests)
│   └── backend-test-helper.ts      # Backend configuration helper
└── unit/                           # 116 unit tests (isolated component testing)
    ├── validators.test.ts          # Validator type guards (48 tests)
    ├── errors.test.ts              # Error classes and utilities (52 tests)
    ├── cardano-client.test.ts      # CardanoClient configuration (15 tests)
    └── blockfrost-backend.test.ts  # Blockfrost backend initialization (1 test)
```

### Current Test Status

- Framework: Jest 29 + @cap-js/cds-test v0.4.x
- Total Tests: 249 (135 integration + 116 unit)
- Coverage: ~99% statements, ~97% branches (service layer)
- Scripts: `test`, `test:coverage`, `test:integration`, `test:unit`
- Coverage report: `coverage/lcov-report/index.html`
- See detailed test documentation: [test/README.md](../../test/README.md)

### Running Tests

```bash
# Optional: Set provider key for live data
$env:BLOCKFROST_KEY='your_api_key_here'

# Run all tests / with coverage
npm test
npm run test:coverage

# Specific suites
npm run test:integration
npm run test:unit
```

### Test Architecture (TypeScript + cds.test)

```typescript
import cds from "@sap/cds";

describe("CardanoODataService", () => {
    let GET: Function, POST: Function;

    beforeAll(async () => {
        // Start CAP server in-process
        const server = await cds.test("serve", "--in-memory");
        ({ GET, POST } = server);
    });

    test("GetTransactionByHash - valid tx", async () => {
        const { data } = await POST(
            "/odata/v4/cardano-odata/GetTransactionByHash",
            {
                hash:
                    "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
            },
        );

        expect(data.hash).toBe(
            "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
        );
        expect(data.fee).toBeDefined();
    });

    test("GetTransactionByHash - invalid hash", async () => {
        try {
            await POST("/odata/v4/cardano-odata/GetTransactionByHash", {
                hash: "invalid",
            });
            fail("Should have thrown error");
        } catch (error) {
            expect(error.response.status).toBe(400);
            expect(error.response.data.error.message).toContain("Invalid");
        }
    });
});
```

**Key Testing Patterns:**

1. **In-Process Testing**: Uses `cds.test()` instead of HTTP requests
2. **Real Data**: Tests use actual Preview Testnet blockchain data
3. **Error Handling**: Try/catch blocks for 400/500 responses (cds.test throws
   AxiosError)
4. **Coverage Focus**: Tests execute service layer code directly for accurate
   coverage

### Writing Integration Tests

```javascript
const supertest = require("supertest");
const app = require("@sap/cds").app;

describe("GetTransactionByHash", () => {
    test("rejects invalid hash format", async () => {
        const response = await supertest(app)
            .post("/odata/v4/cardano-odata/GetTransactionByHash")
            .send({ hash: "invalid" });

        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty("error");
    });

    test("accepts valid 64-hex hash", async () => {
        const validHash = "0".repeat(64);
        const response = await supertest(app)
            .post("/odata/v4/cardano-odata/GetTransactionByHash")
            .send({ hash: validHash });

        // Will be 200 if hash exists, 500 if provider fails
        expect([200, 500]).toContain(response.status);
    });
});
```

### Writing Unit Tests

```javascript
const { isTxHash } = require("../srv/utils/validators");

describe("validators.isTxHash", () => {
    test("accepts 64-char hex string", () => {
        const valid = "0".repeat(64);
        expect(isTxHash(valid)).toBe(true);
    });

    test("rejects non-hex characters", () => {
        const invalid = "G".repeat(64);
        expect(isTxHash(invalid)).toBe(false);
    });

    test("rejects wrong length", () => {
        const invalid = "0".repeat(63);
        expect(isTxHash(invalid)).toBe(false);
    });
});
```

### Running Tests

```bash
# All tests (249 total)
npm test

# With coverage report
npm test -- --coverage

# Only integration tests (135 tests)
npm run test:integration

# Only unit tests (116 tests)
npm run test:unit

# Specific file
npm test -- core.koios.test.ts

# Watch mode (re-run on file changes)
npm test -- --watch

# Verbose output
npm test -- --verbose
```

### Coverage Requirements

Notes:

- Integration tests execute the CAP service in-process for realistic coverage.
- Some provider-dependent tests may require `BLOCKFROST_KEY`.

---

## Deployment

### Build for Production

```bash
# 1. Build the application
npm run build

# 2. Run production server
NODE_ENV=production npm start
```

### Environment Configuration

**Development** (.env)

```
LOG_LEVEL=debug
NETWORK=preview
BLOCKFROST_KEY=your_preview_api_key
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000
INDEX_TTL_MS=60000
```

**Production** (.env)

```
LOG_LEVEL=info
NETWORK=mainnet
BLOCKFROST_KEY=your_mainnet_api_key
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000
INDEX_TTL_MS=60000
PORT=4004
```

**Configuration Notes:**

- `INDEX_TTL_MS`: Not used - data persists in database without TTL expiration
- `NETWORK`: `mainnet`, `preview`, or `preprod` (determines API endpoints and
  address validation)
- `BLOCKFROST_KEY`: Required for Blockfrost provider (get from
  https://blockfrost.io)
- `PRIMARY_TIMEOUT_MS` / `FALLBACK_TIMEOUT_MS`: Provider request timeout in
  milliseconds
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error` (uses Pino logger)

### Docker Deployment (Future)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 4004
CMD ["npm", "start"]
```

---

## Troubleshooting

### Server Won't Start

**Issue:** `Error: Cannot find module '@sap/cds'`

**Solution:**

```bash
rm -rf node_modules package-lock.json
npm install
```

**Issue:** Port 4004 already in use

**Solution:**

```bash
# Windows
netstat -ano | findstr :4004
taskkill /PID <PID> /F

# Mac/Linux
lsof -i :4004
kill -9 <PID>
```

### Tests Failing

**Issue:** `Cannot find running CAP server`

**Solution:**

```bash
# Terminal 1
npm run cds:watch

# Terminal 2 (wait 3 seconds)
npm test
```

**Issue:** `BLOCKFROST_KEY not set`

**Solution:**

```bash
# Mock mode (no real API calls)
npm test

# Or set a test key
export BLOCKFROST_KEY=test
npm test
```

### Performance Issues

**Issue:** Slow response times

**Check:**

1. Provider timeouts: Check 8000ms timeouts
2. Database queries: Review slow query logs

**Solutions:**

```typescript
// Adjust timeouts in config/config.ts
export const CONFIG = {
    primaryTimeoutMs: 5000,   // 5 seconds instead of default 8000
    fallbackTimeoutMs: 5000,  // 5 seconds instead of default 8000
};

// Add request logging in service handler
console.time("blockfrost_call");
const result = await cardano.getTransaction(hash);
console.timeEnd("blockfrost_call");

// Reduce timeout for faster failover
PRIMARY_TIMEOUT_MS = 5000; // 5 seconds instead of 8
```

### Provider Errors

**Blockfrost API Issues:**

- Check BLOCKFROST_KEY validity
- Verify preview network access
- Check Blockfrost status: https://status.blockfrost.io

**Koios API Failover:**

- Falls back if Blockfrost fails
- No API key required
- Rate limited to 10 requests/second

---

## Key Takeaways for Developers

1. **Always validate input** before calling providers
2. **Use caching** to reduce unnecessary API calls
3. **Handle errors gracefully** with proper HTTP status codes
4. **Log everything** for debugging in production
5. **Test edge cases** including error scenarios
6. **Use lazy initialization** for SDK instances to prevent startup crashes
7. **Implement timeouts** to prevent hanging requests
8. **Document your changes** in this guide

---

**Need Help?** Check the [User Guide](USER_GUIDE.md) or review
[Test Documentation](../../test/README.md) for examples.
