# Technical Design Specification (TDS)

**Project:** ODATANO – SAP–Cardano OData Connector **Scope:** Milestone 1 –
OData Foundation & Blockchain Read Integration **Version:** 1.0 **Date:**
2025-11-18 **Author:** Maximilian Weber **License:** Apache-2.0

## 1. Purpose & Objectives

### Purpose

Define the foundational architecture and data model for an enterprise-grade
OData V4 service (SAP CAP-based) providing **read-only access** to Cardano
blockchain data such as transactions, addresses, multi-asset holdings and token
metadata.

### Objectives

- Deliver a functional **CAP OData service** exposing blockchain entities
  (Transactions, Addresses, Assets, Metadata, UTxOs where applicable).
- Implement CAP Services for the **read-integration** with the Cardano preview
  network using the official **@blockfrost/blockfrost-js** SDK (primary) and
  **Koios** as fallback.
- Provide three primary OData actions/operations for M1: `GetTransactionByHash`,
  `GetAddressByBech32`, `GetMetadataByTx`, plus standard READ collections.
- Include automated unit and integration tests, coverage reporting, and
  demonstration queries.

## 2. Architecture Overview

### Layered Architecture

| Layer                   | Description                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **OData API (CAP)**     | Provides typed V4 endpoints and actions for blockchain entities (Transactions, Addresses, Metadata, Assets).                   |
| **Service Layer**       | `srv/cardano-service.js` — OData handlers, action implementations, request validation and mapping to domain objects.           |
| **Integration Adapter** | `srv/blockchain/*` — provider adapters (Blockfrost SDK, Koios) and `cardano-client.js` orchestrator for failover and timeouts. |
| **Domain Model**        | Typed CDS entities (db/schema.cds) for blockchain primitives (TxHash, Bech32, Lovelace, PolicyId, Blake2b types).              |
| **Caching / Mirror**    | In-memory cache (`srv/utils/cache.js`) and optional local mirror tables (UTxOs) used for demo/offline scenarios.               |

### Design Principles

- Strict typing of all blockchain primitives.
- Read-only, side-effect-free operations for M1.
- Adapter isolation (`/srv/adapters/`).
- Consistent API mapping independent of data source.
- Resilient error handling for invalid inputs and network failures.

## 3. Data Model (CDS)

### 3.1 Primitive Types

| Type         | CAP Type        | Description                                          |
| ------------ | --------------- | ---------------------------------------------------- |
| `Lovelace`   | `Decimal(38,0)` | ADA amount in Lovelace (1 ADA = 1_000_000 Lovelace)  |
| `PolicyId`   | `String(56)`    | 28-byte hex policy hash                              |
| `AssetName`  | `String(128)`   | UTF-8 token name (≤ 32 bytes)                        |
| `TxHash`     | `String(64)`    | 32-byte transaction hash                             |
| `Bech32`     | `String(256)`   | Cardano address / stake key                          |
| `Blake2b224` | `String(56)`    | 224-bit blake2b used in some Cardano identifiers     |
| `Blake2b256` | `String(64)`    | 256-bit blake2b used in transaction hashes (if used) |
| `Hex`        | `String(4096)`  | CBOR-encoded binary data                             |
| `JsonText`   | `LargeString`   | Arbitrary JSON payload                               |
| `NetworkTag` | `String(16)`    | Environment identifier (preview / mainnet)           |

### 3.2 Core Entities (M1 Scope)

| Entity           | Description                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Networks**     | Holds network configuration (chain ID, API base URL, isDefault).                                                              |
| **Transactions** | Transaction entity with `txHash`, `blockHeight`, `timestamp`, `fee`, flattened `inputs` and `outputs`, and linked `metadata`. |
| **Addresses**    | Represents Cardano addresses (`bech32`, `stakeKey`, `type`) with balance and asset holdings.                                  |
| **Assets**       | Multi-asset representation: `policyId`, `assetName`, `quantity`, `metadata` (CIP-25/68/721).                                  |
| **UTxOs**        | Optional mirror table used for demo/offline lookup; links `address` with `txHash` + `index` and amounts.                      |

> Entities like `SignRequests`, `BridgeJobs`, `Subscriptions` are planned for
> future milestones and excluded here.

## 4. OData Service Design

**Service Name:** `cardano-odata` (OData root: `/odata/v4/cardano-odata`)

**Exposed Entities & Actions:** `Transactions`, `Addresses`, `Assets`,
`Metadata`, `TransactionInputs`, `TransactionOutputs`, `TransactionInputAssets`,
`TransactionOutputAssets` and actions: `GetTransactionByHash`,
`GetAddressByBech32`, `GetMetadataByTx`.

**Example Queries:**

```http
GET /odata/v4/BlockchainService/Transactions?$filter=txHash eq '<hash>'
GET /odata/v4/BlockchainService/Addresses('<bech32>')/UTxOs
GET /odata/v4/BlockchainService/Assets?$filter=policyId eq '<pid>'
```

### 5. Blockchain Integration Adapter (Read)

### Supported Sources

- **Primary:** Blockfrost (official SDK: `@blockfrost/blockfrost-js`)
- **Fallback:** Koios (HTTP adapter)
- **Future:** db-sync or direct Cardano node connector

### cardano-client Orchestration

`srv/blockchain/cardano-client.js` implements lazy initialization and failover:

- Primary call to Blockfrost via SDK with a configurable timeout (default
  8000ms).
- On timeout/error, try Koios with same timeout.
- Combine and normalize errors for the service layer.

### Mapping Logic

| Source API                | Target Entity     | Notes                                                                     |
| :------------------------ | :---------------- | :------------------------------------------------------------------------ |
| `txs/{hash}` (Blockfrost) | `Transactions`    | Map inputs/outputs, decode multi-asset units, attach metadata if present. |
| `txs/{hash}/metadata`     | `Metadata`        | Blockfrost tx metadata → JSON stored in `Metadata` entity.                |
| `addresses/{addr}`        | `Addresses/UTxOs` | Address info + assets; used to compute balance and list assets.           |
| `assets/{unit}`           | `Assets`          | Read on-demand for asset metadata (CIP-25/721)                            |

### Error Handling (Normalized)

| Condition                 | Response                         |
| :------------------------ | :------------------------------- |
| Invalid address / hash    | HTTP 400 – Bad Request           |
| Not found                 | HTTP 404 – Not Found             |
| API timeout / unreachable | HTTP 503 – Service Unavailable   |
| Unauthorized (API key)    | HTTP 401 – Unauthorized          |
| Internal error            | HTTP 500 – Internal Server Error |

### Caching / Consistency

- `srv/utils/cache.js` (NodeCache) used with default TTL = 300s (5 minutes).
- Cache keys: `tx_{hash}`, `addr_{bech32}`, `meta_{hash}` and include network
  tag.
- Optional mirror tables (`UTxOs`) for demo/offline usage; mirror updated
  on-demand.

### 6. Security & Compliance

| Area                | Implementation                                                                                      |
| :------------------ | :-------------------------------------------------------------------------------------------------- |
| **Authentication**  | Local dev: `.env` with `BLOCKFROST_KEY`. Production: integrate with SAP BTP Destinations or OAuth2. |
| **Secret Handling** | Use environment variables or secret manager (do not commit keys). `.env.example` provided.          |
| **Data Privacy**    | Only public blockchain data is stored; no PII is kept.                                              |
| **Audit Logging**   | Service logs (console) and structured logs can be enabled. Add central logging in production.       |
| **Webhooks**        | Not in scope for M1 (read-only phase).                                                              |

## 7. Acceptance Criteria (M1 Alignment)

| Category              | Expected Outcome                                                                                                      |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **Deployment**        | CAP service deployable locally (`cds watch` or `cds serve --with-mocks`) and accessible at `/odata/v4/cardano-odata`. |
| **Connectivity**      | Live queries return Cardano preview data via Blockfrost (or Koios fallback).                                          |
| **Endpoints**         | `GetTransactionByHash`, `GetAddressByBech32`, `GetMetadataByTx` implemented and tested.                               |
| **Schema Validation** | Responses conform to the OData EDMX schema in the service `$metadata`.                                                |
| **Error Handling**    | Standardized error mapping for 400, 401, 404, 500, 503 implemented and covered by tests.                              |
| **Test Coverage**     | Unit + integration tests present; current status: 23 passing tests, 100% statements, 97.22% branches.                 |
| **Open Source**       | Repo contains license, README and a `/docs` folder with guides and test reports.                                      |
| **Performance**       | Typical cached response <100ms; first-call provider latency depends on external API (< ~2s typical).                  |

## 8. Testing Strategy

### Unit Tests

- Validate `srv/utils/validators.js` functions (isTxHash, isPolicyId,
  isBech32Address) — unit coverage 100%.
- Validate `srv/utils/errors.js` mapping logic — near-complete coverage.
- Mapping functions: API response → internal DTO → OData entity.

### Integration Tests

- Integration tests exercise the running CAP server endpoints
  (test/integration/*.test.js).
- Tests include 14 core M1 tests (m1_core.test.js) and provider error tests
  (provider_errors.test.js).

### Continuous Integration

- **Tooling:** Jest + Supertest + nyc for coverage; CI pipeline runs tests and
  produces coverage report.

### End-to-End Demo

- Demonstrations executed during M1 validation:
  - `POST /GetTransactionByHash` → validates input, calls providers, returns
    mapped transaction.
  - `POST /GetAddressByBech32` → returns balances and assets.
  - `POST /GetMetadataByTx` → returns transaction metadata.

Live test result snapshot: 23 tests passing; coverage: 100% statements, 97.22%
branches.

## 9. Future Outlook (M2 Preview)

Milestone 2 & 3 will extend this foundation with **enhanced transaction details,
write/construct capabilities, multi-asset flattening and improved asset
metadata**:

- Transaction input/output flattening and full multi-asset unit normalization
- Asset metadata enrichment (CIP-25, CIP-68, CIP-721 lookups)
- Batch query endpoints and pagination improvements
- Optional db-sync / direct node adapter for high-throughput production
- Explore OpenAPI / Swagger and interactive API explorer

---

## 10. Run & Test (Quick Commands)

Run CAP server (development/watch):

```powershell
cd 'c:\Users\max\ODATANO'
cds watch
```

Run CAP server (serve with mocks):

```powershell
cds serve --with-mocks
```

Run tests and coverage:

```powershell
npm test
npm test -- --coverage
```

Check OData metadata:

```powershell
Invoke-WebRequest -Uri 'http://localhost:4004/odata/v4/cardano-odata/$metadata' -UseBasicParsing
```

_Document updated to reflect implementation state as of 2025-11-18._
