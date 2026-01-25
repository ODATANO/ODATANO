# Changelog

All notable changes to ODATANO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2025-01-25 - Milestone 2: Transaction Building & Submission

### Added

- **Transaction Builder Module**: Dual-builder architecture with CSL (Cardano Serialization Lib) and Buildooor engines
- **Transaction Types**: Support for 4 transaction types
  - Simple ADA transfers
  - Token minting with policy scripts
  - Multi-asset transfers (ADA + native tokens)
  - Transactions with metadata
- **6 Transaction Actions** (OData POST endpoints):
  - `BuildSimpleAdaTransaction` - Build simple ADA transfer
  - `BuildTransactionWithMetadata` - Build ADA transfer with metadata
  - `BuildTokenMintTransaction` - Build token minting transaction
  - `BuildMultiAssetTransaction` - Build multi-asset transfer
  - `SubmitTransaction` - Submit signed transaction to Cardano
  - `GetProtocolParameters` - Fetch current protocol parameters
- **Ogmios Live Backend**: WebSocket-based real-time data access for protocol parameters, UTxO queries, and transaction submission
- **TX Builder Registry**: Factory pattern for runtime builder selection and initialization
- **End-to-End Example Scripts**:
  - `send-ada-preview.ts` - Simple ADA transfer workflow
  - `mint-token-preview.ts` - Token minting workflow
  - `send-ada-with-metadata-preview.ts` - Metadata transaction workflow
  - `send-multi-asset-preview.ts` - Multi-asset transfer workflow
- **Postman Collection M2**: Pre-configured requests for all transaction endpoints
- **Transaction Error Handling**: 5 specialized error scenarios
  - Insufficient funds (`ODATANO_INSUFFICIENT_FUNDS`)
  - Invalid input data (`ODATANO_INVALID_INPUT`)
  - Invalid signature (`ODATANO_TX_VALIDATION_FAILED`)
  - Network failure (`ODATANO_PROVIDER_UNAVAILABLE`)
  - Duplicate transaction (`ODATANO_TX_ALREADY_SUBMITTED`)
- **327 new tests** (6 new test suites): Transaction builder tests (CSL, Buildooor), submission tests, error handling tests
- **Transaction Workflow Documentation**: Build → Sign → Submit flow guide

### Changed

- Extended multi-provider architecture: Ogmios (live) + Blockfrost (primary historical) + Koios (fallback)
- Updated test suite: 692 tests across 19 test suites (from 340 tests / 11 suites)
- Enhanced error handling with 8 specialized error classes

### Technical Details

- UTXO selection: LargestFirstMultiAsset strategy
- Fee calculation: Based on current protocol parameters
- Output format: CBOR hex (unsigned transactions)
- External signing: Cardano CLI, browser wallets, hardware wallets supported

---

## [0.1.0] - 2024-12-29 - Milestone 1: OData Read Service

### Added

- **Project Infrastructure**
  - Public GitHub repository with Apache 2.0 license
  - SAP CAP project structure with complete scaffolding
  - CI/CD pipeline with automated tests on Node.js 20.x and 22.x
  - Code coverage reporting via Codecov (96%+ statement, 81%+ branch)
  - Docker deployment support

- **OData V4 Service** (`/odata/v4/cardano-odata`)
  - Full OData V4 query support: `$filter`, `$select`, `$expand`, `$top`, `$skip`, `$count`, `$orderby`
  - SAP Fiori UI annotations for rapid UI development
  - Multi-network support: mainnet, preview, preprod

- **17 Entities** defining Cardano Core Components:
  - `NetworkInformation` - Network statistics (supply, stake)
  - `Blocks` - Block headers
  - `Epochs` - Epoch summaries
  - `Transactions` - Transaction details with inputs/outputs
  - `TransactionInputs` - Inputs of a transaction
  - `TransactionOutputs` - Outputs of a transaction
  - `TransactionInputAssets` - Assets per transaction input
  - `TransactionOutputAssets` - Assets per transaction output
  - `TransactionMetadata` - Transaction metadata by tx + label
  - `Addresses` - Address balances and metadata
  - `AddressAssets` - Native assets at an address
  - `AddressUTxOs` - Unspent outputs at an address
  - `UTxOAssets` - Assets contained in a specific UTxO
  - `Pools` - Stake pools
  - `Accounts` - Stake accounts
  - `Dreps` - Delegated representatives

- **11 Read Actions** (OData POST endpoints):
  - `GetNetworkInformation`
  - `GetBlockByHash`
  - `GetEpochByNumber`
  - `GetTransactionByHash`
  - `GetMetadataByTxHash`
  - `GetAddressByBech32`
  - `GetUTxOsByAddress`
  - `GetAssetsByAddress`
  - `GetPoolById`
  - `GetAccountByStakeAddress`
  - `GetDrepById`

- **Multi-Provider Architecture**
  - Blockfrost (primary, 8s timeout)
  - Koios (fallback, 10s timeout)
  - Automatic failover on timeout, network error, or backend error
  - Response normalization into canonical internal data model

- **Lazy On-Demand Indexing**
  - Data fetched from Cardano on first access
  - Persisted with TTL-based refresh (configurable via `INDEX_TTL_MS`)
  - Temporal entities: only currently valid rows returned
  - No background jobs; all refresh is request-driven

- **Input Validation**
  - Transaction/pool/drep IDs: 64-char hex validation
  - Addresses: network-aware bech32 validation
  - Stake addresses: network-aware bech32 stake HRP validation

- **340 Tests** across 11 test suites:
  - Integration tests for Blockfrost and Koios backends
  - OData query feature tests
  - Error handling and failover tests
  - Input validation tests

- **Documentation Package**
  - Quick Start Guide
  - Developer Guide (architecture, setup, development)
  - User Guide (deployment, querying, examples)
  - Docker Deployment Guide
  - Data Model Documentation
  - Indexing Concept Documentation
  - Error Handling Documentation
  - Postman Collection M1

### Technical Stack

- SAP CAP v9.x
- TypeScript v5.9
- Node.js v20.x / v22.x
- SQLite (persistent caching via @cap-js/sqlite)
- Jest v29.x (testing)
- Pino (structured logging)

---

## Links

- [GitHub Repository](https://github.com/ODATANO/ODATANO)
- [Milestone 1 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1)
- [Milestone 2 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.2-milestone2)
- [Catalyst Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk)
