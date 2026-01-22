# ODATANO

**OData Service for Cardano Blockchain Data**

ODATANO is a SAP Cloud Application Programming (CAP) service that provides OData V4 access to Cardano blockchain data. It features intelligent caching, multi-provider fallback, and comprehensive blockchain data exposure through a standardized REST API.

**Funded by Cardano Catalyst Fund 14** ([Official Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk))

**Milestone Status:**
- [Milestone 1: Final Release](https://milestones.projectcatalyst.io/projects/1400109/milestones/1862543) - ✅ Completed
- [Milestone 2: Transaction Building & Submission](https://milestones.projectcatalyst.io/projects/1400109/milestones/1862544) - ✅ Completed

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Status

### Milestone 1 (Completed)
Cardano read operations with multi-provider failover (Blockfrost → Koios), comprehensive input validation, full OData V4 query support, 96.28% test coverage

### Milestone 2 (Pending Completion)
Multi-provider transaction builder implementation (Buildooor & Cardano Serialization Lib), Ogmios live backend support, submitting externally signed transactions, 593 tests across 16 test suites, performance optimizations & bug fixes

### What's New in M2
- ✅ **Transaction Building**: Build unsigned transactions with CSL or Buildooor
- ✅ **Token Minting**: Create new native tokens with policy scripts
- ✅ **Multi-Asset Transfers**: Transfer multiple assets in a single transaction
- ✅ **Transaction Metadata**: Attach metadata to transactions
- ✅ **Ogmios Integration**: Live backend via WebSocket for real-time data
- ✅ **Transaction Submission**: Submit externally signed transactions
- ✅ **250+ New Tests**: Comprehensive transaction builder test coverage
- ✅ **Working Examples**: 4 end-to-end transaction scripts for Preview testnet
- ✅ **Postman Collection**: M2 API collection for manual testing

## Key Features

- **OData V4 Protocol**: Full query support ($filter, $select, $expand, $top, $skip, $count, $orderby)
- **Multi-Network Support**: Mainnet, Preview, and Preprod configurations
- **Multi-Provider Architecture**: Blockfrost (primary, 8s timeout) + Koios (fallback, 10s timeout) + Ogmios (live) with automatic failover
- **Ogmios Live Backend**: Real-time data access via WebSocket connection to Ogmios for protocol parameters and UTxO queries
- **Transaction Builder Integration**: Buildooor and Cardano Serialization Lib (CSL) for constructing minting and transfer transactions
- **Multi-Asset Support**: Token minting, multi-asset transfers, and transaction metadata
- **Lazy On-Demand Indexing**: Data fetched from Cardano on first access, persisted with TTL-based refresh ([Details](docs/concepts%20&%20architecture/INDEXING.md))
- **Type Safety**: Full TypeScript implementation with CAP type generation
- **Comprehensive Testing**: 593 tests across 16 test suites, 96.28% statement coverage, 81.97% branch coverage
- **CI/CD**: Automated testing on Node.js 20.x and 22.x with Codecov integration
- **Enterprise Features**: Structured CAP logging, input validation & error normalization

## M2 Milestone Features (Transaction Support)

The M2 milestone adds comprehensive transaction building and submission capabilities:

### Transaction Builders
- **Dual Builder Architecture**: Support for both CSL (Cardano Serialization Lib) and Buildooor
- **Builder Registry**: Dynamic builder selection and initialization
- **Pluggable Design**: Easy to add additional builders

### Transaction Types Supported
1. **Simple ADA Transfers**: Basic lovelace transfers between addresses
2. **Token Minting**: Create new native tokens with policy scripts
3. **Multi-Asset Transfers**: Transfer multiple assets (ADA + native tokens) in a single transaction
4. **Transactions with Metadata**: Attach metadata to any transaction

### Transaction Workflow
- **Build**: Construct unsigned transactions via OData actions
- **Sign**: External signing (cardano-cli, wallets) - key management not in scope
- **Submit**: Submit signed transactions to Cardano network via multiple backends

### Integration Features
- **Protocol Parameters**: Fetch current protocol parameters from live backend
- **UTXO Selection**: Automatic UTXO selection and coin selection
- **Fee Calculation**: Automatic transaction fee calculation
- **Change Handling**: Automatic change output creation
- **Metadata Support**: Attach metadata labels and JSON content

### Testing & Validation
- **250+ Transaction Tests**: Comprehensive test coverage for all transaction types
- **Builder-Specific Tests**: Separate test suites for CSL and Buildooor
- **End-to-End Scripts**: Working examples for all transaction types on Preview testnet
- **Postman Collection**: Pre-configured requests for manual testing

## Architecture Blockchain Data Read Flow

```
OData V4 API (http://localhost:4004/odata/v4/cardano-odata)
    ↓
CAP Service Layer (cardano-service.cds/ts)
    ↓ validators → mappers → indexer
Cardano Client (multi-provider orchestration)
    ↓
Historical Backends Blockfrost (primary) → Koios (fallback)
Live Backend Ogmios (WebSocket)
```

## Architecture Transaction Flow
```
1. Build Transaction:
   OData V4 API (http://localhost:4004/odata/v4/cardano-transaction)
       ↓
   CAP Service Layer (cardano-tx-service.cds/ts)
       ↓ validators → mappers → tx-builder
   Transaction Builder Module (CSL or Buildooor)
       ↓ fetch protocol params, UTxOs, address info
   Multi-Provider Client:
       • Live Backend: Ogmios (WebSocket)
       • Historical Backends: Blockfrost → Koios (fallback)
       ↓
   Returns unsigned transaction (CBOR hex)

2. Sign Externally:
   (External signing with cardano-cli or wallet)
   User signs transaction with private keys
       ↓
   Returns signed transaction (CBOR hex)

3. Submit Transaction:
   OData V4 API (http://localhost:4004/odata/v4/cardano-transaction/SubmitTransaction)
       ↓
   CAP Service Layer (cardano-tx-service.cds/ts)
       ↓ validators → cardano-client
   Multi-Provider Client:
       • Live Backend: Ogmios (WebSocket - primary)
       • Historical Backends: Blockfrost → Koios (fallback)
       ↓
   Returns transaction hash
```

**Provider Failover & Backend Strategy:**
- **Historical Data**: Blockfrost (primary, 8s timeout) → Koios (fallback, 10s timeout)
- **Live Data**: Ogmios (WebSocket) for protocol parameters, UTxO lookups, and transaction submission
- **Automatic Failover**: On failure (timeout, network error, backend error), fallback backend automatically activated
- **Response Normalization**: All provider responses normalized into canonical internal data model
- **Transparent Access**: Consumers interact with stable OData entities, independent of underlying provider

**Data Freshness:**
- **Temporal entities** (Addresses, Accounts, NetworkInformation, Transactionbuilds): TTL-based refresh (configurable via `INDEX_TTL_MS`)
- **Non-temporal entities** (Transactions, Blocks, Epochs): Permanent storage after first fetch
- No background jobs; all refresh operations are request-driven
- See [Indexing Concept](docs/concepts%20&%20architecture/INDEXING.md) for details

## Installation

### Quick Start with Docker

```bash
git clone https://github.com/ODATANO/ODATANO && cd ODATANO
cp .env.example .env  # Add your BLOCKFROST_KEY
docker-compose up -d
```

Service runs at `http://localhost:4004`

See [Docker Deployment Guide](docs/guides/DOCKER_DEPLOYMENT.md) for details.

### Local Development Setup

#### Prerequisites

- Node.js 20+ or 22+
- npm 10+
- Blockfrost API Key ([Get one here](https://blockfrost.io))

#### 1. Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci
```

#### 2. Configure Environment

```env
# Log level: trace, debug, info, warn, error, fatal (default: info)
LOG_LEVEL=info

# Network: mainnet, preview, preprod (default: preview)
NETWORK=preview

# Blockfrost API key (required)
BLOCKFROST_KEY=your_blockfrost_api_key_here

# Timeout settings (milliseconds) - optional
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000

# Enabled Backends (comma-separated)
BACKENDS=blockfrost,koios,ogmios

# Ogmios WebSocket URL
OGMIOS_URL=ws://localhost:1337

# Available builders (comma-separated): csl, buildooor
# Example: csl,buildooor or just csl
TX_BUILDERS=csl,buildooor

# Lazy Indexing Time-To-Live (milliseconds) - optional
INDEX_TTL_MS=600000
```

**Network Configuration:**

- `mainnet` - Cardano mainnet with production data
- `preview` - Preview testnet (recommended for development)
- `preprod` - Pre-production testnet

The service automatically selects the correct Blockfrost and Koios API endpoints based on your `NETWORK` setting.

#### 3. Initialize Database

```bash
cds deploy --to sqlite
```

This creates the database with temporal caching tables for lazy on-demand indexing.

#### 4. Start Server

**Development mode (recommended for local development):**

```bash
npm run cds:watch # Restarts the server on file changes
```

```bash
npm run cds:serve # Single run without watch
```

**Production mode:**

```bash
npm run build # Compile TypeScript
```

```bash
npm start # Start compiled server
```

**Server runs at:** `http://localhost:4004`

## Quick Start

### Read Operations (M1)

**Test Network Information:**
```bash
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

**Query a Transaction:**
```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('your_tx_hash_here')"
```

**Check an Address:**
```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1...')"
```

**Query with OData Filters:**
```bash
# Get latest blocks with pagination
curl "http://localhost:4004/odata/v4/cardano-odata/Blocks?\$top=5&\$orderby=height desc"

# Get address UTxOs
curl "http://localhost:4004/odata/v4/cardano-odata/AddressUTxOs?\$filter=address_address eq 'addr_test1...'"
```

### Transaction Operations (M2)

**Build Simple ADA Transfer:**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "network": "preview",
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'
```

**Build Token Minting Transaction:**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildTokenMintTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "network": "preview",
    "senderAddress": "addr_test1...",
    "policyId": "your_policy_id",
    "assetName": "MyToken",
    "quantity": 1000000
  }'
```

**Submit Signed Transaction:**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/SubmitTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "network": "preview",
    "signedTxCbor": "84a400..."
  }'
```

## Test All Read Endpoints

**Automated Test Script:**
```bash
npx tsx scripts/request_examples.ts
```

The [request_examples.ts](scripts/request_examples.ts) script automatically tests all read endpoints (entity sets and actions) with real test data and provides a summary of successful/failed requests.

## Test Transaction Builder Endpoints (Build → Sign → Submit Flow)

If you have set up Ogmios and have Buildooor or CSL configured in the .env file, you can run the following scripts to test transaction building, signing, and submitting on the Preview testnet.

**Note**: Key management is NOT in scope of ODATANO M2. For signing, we use a local Docker instance of cardano-cli with custom key files. Be sure to replace the example addresses with your own test addresses that have sufficient funds.

**Example signing with cardano-cli (Docker):**
```bash
docker run --rm -v ${tempDir}:/work -v ${process.cwd()}:/keys -w /work \
  ghcr.io/blinklabs-io/cardano-node:latest cli conway transaction sign \
  --tx-body-file tx.body.json \
  --signing-key-file /keys/payment.skey \
  --testnet-magic 2 \
  --out-file tx.signed.json
```

**Automated Transaction Test Scripts:**
```bash
# Simple ADA transfer
npx tsx scripts/send-ada-preview.ts

# Token minting (M2 feature)
npx tsx scripts/mint-token-preview.ts

# ADA transfer with metadata (M2 feature)
npx tsx scripts/send-ada-with-metadata-preview.ts

# Multi-asset transfer (M2 feature)
npx tsx scripts/send-multi-asset-preview.ts
```

**Postman Collections:**

Import the Postman collections to manually test and explore all available endpoints with pre-configured requests and example data:

- [ODATANO M1 - Full Service Catalog](scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json) - Read operations
- [ODATANO M2 - Full Service Catalog](scripts/ODATANO%20M2%20-%20Full%20Service%20Catalog.postman_collection.json) - Transaction operations

## Testing

```bash
npm test                              # Run all tests (593 tests)
npm run test:coverage                 # Run with coverage report
npm run test:integration              # Integration tests only
npm run test:unit                     # Unit tests only
npm run test:integration:blockfrost   # Test Blockfrost backend
npm run test:integration:koios        # Test Koios backend
npm run test:integration:ogmios       # Test Ogmios backend (requires running Ogmios instance)
```

**Test Coverage:**
- 593 tests across 16 test suites
- 96.28% statement coverage
- 81.97% branch coverage
- Integration tests for all backends (Blockfrost, Koios, Ogmios)
- Transaction builder tests (CSL, Buildooor)
- Full OData V4 query compliance tests

## Documentation

- **[Quick Start Guide](docs/QUICK_START.md)** - Get up and running in 5 minutes
- **[Docker Deployment Guide](docs/guides/DOCKER_DEPLOYMENT.md)** - Run with Docker in 3 commands
- **[Developer Guide](docs/guides/DEVELOPER_GUIDE.md)** - Architecture and development
- **[User Guide](docs/guides/USER_GUIDE.md)** - API usage and examples
- **[Transaction Workflow Guide](docs/guides/TRANSACTION_WORKFLOW.md)** - Build → Sign → Submit flow (M2)
- **[Hybrid Backend Guide](docs/guides/HYBRID_BACKEND.md)** - Multi-backend configuration
- **[Test Documentation](test/README.md)** - Complete test suite overview (593 tests)
- **[Data Model](docs/concepts%20&%20architecture/MM_DATAMODEL.md)** - Entity relationships and schema
- **[Indexing Concept](docs/concepts%20&%20architecture/INDEXING.md)** - Caching strategy
- **[Error Handling](docs/concepts%20&%20architecture/ERROR_HANDLING.md)** - Error normalization and fallback

## SAP Fiori UI Annotations

ODATANO includes comprehensive SAP Fiori Elements UI annotations in [cardano-ui.cds](srv/cardano-ui.cds), providing a ready-to-use UI:

- List pages with selection fields, columns, and actions
- Object pages with header info, facets, and field groups
- Automatic navigation and drill-down (e.g., Transactions → Inputs → Assets)
- DataPoints for KPIs, conditional visibility, reference facets
- All service actions exposed in the UI

**Access:** `http://localhost:4004/$fiori-preview`

See [cardano-ui.cds](srv/cardano-ui.cds) for complete definitions.

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

### Read Actions (POST)

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

### Transaction Actions (POST) - M2

| Action                          | Parameters                                                      | Description                                |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `BuildSimpleAdaTransaction`     | `network`, `senderAddress`, `recipientAddress`, `lovelaceAmount` | Build simple ADA transfer transaction      |
| `BuildTransactionWithMetadata`  | `network`, `senderAddress`, `recipientAddress`, `lovelaceAmount`, `metadata` | Build ADA transfer with metadata           |
| `BuildTokenMintTransaction`     | `network`, `senderAddress`, `policyId`, `assetName`, `quantity`, `metadata` | Build token minting transaction            |
| `BuildMultiAssetTransaction`    | `network`, `senderAddress`, `recipientAddress`, `assets[]`      | Build multi-asset transfer transaction     |
| `SubmitTransaction`             | `network`, `signedTxCbor`                                       | Submit signed transaction to Cardano       |
| `GetProtocolParameters`         | `network`                                                       | Get current protocol parameters            |

All transaction build actions return unsigned transactions in CBOR hex format. The `SubmitTransaction` action accepts externally signed transactions and submits them to the Cardano network.

## Validation and Data Freshness

**Validation:**
- Transaction/pool/drep IDs: 64-char hex (`isTxHash`)
- Addresses: network-aware bech32 (`isBech32Address` for addr)
- Stake addresses: network-aware bech32 stake HRP (`isBech32StakeAddress`)
- Empty label strings rejected for metadata reads

**Caching and TTL:**
- Temporal CDS entities: only currently valid rows are returned
- TTL (`INDEX_TTL_MS`): stale or missing rows trigger on-demand reindexing
- No background jobs; refresh is request-driven

## Project Structure

```
ODATANO/
├── config/
│   └── config.ts                      # Centralized config (network, backends, builders, timeouts, TTL)
│
├── db/
│   └── schema.cds                     # CDS data model with 16+ entities (temporal & non-temporal)
│
├── srv/
│   ├── cardano-service.cds            # Read service definition (entities + actions)
│   ├── cardano-service.ts             # Main OData read service (validation, indexing)
│   ├── cardano-tx-service.cds         # Transaction service definition (M2)
│   ├── cardano-tx-service.ts          # Transaction service implementation (M2)
│   ├── cardano-ui.cds                 # SAP Fiori Elements UI annotations
│   │
│   ├── blockchain/
│   │   ├── backends/
│   │   │   ├── blockfrost-backend.ts  # Blockfrost adapter (primary historical)
│   │   │   ├── koios-backend.ts       # Koios adapter (fallback historical)
│   │   │   ├── ogmios-backend.ts      # Ogmios adapter (live data, M2)
│   │   │   ├── backend-registry.ts    # Backend factory & initialization
│   │   │   └── cardano-backend.ts     # Backend interface contract
│   │   │
│   │   ├── transaction-building/      # M2: Transaction Builder Module
│   │   │   ├── csl-tx.ts              # Cardano Serialization Lib builder
│   │   │   ├── buildooor-tx.ts        # Buildooor builder
│   │   │   ├── tx-builder-registry.ts # Builder factory
│   │   │   └── cardano-tx.ts          # Builder interface
│   │   │
│   │   ├── cardano-client.ts          # Multi-provider orchestration + failover
│   │   ├── cardano-indexer.ts         # Lazy indexing + TTL + persistence
│   │   └── cardano-tx-builder.ts      # Transaction builder coordinator (M2)
│   │
│   └── utils/
│       ├── backend-request-handler.ts # Backend error handling wrapper
│       ├── errors.ts                  # Error hierarchy (8 custom error classes)
│       ├── error-codes.ts             # Error code definitions
│       ├── mappers.ts                 # Data transformation to CDS entities
│       ├── types.ts                   # Shared TypeScript types
│       ├── validators.ts              # Input validators (8 validators)
│       └── tx-build-helper.ts         # Transaction building utilities (M2)
│
├── test/                              # 593 tests across 16 test suites
│   ├── integration/
│   │   ├── core-test-suite.ts         # 71 shared read operation tests
│   │   ├── core.blockfrost.test.ts    # Blockfrost backend tests
│   │   ├── core.koios.test.ts         # Koios backend tests
│   │   ├── core-ogmios.test.ts        # Ogmios backend tests (M2)
│   │   ├── tx-test-suite.ts           # Transaction builder tests (M2)
│   │   ├── tx.blockfrost.test.ts      # Blockfrost tx tests (M2)
│   │   ├── tx.csl.test.ts             # CSL builder tests (M2)
│   │   ├── tx.buildooor.test.ts       # Buildooor builder tests (M2)
│   │   └── [other test files]
│   ├── unit/                          # 205+ unit tests
│   └── README.md                      # Complete test documentation
│
├── scripts/                           # Helper & example scripts
│   ├── request_examples.ts            # Test all read endpoints
│   ├── send-ada-preview.ts            # Test ADA transfer (M2)
│   ├── mint-token-preview.ts          # Test token minting (M2)
│   ├── send-ada-with-metadata-preview.ts  # Test metadata (M2)
│   ├── send-multi-asset-preview.ts    # Test multi-asset (M2)
│   └── [Postman collections]
│
├── docs/                              # Comprehensive documentation
│   ├── guides/                        # User & developer guides
│   │   ├── TRANSACTION_WORKFLOW.md    # M2 transaction flow
│   │   └── [other guides]
│   └── concepts & architecture/       # Architecture documentation
│
├── @cds-models/                       # Auto-generated CDS TypeScript types
├── docker-compose.yml                 # Container orchestration
├── Dockerfile                         # Container image definition
└── package.json                       # Dependencies & scripts
```

## Technology Stack

- **SAP CAP** (v9.x) - Application framework
- **TypeScript** (v5.9) - Type-safe development
- **Node.js** (v20.x / v22.x) - Runtime environment
- **SQLite** - Persistent caching via @cap-js/sqlite
- **Jest** - Testing framework (29.x with ts-jest)
- **Pino** - Structured logging
- **Blockfrost/Koios/Ogmios** - Cardano data providers
- **Cardano Serialization Lib** - Transaction building (M2)
- **Buildooor** - Alternative transaction builder (M2)
- **Docker** - Container deployment support

## Environment Variables

| Variable                  | Required | Default                       | Description                                            |
| ------------------------- | -------- | ----------------------------- | ------------------------------------------------------ |
| `LOG_LEVEL`               | No       | `info`                        | Logging level (trace, debug, info, warn, error, fatal) |
| `NETWORK`                 | No       | `preview`                     | Cardano network (mainnet, preview, preprod)            |
| `BLOCKFROST_KEY`          | Yes      | -                             | Blockfrost API project ID                              |
| `PRIMARY_TIMEOUT_MS`      | No       | `8000`                        | Primary backend timeout in milliseconds                |
| `FALLBACK_TIMEOUT_MS`     | No       | `10000`                       | Fallback backend timeout in milliseconds               |
| `BACKENDS`                | No       | `blockfrost,koios,ogmios`     | Comma-separated list of backends                       |
| `OGMIOS_URL`              | No       | `ws://localhost:1337`         | Ogmios WebSocket URL                                   |
| `TX_BUILDERS`             | No       | `csl,buildooor`               | Comma-separated list of transaction builders (M2)      |
| `INDEX_TTL_MS`            | No       | `600000`                      | Cache TTL in milliseconds (10 minutes default)         |

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Documentation**: [docs/](docs/)
- **Blockfrost**: https://blockfrost.io
- **Koios**: https://koios.rest
- **Project Lead**: Max Weber (max@maxalexweber.de)