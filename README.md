# ODATANO

**OData Service for Cardano Blockchain Data**

ODATANO is a SAP Cloud Application Programming (CAP) service that provides OData
V4 access to Cardano blockchain data. It features intelligent caching,
multi-provider fallback, and comprehensive blockchain data exposure through a
standardized REST API.

[![Tests](https://img.shields.io/badge/tests-52%20passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()

## Features

- **OData V4 Protocol**: Full OData query capabilities ($filter, $select,
  $expand, $top, $skip, $count)
- **Multi-Provider Architecture**: Blockfrost (primary) + Koios (fallback) with
  automatic failover (I am also planning a way to access Cardano directly via a
  running node in the future)
- **Smart Caching**: SQLite-based temporal caching with automatic expiration
- **Type Safety**: Full TypeScript implementation with CAP type generation
- **Comprehensive Testing**: 52 tests (40 integration + 12 unit) with 100% pass
  rate
- **Other features**: Error handling, logging, validation, and monitoring

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        OData V4 API                            │
│      http://localhost:4004/odata/v4/cardano-odata              │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│                    CAP Service Layer                           │
│      - cardano-service.ts (Entities + Actions)                 │
│      - validators.ts (Input validation)                        │
│      - mappers.ts (Data transformation)                        │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│                Cardano Indexer & Client                        │
│      - cardano-indexer.ts (Caching logic)                      │
│      - cardano-client.ts (Multi-provider orchestration)        │      
└────────────────────────────────┬───────────────────────────────┘
                                 │
          ┌──────────────────────┬─────────────────────┐
          │                      │                     │         
┌─────────▼─────────┐  ┌─────────▼─────────┐ ┌─────────▼─────────┐
│ Blockfrost Backend│  │  Koios Backend    │ │  Cardano Node     │
│  (Primary)        │  │  (Fallback)       │ │    (etc.)         │
└───────────────────┘  └───────────────────┘ └───────────────────┘
```

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
# Blockfrost API key (required)
BLOCKFROST_KEY=your_blockfrost_project_id_here

# Timeout settings (milliseconds) - optional
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=8000

# Data cache validity (minutes) - optional
ADDR_MAX_AGE_MIN=1
```

### 3. Initialize Database

```bash
cds deploy --to sqlite
```

This creates the SQLite database with data caching tables.

### 4. Start Server

```bash
npm run cds:watch
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

### Run All Tests

```bash
npm test
```

### Run with Coverage

```bash
npm test -- --coverage
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
- **[Data Model](docs/DATAMODEL.md)** - Entity relationships and schema
- **[Indexing Concept](docs/INDEXING.md)** - Caching strategy

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
├── db/                     # Database schema
│   └── schema.cds          # CDS data model
│
├── srv/                    # Service implementation
│   ├── cardano-service.ts  # Main OData service
│   ├── cardano-service.cds # Service definition
│   ├── blockchain/         # Blockchain integration
│   │   ├── cardano-client.ts      # Multi-provider client
│   │   ├── cardano-indexer.ts     # Caching logic
│   │   ├── blockfrost-backend.ts  # Blockfrost adapter
│   │   └── koios-backend.ts       # Koios adapter
│   │
│   └── utils/              # Utilities
│       ├── validators.ts   # Input validation
│       ├── mappers.ts      # Data transformation
│       ├── errors.ts       # Error handling
│       └── logger.ts       # Structured logging
│   
├── test/                   # Test suites
│   ├── integration/        # End-to-end tests
│   └── unit/              # Unit tests
└── docs/                   # Documentation
```

## Technology Stack

- **SAP CAP** (v9.x) - Application framework
- **TypeScript** (v5.9) - Type-safe development
- **SQLite** - Persistent caching
- **Jest** - Testing framework
- **Supertest** - HTTP assertions
- **Pino** - Structured logging
- **Blockfrost/Koios** - Cardano data providers

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Documentation**: [docs/](docs/)
- **Blockfrost**: https://blockfrost.io
- **Koios**: https://koios.rest
