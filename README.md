# ODATANO

**OData Service for Cardano Blockchain Data**

ODATANO is a SAP Cloud Application Programming (CAP) service that provides OData V4 access to Cardano blockchain data. It features intelligent caching, multi-provider fallback, and comprehensive blockchain data exposure through a standardized REST API.

**Funded by Cardano Catalyst Fund 14** ([Official Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk))

**Milestone Status:**
- [Milestone 1: Final Release](https://milestones.projectcatalyst.io/projects/1400109/milestones/1862543) - Completed
- [Milestone 2: Transaction Building & Submission](https://milestones.projectcatalyst.io/projects/1400109/milestones/1862544) - Pending Completion

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Status

### Milestone 1 (Completed)
Cardano read operations with multi-provider failover (Blockfrost → Koios), 17 Entities defining Cardano Core Components & 11 Blockchain Read Actions with comprehensive input validation, full OData V4 query support, lazy on-demand indexing with TTL-based refresh, 340 tests across 11 test suites, CI/CD with Codecov integration

### Milestone 2 (Pending Completion)
Cardano transaction building with dual-builder architecture (CSL & Buildooor), 4 transaction types (simple transfers, token minting, multi-asset transfers, metadata), Ogmios live backend for protocol parameters & UTxO queries, 6 Transaction Actions with external signing workflow, full Build → Sign → Submit flow, 327 new tests & 6 new test suites, end-to-end Preview testnet examples & Postman collection

## Key Features

- **OData V4 Protocol**: Full query support ($filter, $select, $expand, $top, $skip, $count, $orderby)
- **Multi-Network Support**: Mainnet, Preview, and Preprod configurations
- **Multi-Provider Architecture**: Blockfrost + Koios + Ogmios with automatic failover
- **Transaction Building**: CSL & Buildooor for minting, transfers, and metadata transactions
- **Lazy On-Demand Indexing**: TTL-based refresh, no background jobs
- **Comprehensive Testing**: 692 tests across 19 test suites, 96%+ statement coverage

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/ODATANO/ODATANO && cd ODATANO
cp .env.example .env  # Add your BLOCKFROST_KEY
docker-compose up -d
```

Service runs at `http://localhost:4004`

### Local Development

```bash
git clone https://github.com/ODATANO/ODATANO && cd ODATANO
npm ci
cp .env.example .env  # Add your BLOCKFROST_KEY
cds deploy --to sqlite
npm run cds:watch
```

See [Quick Start Guide](docs/QUICK_START.md) for detailed setup instructions.

## Usage Examples

**Read Operations:**
```bash
# Network information
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation

# Query transaction
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('tx_hash')"

# Address with OData filters
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1...')?\$expand=assets"
```

**Transaction Operations (M2):**
```bash
# Build ADA transfer (returns buildId and unsigned CBOR)
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{"senderAddress":"addr_test1...","recipientAddress":"addr_test1...","lovelaceAmount":10000000}'

# Submit signed transaction (using buildId from build response)
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/SubmitTransaction \
  -H "Content-Type: application/json" \
  -d '{"buildId":"uuid-from-build-response","signedTxCbor":"84a400..."}'
```

See [User Guide](docs/guides/USER_GUIDE.md) for complete API reference.

## Testing

```bash
npm test                    # Run all 692 tests
npm run test:coverage       # With coverage report
npm run test:integration    # Integration tests only
npm run test:unit           # Unit tests only
```

See [Test Documentation](test/README.md) for details.

## Documentation

| Guide | Description |
|-------|-------------|
| [Quick Start](docs/QUICK_START.md) | Get running in 5 minutes |
| [User Guide](docs/guides/USER_GUIDE.md) | API usage, entities, and examples |
| [Developer Guide](docs/guides/DEVELOPER_GUIDE.md) | Architecture and development |
| [Transaction Workflow](docs/guides/TRANSACTION_WORKFLOW.md) | Build → Sign → Submit flow (M2) |
| [Docker Deployment](docs/guides/DOCKER_DEPLOYMENT.md) | Container deployment |
| [Data Model](docs/concepts%20&%20architecture/MM_DATAMODEL.md) | Entity relationships |
| [Error Handling](docs/concepts%20&%20architecture/ERROR_HANDLING.md) | Error codes and handling |
| [Test Documentation](test/README.md) | Test suite overview (692 tests) |

**Postman Collections:**
- [M1 - Read Operations](scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json)
- [M2 - Transaction Operations](scripts/ODATANO%20M2%20-%20Full%20Service%20Catalog.postman_collection.json)

## API Overview

### Read Service (`/odata/v4/cardano-odata`) - M1

**17 Entities:** NetworkInformation, Blocks, Epochs, Transactions, TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionOutputAssets, TransactionMetadata, Addresses, AddressAssets, AddressUTxOs, UTxOAssets, Pools, Accounts, Dreps

**11 Actions:** GetNetworkInformation, GetBlockByHash, GetEpochByNumber, GetTransactionByHash, GetMetadataByTxHash, GetAddressByBech32, GetUTxOsByAddress, GetAssetsByAddress, GetPoolById, GetAccountByStakeAddress, GetDrepById

### Transaction Service (`/odata/v4/cardano-transaction`) - M2

**7 Entities:** TransactionBuilds, TransactionBuildInputs, TransactionBuildOutputs, TransactionBuildInputAssets, TransactionBuildOutputAssets, TransactionSubmissions, TransactionSubmissionErrors

**6 Actions:** BuildSimpleAdaTransaction, BuildTransactionWithMetadata, BuildTokenMintTransaction, BuildMultiAssetTransaction, SubmitTransaction, GetProtocolParameters

See [User Guide](docs/guides/USER_GUIDE.md) for complete API reference with parameters.

## Technology Stack

SAP CAP 9.x | TypeScript 5.9 | Node.js 20.x/22.x | SQLite | Jest | Blockfrost | Koios | Ogmios | CSL | Buildooor | Docker

## License

Apache License 2.0 - see [LICENSE](LICENSE)

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Documentation**: [docs/](docs/)
- **Project Lead**: Max Weber (max@maxalexweber.de)
