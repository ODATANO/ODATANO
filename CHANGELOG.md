# Changelog

All notable changes to ODATANO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.3-milestone3] - 2026-02-05 - Milestone 3: External Signing & SAP Integration

### Added

- **External Signing Module**: Complete external signing workflow with private key isolation
  - `ExternalSignerModule` - Signing request creation and workflow management
  - `SignatureVerifier` - Cryptographic signature verification
  - CIP-30 browser wallet support (Nami, Eternl, Yoroi, etc.)
  - Cardano CLI signing support
  - Hardware wallet compatibility (Ledger, Trezor)

- **5 New Entities** for signing workflow:
  - `SigningRequests` - Unsigned transaction export with TTL-based expiration
  - `SignatureVerifications` - Cryptographic verification results and audit trail
  - `AddressSigningRequests` - Address-to-signing-request associations
  - `AddressTransactionBuilds` - Address-to-build associations
  - `AddressTransactions` - Address transaction history with net amounts

- **6 External Signing Actions** (OData POST endpoints):
  - `CreateSigningRequest` - Create signing request for external signing
  - `GetSigningRequest` - Retrieve signing request (auto-expires if TTL exceeded)
  - `VerifySignature` - Cryptographically verify signed transaction
  - `SubmitVerifiedTransaction` - Verify and submit in one step
  - `GetSigningRequestsByAddress` - Get signing requests for an address
  - `GetTransactionBuildsByAddress` - Get transaction builds for an address

- **Centralized App Context Architecture**: Refactored initialization in `server.ts`
  - `getAppContext()` - Get singleton application context
  - `getCardanoIndexer()` - Convenience function for services
  - `getCardanoClient()` - Convenience function for services
  - `createTestContext()` - Create isolated test contexts
  - `shutdownAppContext()` - Graceful connection cleanup

- **CIP-30 Wallet Integration**:
  - `combineTransactionWithWitnesses()` - Combine unsigned TX with CIP-30 witness set
  - `isWitnessSetCbor()` - Detect witness set vs full transaction
  - Automatic handling in SubmitVerifiedTransaction

- **Signing Workflow States**: `SigningStatus` enum
  - `pending` - Request created, awaiting signing
  - `signed` - Transaction has been signed
  - `verified` - Signature verified, ready for submission
  - `submitted` - Transaction submitted to network
  - `expired` - Request expired (30 minute default TTL)
  - `failed` - Signing or verification failed

- **New Test Suites** (2 new test files):
  - `signing-services.test.ts` - External signing integration tests
  - `signing.test.ts` - SignatureVerifier and ExternalSignerModule unit tests

- **SAP BTP Deployment Learnings**: `BTP-DEPLOYMENT-LEARNINGS.md` with deployment patterns

- **2 New Transaction Actions** (Plutus Smart Contracts & Collateral):
  - `BuildPlutusSpendTransaction` - Spend UTxO locked at a Plutus validator script address (supports PlutusV3, redeemer/datum JSON, Ogmios execution unit evaluation, optional `inlineDatumJson` for state-machine continuing outputs)
  - `SetCollateral` - Ensure a dedicated ADA-only collateral UTxO exists for Plutus transactions (auto-checks address UTxOs, builds self-send if needed)

- **End-to-End Plutus Scripts**:
  - `lock-ada-at-script-preview.ts` - Lock ADA at a PlutusV3 script address with inline datum
  - `plutus-spend-preview.ts` - Spend locked UTxO with redeemer, verified on Preview testnet

- **Plutus Parameterized Validator Support**:
  - `scriptParamsJson` on `BuildMintTransaction` and `BuildPlutusSpendTransaction` — apply UPLC parameters to unapplied validators, returns `scriptHash` (= policy ID)
  - `requiredSignersJson` — set `required_signers` in tx body for Plutus `extra_signatories` checks
  - `inlineDatumJson` on `BuildMintTransaction` — attach inline datum on minted token output (for spend validators that read `InlineDatum`)
  - `inlineDatumJson` on `BuildPlutusSpendTransaction` — attach inline datum on continuing output (state-machine patterns)
  - `mintRedeemerJson` — custom redeemer for minting policy (defaults to integer 0)
  - `fingerprint` — CIP-14 asset fingerprint (`asset1...`) returned in `BuildMintTransaction` response

- **`lockOnScript`** on `BuildMintTransaction` and `BuildPlutusSpendTransaction`:
  - When `true` and `scriptParamsJson` is provided, routes the output to the enterprise script address derived from the applied script hash
  - Returns `scriptAddress` (bech32) in the response — eliminates consumer-side script address computation
  - New `scriptAddress` field on `TransactionBuilds` entity

- **Extended Transaction Actions for Script Locking**:
  - `BuildSimpleAdaTransaction` now supports optional `outputDatumJson` and `assetsJson` — send ADA + native assets with inline datum to script addresses
  - `BuildMultiAssetTransaction` now supports optional `outputDatumJson` — attach inline datum when sending assets to script addresses

### Changed

- Architecture refactored to centralized App Context pattern
- Services now use `getCardanoIndexer()` instead of direct instantiation
- Test suite updated: 26 test files, 1001+ tests across integration and unit tests
- Enhanced error handling with signing-specific error cases

### Security

- **Private Key Isolation**: Server NEVER handles private keys
- **Signature Verification**: Cryptographic verification before submission
- **Audit Trail**: Complete history of signing requests and verifications
- **TTL Expiration**: Signing requests expire after 30 minutes (configurable)

---

## [v0.2-milestone2] - 2025-01-25 - Milestone 2: Transaction Build & Submit

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
  - `BuildMintTransaction` - Build token minting transaction
  - `BuildMultiAssetTransaction` - Build multi-asset transfer
  - `SubmitTransaction` - Submit signed transaction to Cardano
  - `SubmitSignedTransaction` - Submit externally built transaction
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
- **327 new tests** (6 new test suites): Ogmios Tests, Transaction builder tests (CSL, Buildooor), mocked submission tests, error handling tests
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

## [v0.1-milestone1] - 2024-12-29 - Milestone 1: OData Read Service

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

- **18 Entities** defining Cardano Core Components:
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
  - `AddressTransactions` - Address transaction history
  - `LedgerProtocolParameters` - Protocol parameters

- **15 Read Actions** (OData POST endpoints):
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
  - `GetLatestTransactionsByAddress`
  - `GetLatestBlock`
  - `GetLatestEpoch`
  - `GetLedgerProtocolParameters`

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

---

## Links

- [GitHub Repository](https://github.com/ODATANO/ODATANO)
- [Milestone 1 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1)
- [Milestone 2 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.2-milestone2)
- [Milestone 3 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.3-milestone3)
- [Catalyst Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk)
