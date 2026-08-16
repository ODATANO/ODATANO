# Lazy On-Demand Indexing (Architecture Concept)

**Version:** v2.0.0-rc.3 | **Last Updated:** August 2026

ODATANO uses a **Lazy On-Demand Indexing** model for Cardano blockchain data.

1. **Data is indexed only when first requested**, not pre-synchronized
2. **Temporal entities** (mutable state) remain valid for the duration defined by `INDEX_TTL_MS` (default: 600000ms = 10 minutes)
3. **Non-temporal entities** (immutable facts) are stored permanently after first indexing

When a client queries data for the first time, ODATANO checks the database, fetches from the blockchain on cache miss, persists the result, and returns the OData response. All subsequent reads within TTL are instant local DB lookups.

## Why This Architecture?

- **CAP "Service Facade" Pattern**: Consumer sees clean OData entities while the service transparently handles retrieval and enrichment
- **No Full Blockchain Sync**: Only actually requested data gets indexed
- **SAP/ERP Integration**: Supports dynamic, ad-hoc lookups (arbitrary addresses, on-demand transactions, smart contract UTxOs)
- **Full OData Compatibility**: Once indexed, data supports `$filter`, `$expand`, `$orderby`, `$top`/`$skip`, `$search`
- **Efficiency**: First read = live blockchain call + persistence; subsequent reads = fast local DB lookup

## Temporal vs. Non-Temporal Data

### Temporal Entities (TTL-Based Cache)

Mutable blockchain state that can change over time. Uses CAP's `temporal` aspect which adds `validFrom`/`validTo` key fields for automatic time-based versioning. Queries automatically return only currently valid entries.

- **NetworkInformation**: Supply, stake amounts
- **Addresses**: Balance, UTxOs
- **Accounts**: Stake delegation, rewards
- **AddressAssets / AddressUTxOs**: Asset holdings, available UTxOs
- **TransactionBuilds** (M2): Unsigned transaction builds
- **TransactionSubmissions** (M2): Submission records with status tracking
- **SigningRequests** (M3): External signing requests (custom 30-min TTL)

### Non-Temporal Entities (Permanent Storage)

Immutable blockchain facts stored without `validFrom`/`validTo`. Not affected by `INDEX_TTL_MS`.

- **Transactions / Blocks / Epochs**: Confirmed, immutable chain data
- **Pools / Dreps**: Registration data
- **TransactionBuildInputs/Outputs/Assets** (M2): Build details
- **TransactionSubmissionErrors**: Failed submission records
- **SignatureVerifications**: Immutable verification audit trail
- **AddressSigningRequests / AddressTransactionBuilds / AddressTransactions** (M3): Address association entities

See `db/schema.cds` for full entity definitions.

## v2.0: pre-sync alongside lazy indexing

Lazy indexing stays the default and is unchanged. v2.0 adds an **opt-in chain crawler** that fills
the same tables *ahead* of the request instead of on a cache miss:

| | Lazy indexing | Crawler pre-sync (v2.0) |
|---|---|---|
| Trigger | cache miss on a read | continuous, from a configured start block |
| Scope | the single entity asked for | every block + its transactions, inputs/outputs/assets/metadata |
| Freshness rule | TTL on temporal entities | none — the crawled range is **authoritative** |
| Write path | `CardanoIndexer.index*` per entity | `CardanoIndexer.indexBlockFull` (one UPSERT per table per block, atomic) |

The two coexist by design. Crawled entities (`Blocks`, `Transactions` and children) are
**non-temporal**, so nothing expires them and the lazy path simply finds them present; gaps outside
the crawled range are still filled on demand.

**Cursor and reorgs.** `CardanoSyncState` is a singleton cursor (last slot/hash/height, tip,
`syncStatus`, error streak) guarded by a DB lease, so exactly one instance crawls per deployment.
A rollback deletes everything after the fork point in one transaction, rewinds the cursor and writes
a `CardanoReorgLog` row. Two sources: Ogmios chain-sync (native `rollBackward`) and Blockfrost/Koios
pagination (parent-hash comparison). Enable with `CRAWLER_ENABLED=true` plus a start point; see the
[User Guide](../guides/USER_GUIDE.md).

**Consequence for consumers:** within the pre-synced range, reads never touch a backend — that is
the point of the feature, and the reason the range carries no TTL.

## Configuration

| Variable       | Default   | Description                                              |
| -------------- | --------- | -------------------------------------------------------- |
| `INDEX_TTL_MS` | `600000`  | TTL for temporal entities in milliseconds (10 minutes)   |
| `NETWORK`      | `preview` | Cardano network: `mainnet`, `preview`, or `preprod`      |
| `BACKENDS`     | `blockfrost,koios,ogmios` | Enabled backends                         |
| `TX_BUILDERS`  | `buildooor`     | Ignored — Buildooor is the only builder           |

`INDEX_TTL_MS` only affects temporal entities. Non-temporal entities remain permanently.

## Implementation Flow

### Temporal Entity (e.g., Address)

```
GET /Addresses('addr1...')
  → DB lookup for valid entry
  → Miss or expired: fetch from Blockfrost/Koios → persist with validFrom/validTo → return
  → Hit (within TTL): return from DB (no blockchain call)
  → After TTL: re-fetch → new temporal version (old version kept for history)
```

### Non-Temporal Entity (e.g., Transaction)

```
GET /Transactions('hash123...')
  → DB lookup
  → Miss: fetch from Blockfrost/Koios → persist (no temporal fields) → return
  → Hit: return from DB (never expires, never re-fetched)
```

### Transaction Build Workflow

```
POST /BuildSimpleAdaTransaction
  → Validate inputs → build (Buildooor)
  → Fetch protocol params + UTxOs from Ogmios/Blockfrost
  → Build unsigned tx with fee calculation
  → Persist TransactionBuilds with inputs/outputs/assets
  → Return unsigned CBOR (temporal, respects INDEX_TTL_MS)
```

### Transaction Submission Workflow

```
POST /SubmitTransaction (signed CBOR)
  → Validate → submit via Ogmios (primary) or Blockfrost/Koios (fallback)
  → Record in TransactionSubmissions (success → txHash, failure → errors)
```

### External Signing Workflow

```
POST /CreateSigningRequest (buildId)
  → Retrieve build → create SigningRequest (30-min TTL)
  → Return signing instructions (CLI command, CIP-30 guidance)
  → Client signs externally (wallet, CLI, hardware)

POST /SubmitVerifiedTransaction (signed CBOR)
  → Verify signature → record in SignatureVerifications
  → Submit to network → update SigningRequest status
```
