# ODATANO Developer Guide

**Project:** ODATANO - OData V4 Service for Cardano Blockchain\
**Version:** 0.1.0 (Milestone 1 Complete)\
**Status:** Production-Ready - 340 tests, 96.28% coverage\
**Last Updated:** December 2025

---

## Table of Contents

1. [Architecture](#architecture)
2. [Quick Setup](#quick-setup)
3. [Core Components](#core-components)
4. [Error Handling](#error-handling)
5. [Testing](#testing)
6. [Deployment](#deployment)

---

## Architecture

### Service Surface

**16 Entities:** NetworkInformation, Blocks, Epochs, Pools, Dreps, Transactions, TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionOutputAssets, TransactionMetadata, Accounts, Addresses, AddressAssets, AddressUTxOs, UTxOAssets

**11 Actions:** GetNetworkInformation, GetBlockByHash, GetEpochByNumber, GetPoolById, GetDrepById, GetAccountByStakeAddress, GetTransactionByHash, GetMetadataByTxHash, GetAddressByBech32, GetUTxOsByAddress, GetAssetsByAddress

### Layered Architecture

```
HTTP Client → OData Service (cardano-service.ts)
    ↓
Validation & Mapping (validators.ts, mappers.ts)
    ↓
Blockchain Client (cardano-client.ts)
    ↓
Backends: Blockfrost (8s) → Koios Fallback (10s)
    ↓
Indexer Cache (SQLite temporal entities)
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
npm install

# Configure
cp .env.example .env
# Edit .env: Set BLOCKFROST_KEY, NETWORK=preview

# Run
npm run cds:watch    # Development server
npm test             # Run tests
npm run test:coverage # Coverage report
```

### Key Files

```
srv/
  cardano-service.cds    # Entity/action definitions
  cardano-service.ts     # Handler implementations
  blockchain/
    cardano-client.ts    # Multi-backend orchestrator
    cardano-indexer.ts   # Lazy indexing & caching
    backends/
      blockfrost-backend.ts  # Primary provider
      koios-backend.ts       # Fallback provider
  utils/
    validators.ts        # Input validation (8 functions)
    errors.ts            # Error hierarchy (8 classes)
    mappers.ts           # API → OData transformations (14 mappers)
    backend-request-handler.ts  # DB transaction wrapper

db/schema.cds          # 16 entities with temporal support
config/config.ts       # Timeouts, network, TTL
test/                  # 340 tests (135 integration, 205 unit)
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
└── AllBackendsInitFailedError // All init failed (500)

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
├── integration/        # 135 tests (live backend)
│   ├── core-test-suite.ts          # 71 tests (shared)
│   ├── core.blockfrost.test.ts     # Blockfrost execution
│   ├── core.koios.test.ts          # Koios execution
│   ├── error-handling-service.test.ts  # 34 tests
│   └── odata_features.test.ts      # 28 tests (OData V4)
└── unit/               # 205 tests (isolated)
    ├── validators.test.ts          # 48 tests
    ├── errors.test.ts              # 52 tests
    ├── cardano-client.test.ts      # 15 tests
    └── blockfrost-backend.test.ts  # 1 test
```

**Current Status:** 340 tests, 96.28% coverage

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
- [Test Documentation](../../test/README.md) - Complete test reference
- [Error Handling](../concepts%20&%20architecture/ERROR_HANDLING.md) - Error architecture
- [Indexing Concept](../concepts%20&%20architecture/INDEXING.md) - Caching strategy

