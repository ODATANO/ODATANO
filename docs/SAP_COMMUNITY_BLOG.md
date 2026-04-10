# Adding Immutable Blockchain Proofs to SAP — With Cardano, CAP, and OData V4

**How a CAP plugin turns Cardano into just another OData service in your SAP landscape**

> *What if anchoring tamper-proof blockchain records from SAP was as simple as adding a CAP plugin? ODATANO turns the Cardano blockchain into a fully typed OData V4 service — 31 CDS entities, 34 actions, zero blockchain complexity for the consumer. Install it, configure it, query it like any other CAP service. This post walks through the architecture, the CAP plugin patterns behind it, and a real-world pharma supply chain demo built with Fiori and Plutus V3 smart contracts.*

---

## The Problem

SAP systems are trusted — but mutable. An admin can change a record, a migration can alter data, and an audit trail in the same database as the data it tracks is only as trustworthy as the access controls around it. Blockchain fixes that: **immutable, independently verifiable proof that data existed at a specific point in time**, outside any single organization's trust boundary.

The use cases are obvious — audit anchoring, supply chain provenance, cross-company verification, regulatory compliance. The challenge is the integration: chain-specific SDKs, raw CBOR payloads, wallet protocols, and provider APIs that have nothing in common with the OData services SAP developers consume every day.

If you have built CAP applications, you know the answer: model your domain in CDS, implement service handlers, let the framework handle OData protocol and runtime plumbing. That same pattern works for blockchain. Model Cardano's domain — blocks, transactions, UTxOs, assets — as CDS entities, and the blockchain becomes just another data source behind a CAP service. That is exactly what I built.

## ODATANO: A CAP Plugin That Makes Cardano Feel Native

ODATANO is not a standalone application — it is a **CAP plugin** (`@odatano/core` on npm). If you have ever used `@cap-js/sqlite` or `@sap/cds-hana`, you already know the pattern: install the package, add a configuration block, and the plugin auto-registers its services into your CAP application at startup. No code changes in your host app. No custom middleware. No manual route wiring.

### The CAP Plugin Mechanism

CAP scans `node_modules/` for packages containing a `cds-plugin.js` entry point. ODATANO ships exactly that. When CAP finds it, the plugin:

1. Registers a named service kind (`odatano-core`) so configuration flows through `cds.env.requires`
2. Hooks into `cds.on('served')` to initialize the blockchain client, backend connections, and local cache
3. Hooks into `cds.on('shutdown')` for clean teardown of WebSocket connections and indexer state
4. Auto-discovers its CDS models from the plugin's `db/` and `srv/` directories — CAP merges them into the host app's model at compile time

The plugin never throws on failure. If the blockchain backends are unreachable at startup, the host application continues serving its own services — ODATANO's endpoints simply return 503 until a backend becomes available.

### Setup in 60 Seconds

```bash
npm install @odatano/core @cap-js/sqlite
```

Add to your `package.json`:

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

Run `cds watch`. That is it. Three OData V4 services are now live alongside your own services, sharing the same CAP runtime, the same authentication middleware, and the same `$metadata` discoverability that every SAP tool expects.

### What the Plugin Provides

**Read Service** (`/odata/v4/cardano-odata`)
18 CDS entities covering blocks, transactions, addresses, UTxOs, assets, stake pools, epochs, accounts, DReps, and protocol parameters. All of them support the full OData V4 query surface: `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`, `$count`. This is not a thin wrapper — it is a proper CDS domain model with associations, compositions, and typed properties. A Fiori Elements list report can bind against these entities without a single line of custom UI code.

**Transaction Service** (`/odata/v4/cardano-transaction`)
11 CDS actions for the complete Build → Sign → Submit lifecycle. Simple ADA transfers, multi-asset transfers, native token minting, CIP-20 metadata transactions, and Plutus V3 smart contract interactions — all as OData-bound actions with typed parameters and structured responses. Each action returns a `TransactionBuilds` entity with fee estimates, unsigned CBOR, and output details.

**Signing Service** (`/odata/v4/cardano-sign`)
8 CDS actions implementing an external signing state machine. CIP-30 browser wallets, Cardano CLI, or PKCS#11 HSMs — the CAP service never touches private keys. Signing requests follow an explicit state machine (`pending` → `verified` → `submitted`) backed by CDS entities with TTL-based expiry.

In total: **31 CDS entities and 34 OData actions** across three services.

## How the CDS Model Maps to Cardano

One of the key design decisions was modeling Cardano's data structures as proper CDS entities rather than untyped JSON blobs. Here is what that looks like:

Cardano's native data — blocks, transactions, UTxOs — maps naturally to CDS entities with associations. A `Transaction` has a composition of many `TransactionInputs` and `TransactionOutputs`. An `Output` has a composition of many `OutputAssets`. An `Asset` has a `policyId`, `assetName`, `fingerprint`, and `quantity`. These are all typed CDS fields — not strings stuffed into a generic key-value store.

This means you can write queries like:

```
GET /odata/v4/cardano-odata/Transactions('abc123')?$expand=inputs,outputs($expand=assets)
```

And get back a fully structured, typed response that any OData client — Fiori, Excel, Power BI, or a custom CAP consumer — can process without parsing raw blockchain data.

For transaction building, the CDS actions use typed parameters:

```cds
action BuildMintTransaction(
  senderAddress         : String,
  recipientAddress      : String,
  lovelaceAmount        : String,
  mintActionsJson       : String,
  mintingPolicyScript   : String,
  scriptParamsJson      : String,
  changeAddress         : String,
  requiredSignersJson   : String,
  inlineDatumJson       : String,
  lockOnScript          : Boolean
) returns TransactionBuilds;
```

Every parameter has a name, a type, and OData metadata annotations with titles and descriptions. SAP tooling (API Business Hub, Gateway Client, Fiori Elements) can render input forms and documentation from the `$metadata` document alone.

## Architecture: CAP Patterns All the Way Down

Under the hood, ODATANO follows the same architectural patterns you would use in any well-structured CAP application:

### Service Handlers with `handleRequest()`

Every CDS action handler follows the same wrapper pattern:

```typescript
srv.on('BuildMintTransaction', async (req) => {
  // Validation rejections BEFORE handleRequest
  if (!req.data.senderAddress) return req.reject(400, 'senderAddress is required');

  return handleRequest(req, async () => {
    // Business logic inside handleRequest for error normalization
    const result = await txBuilder.buildMintTransaction(cleanData);
    return mapBuildResult(result);
  });
});
```

`handleRequest()` catches blockchain-specific errors and maps them to proper OData error responses — `400` for validation failures, `404` for missing UTxOs, `503` for backend unavailability. The consumer never sees a raw blockchain error.

### Lazy On-Demand Indexing

Blockchain data is not replicated in bulk. Instead, ODATANO uses lazy indexing: when a consumer queries a block, transaction, or address for the first time, the service fetches it from the blockchain backend, caches it in the local SQLite (or HANA) database via CDS UPSERT, and serves subsequent requests from cache until the TTL expires. This is the same pattern you would use with any external data source behind a CAP service — fetch on demand, cache locally, refresh periodically.

### Multi-Backend Failover

ODATANO supports three Cardano backends — Blockfrost, Koios, and Ogmios — with intelligent routing and automatic failover. The orchestrator picks the fastest available backend for each request type (Ogmios for live UTxOs, Blockfrost for historical queries) and falls back to alternatives on timeout or error. This is transparent to the consumer — the OData contract is the same regardless of which backend serves the data.

### Database Agnostic

Because ODATANO uses CDS entities and standard CAP persistence, it works with any CAP-supported database. Use `@cap-js/sqlite` for development and local testing, switch to `@cap-js/hana` for production on BTP — no code changes, no schema migration. The CDS compiler generates the correct DDL for each target.

## Real-World Example: TRACE — Pharma Supply Chain on Cardano

To show what this looks like end-to-end, I built TRACE — a full-stack **Fiori + CAP** application for pharmaceutical supply chain tracking. TRACE is itself a CAP application that consumes `@odatano/core` as a plugin. It demonstrates how a CAP developer can build on-chain business logic without ever leaving the CAP ecosystem.

The scenario: a pharmaceutical manufacturer produces a batch of medication. Regulatory compliance requires tamper-proof proof of every custody transfer — from manufacturer to distributor to pharmacy. Every handover must be traceable, and no party should be able to alter the record after the fact.

TRACE solves this with Plutus V3 smart contracts on Cardano:

1. **Mint.** The manufacturer mints a batch NFT through ODATANO's `BuildMintTransaction` action. The NFT carries an inline datum with the manufacturer ID, batch ID, and initial custody state — all written on-chain at the moment of creation. The `lockOnScript: true` parameter tells ODATANO to route the output to the Plutus script address automatically — no manual address derivation needed.

2. **Transfer.** Each custody handover calls `BuildPlutusSpendTransaction`. The Plutus validator enforces who is allowed to transfer, and the `inlineDatumJson` parameter carries the updated custody state to the continuing output. The rules are on-chain — not in the application.

3. **Verify.** Any party — including regulators, auditors, or the end consumer — can verify the complete chain of custody by querying ODATANO's read service with standard OData `$filter` and `$expand`. The data comes directly from Cardano, not from any single company's database.

From the CAP perspective, TRACE's `package.json` looks like this:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "odatano-core": {
        "network": "preview",
        "backends": ["blockfrost"],
        "blockfrostApiKey": "preview_KEY",
        "txBuilders": ["buildooor"]
      }
    }
  }
}
```

The Fiori app calls ODATANO the same way it would call any other OData service. The blockchain complexity — Plutus validators, CBOR encoding, UTxO selection, witness merging, cost model handling — is entirely behind the CDS service contract. For the SAP developer building the UI, it is just another CAP service.

## Why CAP — and Not a Custom REST API?

Building this as a CAP plugin rather than a standalone REST service was a deliberate architectural choice. Here is what it buys you:

| Concern | CAP Plugin Approach | Custom REST API |
|---|---|---|
| **Protocol** | OData V4 with full query support — free from the framework | Manual implementation of filtering, paging, sorting |
| **Metadata** | `$metadata` document auto-generated from CDS — tooling just works | OpenAPI spec maintained by hand, drifts from implementation |
| **Integration** | `npm install` + config — plugin merges into host app | Separate deployment, separate auth, separate lifecycle |
| **Database** | CDS entities work with SQLite, HANA, PostgreSQL — switch at deploy time | Schema migration per database, manual ORM |
| **Security** | Inherits host app's auth config (XSUAA, IAS, basic) | Separate auth setup, separate token validation |
| **UI Binding** | Fiori Elements annotations, draft support, value helps — all from CDS | Custom UI binding for every field |
| **Extensibility** | Consumers can extend CDS models, add custom handlers, hook into events | Fork the API or build a wrapper |

The CAP runtime handles the protocol plumbing — OData serialization, `$batch` support, ETag handling, error formatting — so the plugin code focuses entirely on the Cardano domain logic.

## Project Status

ODATANO is funded by Cardano Catalyst Fund 14 and is fully open source under Apache 2.0.

- **Version**: v1.0.0 (`@odatano/core` on npm)
- **Test suite**: 1,285 tests across 31 suites, 99% statement coverage
- **Networks**: mainnet, preview, preprod
- **Backends**: Blockfrost, Koios, Ogmios
- **Transaction builders**: CSL (Cardano Serialization Lib), Buildooor
- **CAP compatibility**: @sap/cds ^9, Node.js 18+
- **Repository**: [github.com/ODATANO/ODATANO](https://github.com/ODATANO/ODATANO)
- **Package**: [@odatano/core](https://www.npmjs.com/package/@odatano/core)

---

*ODATANO is open source under Apache 2.0. Try it in your CAP project:*

```bash
npm install @odatano/core
```

*Questions or feedback? Find me on GitHub: [github.com/ODATANO/ODATANO](https://github.com/ODATANO/ODATANO)*

**Maximilian Weber**
Project Lead, ODATANO
