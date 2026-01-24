# ODATANO Quick Start Guide

This guide gets you running the OData V4 service locally in minutes.

## Installation

### 1) Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci
```

### 2) Configure Environment

```bash
# Linux/macOS (or Git Bash on Windows)
cp .env.example .env

# Windows PowerShell (alternative)
Copy-Item .env.example .env
```

Open `.env` and set at least your Blockfrost key. Supported variables:

```env
# Log level: trace | debug | info | warn | error | fatal
LOG_LEVEL=info

# Network: mainnet | preview | preprod (default: preview)
NETWORK=preview

# Blockfrost API key (https://blockfrost.io)
BLOCKFROST_KEY=your_api_key_here

# Timeouts (milliseconds)
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000

# Enabled Backends (comma-separated): koios, blockfrost, ogmios
BACKENDS=koios

# Ogmios WebSocket URL (optional, for live data)
OGMIOS_URL=ws://localhost:1337

# Transaction Builders (M2): csl, buildooor
TX_BUILDERS=csl

# Lazy indexing TTL (milliseconds). Example: 60000 = 1 minute
INDEX_TTL_MS=60000
```

### 3) Initialize Database

```bash
cds deploy --to sqlite
```

This creates the SQLite database used for on-demand indexing and caching.

### 4) Start Server

**Development mode (recommended):**

```bash
npm run cds:watch
```

- Runs TypeScript directly with live reload
- No compiled files generated
- Auto-restarts on changes

**Production mode:**

```bash
npm start
```

- Compiles TypeScript → JavaScript
- Optimized for deployment

Server runs at: http://localhost:4004

Base service path: http://localhost:4004/odata/v4/cardano-odata

## First Requests

- Network information

```bash
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

- Latest block / epoch via OData queries:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Blocks?$orderby=height desc&$top=1"
curl "http://localhost:4004/odata/v4/cardano-odata/Epochs?$orderby=epoch desc&$top=1"
```

- Transaction by hash

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash \
  -H "Content-Type: application/json" \
  -d '{"hash":"<64-hex-hash>"}'
```

- Address details

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAddressByBech32 \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'
```

- Pool / account / drep lookups

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetPoolById \
  -H "Content-Type: application/json" \
  -d '{"poolId":"pool1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAccountByStakeAddress \
  -H "Content-Type: application/json" \
  -d '{"stakeAddress":"stake_test1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetDrepById \
  -H "Content-Type: application/json" \
  -d '{"drepId":"drep1..."}'
```

- Address UTxOs and Assets

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetUTxOsByAddress \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAssetsByAddress \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'
```

- Transaction metadata

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetMetadataByTxHash \
  -H "Content-Type: application/json" \
  -d '{"tx_hash":"<64-hex-hash>"}'
```

Tip: You can also read by keys where applicable, e.g.:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('<64-hex-hash>')"
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1...')"
```

## Testing All Endpoints

For comprehensive API testing, ODATANO provides two convenient options:

### Automated Test Script

```bash
npx tsx scripts/request_examples.ts
```

The [request_examples.ts](../scripts/request_examples.ts) script automatically tests all 21 endpoints (10 GET entity sets and 11 POST actions) with real test data from the preview network. It provides:

- Automatic testing of all service endpoints
- Real test data (block hashes, addresses, transaction hashes, etc.)
- Summary statistics (successful/failed requests)
- Detailed logging output

### Postman Collection

Import the [ODATANO M1 - Full Service Catalog](../scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json) collection into Postman to:

- Manually test and explore all available endpoints
- View pre-configured requests with example data
- See detailed descriptions for each endpoint
- Modify parameters and experiment with the API

## Transaction Building (M2)

Build and submit transactions via the transaction service:

```bash
# Build simple ADA transfer
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'
```

See [Transaction Workflow Guide](guides/TRANSACTION_WORKFLOW.md) for signing and submission.

## Testing

```bash
# All tests (635 tests)
npm test

# Coverage report
npm run test:coverage

# Only integration tests / only unit tests
npm run test:integration
npm run test:unit
```

For tests using live providers, set `BLOCKFROST_KEY` in your environment.
