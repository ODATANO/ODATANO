# Technical Design Specification (TDS)

**Project:** ODATANO – SAP–Cardano OData Connector\
**Scope:** Milestone 1 – OData Foundation & Blockchain Read Integration\
**Version:** 1.0\
**Date:** 2025-11-29\
**Author:** Maximilian Weber\
**License:** Apache-2.0

---

## 1. Purpose & Objectives

### Purpose

Define the foundational architecture and data model for an enterprise-grade
OData V4 service (SAP CAP-based) providing **read-only access** to Cardano
blockchain data such as transactions, addresses, UTxOs, multi-asset holdings,
and transaction metadata.

The service acts as a **typed OData facade** on top of the Cardano blockchain,
using **lazy on-demand indexing**: data is fetched from Cardano on first access,
persisted into the ODATANO schema, and then served from the local database for
all subsequent reads.

### Objectives

- Deliver a functional **CAP OData V4 service** exposing Cardano entities:
  - `NetworkInformation`
  - `Transactions`, `TransactionInputs`, `TransactionOutputs`
  - `TransactionInputAssets`, `TransactionOutputAssets`
  - `Addresses`, `AddressAssets`, `AddressUTxOs`, `UTxOAssets`
  - `Metadata`, `MetadataLabels`
- Implement **read-integration** with Cardano using a pluggable backend:
  - Primary: Blockfrost (`@blockfrost/blockfrost-js`)
  - Fallback: Koios HTTP API
  - Orchestrated via a unified `CardanoClient` abstraction.
- Support **lazy on-demand indexing**:
  - First READ triggers indexing from Cardano if the entity is missing.
  - Persisted entities are then queryable via standard OData semantics.
- Provide example queries and scripts to demonstrate and test the integration
  (e.g. `examples/cardano-smoke-test.ts`).
- Include automated unit and integration tests plus coverage reporting.

---

## 2. Architecture Overview

### Layered Architecture

| Layer                         | Description                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OData API (CAP Service)**   | `CardanoODataService` – exposes typed V4 endpoints for blockchain entities (Transactions, Addresses, UTxOs, Metadata, etc.) via `/odata/v4/cardano-odata`.      |
| **Service Layer**             | `srv/cardano-service.ts` – CAP `ApplicationService` implementing `READ` handlers with validation, lazy indexing, and error mapping.                             |
| **Indexing Layer**            | `srv/blockchain/cardano-indexer.ts` – orchestrates calls to `CardanoClient`, maps provider responses into CDS entities, and performs UPSERTs into the database. |
| **Integration Adapter**       | `srv/blockchain/cardano-client.ts` plus backends `blockfrost-backend.ts`, `koios-backend.ts` implementing the `CardanoBackend` interface.                       |
| **Domain Model (CDS Schema)** | `db/schema.cds` – CDS entities in namespace `odatano.cardano` for addresses, UTxOs, transactions, metadata, and supporting types.                               |

### Design Principles

- **Service-as-Facade:** CAP service hides Cardano specifics behind a clean
  OData model.
- **Lazy On-Demand Indexing:** Data is pulled from Cardano only when requested
  and then persisted for subsequent reads.
- **Strict typing** of Cardano primitives (hashes, Lovelace, bech32, metadata
  labels).
- **Read-only** operations for Milestone 1 (no transaction building / signing).
- **Backend abstraction**: multiple Cardano backends implementing the same
  interface (`CardanoBackend`) with initialization, timeout, and failover logic.
- **Resilient error handling** for invalid input, not found, timeout, and
  backend failures.

---

## 3. Data Model (CDS)

Namespace: `odatano.cardano`\
File: `db/schema.cds`

### 3.1 Primitive Types

| Type            | CAP Type        | Description                                                  |
| --------------- | --------------- | ------------------------------------------------------------ |
| `Blake2b224`    | `String(56)`    | 28-byte hex (e.g. policy IDs)                                |
| `Blake2b256`    | `String(64)`    | 32-byte hex (e.g. transaction hashes, block hashes)          |
| `HexBytes`      | `String(8192)`  | Generic hex-encoded CBOR / script data                       |
| `Lovelace`      | `Decimal(20,0)` | ADA amount in Lovelace (1 ADA = 1_000_000 Lovelace)          |
| `AssetUnit`     | `String(120)`   | Concatenation of policyId + assetNameHex                     |
| `CIP10`         | `String(120)`   | CIP-10 metadata label description / URL                      |
| `MetadataLabel` | `String(5)`     | Metadata label as string (e.g. `"721"`, `"674"`)             |
| `bech32`        | `String(120)`   | Cardano bech32 address or stake address (with regex assert). |

The `bech32` type has an assertion constraint:

```cds
type bech32 : String(120)
  @assert.format: '^(addr1|stake1|addr_test1|stake_test1)[0-9a-z]+$';
```

### 3.1 Structural Types

## AssetSlice

```cds
type AssetSlice {
    quantity     : Lovelace;
    policyId     : Blake2b224;
    assetNameHex : String(64);
    assetName    : String(128);
    fingerprint  : String(44);
}
```

## UTxODataSlice

```cds
type UTxODataSlice {
    dataHash            : Blake2b256;
    inlineDatum         : HexBytes;
    referenceScriptHash : Blake2b256;
}
```

## 3.2 Core Entities

### 3.3 Core Entities

#### 3.3.1 NetworkInformation

```
entity NetworkInformation : temporal, cuid {
    latestBlock : Blake2b256;
    network     : String(14);
    latestEpoch : String(3);
    apiHealth   : String(10);
}
```

#### 3.3.2 Addresses

```
entity Addresses : temporal {
    key address       : bech32;
        stakeAddress  : bech32;
        type          : String(20);
        isScript      : Boolean;
        totalLovelace : Lovelace;

        assets        : Composition of many AddressAssets
                            on assets.address = $self;
        utxos         : Composition of many AddressUTxOs
                            on utxos.address = $self;
}
```

#### 3.3.3 AddressAssets

```
entity AddressAssets : temporal {
    key address : Association to Addresses;
    key unit    : AssetUnit;
        asset   : AssetSlice;
}
```

#### 3.3.4 AddressUTxOs

```
entity AddressUTxOs : temporal {
    key address   : Association to Addresses;
    key hash      : Blake2b256;
    key index     : Integer;

        blockHash : Blake2b256;
        utxodata  : UTxODataSlice;

        assets    : Composition of many UTxOAssets
                        on assets.utxo = $self;
}
```

#### 3.3.5 UTxOAssets

```
entity UTxOAssets : cuid {
    utxo  : Association to AddressUTxOs;
    unit  : AssetUnit;
    asset : AssetSlice;
}
```

#### 3.3.6 Transactions

```
entity Transactions {
    key hash                 : Blake2b256 @assert.format: '^[a-f0-9]{64}$';
        blockHash            : Blake2b256;
        blockHeight          : Integer;
        blockTime            : Timestamp;
        slot                 : Integer64;
        txIndex              : Integer;
        fee                  : Lovelace;
        deposit              : Lovelace;
        size                 : Integer;
        utxoCount            : Integer;
        withdrawalCount      : Integer;
        mirCertCount         : Integer;
        delegationCount      : Integer;
        stakeCertCount       : Integer;
        poolUpdateCount      : Integer;
        poolRetireCount      : Integer;
        assetMintOrBurnCount : Integer;
        redeemerCount        : Integer;
        validContract        : Boolean;
        metadata             : Association to Metadata
                                   on metadata.tx = $self;
        inputs               : Composition of many TransactionInputs
                                   on inputs.tx = $self;
        outputs              : Composition of many TransactionOutputs
                                   on outputs.tx = $self;
}
```

#### 3.3.7 TransactionInputs

```
entity TransactionInputs {
    key tx           : Association to Transactions;
    key inputIndex   : Integer;
        address      : Association to Addresses;
        utxoData     : UTxODataSlice;
        isCollateral : Boolean;
        isReference  : Boolean;
        assets       : Composition of many TransactionInputAssets
                           on assets.input = $self;
}
```

#### 3.3.8 TransactionInputAssets

```
entity TransactionInputAssets : cuid {
    input : Association to TransactionInputs;
    unit  : AssetUnit;
    asset : AssetSlice;
}
```

#### 3.3.9 TransactionOutputs

```
entity TransactionOutputs {
    key tx          : Association to Transactions;
    key outputIndex : Integer;
        address     : Association to Addresses;
        utxo        : UTxODataSlice;
        assets      : Composition of many TransactionOutputAssets
                          on assets.output = $self;
}
```

#### 3.3.10 TransactionOutputAssets

```
entity TransactionOutputAssets : cuid {
    output : Association to TransactionOutputs;
    unit   : AssetUnit;
    asset  : AssetSlice;
}
```

#### 3.3.11 Metadata

```
entity Metadata {
    key tx          : Association to Transactions;
    key label       : Association to MetadataLabels;
        payloadJson : LargeString;
}
```

#### 3.3.12 MetadataLabels

```
entity MetadataLabels : cuid {
    label : MetadataLabel;
    cip10 : CIP10;
    count : Integer;
}
```

---

## 4. OData Service Definition

File: `srv/cardano-service.cds`

```
using { odatano } from '../db/schema';

service CardanoODataService {

    entity NetworkInformation      as projection on odatano.cardano.NetworkInformation;

    // core entities
    entity Transactions            as projection on odatano.cardano.Transactions;
    entity Addresses               as projection on odatano.cardano.Addresses;
    entity Metadata                as projection on odatano.cardano.Metadata;

    // address details
    entity AddressAssets           as projection on odatano.cardano.AddressAssets;
    entity AddressUTxOs            as projection on odatano.cardano.AddressUTxOs;
    entity UTxOAssets              as projection on odatano.cardano.UTxOAssets;

    // transaction details
    entity TransactionInputs       as projection on odatano.cardano.TransactionInputs;
    entity TransactionOutputs      as projection on odatano.cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on odatano.cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on odatano.cardano.TransactionOutputAssets;
}
```

---

## 5. Lazy Indexing & READ Handler Flow

File: `srv/cardano-service.ts`

The CAP service implements lazy on-demand indexing in the `READ` handlers for
`Addresses` and `Transactions`.

### 5.1 Address READ Flow

1. Validate the incoming `address` using `isBech32Address`.
2. Use `SELECT.one.from(Addresses).where({ address })` to check if the address
   is already stored.
3. If found → return the record directly from the database.
4. If not found → call `indexer.indexAddress(dbTx, address)` which:
   - calls `cardanoClient.getAddress()` and `cardanoClient.getAddressUtxos()`,
   - maps the response to `Addresses`, `AddressAssets`, `AddressUTxOs`,
     `UTxOAssets`,
   - persists everything via UPSERT using the same CAP transaction
     (`cds.tx(req)`),
   - returns the newly persisted `Addresses` row.

### 5.2 Transaction READ Flow

1. Validate the incoming `hash` with `isTxHash`.
2. Check the local table via `SELECT.one.from(Transactions).where({ hash })`.
3. If found → return.
4. If not → call `indexer.indexTransaction(dbTx, hash)` which:
   - calls `cardanoClient.getTransaction(hash)`,
   - maps the provider response to `Transactions`, `TransactionInputs`,
     `TransactionOutputs`, `TransactionInputAssets`, `TransactionOutputAssets`,
   - UPSERTs them into the database,
   - returns the `Transactions` row.

### 5.3 Detail Entities

For the following entities, the service simply forwards the OData query to the
underlying database with `db.run(req.query)`:

- `AddressAssets`
- `AddressUTxOs`
- `UTxOAssets`
- `TransactionInputs`
- `TransactionOutputs`
- `TransactionInputAssets`
- `TransactionOutputAssets`

These entities depend on the indexing having been performed previously for the
corresponding address or transaction.

---

## 6. Cardano Backend Layer

### 6.1 CardanoBackend Interface

File: `srv/blockchain/cardano-backend.ts`

```
export interface CardanoBackend {
  name: string;

  init(): Promise<void>;

  getTransaction(txHash: string): Promise<unknown>;
  getAddress(address: string): Promise<unknown>;
  getAddressUtxos(address: string): Promise<unknown[]>;

  getNetworkInformation(): Promise<unknown>;

  getMetadataLabels(): Promise<unknown[]>;
  getMetadataLabelTransactions(label: string | number): Promise<unknown[]>;
}
```

### 6.2 BlockfrostBackend

- Uses `@blockfrost/blockfrost-js`.
- Implements all methods of `CardanoBackend` where supported by Blockfrost.
- Converts HTTP/SDK errors into normalized error codes (e.g. `NOT_FOUND`).

### 6.3 KoiosBackend

- Uses `axios` to call Koios REST endpoints.
- Provides compatible implementations for transactions, addresses, UTxOs, and
  network information.
- For unsupported features (e.g. some metadata queries), throws a defined
  `NOT_SUPPORTED` error.

### 6.4 CardanoClient (Orchestrator)

File: `srv/blockchain/cardano-client.ts`

Responsibilities:

- Maintain an ordered list of backends, e.g.
  `[BlockfrostBackend, KoiosBackend]`.
- Initialize all backends via `init()`.
- Provide high-level methods:
  - `getTransaction(txHash)`
  - `getAddress(address)`
  - `getAddressUtxos(address)`
  - `getNetworkInformation()`
  - `getMetadataLabels()`
  - `getMetadataTransactions(label)`
- Wrap calls using helpers like `withTimeout` and `withFallback` to:
  - time-limit requests,
  - fall back to the next backend when the primary fails or times out.

The indexer (`cardano-indexer.ts`) uses only `CardanoClient`, never individual
backends directly.

---

## 7. Indexer

File: `srv/blockchain/cardano-indexer.ts`

### 7.1 Responsibilities

- `indexTransaction(dbTx, hash)`
  - Use `cardanoClient.getTransaction(hash)`.
  - Map provider response into:
    - `Transactions`
    - `TransactionInputs`
    - `TransactionOutputs`
    - `TransactionInputAssets`
    - `TransactionOutputAssets`
  - Persist via `UPSERT` using the CAP transaction.

- `indexAddress(dbTx, address)`
  - Use `cardanoClient.getAddress(address)` and
    `cardanoClient.getAddressUtxos(address)`.
  - Map into:
    - `Addresses`
    - `AddressAssets`
    - `AddressUTxOs`
    - `UTxOAssets`
  - Persist using `UPSERT`.

- Return the primary entity (`Transactions` or `Addresses`) so that the `READ`
  handler can send it back to the OData client.

### 7.2 Error Handling

- For not-found conditions from backends, rethrow a standardized `NOT_FOUND`
  error, which is then mapped to HTTP 404 at service level.
- For transient network issues, timeouts, or unexpected provider responses,
  throw generic errors that are mapped to 503/500.

---

## 8. Security & Compliance

- Blockfrost API keys are provided via environment variables (e.g.
  `BLOCKFROST_KEY`).
- No private keys or signing material is handled in Milestone 1 (read-only).
- Only public on-chain data is stored; there is no PII by design.
- Logging is done via a centralized logger (`srv/utils/logger`), which can be
  wired to SAP BTP logging or other observability stacks.

---

## 9. Acceptance Criteria (Milestone 1)

- CAP service runs via `cds watch` and is reachable at
  `/odata/v4/cardano-odata`.
- Entities exposed:
  - `NetworkInformation`
  - `Addresses`, `AddressAssets`, `AddressUTxOs`, `UTxOAssets`
  - `Transactions`, `TransactionInputs`, `TransactionOutputs`
  - `TransactionInputAssets`, `TransactionOutputAssets`
  - `Metadata`, `MetadataLabels`
- Lazy indexing works as designed:
  - First `READ` for an unknown address/transaction triggers indexing.
  - Subsequent `READ`s use the local DB only.
- Error behavior:
  - Invalid input (bad hash/address) → 400
  - Not found in Cardano → 404
  - Provider unreachable / timeout → 503
  - Unexpected internal errors → 500
- OData metadata (`$metadata`) is valid and in sync with `db/schema.cds` and
  `srv/cardano-service.cds`.
- Tests cover validators, CardanoClient fallback behavior, and core indexing
  flows with high coverage.
