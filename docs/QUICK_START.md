# ODATANO Quick Start Guide

This guide gets you running the OData V4 service locally in minutes.

## Installation

### 1) Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm install
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

# Lazy indexing TTL (milliseconds). Example: 60000 = 1 minute
INDEX_TTL_MS=60000
```

### 3) Initialize Database

```bash
cds deploy --to sqlite
```

This creates the SQLite database used for on-demand indexing and caching.

### 4) Start Server (Dev Mode)

```bash
npm run cds:watch
```

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
  -d '{"txHash":"<64-hex-hash>"}'
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
  -d '{"txHash":"<64-hex-hash>"}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetMetadataLabelTransactions \
  -H "Content-Type: application/json" \
  -d '{"label":"721"}'
```

Tip: You can also read by keys where applicable, e.g.:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('<64-hex-hash>')"
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1...')"
```

## Testing

```bash
# All tests
npm test

# Coverage report
npm run test:coverage

# Only integration tests / only unit tests
npm run test:integration
npm run test:unit
```

For tests using live providers, set `BLOCKFROST_KEY` in your environment.
