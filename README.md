# ODATANO

**OData Service for Cardano Blockchain Data**

ODATANO is a SAP Cloud Application Programming (CAP) service that provides OData
V4 access to Cardano blockchain data. It features intelligent caching,
multi-provider fallback, and comprehensive blockchain data exposure through a
standardized REST API.

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Milestone Status

For the current functionality status and roadmap across milestones, see
[docs/requirments & milestones/MILESTONES_FINAL.md](docs/requirments%20%26%20milestones/MILESTONES_FINAL.md).
The project is at Milestone 1 completion with 9 read actions, multi-provider
failover (Blockfrost primary, Koios fallback), and full OData query capabilities
($filter, $select, $expand, $top, $skip, $count). Latest test run: 11 suites,
274 tests, statements 93% coverage.

## Features

- **OData V4 Protocol**: Full OData query capabilities ($filter, $select,
  $expand, $top, $skip, $count)
- **Multi-Network Support**: Mainnet, Preview, and Preprod network
  configurations
- **Multi-Provider Architecture**: Blockfrost (primary) + Koios (fallback) with
  automatic failover (I am also planning a way to access Cardano directly via a
  running node in the future)
- **Lazy On-Demand Indexing**: Data fetched from Cardano on first access,
  persisted to database with TTL-based refresh (see
  [Indexing Concept](docs/concepts%20&%20architecture/INDEXING.md))
- **Type Safety**: Full TypeScript implementation with CAP type generation
- **Comprehensive Testing**: 276 tests with 90%+ code coverage and 100% pass
  rate
- **CI/CD**: Automated testing on Node.js 20.x and 22.x with Codecov integration
- **Enterprise Features**: Error handling, structured logging (Pino), input
  validation, and monitoring

## Architecture & Provider Semantics

```
┌────────────────────────────────────────────────────────────────┐
│                        OData V4 API                            │
│      http://localhost:4004/odata/v4/cardano-odata              │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│                    CAP Service Layer                           │
│      - cardano-service.ts (Entities + Actions)                 │
│      - cardano-service.js (TypeScript loader wrapper)          │
│      - validators.ts (Input validation)                        │
│      - mappers.ts (Data transformation)                        │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│                Cardano Indexer & Client                        │
│      - cardano-indexer.ts (Caching logic with TTL)             │
│      - cardano-client.ts (Multi-provider orchestration)        │      
└────────────────────────────────┬───────────────────────────────┘
                                 │
          ┌──────────────────────┬─────────────────────┐
          │                      │                     │         
┌─────────▼─────────┐  ┌─────────▼─────────┐ ┌─────────▼─────────┐
│ Blockfrost Backend│  │  Koios Backend    │ │  Cardano Node     │
│  (Primary)        │  │  (Fallback)       │ │    (Future)       │
└───────────────────┘  └───────────────────┘ └───────────────────┘
```

ODATANO supports multiple Cardano data providers and applies a deterministic
fallback strategy.

- A primary backend (e.g. Blockfrost) is queried first.
- If the primary backend fails (timeout, network error, or backend error), a
  fallback backend (e.g. Koios) is used.
- Provider responses are normalized into a canonical internal data model before
  persistence.
- Consumers always interact with stable OData entities, independent of the
  underlying provider.

### Data Freshness Model

ODATANO uses a lazy, on-demand freshness model based on SAP CAP temporal
entities and a configurable indexing TTL.

Entities such as addresses, current network information, and latest block data
are modeled as _temporal_.\
For temporal entities, SAP CAP automatically returns only records that are valid
“as of now” (`validFrom ≤ now < validTo`) during read operations.

In addition, ODATANO applies a configurable indexing TTL (`INDEX_TTL_MS`) to
control when data may be refreshed. If no currently valid record exists at read
time, or if the existing record exceeds the configured TTL, ODATANO refreshes
the data on demand by querying the Cardano backend and re-indexing the result.

No background jobs or periodic crawlers are used.\
All refresh operations are strictly request-driven.

### Provider Semantics

ODATANO supports multiple Cardano data providers and applies a deterministic
fallback strategy.

- A primary backend (e.g. Blockfrost) is queried first.
- If the primary backend fails (timeout, network error, or backend error), a
  fallback backend (e.g. Koios) is used.
- Provider responses are normalized into a canonical internal data model before
  persistence.
- Consumers always interact with stable OData entities, independent of the
  underlying provider.

## Installation

### Prerequisites

- Node.js 20+ or 22+
- npm 10+
- Blockfrost API Key ([Get one here](https://blockfrost.io))

### 1. Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

**Configuration (.env):**

```env
# Log level: trace, debug, info, warn, error, fatal (default: info)
LOG_LEVEL=info

# Network: mainnet, preview, preprod (default: preview)
NETWORK=preview

# Blockfrost API key (required)
BLOCKFROST_KEY=your_blockfrost_api_key_here

# Timeout settings (milliseconds) - optional
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=8000

# Lazy Indexing Time-To-Live (milliseconds) - optional
INDEX_TTL_MS=60000
```

**Network Configuration:**

- `mainnet` - Cardano mainnet with production data
- `preview` - Preview testnet (recommended for development)
- `preprod` - Pre-production testnet

The service automatically selects the correct Blockfrost and Koios API endpoints
based on your `NETWORK` setting.

### 3. Initialize Database

```bash
cds deploy --to sqlite
```

This creates the database with temporal caching tables for lazy on-demand
indexing.

### 4. Start Server

**Development mode with live reload:**

```bash
npm run cds:watch
```

**Production mode:**

```bash
npm start
```

**Server runs at:** `http://localhost:4004`

## Quick Start

### Test Network Information

```bash
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

### Query a Transaction

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('your_tx_hash_here')"
```

### Check an Address

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1...')"
```

## Testing

Note: `srv/cardano-service.js` is intentionally committed as a small runtime
entrypoint used by the CAP/Jest test harness. It only re-exports the TypeScript
implementation (`srv/cardano-service.ts`) and contains no business logic.

### Run All Tests

```bash
npm test
```

### Run with Coverage

```bash
npm run test:coverage
```

### Run Only Integration Tests

```bash
npm run test:integration
```

### Run Only Unit Tests

```bash
npm run test:unit
```

## Documentation

- **[Quick Start Guide](docs/QUICK_START.md)** - Get up and running in 5 minutes
- **[Developer Guide](docs/guides/DEVELOPER_GUIDE.md)** - Architecture and
  development
- **[User Guide](docs/guides/USER_GUIDE.md)** - API usage and examples
- **[Data Model](docs/concepts%20&%20architecture/MM_DATAMODEL.md)** - Entity
  relationships and schema
- **[Indexing Concept](docs/concepts%20&%20architecture/INDEXING.md)** - Caching
  strategy

## API Overview

### Entities (GET)

| Entity                | Description                              | Example                 |
| --------------------- | ---------------------------------------- | ----------------------- |
| `NetworkInformation`  | Network statistics (supply, stake)       | `/NetworkInformation`   |
| `LatestBlock`         | Most recent block data                   | `/LatestBlock`          |
| `LatestEpoch`         | Current epoch data                       | `/LatestEpoch`          |
| `Transactions`        | Transaction details with inputs/outputs  | `/Transactions('hash')` |
| `Addresses`           | Address balances and metadata            | `/Addresses('addr...')` |
| `AddressAssets`       | Native assets at an address              | `/AddressAssets`        |
| `AddressUTxOs`        | Unspent outputs at an address            | `/AddressUTxOs`         |
| `TransactionMetadata` | Transaction metadata by label or tx hash | `/TransactionMetadata`  |

### Actions (POST)

| Action                         | Parameters | Description                 |
| ------------------------------ | ---------- | --------------------------- |
| `GetNetworkInformation`        | -          | Fetch current network stats |
| `GetLatestBlock`               | -          | Get latest block            |
| `GetLatestEpoch`               | -          | Get current epoch           |
| `GetTransactionByHash`         | `txHash`   | Lookup transaction          |
| `GetMetadataByTxHash`          | `txHash`   | Get tx metadata             |
| `GetAddressByBech32`           | `address`  | Get address info            |
| `GetUTxOsByAddress`            | `address`  | Get address UTxOs           |
| `GetAssetsByAddress`           | `address`  | Get address assets          |
| `GetMetadataLabelTransactions` | `label`    | Find txs by metadata label  |

### OData Query Examples

```bash
# Filter transactions by fee
GET /Transactions?$filter=fee gt 1000000

# Select specific fields
GET /Addresses?$select=address,totalLovelace

# Pagination
GET /Transactions?$top=10&$skip=0

# Count results
GET /Addresses?$count=true

# Expand related data
GET /Transactions?$expand=inputs,outputs
```

## Important parts of the project structure

```
ODATANO/
├── config/                 # Configuration
│   └── config.ts           # Centralized config (network, timeouts, TTL, log level)
│
├── db/                     # Database schema
│   └── schema.cds          # CDS data model
│
├── srv/                    # Service implementation
│   ├── cardano-service.ts  # Main OData service
│   ├── cardano-service.cds # Service definition
│   │  
│   ├── blockchain/         # Blockchain integration
│   │   ├── backends/       # Provider adapters
│   │   │   ├── blockfrost-backend.ts  # Blockfrost adapter
│   │   │   ├── cardano-backend.ts     # Backend interface
│   │   │   └── koios-backend.ts       # Koios adapter
│   │   ├── cardano-client.ts          # Client with fallback logic
│   │   └── cardano-indexer.ts         # Lazy indexing with TTL
│   │
│   └── utils/              # Utilities
│       ├── backend-request-handler.ts # Backend error handling wrapper
│       ├── errors.ts       # Error hierarchy and normalization
│       ├── logger.ts       # Pino structured logging
│       ├── mappers.ts      # Data transformation
│       ├── types.ts        # TypeScript types
│       └── validators.ts   # Input validation (network-aware)
│   
├── test/               # Test suites
│   ├── integration/    # End-to-end tests
│   └── unit/           # Unit tests
└── docs/               # Documentation
```

## Technology Stack

- **SAP CAP** (v9.x) - Application framework
- **TypeScript** (v5.9) - Type-safe development
- **SQLite** - Persistent caching
- **Jest** - Testing framework
- **Pino** - Structured logging with optional pino-pretty for development
- **Blockfrost/Koios** - Cardano data providers

## Environment Variables

| Variable              | Required | Default   | Description                                            |
| --------------------- | -------- | --------- | ------------------------------------------------------ |
| `LOG_LEVEL`           | No       | `info`    | Logging level (trace, debug, info, warn, error, fatal) |
| `NETWORK`             | No       | `preview` | Cardano network (mainnet, preview, preprod)            |
| `BLOCKFROST_KEY`      | Yes      | -         | Blockfrost API project ID                              |
| `PRIMARY_TIMEOUT_MS`  | No       | `8000`    | Primary backend timeout in milliseconds                |
| `FALLBACK_TIMEOUT_MS` | No       | `10000`   | Fallback backend timeout in milliseconds               |
| `INDEX_TTL_MS`        | No       | `60000`   | Cache TTL in milliseconds (1 minute default)           |

## License

This project is licensed under the Apache License 2.0 - see the
[LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Documentation**: [docs/](docs/)
- **Blockfrost**: https://blockfrost.io
- **Koios**: https://koios.rest
