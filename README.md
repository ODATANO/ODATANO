# ODATANO

**OData Service for Cardano Blockchain Data**

ODATANO is a SAP Cloud Application Programming (CAP) service that provides OData
V4 access to Cardano blockchain data. It features intelligent caching,
multi-provider fallback, and comprehensive blockchain data exposure through a
standardized REST API.

The project is funded by Cardano Catalyst Fund14.
([Offical Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk))

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Milestone Status

Milestone 1 is nearly complete: multi-provider failover (Blockfrost primary,
Koios fallback), defensive mappers/validators, and full OData query support
($filter, $select, $expand, $top, $skip, $count).

## Features

- **OData V4 Protocol**: Full OData query capabilities ($filter, $select,
  $expand, $top, $skip, $count)
- **Multi-Network Support**: Mainnet, Preview, and Preprod network
  configurations
- **Multi-Provider Architecture**: Blockfrost (primary) + Koios (fallback) with
  automatic failover (future: direct node access)
- **Lazy On-Demand Indexing**: Data fetched from Cardano on first access,
  persisted to database with TTL-based refresh (see
  [Indexing Concept](docs/concepts%20&%20architecture/INDEXING.md))
- **Type Safety**: Full TypeScript implementation with CAP type generation
- **Comprehensive Testing**: Unit + integration suites with near-complete
  coverage (service ~99/97 statements/branches; Blockfrost backend 100%)
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

## Installation

### Prerequisites

- Node.js 20+ or 22+
- npm 10+
- Blockfrost API Key ([Get one here](https://blockfrost.io))

### 1. Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci
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

# Enabled Backends (comma-separated)
BACKENDS=blockfrost,koios

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

- See the Integration Test Guide:
  [test/integration/README.md](test/integration/README.md)

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

| Entity                    | Description                             | Primary key(s) (service)                            | Example                                                            |
| ------------------------- | --------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `NetworkInformation`      | Network statistics (supply, stake)      | temporal single row                                 | `/NetworkInformation`                                              |
| `Blocks`                  | Block headers                           | `hash`                                              | `/Blocks(hash='...')`                                              |
| `Epochs`                  | Epoch summaries                         | `epoch`                                             | `/Epochs(epoch=300)`                                               |
| `Transactions`            | Transaction details with inputs/outputs | `hash` (Blake2b256)                                 | `/Transactions('...64hex...')`                                     |
| `TransactionInputs`       | Inputs of a transaction                 | `tx_hash` + `inputIndex`                            | `/TransactionInputs?$filter=tx_hash eq '...64hex...'`              |
| `TransactionOutputs`      | Outputs of a transaction                | `tx_hash` + `outputIndex`                           | `/TransactionOutputs?$filter=tx_hash eq '...64hex...'`             |
| `TransactionInputAssets`  | Assets per transaction input            | `input_tx_hash` + `input_inputIndex` + `unit`       | `/TransactionInputAssets?$filter=input_tx_hash eq '...64hex...'`   |
| `TransactionOutputAssets` | Assets per transaction output           | `output_tx_hash` + `output_outputIndex` + `unit`    | `/TransactionOutputAssets?$filter=output_tx_hash eq '...64hex...'` |
| `TransactionMetadata`     | Transaction metadata by tx + label      | `tx_hash` + `label`                                 | `/TransactionMetadata(tx_hash='...64hex...',label='721')`          |
| `Addresses`               | Address balances and metadata           | `address` (bech32)                                  | `/Addresses('addr_test1...')`                                      |
| `AddressAssets`           | Native assets at an address             | `address_address` + `unit`                          | `/AddressAssets?$filter=address_address eq 'addr_test1...'`        |
| `AddressUTxOs`            | Unspent outputs at an address           | `address_address` + `hash` + `index`                | `/AddressUTxOs?$filter=address_address eq 'addr_test1...'`         |
| `UTxOAssets`              | Assets contained in a specific UTxO     | `utxo_address_address` + `utxo_hash` + `utxo_index` | `/UTxOAssets?$filter=utxo_hash eq '...64hex...'`                   |
| `Pools`                   | Stake pools                             | `poolId`                                            | `/Pools('pool1...')`                                               |
| `Accounts`                | Stake accounts (by stake address)       | `stakeAddress` (bech32 stake)                       | `/Accounts('stake_test1...')`                                      |
| `Dreps`                   | Delegated representatives               | `drepId`                                            | `/Dreps('drep1...')`                                               |

> For the most recent block or epoch, query `Blocks?$orderby=height desc&$top=1`
> and `Epochs?$orderby=epoch desc&$top=1`.

### Actions (POST)

| Action                     | Parameters     | Description                       |
| -------------------------- | -------------- | --------------------------------- |
| `GetNetworkInformation`    | -              | Fetch current network stats       |
| `GetBlockByHash`           | `hash`         | Fetch a specific block by hash    |
| `GetEpochByNumber`         | `epochNumber`  | Fetch a specific epoch by number  |
| `GetTransactionByHash`     | `hash`         | Lookup transaction (64-hex)       |
| `GetMetadataByTxHash`      | `tx_hash`      | Get transaction metadata (64-hex) |
| `GetAddressByBech32`       | `address`      | Get address info (bech32)         |
| `GetUTxOsByAddress`        | `address`      | Get address UTxOs (bech32)        |
| `GetAssetsByAddress`       | `address`      | Get address assets (bech32)       |
| `GetPoolById`              | `poolId`       | Fetch a pool by pool ID           |
| `GetAccountByStakeAddress` | `stakeAddress` | Fetch an account by stake address |
| `GetDrepById`              | `drepId`       | Fetch a drep by ID                |

## Validation and data freshness

- **Validation**
  - Transaction / pool / drep IDs: 64-char hex (`isTxHash`)
  - Addresses: network-aware bech32 (`isBech32Address` for addr)
  - Stake addresses: network-aware bech32 stake HRP (`isBech32StakeAddress`)
  - Empty label strings are rejected for metadata reads
- **Caching and TTL**
  - Temporal CDS entities: only currently valid rows are returned
  - TTL (`INDEX_TTL_MS`): stale or missing rows trigger on-demand reindexing
  - No background jobs; refresh is request-driven

## Important parts of the project structure

```
ODATANO/
├── config/
│   └── config.ts               # Centralized config (network, timeouts, TTL, log level)
│
├── db/
│   └── schema.cds              # CDS data model with temporal entities
│
├── srv/
│   ├── cardano-service.cds     # Service definition (entities + actions)
│   ├── cardano-service.ts      # Main OData service (validation, cache-hit/miss flows)
│   ├── blockchain/
│   │   ├── backends/
│   │   │   ├── blockfrost-backend.ts  # Blockfrost adapter (primary)
│   │   │   ├── koios-backend.ts       # Koios adapter (fallback)
│   │   │   └── cardano-backend.ts     # Backend interface contract
│   │   ├── cardano-client.ts          # Provider orchestration + timeouts/failover
│   │   └── cardano-indexer.ts         # Lazy indexing + TTL + persistence mapping
│   └── utils/
│       ├── backend-request-handler.ts # Backend error handling wrapper (maps provider errors)
│       ├── errors.ts                 # Error hierarchy and normalization helpers
│       ├── logger.ts                 # Pino structured logging
│       ├── mappers.ts                # Data transformation to CDS entities
│       ├── types.ts                  # Shared types
│       └── validators.ts             # Network-aware validators (tx hash, policy, addr/stake)
│
├── test/
│   ├── integration/                  # End-to-end OData and error-path tests
│   └── unit/                         # Service, backend, and utility tests
└── docs/                             # Documentation (Quick Start, User, Developer, concepts)
```

## Technology Stack

- **SAP CAP** (v9.x) - Application framework
- **TypeScript** (v5.9) - Type-safe development
- **SQLite** - Persistent caching
- **Jest** - Testing framework
- **Pino** - Structured logging with optional pino-pretty for development
- **Blockfrost/Koios** - Cardano data providers

## Environment Variables

| Variable                  | Required | Default            | Description                                            |
| ------------------------- | -------- | ------------------ | ------------------------------------------------------ |
| `LOG_LEVEL`               | No       | `info`             | Logging level (trace, debug, info, warn, error, fatal) |
| `NETWORK`                 | No       | `preview`          | Cardano network (mainnet, preview, preprod)            |
| `BLOCKFROST_KEY`          | Yes      | -                  | Blockfrost API project ID                              |
| `PRIMARY_TIMEOUT_MS`      | No       | `8000`             | Primary backend timeout in milliseconds                |
| `FALLBACK_TIMEOUT_MS`     | No       | `10000`            | Fallback backend timeout in milliseconds               |
| `BACKENDS`                | No       | `blockfrost,koios` | Comma-separated list of backends                       |
| `INDEX_TTL_MS`            | No       | `60000`            | Cache TTL in milliseconds (1 minute default)           |
| BACKENDS=blockfrost,koios |          |                    |                                                        |

## License

This project is licensed under the Apache License 2.0 - see the
[LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Documentation**: [docs/](docs/)
- **Blockfrost**: https://blockfrost.io
- **Koios**: https://koios.rest
