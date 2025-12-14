# Lazy On-Demand Indexing (Architecture Concept)

ODATANO uses a **Lazy On-Demand Indexing** model for Cardano blockchain data.

This means two things:

1. Data is indexed _only when it is first requested_, not pre-synchronized.
2. Temporal entities remain valid for the duration defined by the `INDEX_TTL_MS`
   environment variable (default: 60000ms = 1 minute).

When a client (e.g., SAP system, UI5 app, ABAP logic, or any OData consumer)
queries an address, transaction, or UTxO data for the first time, ODATANO:

1. Checks if the entity exists in the database
2. If not → fetches it live from the Cardano blockchain
3. Normalizes and persists it into the ODATANO schema
4. Returns the enriched OData response

All subsequent reads within the TTL period are **instant** because the data is
locally indexed in the database. After TTL expiry, the data is re-fetched and
re-indexed on the next access.

---

## Why This Architecture?

### CAP “Service Facade” Pattern

ODATANO acts as a facade on top of the Cardano blockchain.\
The consumer sees clean OData entities while the service transparently handles
data retrieval and enrichment.

### No Full Blockchain Sync Required

ODATANO does **not** crawl or pre-index the entire chain.\
Only data that is actually requested gets indexed.

### Ideal for SAP / ERP Integrations

ERP systems often require dynamic, ad-hoc lookups.\
Lazy indexing supports scenarios like:

- Fetching arbitrary addresses
- Viewing transactions on demand
- Querying smart contract UTxOs

### Full OData Compatibility

Once indexed, the data supports the full OData query set:

- `$filter`
- `$expand`
- `$orderby`
- `$top` / `$skip`
- `$search`

### Efficiency

- **First read**: Live blockchain call via Blockfrost/Koios + persistence to
  database
- **Subsequent reads (within TTL)**: Fast local DB lookup
- **After TTL expiry**: Automatic re-indexing on next access

---

## Handling Temporal Data

For example, the `NetworkInformation` entity is marked as **temporal**:

```cds
entity NetworkInformation : temporal {
    key network           : String; // 'mainnet' | 'preview' | 'preprod' | 'testnet'
        maxSupply         : Lovelace; // 45_000_000_000_000_000
        totalSupply       : Lovelace; // current total supply
        circulatingSupply : Lovelace; // current circulating supply
        lockedSupply      : Lovelace; // current locked supply
        treasurySupply    : Lovelace; // current treasury supply
        reservesSupply    : Lovelace; // current reserves supply
        liveStake         : Lovelace; // current live stake
        activeStake       : Lovelace; // current active stake
}
```

When **`temporal`** is used in the entity definition, SAP CAP automatically
creates two additional key fields: **`validFrom`** and **`validTo`**. These
timestamp fields ensure that each entry is only valid for the specified time
period, enabling automatic time-based versioning.

When querying temporal entities, CAP automatically filters by temporal validity
and returns only currently valid entries, without requiring custom WHERE logic
in the read handler.

### Example in cardano-indexer.ts

```typescript
const existing = await db.run(SELECT.one.from(NetworkInformation));
```

This query returns **only** the currently valid entry (where current time is
between `validFrom` and `validTo`).

### Viewing Historical Data

To access historical or expired entries, you can create a projection that
disables temporal filtering:

```cds
entity HistoricNetworkInformation as projection on NetworkInformation {
    *,
    @(cds.valid.from: false) validFrom,
    @(cds.valid.to: false) validTo
}
```

This projection exposes all temporal versions of the data, allowing you to query
historical network information states.

---

## Configuration

The indexing behavior is controlled by environment variables:

| Variable       | Default   | Description                                          |
| -------------- | --------- | ---------------------------------------------------- |
| `INDEX_TTL_MS` | `60000`   | Time-to-live for cached data in milliseconds (1 min) |
| `NETWORK`      | `preview` | Cardano network (mainnet, preview, preprod)          |

**Example:**

```bash
# Set TTL to 5 minutes
INDEX_TTL_MS=300000

# Use mainnet
NETWORK=mainnet
```

---

## Implementation Flow

### 1. Initial Request

```
Client → GET /Addresses('addr1...')
  ↓
Service checks database for valid entry
  ↓ (not found or expired)
Indexer fetches from Blockfrost/Koios
  ↓
Data mapped and persisted with validFrom/validTo
  ↓
Response returned to client
```

### 2. Subsequent Requests (within TTL)

```
Client → GET /Addresses('addr1...')
  ↓
Service checks database for valid entry
  ↓ (found and valid)
Instant response from local DB
```

### 3. After TTL Expiry

```
Client → GET /Addresses('addr1...')
  ↓
Service checks database for valid entry
  ↓ (found but expired)
Indexer re-fetches from Blockfrost/Koios
  ↓
New temporal version created
  ↓
Response returned to client
```

This architecture ensures data freshness while minimizing blockchain API calls
and maintaining optimal query performance.
