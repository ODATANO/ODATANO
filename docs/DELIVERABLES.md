# Proof of Achievement – Milestone 1

---

## A. Output: Project Infrastructure & Repository Setup

Public GitHub repository with Apache 2.0 license initialized with SAP CAP project structure, continuous integration setup, basic README, and issue tracker for project tasks.

### Acceptance criteria

- Repository publicly accessible under Apache 2.0 license  
- SAP CAP project structure initialized with complete project scaffolding  
- CI/CD pipeline configured and running automated tests  
- Comprehensive README documentation with setup instructions  
- Issue tracker available for project management  
- Multiple Node.js versions tested (20.x, 22.x)  
- Code coverage reporting integrated  

### Evidence

- Repository: https://github.com/ODATANO/ODATANO  
- License (Apache 2.0): https://github.com/ODATANO/ODATANO/blob/main/LICENSE  
- CI/CD Pipeline: https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml  
- Test Coverage: https://codecov.io/gh/ODATANO/ODATANO  
- README: https://github.com/ODATANO/ODATANO/blob/main/README.md  
- Milestone Release v0.1-milestone1: https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1  
- Project Issues: https://github.com/ODATANO/ODATANO/issues  
- GitHub Actions History: https://github.com/ODATANO/ODATANO/actions  
- Demo Video: https://www.youtube.com/watch?v=jDw6MXgbfR0  

---

## B. Output: CAP OData Service Read Operations Implemented

A fully functional OData V4 service using SAP Cloud Application Programming Model, defining entities/endpoints for Transactions, Addresses, Blocks, Epochs, Accounts, and NetworkInformation. The service runs on a local CAP server and responds to requests with complete OData V4 query support.

### Acceptance criteria

- OData V4 service deployable locally with `cds watch` or `npm run dev`  
- Service accessible via standard OData V4 endpoint (`http://localhost:4004/odata/v4/cardano-odata`)  
- Metadata document (`$metadata`) reachable confirming service is operational  
- Six main entities defined: Transactions, Addresses, Blocks, Epochs, Accounts, NetworkInformation  
- Full OData query support: `$filter`, `$select`, `$expand`, `$top`, `$skip`, `$count`, `$orderby`  
- SAP Fiori UI annotations included for rapid UI development  
- Docker deployment option available  
- Service accessible on multiple networks (mainnet, preview, preprod)  

### Evidence

- Service Definition (CDS): https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-service.cds  
- Service Implementation (TypeScript): https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-service.ts  
- UI Annotations: https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-ui.cds  
- Data Schema: https://github.com/ODATANO/ODATANO/blob/main/db/schema.cds  
- Generated Type Models: https://github.com/ODATANO/ODATANO/tree/main/@cds-models/CardanoODataService  
- Docker Deployment Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/DOCKER_DEPLOYMENT.md  
- Docker Compose Configuration: https://github.com/ODATANO/ODATANO/blob/main/docker-compose.yml  
- Dockerfile: https://github.com/ODATANO/ODATANO/blob/main/Dockerfile  
- OData Features Documentation: https://github.com/ODATANO/ODATANO/blob/main/README.md#key-features  
- API Endpoint Verification (Postman/Screenshots):  
- Milestone Release v0.1-milestone1: https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1  

---

## C. Output: Blockchain Data Integration Layer

Integration of the CAP service with Cardano blockchain data sources using Blockfrost (primary) and Koios (fallback) APIs to support real-time read operations. Multiple read endpoints are connected to Cardano networks (mainnet, preview, preprod) with automatic provider failover and response normalization.

### Acceptance criteria

- At least three key read endpoints functional against Cardano networks:  
  - **Transaction Lookup:** Given a transaction hash, returns complete transaction details (inputs, outputs, metadata, fees, block info)  
  - **Address Information:** Given a Cardano address, returns current ADA balance and complete asset list  
  - **Block Information:** Given a block hash or number, returns block details  
  - **Epoch Information:** Returns current and historical epoch data  
  - **Account Information:** Stake account information and rewards  
  - **Network Information:** Current blockchain parameters and status  
- Multi-provider architecture with automatic failover (Blockfrost primary with 8s timeout, Koios fallback with 10s timeout)  
- All responses conform to defined OData schema with proper type mapping  
- Queries complete within acceptable time (< 10 seconds including fallback)  
- Provider responses normalized into canonical internal data model  
- Lazy on-demand indexing with TTL-based refresh for temporal entities  
- Support for mainnet, preview, and preprod networks  

### Evidence

- Cardano Client (Multi-Provider Orchestration): https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/cardano-client.ts  
- Blockfrost Backend Implementation: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/blockfrost-backend.ts  
- Koios Backend Implementation: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/koios-backend.ts  
- Backend Interface Definition: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/cardano-backend.ts  
- Data Mappers (Response Normalization): https://github.com/ODATANO/ODATANO/blob/main/srv/utils/mappers.ts  
- Indexing Logic: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/cardano-indexer.ts  
- Type Definitions: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/types.ts  
- Architecture Documentation: https://github.com/ODATANO/ODATANO/blob/main/README.md#architecture  
- Indexing Concept: https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/INDEXING.md  
- Data Model Documentation: https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/MM_DATAMODEL.md  
- Integration Tests (Blockfrost): https://github.com/ODATANO/ODATANO/blob/main/test/integration/core.blockfrost.test.ts  
- Integration Tests (Koios): https://github.com/ODATANO/ODATANO/blob/main/test/integration/core.koios.test.ts  
- OData Features Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/odata_features.test.ts  
- Postman Collection (Complete API Catalog): https://github.com/ODATANO/ODATANO/blob/main/scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json  
- Request Examples: https://github.com/ODATANO/ODATANO/blob/main/scripts/request_examples.ts  
- Demonstration Query (End-to-End Test): https://www.youtube.com/watch?v=jDw6MXgbfR0  
- Milestone Release v0.1-milestone1: https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1  

---

## D. Output: Automated Test Suite (Read Operations)

Comprehensive automated unit and integration test suite covering all core OData endpoints, blockchain data retrieval scenarios, error handling, input validation, and OData query features. Tests are configured to run in CI on multiple Node.js versions ensuring code quality and preventing regressions.

### Acceptance criteria

- Automated tests cover at least 70% of code (achieved: >96% statement coverage, >81% branch coverage)  
- Test suite includes at least 15 test cases (achieved: 340 total tests)  
- Coverage areas:  
  - Successful data retrieval queries (transactions, addresses, blocks, epochs, accounts, network info)  
  - OData query features (`$filter`, `$select`, `$expand`, `$top`, `$skip`, `$count`, `$orderby`)  
  - Edge cases (empty results, large responses, pagination)  
  - Error scenarios (invalid input, not found, connectivity failures, backend errors, timeout handling)  
  - Multi-provider failover scenarios  
  - Input validation and sanitization  
- All tests pass in continuous integration with 100% pass rate  
- Tests run on multiple Node.js versions (20.x, 22.x)  
- Error handling covers at least five distinct error scenarios:  
  - Invalid input format (400 Bad Request)  
  - Resource not found (404 Not Found)  
  - Backend connectivity failure (503 Service Unavailable)  
  - Request timeout (504 Gateway Timeout)  
  - Internal server errors (500 Internal Server Error)  

### Evidence

- Test Suite Statistics: 340 tests total (135 integration tests, 205 unit tests)  
- Code Coverage Report: https://codecov.io/gh/ODATANO/ODATANO  
- Coverage Metrics: 96.28% statement coverage, 81.97% branch coverage  
- CI/CD Pipeline Configuration: https://github.com/ODATANO/ODATANO/blob/main/.github/workflows/test.yaml  
- CI/CD Test Runs: https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml  
- Code Coverage Configuration: https://github.com/ODATANO/ODATANO/blob/main/codecov.yml  

**Integration Test Files**

- Core Blockfrost Integration Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/core.blockfrost.test.ts  
- Core Koios Integration Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/core.koios.test.ts  
- Error Handling Service Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/error-handling-service.test.ts  
- Error Handling Backend Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/error-handling.backend.ts  
- OData Features Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/odata_features.test.ts  
- Test Helper Utilities: https://github.com/ODATANO/ODATANO/blob/main/test/integration/backend-test-helper.ts  
- Core Test Suite: https://github.com/ODATANO/ODATANO/blob/main/test/integration/core-test-suite.ts  

**Unit Test Files**

- Blockfrost Backend Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/blockfrost-backend.test.ts  
- Cardano Client Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/cardano-client.test.ts  
- Error Classes Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/errors.test.ts  
- Validators Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/validators.test.ts  

**Configuration and Documentation**

- Jest Test Configuration: https://github.com/ODATANO/ODATANO/blob/main/jest.config.cjs  
- Test Documentation: https://github.com/ODATANO/ODATANO/blob/main/test/README.md  
- Error Handling Documentation: https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/ERROR_HANDLING.md  
- Error Code Definitions: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/error-codes.ts  
- Error Implementation: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/errors.ts  

**Test Reports & Release**

- Test Reports (CI Pipeline Logs): https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml  
- Latest Test Run Results: https://github.com/ODATANO/ODATANO/actions  
- Milestone Release v0.1-milestone1: https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1  

---

## E. Output: Documentation Package

Comprehensive documentation package covering all aspects of the project including architecture, setup, deployment, API usage, data models, error handling, testing, and development guidelines. Documentation is structured in the `/docs` folder with clear separation between user-facing guides and technical architecture documentation.

### Acceptance criteria

- Comprehensive documentation available in `/docs` folder and main README  

**Developer Guide includes:**

- Complete project architecture overview with multi-provider failover explanation  
- Data models and EDMX schema documentation  
- Setup instructions for local development (Node.js, npm, environment configuration)  
- Integration details for Cardano APIs (Blockfrost, Koios)  
- TypeScript configuration and CDS model generation  
- Testing setup and execution  
- CI/CD pipeline documentation  

**User Guide includes:**

- Service deployment instructions (local, Docker, SAP BTP)  
- How to query OData API from different clients (SAP, Postman, REST clients)  
- Complete example queries with expected outputs  
- OData query feature examples (`$filter`, `$select`, `$expand`, etc.)  
- Network configuration (mainnet, preview, preprod)  
- Known limitations and troubleshooting  

**Architecture Documentation includes:**

- Data model diagrams (Mermaid format)  
- Entity relationship documentation  
- Indexing strategy (lazy on-demand with TTL)  
- Error handling concepts and error codes  
- Quick Start Guide for rapid deployment  
- Docker Deployment Guide for containerized deployment  
- Architecture diagrams available in multiple formats  
- Clear licensing (Apache 2.0) and contribution guidelines  

### Evidence

**Main Documentation**

- Project README (Overview, Features, Installation, Quick Start): https://github.com/ODATANO/ODATANO/blob/main/README.md  
- Quick Start Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/QUICK_START.md  
- Developer Guide (Architecture, Setup, Development): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/DEVELOPER_GUIDE.md  
- User Guide (Deployment, Querying, Examples): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/USER_GUIDE.md  
- Docker Deployment Guide (Container Setup): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/DOCKER_DEPLOYMENT.md  

**Concepts & Architecture Documentation**

- Data Model Mermaid Diagram: https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/datamodel.mmd  
- Data Model Documentation (Detailed Entity Specs): https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/MM_DATAMODEL.md  
- Error Handling Guide (Error Codes, Strategies): https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/ERROR_HANDLING.md  
- Indexing Strategy Documentation (Lazy Loading, TTL): https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/INDEXING.md  

**Requirements & Project Planning**

- Milestones Documentation (M1, M2, M3): https://github.com/ODATANO/ODATANO/blob/main/docs/requirments%20%26%20milestones/MILESTONES_FINAL.md  
- Deliverables Document: https://github.com/ODATANO/ODATANO/blob/main/docs/DELIVERABLES.md  

**Code Examples & Tools**

- Postman Collection (Complete API Catalog): https://github.com/ODATANO/ODATANO/blob/main/scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json  
- TypeScript Request Examples: https://github.com/ODATANO/ODATANO/blob/main/scripts/request_examples.ts  

**Configuration Files**

- TypeScript Configuration: https://github.com/ODATANO/ODATANO/blob/main/tsconfig.json  
- ESLint Configuration: https://github.com/ODATANO/ODATANO/blob/main/eslint.config.mjs  
- Package.json (Dependencies, Scripts): https://github.com/ODATANO/ODATANO/blob/main/package.json  
- Docker Compose: https://github.com/ODATANO/ODATANO/blob/main/docker-compose.yml  
- Dockerfile: https://github.com/ODATANO/ODATANO/blob/main/Dockerfile  
- Environment Configuration: https://github.com/ODATANO/ODATANO/blob/main/config/config.ts  

**License & Legal**

- Apache 2.0 License: https://github.com/ODATANO/ODATANO/blob/main/LICENSE  

**Demo & Release**

- Milestone Release v0.1-milestone1: https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1  
- Demo Video (M1 Walkthrough – ~5 min): https://www.youtube.com/watch?v=jDw6MXgbfR0

---
---

# Proof of Achievement – Milestone 2

---

## A. Output: Transaction Builder Module

Implementation of a server-side module within the CAP service that constructs raw Cardano transactions from API inputs. The builder supports ADA transfers, metadata transactions, multi-asset transfers, and token minting. It handles UTXO selection and fee calculation using established Cardano libraries. Two builder engines are implemented (CSL and Buildooor) with a registry pattern for runtime selection.

### Acceptance criteria

- Transaction construction from specified input parameters (destination address, ADA amount, optional metadata)
- Well-formed unsigned transactions with correct inputs, outputs, and valid fees
- UTXO selection implemented (LargestFirstMultiAsset strategy)
- Fee calculation based on current protocol parameters
- CBOR serialized output ready for external signing
- Support for multiple transaction types (ADA transfer, metadata, multi-asset, minting)
- Protocol compliance: sum of inputs covers outputs + fees, valid CBOR format
- Transactions pass Cardano protocol validation when signed and submitted

### Evidence

**Transaction Builder Implementations**

- CSL Transaction Builder: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/transaction-building/csl-tx.ts
- Buildooor Transaction Builder: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/transaction-building/buildooor-tx.ts
- TX Builder Registry (Factory Pattern): https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/transaction-building/tx-builder-registry.ts
- TX Builder Interface: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/transaction-building/tx-builder.ts

**Transaction Service (OData Actions)**

- Transaction Service Definition: https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-tx-service.cds
- Transaction Service Implementation: https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-tx-service.ts

**Data Model**

- Transaction Build Entities (Schema): https://github.com/ODATANO/ODATANO/blob/main/db/schema.cds

**Libraries Used**

- Cardano Serialization Lib (CSL): `@emurgo/cardano-serialization-lib-nodejs` v15.0.3
- Buildooor: `@harmoniclabs/buildooor` v0.1.21
- Ogmios Client: `@cardano-ogmios/client` v6.14.0

---

## B. Output: Transaction Submission Functionality

Integration with multiple Cardano backends to submit signed transactions. Using a multi-backend architecture with Ogmios (primary), Blockfrost, and Koios as fallback providers, the service can broadcast signed transactions to the Cardano network. The implementation includes automatic failover, transaction ID tracking, and submission status monitoring.

### Acceptance criteria

- Signed transaction submission to Cardano preview testnet
- Transaction ID (txHash) extraction and tracking
- Multi-backend support with automatic failover (Ogmios → Blockfrost → Koios)
- Submission status tracking (submitted, confirmed, failed)
- Network response handling and error reporting
- Support for both build-referenced and externally-built transactions

### Evidence

**Backend Implementations**

- Ogmios Backend: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/ogmios-backend.ts
- Blockfrost Backend: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/blockfrost-backend.ts
- Koios Backend: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/koios-backend.ts
- Backend Registry: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/backend-registry.ts
- Backend Interface: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/backends/cardano-backend.ts

**Submission Logic**

- Transaction Service (Submit Actions): https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-tx-service.ts
- Cardano Client (Multi-Provider Orchestration): https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/cardano-client.ts

**Documentation**

- Backend Configuration Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/BACKEND_CONFIGURATION.md
- Example Build–Sign–Submit Workflows: https://github.com/ODATANO/ODATANO/blob/main/docs/requirments%20%26%20milestones/ODATANO-M2%20Testing%20Screenshots%20Postman%20%26%20Scripts.pdf

---

## C. Output: End-to-End Example Scripts

Reference implementations and scripts demonstrating the full build–sign–submit flow. Scripts call the OData API to build transactions, invoke external signing (Cardano CLI via Docker), and submit the signed transaction through the API.

### Acceptance criteria

- Complete build → sign → submit workflow demonstrated
- External signing with (Cardano CLI)
- Scripts executable against preview testnet
- Postman collection for API testing

### Evidence

**Example Scripts**

- Send ADA Script (Build → Sign → Submit): https://github.com/ODATANO/ODATANO/blob/main/scripts/send-ada-preview.ts
- Send ADA with Metadata Script: https://github.com/ODATANO/ODATANO/blob/main/scripts/send-ada-with-metadata-preview.ts
- Mint Token Script: https://github.com/ODATANO/ODATANO/blob/main/scripts/mint-token-preview.ts
- Send Multi-Asset Script: https://github.com/ODATANO/ODATANO/blob/main/scripts/send-multi-asset-preview.ts

**Postman Collection**

- M2 Full Service Catalog: https://github.com/ODATANO/ODATANO/blob/main/scripts/ODATANO%20M2%20-%20Full%20Service%20Catalog.postman_collection.json

---

## D. Output: Extended Documentation

Updates to the documentation focusing on transaction handling, including Transaction Schema Specification, Signing Workflow Guide with examples using Cardano CLI and browser wallets, and Troubleshooting & Error Codes section for common issues.

### Acceptance criteria

- Transaction Schema Specification documented
- Signing Workflow Guide with multiple signing methods (CLI, Browser Wallet, Hardware Wallet)
- Troubleshooting & Error Codes section for transaction-related issues
- API reference for all transaction actions
- Architecture diagrams for transaction flow

### Evidence

**Transaction Documentation**

- Transaction Workflow Guide (685 lines): https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/TRANSACTION_WORKFLOW.md
- Error Handling Documentation: https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/ERROR_HANDLING.md
- Backend Configuration Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/BACKEND_CONFIGURATION.md
- Indexing Documentation (Updated for TX Entities): https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/INDEXING.md
- Data Model Documentation (Updated): https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/MM_DATAMODEL.md

---

## E. Output: Test Cases for Build/Submit

Additional automated tests validating the transaction builder logic, submission flow, and error handling. Unit tests verify transaction construction with known inputs, and integration tests simulate the submission workflow.

### Acceptance criteria

- Unit tests for transaction builder (CSL and Buildooor engines)
- Integration tests for submission flow
- Error scenario tests for all five required error cases:
  - (1) Insufficient funds
  - (2) Invalid input data
  - (3) Invalid signature
  - (4) Network failure
  - (5) Duplicate/Replay transaction
- Tests pass in continuous integration

### Evidence

**Integration Tests**

- CSL Builder Integration Test: https://github.com/ODATANO/ODATANO/blob/main/test/integration/tx.csl.test.ts
- Buildooor Builder Integration Test: https://github.com/ODATANO/ODATANO/blob/main/test/integration/tx.buildooor.test.ts
- Transaction Submission Mock Test: https://github.com/ODATANO/ODATANO/blob/main/test/integration/tx-submission-mock.test.ts
- Transaction Test Suite: https://github.com/ODATANO/ODATANO/blob/main/test/integration/tx-test-suite.ts
- Error Handling Builder Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/tx-error-handling.builder.ts

**Unit Tests**

- CSL TX Builder Unit Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/csl-tx-builder.test.ts
- TX Builder Registry Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/tx-builder-registry.test.ts
- TX Build Helper Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/tx-build-helper.test.ts
- Error Classes Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/errors.test.ts
- Validators Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/validators.test.ts

**Error Handling Implementation**

- Error Classes (8 specialized): https://github.com/ODATANO/ODATANO/blob/main/srv/utils/errors.ts
- Error Codes Definition: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/error-codes.ts
- Input Validators: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/validators.ts

**CI/CD**

- Test Pipeline: https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml
- Code Coverage: https://codecov.io/gh/ODATANO/ODATANO
- Ogimos Sync Action for Tests: https://github.com/ODATANO/ODATANO/actions/workflows/ogmios-sync.yaml

---

## F. Output: Error Handling (Transaction Flow)

Implementation of comprehensive error handling for transaction-related operations with five distinct error scenarios as specified in the milestone requirements.

### Acceptance criteria

- (1) **Insufficient funds:** Build fails with clear error when UTXOs cannot cover amount + fees
- (2) **Invalid input data:** Malformed address or invalid parameters yield 400 error
- (3) **Invalid signature:** Wrong signing key or tampered CBOR returns validation failure
- (4) **Network failure:** Timeout or unreachable endpoint returns 503 error (with failover)
- (5) **Duplicate/Replay:** Already-submitted transaction handled gracefully (409 or idempotent success)
- All error conditions have corresponding error codes documented

### Evidence

**Error Classes Implemented**

| Error Scenario | Error Code | HTTP Status | Class |
|----------------|------------|-------------|-------|
| Insufficient Funds | `ODATANO_INSUFFICIENT_FUNDS` | 400 | `InsufficientFundsError` |
| Invalid Input | `ODATANO_INVALID_INPUT` | 400 | `InvalidInputError` |
| Invalid Signature | `ODATANO_TX_VALIDATION_FAILED` | 400 | `TransactionValidationError` |
| Network Failure | `ODATANO_PROVIDER_UNAVAILABLE` | 503 | `ProviderUnavailableError` |
| Duplicate TX | `ODATANO_TX_ALREADY_SUBMITTED` | 409 | `TransactionAlreadySubmittedError` |

**Implementation Files**

- Error Classes: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/errors.ts
- Error Codes: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/error-codes.ts
- Error Handling Documentation: https://github.com/ODATANO/ODATANO/blob/main/docs/concepts%20%26%20architecture/ERROR_HANDLING.md

---

**Demo & Release**

- Milestone Release v0.2-milestone2: https://github.com/ODATANO/ODATANO/releases/tag/v0.2-milestone2
- Testing Output summary: https://github.com/ODATANO/ODATANO/blob/main/docs/requirments%20%26%20milestones/ODATANO-M2%20Testing%20Screenshots%20Postman%20%26%20Scripts.pdf
- Demo Video (M2 Walkthrough – ~5 min): https://www.youtube.com/watch?v=oFUJ-tN1QCE

---
---

# Proof of Achievement – Milestone 3

---

## A. Output: Unsigned Transaction Export Interface

Unsigned Transaction Export Interface: Extension of the transaction module to support exporting unsigned transactions for external signing. The OData Action BuildTransaction returns a valid payload containing a deterministic reference id, hash placeholder, and timestamp. This enables third-party signers (Cardano CLI, Browser Wallets, etc.) to sign externally – no private keys handled in the CAP service.

### Acceptance criteria
End-to-End External Signing Flow Validated: Unsigned TX can be exported, signed externally, verified, and successfully submitted to Cardano preview testnet.

### Evidence

**Signing Request Implementation**

- External Signer Module: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/signing/external-signer.ts
- Signing Helper Utilities: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/signing-helper.ts
- Sign Service (Signing Actions): https://github.com/ODATANO/ODATANO/blob/main/srv/cardano-sign-service.ts

**Data Model**

- SigningRequests Entity: https://github.com/ODATANO/ODATANO/blob/main/db/schema.cds
- AddressSigningRequests Entity: https://github.com/ODATANO/ODATANO/blob/main/db/schema.cds

**OData Actions (CardanoSignService at `/odata/v4/cardano-sign/`)**

- `CreateSigningRequest` - Create signing request from transaction build
- `GetSigningRequest` - Retrieve signing request status (auto-marks expired)
- `GetSigningRequestsByAddress` - Query signing requests by sender address

---

## B. Output: External Signer Integration Module

Implementation of the external signing workflow using the Cardano CLI as reference signer. Flow: Unsigned TX → External Sign → Verify → Assemble → Submit. Demonstrates full round-trip signing with complete key separation and no private-key exposure

### Acceptance criteria

Private-Key Isolation Confirmed: CAP service never stores or uses private key material (code review + architecture evidence).

### Evidence

**Signing Module Implementation**

- Signature Verifier: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/signing/signature-verifier.ts
- External Signer Module: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/signing/external-signer.ts
- CIP-30 Witness Combination: https://github.com/ODATANO/ODATANO/blob/main/srv/utils/signing-helper.ts
- HSM Signing Module: https://github.com/ODATANO/ODATANO/blob/main/srv/blockchain/signing/hsm-signer.ts

**OData Actions (CardanoSignService at `/odata/v4/cardano-sign/`)**

- `VerifySignature` - Cryptographically verify signed transaction
- `SubmitVerifiedTransaction` - Verify and submit in one step (supports CIP-30 witness sets)
- `SignWithHsm` - HSM signing action for signing with external hardware security modules
- `SignAndSubmitWithHsm` - Dual action for signing with HSM and submitting in one step
- `GetHsmStatus` - Check HSM availability and status

**Data Model**

- SignatureVerifications Entity (Audit Trail): https://github.com/ODATANO/ODATANO/blob/main/db/schema.cds

**Documentation**

- Transaction Workflow Guide (M3 Section): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/TRANSACTION_WORKFLOW.md
- User Guide (External Signing): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/USER_GUIDE.md
- Developer Guide (External Signing): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/DEVELOPER_GUIDE.md

---

## C. Output: SAP Business Process Integration Examples

SAP Business Process Integration Examples: Examples for Integration of the Cardano OData API into an SAP S/4HANA process (for example, a Purchase Order posting triggers a Cardano transaction or retrieves on-chain data).

### Acceptance criteria

SAP Integration Operational: An SAP process can trigger an API call and receive data or transaction confirmation within 10 seconds.

### Evidence

**SAP Integration Examples & Deployment**

- BTP Integration Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/PRODUCTION_DEPLOYMENT.md
- Security Best Practices for SAP Integration: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/SECURITY_GUIDE.md
- ABAP Examples: https://github.com/ODATANO/ODATANO/blob/main/docs/abap%20examples/README.md
---

## D. Output: Extended Enterprise Use Cases

Enterprise Use Cases: Exampels of advanced real-world SAP scenarios based on the integration: (e.g., sustainability tracking of CO₂ certificates, tokenized inter-company settlements, audit-trail reporting for FI/CO documents). Each use case includes ABAP examples and SAP/Explorer screenshots.

### Evidence
- General SAP Integration Use Cases Documentation: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/SAP_INTEGRATION_EXAMPLES.md
- ABAP Examples: https://github.com/ODATANO/ODATANO/blob/main/docs/abap%20examples/README.md
- Reusable ABAP Class for OData Integration: https://github.com/ODATANO/ODATANO/blob/main/docs/abap%20examples/zcl_odatano_client.clas.abap
- ABAP Test Class for OData Client & Goods Receipt Example integration: https://github.com/ODATANO/ODATANO/blob/main/docs/abap%20examples/zcl_odatano_test.clas.abap
- Advanced Example Use Case Implementation with own Fiori APP for supply chain tracking using ODATANO as a plugin: https://github.com/ODATANO/TRACE



## E. Output: Basic Wallet Viewer Fiori Sample App: 
A lightweight SAPUI5/Fiori application that visualizes wallet information from the OData API which demonstrates how easy it is to build simple apps based on the Odataservices / CAP definitions and can be used as a reference in future applications.  

### Acceptance criteria

Working SAP Fiori application that displays wallet information through OData services, including filtered views for balances, tokens, and transaction history.

### Evidence

- Implementation of the Fiori Sample App: https://github.com/ODATANO/ODATANO/tree/main/app/wallet

- Youtube Video Demo of the Fiori Sample App: TODO


## F. Output: Automated Integration & Security Tests:
≥ 15 automated tests covering external signing, signature validation, SAP integration, and error conditions.

### Acceptance criteria
Integration Tests Passing: ≥ 90 % coverage and 100 % pass rate for designed test cases.

### Evidence

**Integration Tests**

- Signing Services Integration Tests: https://github.com/ODATANO/ODATANO/blob/main/test/integration/signing-services.test.ts

**Unit Tests**

- Signing Module Unit Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/signing.test.ts
- HSM Signer Unit Tests: https://github.com/ODATANO/ODATANO/blob/main/test/unit/hsm-signer.test.ts

**Test Documentation**

- Test README (M3 Section): https://github.com/ODATANO/ODATANO/blob/main/test/README.md

**CI/CD**

- Test Pipeline: https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml
- Code Coverage: https://codecov.io/gh/ODATANO/ODATANO

**Security Guidelines and Best Practices for SAP Integration**
- Security Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/SECURITY_GUIDE.md
---

## General Other Evidence for Milestone 3

**Demo & Release**

- Milestone Release v0.3-milestone3: https://github.com/ODATANO/ODATANO/releases/tag/v0.3-milestone3
- Demo Video External Signing: TBD
