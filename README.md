![alt text](docs/assets/odatano_logo/logo_odatano_white.png)

# Enterprise OData Services for the Cardano Blockchain

**ODATANO** is an SAP CAP–based service that exposes the Cardano blockchain via a standardized **OData V4** interface, enabling seamless enterprise-grade read and write access.
It provides unified REST/OData access to on-chain data while supporting native transaction building and submission directly from business applications.
By abstracting blockchain complexity behind familiar SAP integration patterns, ODATANO allows enterprises to integrate Cardano into core processes securely, auditable, and at scale.

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@odatano/core)](https://www.npmjs.com/package/@odatano/core)

## Project Status

**Funded by Cardano Catalyst Fund 14:** [Official Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk)

### Milestone 1 (Completed January 2026) ✅ 
Cardano read operations with multi-provider failover (Blockfrost → Koios), 18 Entities defining Cardano Core Components & 15 Blockchain Read Actions with comprehensive input validation, full OData V4 query support, lazy on-demand indexing with TTL-based refresh, 340 tests across 11 test suites, CI/CD with Codecov integration

[Milestone 1: OData Service Foundation & Blockchain Read Access](https://milestones.projectcatalyst.io/projects/1400109/milestones/1)

### Milestone 2 (Completed February 2026) ✅
Cardano transaction building with dual-builder architecture (CSL & Buildooor), 4 transaction types (simple transfers, token minting, multi-asset transfers, metadata), Ogmios live backend for protocol parameters & UTxO queries, 6 Transaction Actions with external signing workflow, full Build → Sign → Submit flow, 327 new tests & 6 new test suites, end-to-end Preview testnet examples & Postman collection

[Milestone 2: Transaction Build & Submit](https://milestones.projectcatalyst.io/projects/1400109/milestones/2)

### Milestone 3 (Completed March 2026) ✅
Extension of the transaction module & external workflow to export unsigned Cardano transactions via OData, enabling deterministic external signing (e.g. Cardano CLI or browser wallets) with full key separation and no private-key handling in the CAP service.
Includes Plutus smart contract support (BuildPlutusSpendTransaction, SetCollateral), end-to-end external signer integration, SAP S/4HANA business process examples, enterprise use cases, a sample Fiori wallet viewer app, and comprehensive automated integration and security tests.

[Milestone 3: External Signing & SAP Integration](https://milestones.projectcatalyst.io/projects/1400109/milestones/3)

### Final Milestone (Upcoming April/May 2026) ⏳
A demonstration-mode video of the Wallet Viewer Fiori App illustrating audit, compliance, and sustainability use cases, accompanied by transparent community announcements. The milestone is closed with a formal Catalyst close-out report and a short end-to-end video summarizing results, lessons learned, and future plans.

[Final Milestone: Finalization, Advanced Use Cases & Project Close-Out](https://milestones.projectcatalyst.io/projects/1400109/milestones/4)


## Key Features

- **OData V4 Protocol**: Full query support ($filter, $select, $expand, $top, $skip, $count, $orderby)
- **Multi-Network Support**: Mainnet, Preview, and Preprod configurations
- **Multi-Provider Architecture**: Blockfrost + Koios + Ogmios with automatic failover
- **Transaction Building**: Cardano Serialization Library (CSL) & Buildooor for minting, ADA or Token transfers, and metadata transactions
- **Lazy On-Demand Indexing**: TTL-based refresh for changing blockchain data for performance optimization
- **Enterprise-Grade Validation**: Strict input validation and error handling
- **HSM Signing**: Optional server-side transaction signing via PKCS#11 Hardware Security Modules (YubiHSM, AWS CloudHSM, Thales Luna)
- **Comprehensive Testing**: 1285 tests across 31 test suites, 99% statement coverage

## Architecture Overview

![alt text](<docs/assets/architecture & flow diagramms/odatano-ad.png>)

## Quick Start

### Use as CAP Plugin (Recommended)

Add ODATANO to any existing SAP CAP project:

```bash
npm install @odatano/core @cap-js/sqlite
```

Configure in your `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "odatano-core": {
        "network": "preview",
        "backends": ["blockfrost"],
        "blockfrostApiKey": "preview_YOUR_KEY"
      }
    }
  }
}
```

```bash
cds watch
# → CardanoODataService + CardanoTransactionService + CardanoSignService auto-registered
# → /odata/v4/cardano-odata/, /odata/v4/cardano-transaction/, /odata/v4/cardano-sign/ ready
```

### Docker (Standalone)

```bash
git clone https://github.com/ODATANO/ODATANO && cd ODATANO
cp .env.example .env  # Add your BLOCKFROST_API_KEY
docker-compose up -d
```

Service runs at `http://localhost:4004`

### Local Development (Standalone)

```bash
git clone https://github.com/ODATANO/ODATANO && cd ODATANO
npm ci
cp .env.example .env  # Add your BLOCKFROST_API_KEY
cds deploy --to sqlite
npm run cds:watch
```

See [Quick Start Guide](docs/QUICK_START.md) for detailed setup instructions.

## Usage Examples

**Read Operations (M1):**
```bash
# Query transaction
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('tx_hash')"

# Address with OData expand for assets
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

**External Signing Operations (M3):**

```bash
# Create signing request (returns signing instructions and CLI commands)
curl -X POST http://localhost:4004/odata/v4/cardano-sign/CreateSigningRequest \
  -H "Content-Type: application/json" \
  -d '{"buildId":"uuid-from-build-response"}'

# Verify and submit externally signed transaction
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SubmitVerifiedTransaction \
  -H "Content-Type: application/json" \
  -d '{"signingRequestId":"signing-request-id","signedTxCbor":"84a400..."}'
```

**HSM Signing Operations (M3):**

```bash
# Check HSM connection status
curl -X POST http://localhost:4004/odata/v4/cardano-sign/GetHsmStatus \
  -H "Content-Type: application/json" -d '{}'

# Sign and submit with HSM in one step (automated, no external signer needed)
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SignAndSubmitWithHsm \
  -H "Content-Type: application/json" \
  -d '{"buildId":"uuid-from-build-response"}'
```

See [User Guide](docs/guides/USER_GUIDE.md) for complete API reference.

## Testing

```bash
npm test                    # Run all 1285 tests
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
| [Transaction Workflow](docs/guides/TRANSACTION_WORKFLOW.md) | Build → Sign → Submit flow (M2/M3) |
| [Security Guide](docs/guides/SECURITY_GUIDE.md) | Authentication, signing security, HSM |
| [Docker Deployment](docs/guides/DOCKER_DEPLOYMENT.md) | Container deployment |
| [Data Model](docs/concepts%20&%20architecture/MM_DATAMODEL.md) | Entity relationships |
| [Error Handling](docs/concepts%20&%20architecture/ERROR_HANDLING.md) | Error codes and handling |
| [Test Documentation](test/README.md) | Test suite overview (1285 tests) |

**Postman Collections:**
- [M1 - Read Operations](scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json)
- [M2 - Transaction Operations](scripts/ODATANO%20M2%20-%20Full%20Service%20Catalog.postman_collection.json)
- [M3 - Signing Operations](scripts/ODATANO%20M3%20-%20Full%20Service%20Catalog.postman_collection.json)

## API Overview

### Read Service (`/odata/v4/cardano-odata`) - M1

**18 Entities:** NetworkInformation, Blocks, Epochs, Transactions, TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionOutputAssets, TransactionMetadata, Addresses, AddressAssets, AddressUTxOs, AddressTransactions, UTxOAssets, Pools, Accounts, Dreps, LedgerProtocolParameters

**15 Actions:** GetNetworkInformation, GetBlockByHash, GetEpochByNumber, GetTransactionByHash, GetMetadataByTxHash, GetAddressByBech32, GetUTxOsByAddress, GetAssetsByAddress, GetPoolById, GetAccountByStakeAddress, GetDrepById, GetLatestTransactionsByAddress, GetLatestBlock, GetLatestEpoch, GetLedgerProtocolParameters

### Transaction Service (`/odata/v4/cardano-transaction`) - M2

**8 Entities:** TransactionBuilds, TransactionBuildInputs, TransactionBuildOutputs, TransactionBuildInputAssets, TransactionBuildOutputAssets, TransactionSubmissions, TransactionSubmissionErrors, AddressTransactionBuilds

**11 Actions:** BuildSimpleAdaTransaction, BuildTransactionWithMetadata, BuildMultiAssetTransaction, BuildMintTransaction, SubmitTransaction, SubmitSignedTransaction, GetBuildDetails, CheckSubmissionStatus, BuildPlutusSpendTransaction, SetCollateral, GetTransactionBuildsByAddress

### Signing Service (`/odata/v4/cardano-sign`) - M3

**5 Entities:** SigningRequests, SignatureVerifications, AddressSigningRequests, TransactionBuilds, TransactionSubmissions

**8 Actions:** CreateSigningRequest, GetSigningRequest, GetSigningRequestsByAddress, VerifySignature, SubmitVerifiedTransaction, SignWithHsm, SignAndSubmitWithHsm, GetHsmStatus

See [User Guide](docs/guides/USER_GUIDE.md) for complete API reference with parameters.

## npm Package

Published as [`@odatano/core`](https://www.npmjs.com/package/@odatano/core) on npm. See the [Developer Guide](docs/guides/DEVELOPER_GUIDE.md#plugin-architecture) for detailed plugin architecture documentation.

## Technology Stack

SAP CAP 9.x | TypeScript 5.9 | Node.js 20.x/22.x | SQLite | Jest | Blockfrost | Koios | Ogmios | CSL | Buildooor | Docker

## License

Apache License 2.0 - see [LICENSE](LICENSE)

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Documentation**: [docs/](docs/)
- **Project Lead**: Max Weber (max@maxalexweber.de)
