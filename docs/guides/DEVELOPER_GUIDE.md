# ODATANO Developer Guide

**Project:** ODATANO - OData V4 Service for Cardano Blockchain\
**Version:** 1.0.0\
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
Cache.get(hash) - Check cache
        ↓ (if miss)
CardanoClient.getTransaction(hash) - Fetch from blockchain
        ↓
BlockfrostAPI or KoiosAPI - Try primary, fallback if timeout/error
        ↓
Cache.set(hash, result) - Store for 5 minutes
        ↓
mapTransaction(rawData) - Format for OData response
        ↓
HTTP 200 + formatted transaction JSON
```

---

## Project Structure

```
ODATANO/
├── db/
│   ├── schema.cds              # Database/entity definitions
│   └── data/                   # Sample data files
├── srv/
│   ├── cardano-service.cds     # OData service definition
│   ├── cardano-service.ts      # Service implementation (TypeScript)
│   ├── cardano-service.js      # TypeScript loader wrapper
│   ├── blockchain/
│   │   ├── blockfrost-backend.ts # Blockfrost API adapter
│   │   ├── koios-backend.ts    # Koios API adapter
│   │   ├── cardano-backend.ts  # Backend interface
│   │   ├── cardano-client.ts   # Failover orchestrator
│   │   └── cardano-indexer.ts  # Caching/indexing layer
│   └── utils/
│       ├── validators.ts       # Input validation functions
│       ├── errors.ts           # Error mapping to HTTP codes
│       ├── mappers.ts          # Data transformation
│       ├── logger.ts           # Structured logging
│       └── types.ts            # TypeScript type definitions
├── test/
│   ├── integration/
│   │   └── m1_core.test.ts     # Core endpoint tests (83 tests)
│   └── unit/
│       ├── validators.test.ts  # Validator tests
│       ├── errors.test.ts      # Error mapping tests
│       └── mappers.test.ts     # Mapper tests
├── docs/
│   ├── DEVELOPER_GUIDE.md      # This file
│   ├── USER_GUIDE.md
│   ├── QUICK_START.md
│   └── MILESTONES_FINAL.md
├── app/                         # UI layer (future)
├── package.json                 # Dependencies & scripts
├── .env.example                 # Configuration template
├── .eslintrc.json               # Code style rules
└── README.md                    # Project overview
```

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
# Edit .env and add BLOCKFROST_KEY (optional for mock testing)

# 4. Verify setup
npm test

# 5. Start development server
npm run cds:watch
```

### Development Workflow

```bash
# Terminal 1: Watch for changes & auto-restart
npm run dev     # or: cds watch

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
        "test": "jest --runInBand --forceExit",
        "test:coverage": "jest --runInBand --coverage --forceExit",
        "test:integration": "npm test -- --testPathPattern=integration --forceExit",
        "test:unit": "npm test -- --testPathPattern=unit"
    }
}
```

**Script Notes:**

- `--runInBand`: Run tests serially (required for database operations)
- `--forceExit`: Force Jest to exit after tests complete (workaround for async
  resource cleanup)
- `pretest`: Automatically generates TypeScript types and deploys database
  schema before tests

---

## Core Components

### 1. OData Service Handler (srv/cardano-service.js)

The main service file contains entity handlers and OData actions.

#### Structure (TypeScript)

```typescript
import cds from "@sap/cds";
import { CardanoClient } from "./blockchain/cardano-client";
import { isBech32Address, isTxHash } from "./utils/validators";
import { CardanoError } from "./utils/errors";
import { logger } from "./utils/logger";

class CardanoService extends cds.ApplicationService {
    private cardanoClient: CardanoClient;

    async init() {
        this.cardanoClient = new CardanoClient();

        this.on("READ", "Transactions", this.onReadTransactions);
        this.on("GetTransactionByHash", this.onGetTransactionByHash);
        // ... more handlers

        await super.init();
    }

    private async onReadTransactions(req: any) {
        // Handler logic here
    }

    private async onGetTransactionByHash(req: any) {
        // Action logic here
    }
}

export default CardanoService;
```

**Note:** CAP requires a `.js` wrapper file (`srv/cardano-service.js`) to load
TypeScript:

```javascript
// srv/cardano-service.js
require("ts-node/register");
module.exports = require("./cardano-service.ts").default;
```

#### Entity Handler Pattern (TypeScript)

```typescript
this.on("READ", "Transactions", async (req) => {
    try {
        // 1. Parse request parameters
        const txId = req.data?.ID || req.data?.hash;

        // 2. Validate input
        if (txId && !isTxHash(txId)) {
            throw new CardanoError("Invalid transaction hash format", 400);
        }

        // 3. Fetch from indexer (handles caching internally)
        if (txId) {
            const tx = await this.cardanoIndexer.getTransaction(txId);
            return mapTransaction(tx);
        }

        // 4. Return empty collection
        return [];
    } catch (error) {
        if (error instanceof CardanoError) {
            req.reject(error.status, error.message);
        } else {
            logger.error("Unexpected error in onReadTransactions", error);
            req.reject(500, "Internal server error");
        }
    }
});
```

#### Action Handler Pattern (TypeScript)

```typescript
this.on("GetTransactionByHash", async (req) => {
    const { txHash } = req.data || {};

    // Validate parameters
    if (!txHash) {
        throw new CardanoError("txHash is required", 400);
    }
    if (!isTxHash(txHash)) {
        throw new CardanoError("Invalid transaction hash", 400);
    }

    // Execute action
    try {
        const tx = await this.cardanoIndexer.getTransaction(txHash);
        return mapTransaction(tx);
    } catch (error) {
        if (error instanceof CardanoError) {
            req.reject(error.status, error.message);
        } else {
            logger.error("[CardanoService] GetTransactionByHash error", error);
            req.reject(500, "Internal server error");
        }
    }
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
- Throw CardanoError with 400 status for invalid formats
- Prevents unnecessary API calls to providers

### 3. Error Handling (srv/utils/errors.ts)

Custom error class for blockchain-related errors.

```typescript
export class CardanoError extends Error {
    constructor(
        message: string,
        public status: number = 500,
        public code?: string,
    ) {
        super(message);
        this.name = "CardanoError";
    }
}

// Common error factories
export const NotFoundError = (resource: string) =>
    new CardanoError(`${resource} not found`, 404);

export const ValidationError = (message: string) =>
    new CardanoError(message, 400);

export const BackendError = (message: string) =>
    new CardanoError(`Backend error: ${message}`, 503);
```

**Usage:**

```typescript
if (!txHash) {
    throw new CardanoError("txHash is required", 400);
}

if (!isTxHash(txHash)) {
    throw ValidationError("Invalid transaction hash");
}
```

### 4. Indexing & Caching Layer (srv/blockchain/cardano-indexer.ts)

Provides intelligent caching using database temporal entities with automatic TTL
management.

```typescript
export class CardanoIndexer {
    async indexTransaction(db: any, txHash: string): Promise<Transaction> {
        // Check if transaction already exists in database
        const existing = await db.run(
            SELECT.one.from(Transactions).where({ hash: txHash }),
        );

        if (existing && !this.isExpired(existing)) {
            return existing;
        }

        // Fetch from blockchain via client
        const txData = await cardanoClient.getTransaction(txHash);

        // Map and persist to database with temporal fields
        const txRow = await this.mapAndPersist(db, txData);

        return txRow;
    }

    private isExpired(entity: any): boolean {
        if (!entity.validFrom) return true;
        const ttl = CONFIG.indexTtlMs; // from config.ts
        const age = Date.now() - new Date(entity.validFrom).getTime();
        return age > ttl;
    }
}
```

**Caching strategy:**

- Persisted cache using database temporal entities (validFrom/validTo)
- Time-based refresh via `INDEX_TTL_MS` environment variable (milliseconds)
- Default TTL: 1ms in config.ts (configure via environment for production, e.g.,
  60000 = 1 minute)
- Lazy on-demand indexing: Data fetched only when accessed
- Automatic expiration check on read operations
- Database-agnostic: Works with SQLite (dev) and HANA (production)

### 5. Blockchain Adapters

#### Blockfrost Backend (srv/blockchain/blockfrost-backend.ts)

```typescript
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { CardanoBackend } from "./cardano-backend";

export class BlockfrostBackend implements CardanoBackend {
    private api: BlockFrostAPI;

    constructor() {
        const apiKey = process.env.BLOCKFROST_KEY;
        if (!apiKey) {
            throw new Error("BLOCKFROST_KEY environment variable not set");
        }

        this.api = new BlockFrostAPI({
            projectId: apiKey,
            network: "preview",
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
    private backends: CardanoBackend[] = [];

    constructor() {
        // Lazy initialization - only create backends if env vars are set
        if (process.env.BLOCKFROST_KEY) {
            this.backends.push(new BlockfrostBackend());
        }
        this.backends.push(new KoiosBackend()); // Fallback
    }

    async getTransaction(hash: string): Promise<any> {
        const timeout = parseInt(process.env.PRIMARY_TIMEOUT_MS || "8000");

        for (const backend of this.backends) {
            try {
                // Try each backend with timeout
                const result = await Promise.race([
                    backend.getTransaction(hash),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Timeout")), timeout)
                    ),
                ]);
                return result;
            } catch (error) {
                logger.warn(`Backend failed, trying next: ${error.message}`);
                // Continue to next backend
            }
        }

        // All backends failed
        throw new CardanoError("All backends failed", 503);
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

#### Step 3: Implement Handler (srv/cardano-service.js)

```javascript
this.on("GetAddressTransactions", async (req) => {
    const { bech32 } = req.data || {};

    // Step 1: Validate input
    if (!bech32) return req.error(400, "Missing bech32 parameter");
    if (!isBech32Address(bech32)) {
        return req.error(400, "Invalid address format");
    }

    try {
        // Step 2: Check cache
        const cacheKey = `addr_txs_${bech32}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        // Step 3: Fetch from blockchain
        const txs = await cardano.getAddressTransactions(bech32);

        // Step 4: Format response
        const result = {
            address: bech32,
            transactions: txs.map((tx) => ({
                txHash: tx.tx_hash,
                blockHeight: tx.block_height,
                timestamp: new Date(tx.block_time * 1000).toISOString(),
            })),
        };

        // Step 5: Cache result
        cache.set(cacheKey, result, 300);

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
| **401**     | Unauthorized        | Invalid Blockfrost API key                      |
| **404**     | Not Found           | Transaction doesn't exist on blockchain         |
| **500**     | Internal Error      | Unknown provider error                          |
| **503**     | Service Unavailable | Provider timeout or network error               |

### Implementing Custom Error Handling

```typescript
// Custom error class (srv/utils/errors.ts)
export class CardanoError extends Error {
    constructor(
        message: string,
        public status: number = 500,
        public code?: string,
    ) {
        super(message);
        this.name = "CardanoError";
    }
}

// Usage in handler
if (!isTxHash(hash)) {
    throw new CardanoError("Invalid transaction hash", 400);
}

// Catching in error handler
try {
    const tx = await this.cardanoIndexer.getTransaction(txHash);
    return mapTransaction(tx);
} catch (error) {
    if (error instanceof CardanoError) {
        req.reject(error.status, error.message);
    } else {
        logger.error("Unexpected error", error);
        req.reject(500, "Internal server error");
    }
}
```

---

## Testing

### Test Structure

```
test/
├── integration/           # In-process tests using @cap-js/cds-test
│   └── m1_core.test.ts   # 83 comprehensive integration tests
└── unit/                  # Tests for utility functions
    ├── validators.test.ts # Input validation tests
    ├── errors.test.ts     # Error handling tests  
    └── mappers.test.ts    # Data transformation tests
```

### Current Test Status

- Framework: Jest 29 + @cap-js/cds-test v0.4.x
- Scripts: `test`, `test:coverage`, `test:integration`, `test:unit`
- Coverage report generated under `coverage/`

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
                txHash:
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
                txHash: "invalid",
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
# All tests (52 total)
npm test

# With coverage report
npm test -- --coverage

# Only integration tests (40 tests)
npm run test:integration

# Only unit tests (12 tests)
npm run test:unit

# Specific file
npm test -- m1_core.test.ts

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

- `INDEX_TTL_MS`: Cache time-to-live in milliseconds (default: 1ms in config.ts,
  recommended: 60000 for 1 minute)
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
npm run dev

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

1. Cache is working: `cache.get()` should return hits
2. Provider timeouts: Check 8000ms timeouts
3. Database queries: Review slow query logs

**Solutions:**

```javascript
// Increase cache TTL
cache.set(key, value, 600); // 10 minutes instead of 5

// Add request logging
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
[Test Coverage Report](M1_TEST_COVERAGE_REPORT.md) for examples.
