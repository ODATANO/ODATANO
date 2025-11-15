# Technical Design Specification (TDS)

**Project:** ODATANO – SAP–Cardano OData Connector\
**Scope:** Milestone 1 – OData Foundation & Blockchain Read Integration\
**Version:** 1.1 (Aligned with M1 Delivery – Jan 2025)\
**Date:** 2025-10-31\
**Author:** Maximilian Weber\
**License:** Apache-2.0

## 1. Purpose & Objectives

### Purpose

Define the foundational architecture and data model for an enterprise-grade
OData V4 service (SAP CAP-based) providing **read-only access** to Cardano
blockchain data such as transactions, addresses, and token metadata.

### Objectives

- Deliver a functional **CAP OData service** exposing blockchain entities
  (`Transactions`, `Addresses`, `Assets`).
- Implement CAP Services for the **read-integration** with the Cardano preview
  network via **Blockfrost API** (primary) and **Koios API** (fallback).
- Provide **three or more fully working OData endpoints** (transaction lookup,
  address balance, metadata query etc.).
- Include automated tests, schema documentation, and demonstration queries.

## 2. Architecture Overview

### Layered Architecture

| Layer                   | Description                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **OData API (CAP)**     | Provides typed V4 endpoints for blockchain entities (`Transactions`, `Addresses`, `Assets`).     |
| **Integration Adapter** | Service handlers calling external Cardano APIs (Blockfrost / Koios). Converts JSON → CDS models. |
| **Domain Model**        | Typed CDS entities for blockchain primitives (TxHash, Bech32, Lovelace, PolicyId etc.).          |
| **Persistence Layer**   | Lightweight in-memory or SQLite mirror for local caching and test replay.                        |

### Design Principles

- Strict typing of all blockchain primitives.
- Read-only, side-effect-free operations for M1.
- Adapter isolation (`/srv/adapters/`).
- Consistent API mapping independent of data source.
- Resilient error handling for invalid inputs and network failures.

## 3. Data Model (CDS)

### 3.1 Primitive Types

| Type         | CAP Type        | Description                                         |
| ------------ | --------------- | --------------------------------------------------- |
| `Lovelace`   | `Decimal(38,0)` | ADA amount in Lovelace (1 ADA = 1_000_000 Lovelace) |
| `PolicyId`   | `String(56)`    | 28-byte hex policy hash                             |
| `AssetName`  | `String(128)`   | UTF-8 token name (≤ 32 bytes)                       |
| `TxHash`     | `String(64)`    | 32-byte transaction hash                            |
| `Bech32`     | `String(256)`   | Cardano address / stake key                         |
| `Hex`        | `String(4096)`  | CBOR-encoded binary data                            |
| `JsonText`   | `LargeString`   | Arbitrary JSON payload                              |
| `NetworkTag` | `String(16)`    | Environment identifier (preview / mainnet)          |

### 3.2 Core Entities (M1 Scope)

| Entity           | Description                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **Networks**     | Holds network configuration (chain ID, API base URL, isDefault).                                        |
| **Transactions** | Basic transaction object: `txHash`, `blockHeight`, `timestamp`, `fee`, `inputs`, `outputs`, `metadata`. |
| **Addresses**    | Represents Cardano addresses (`bech32`, `stakeKey`, `type`). Used for UTxO and balance queries.         |
| **Assets**       | Multi-asset representation: `policyId`, `assetName`, `quantity`, `decimals`, `metadata`.                |
| **UTxOs**        | (optional mirror) Links `address` and `txHash + index` to ADA and asset amounts.                        |

> Entities like `SignRequests`, `BridgeJobs`, `Subscriptions` are planned for
> future milestones and excluded here.

## 4. OData Service Design

**Service Name:** `BlockchainService`

**Exposed Entities:**\
`Transactions`, `Addresses`, `Assets`, `UTxOs`, `Networks`

**Capabilities:**

- `$filter`, `$expand`, `$select`, `$top`, `$skip`
- Auto-generated `$metadata` document
- JSON + XML response support
- Paging for large result sets

**Example Queries:**

```http
GET /odata/v4/BlockchainService/Transactions?$filter=txHash eq '<hash>'
GET /odata/v4/BlockchainService/Addresses('<bech32>')/UTxOs
GET /odata/v4/BlockchainService/Assets?$filter=policyId eq '<pid>'
```

## 5. Blockchain Integration Adapter (Read)

### Supported Sources

- **Primary:** Blockfrost API
- **Fallback:** Koios API
- **Future:** Direct Cardano Node or db-sync connector

### Mapping Logic

| Source API               | Target Entity      | Mapping Notes                                             |
| :----------------------- | :----------------- | :-------------------------------------------------------- |
| `txs/{hash}`             | `Transactions`     | Includes inputs, outputs, metadata → flattened structure. |
| `addresses/{addr}`       | `UTxOs` (+ Assets) | Extracts balance and multi-asset quantities.              |
| `assets/{policy}/{name}` | `Assets`           | Reads token metadata (CIP-25 / 68 / 721).                 |

### Error Handling

| Condition                 | Response                                              |
| :------------------------ | :---------------------------------------------------- |
| Invalid address / hash    | HTTP 400 – Bad Request                                |
| Not found                 | HTTP 404 – OData error (`ENTITY_NOT_FOUND`)           |
| API timeout / unreachable | HTTP 503 – Service Unavailable                        |
| Unauthorized (API key)    | HTTP 401 – Unauthorized                               |
| Internal error            | HTTP 500 – Generic server error (wrapped OData fault) |

### Caching / Consistency

- In-memory cache (`NodeCache`) for hot queries.
- Cache keys scoped by network (`preview` / `mainnet`).
- Optional local mirror (table `UTxOs`) for demo and offline testing.

## 6. Security & Compliance

| Area                | Implementation                                           |
| :------------------ | :------------------------------------------------------- |
| **Authentication**  | OAuth2 / XSUAA (SAP BTP); Basic Auth fallback for local. |
| **Secret Handling** | API keys from `.env` or BTP Destination Service.         |
| **Data Privacy**    | No PII stored; only public on-chain data.                |
| **Audit Logging**   | CAP default logging enabled (`console` + CI logs).       |
| **Webhooks**        | Not in scope for M1 (read-only phase).                   |

## 7. Acceptance Criteria (M1 Alignment)

| Category              | Expected Outcome                                                                                |
| :-------------------- | :---------------------------------------------------------------------------------------------- |
| **Deployment**        | CAP service deployable locally (`cds watch`) and accessible at `/odata/v4/BlockchainService`.   |
| **Connectivity**      | Queries successfully return live Cardano data from Blockfrost preview network.                  |
| **Endpoints**         | Minimum 3 functional read operations (Transaction Lookup, Address Balance, Metadata Query).     |
| **Schema Validation** | Responses match OData EDMX schema (types, naming, relations).                                   |
| **Error Handling**    | Five standardized error scenarios (400, 401, 404, 503, 500).                                    |
| **Test Coverage**     | ≥ 70 % unit + integration coverage on read services.                                            |
| **Open Source**       | Public GitHub repo with Apache-2.0 license, README, and `/docs` folder.                         |
| **Demonstration**     | Example query `GET /Transactions?$filter=txHash eq '<testHash>'` returns expected result < 5 s. |

## 8. Testing Strategy

### Unit Tests

- Validation of primitive types (`Bech32`, `TxHash`, `PolicyId`).
- Parsing and mapping API response → CDS entity.
- Error response simulation (invalid input / network down).

### Integration Tests

- Live queries against Cardano preview via Blockfrost.
- Schema validation (`$metadata`, `$filter`, `$expand`).
- Mock data fallback for deterministic responses.

### Continuous Integration

- **Tooling:** Jest + Supertest + nyc for coverage.
- Executed on every GitHub Actions push (build + test + coverage report).

### End-to-End Demo

- `Address → UTxOs → Assets` query chain executed live.
- `Transaction → Inputs / Outputs / Metadata` demonstrated through OData
  Services.

## 9. Future Outlook (M2 Preview)

Milestone 2 & 3 will extend this foundation with **write and transaction-build
capabilities**,\
including `SignRequests`, `BridgeJobs`, and external signing via HSM /
Fireblocks.
