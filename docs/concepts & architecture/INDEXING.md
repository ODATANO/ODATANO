# Lazy On-Demand Indexing (Architecture Concept)

ODATANO uses a **Lazy On-Demand Indexing** model for Cardano blockchain data.

This means:

1. **Data is indexed only when first requested**, not pre-synchronized.
2. **Temporal entities** (Addresses, Accounts, NetworkInformation) and their sub-entities (AddressAssets, AddressUTxOs) remain valid for the duration defined by the `INDEX_TTL_MS` environment variable (default: 60000ms = 1 minute).
3. **Non-temporal/immutable data** (Transactions, Blocks, Epochs) are stored without temporal fields and remain accessible directly from the database after being indexed once.      

When a client (e.g., SAP system, UI5 app, ABAP logic, or any OData consumer)
queries an address, transaction, or UTxO data for the first time, ODATANO:

1. Checks if the entity exists in the database
2. If not → fetches it live from the Cardano blockchain
3. Normalizes and persists it into the ODATANO schema
4. Returns the enriched OData response

All subsequent reads are **instant** because the data is locally indexed in the database:

- **Temporal entities**: Valid for TTL period (default: 1 minute), then re-indexed on next access
- **Non-temporal entities**: Remain in database permanently without expiration

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

- **First read**: Live blockchain call via Blockfrost/Koios/Ogmios + persistence to database
- **Subsequent reads (within TTL)**: Fast local DB lookup
- **After TTL expiry**: Automatic re-indexing on next access
- **Transaction building (M2)**: Protocol parameters and UTxOs fetched from Ogmios (live) or Blockfrost/Koios (historical)

---

## Temporal vs. Non-Temporal Data

### Temporal Entities (Time-Limited Cache)

Temporal entities represent **mutable blockchain state** that can change over time:

- **NetworkInformation**: Supply, stake amounts change
- **Addresses**: Balance, UTxOs change
- **Accounts**: Stake delegation, rewards change
- **AddressAssets**: Asset holdings change
- **AddressUTxOs**: Available UTxOs change
- **TransactionBuilds** (M2): Unsigned transaction builds with TTL expiry
- **TransactionSubmissions** (M2): Transaction submission records with status tracking
- **SigningRequests** (M3): External signing requests with TTL-based expiration (30 min default)

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

### Non-Temporal Entities (Permanent Storage)

Non-temporal entities represent **immutable blockchain facts** that never change:

- **Transactions**: Once confirmed, transaction data is final
- **Blocks**: Block content is immutable
- **Epochs**: Epoch statistics are finalized after epoch ends
- **Pools**: Pool registration data (though delegation changes)
- **Dreps**: DRep registration data
- **TransactionBuildInputs/Outputs** (M2): Transaction build details (linked to TransactionBuilds)
- **TransactionBuildInputAssets/OutputAssets** (M2): Asset details in transaction builds
- **TransactionSubmissionErrors** (M2): Error records from failed submissions
- **SignatureVerifications** (M3): Cryptographic verification results (immutable audit trail)
- **AddressSigningRequests** (M3): Address-to-signing-request associations
- **AddressTransactionBuilds** (M3): Address-to-build associations
- **AddressTransactions** (M3): Address transaction history with net amounts

These entities are stored **without** `validFrom`/`validTo` fields and remain in the database permanently once indexed. They do not respect the `INDEX_TTL_MS` setting.

**Example in schema.cds:**

```cds
entity Transactions {
    key hash: Blake2b256;  // No temporal aspect
    blockHash: Blake2b256;
    fee: Lovelace;
    // ... other fields
}
```

Once a transaction is indexed, it can be queried instantly without re-fetching from the blockchain.

---

## Configuration

The indexing behavior is controlled by environment variables:

| Variable       | Default   | Description                                                     |
| -------------- | --------- | --------------------------------------------------------------- |
| `INDEX_TTL_MS` | `600000`  | Time-to-live for temporal entities in milliseconds (10 minutes) |
| `NETWORK`      | `preview` | Cardano network: `mainnet`, `preview`, or `preprod`             |
| `BACKENDS`     | `blockfrost,koios,ogmios` | Enabled backends (M2: Ogmios added)              |
| `TX_BUILDERS`  | `csl,buildooor` | Transaction builders (M2: CSL and Buildooor)            |

**Note:** `INDEX_TTL_MS` only affects **temporal entities** (Addresses, Accounts, NetworkInformation). Non-temporal entities (Transactions, Blocks, Epochs) remain in the database permanently.

**Example:**

```bash
# Set TTL to 5 minutes
INDEX_TTL_MS=300000

# Use mainnet
NETWORK=mainnet

# Enable specific backends (M2)
BACKENDS=blockfrost,ogmios

# Use CSL builder only (M2)
TX_BUILDERS=csl
```

---

## Implementation Flow

### Flow A: Temporal Entity (e.g., Address)

#### 1. Initial Request

```
Client → GET /Addresses('addr1...')
  ↓
Service checks database for valid entry
  ↓ (not found)
Indexer fetches from Blockfrost/Koios
  ↓
Data mapped and persisted with validFrom/validTo
  ↓
Response returned to client
```

#### 2. Subsequent Requests (within TTL)

```
Client → GET /Addresses('addr1...')
  ↓
Service checks database for valid entry
  ↓ (found and still valid)
Instant response from local DB (no blockchain call)
```

#### 3. After TTL Expiry

```
Client → GET /Addresses('addr1...')
  ↓
Service checks database for valid entry
  ↓ (found but expired)
Indexer re-fetches from Blockfrost/Koios
  ↓
New temporal version created (old version kept for history)
  ↓
Response returned to client
```

### Flow B: Non-Temporal Entity (e.g., Transaction)

#### 1. Initial Request

```
Client → GET /Transactions('hash123...')
  ↓
Service checks database for entry
  ↓ (not found)
Indexer fetches from Blockfrost/Koios
  ↓
Data mapped and persisted (no temporal fields)
  ↓
Response returned to client
```

#### 2. All Subsequent Requests

```
Client → GET /Transactions('hash123...')
  ↓
Service checks database for entry
  ↓ (found - never expires)
Instant response from local DB (no blockchain call)
```

---

## M2: Transaction Build and Submission Indexing

### Transaction Build Flow (Temporal Entity)

The M2 milestone introduces **TransactionBuilds** as a temporal entity:

```cds
entity TransactionBuilds : temporal {
    key buildId           : UUID;
        network           : String;
        senderAddress     : Bech32;
        unsignedTxCbor    : HexBytes;
        txHash            : Blake2b256;
        fee               : Lovelace;
        builder           : String; // 'csl' or 'buildooor'
        hasInputs         : Boolean;
        hasOutputs        : Boolean;
}
```

#### Build Transaction Workflow

```
Client → POST /BuildSimpleAdaTransaction
  ↓
Service validates inputs (sender, recipient, amount)
  ↓
Transaction Builder (CSL or Buildooor) selected
  ↓
Fetch protocol parameters from Ogmios/Blockfrost
  ↓
Fetch UTxOs from sender address (Ogmios/Blockfrost)
  ↓
Build unsigned transaction with fee calculation
  ↓
Persist TransactionBuilds with inputs/outputs/assets
  ↓
Return unsigned transaction CBOR to client
```

**TTL Behavior**: TransactionBuilds respect `INDEX_TTL_MS`. After expiry, old builds are no longer returned by default queries, but remain in database for historical queries.

### Transaction Submission Flow (Temporal Entity)

**TransactionSubmissions** tracks submission attempts:

```cds
entity TransactionSubmissions : temporal {
    key submissionId      : UUID;
        network           : String;
        signedTxCbor      : HexBytes;
        txHash            : Blake2b256;
        status            : String; // 'pending', 'submitted', 'failed'
        backend           : String; // 'ogmios', 'blockfrost', 'koios'
        submittedAt       : DateTime;
        hasErrors         : Boolean;
}
```

#### Submit Transaction Workflow

```
Client → POST /SubmitTransaction (with signed CBOR)
  ↓
Service validates signed transaction
  ↓
Submit via Ogmios (primary) or Blockfrost/Koios (fallback)
  ↓
Record submission in TransactionSubmissions
  ↓
If successful: return transaction hash
If failed: record errors in TransactionSubmissionErrors
```

**TTL Behavior**: Submission records are temporal and respect `INDEX_TTL_MS` for active queries, but persist for historical analysis.

---

## M3: External Signing Indexing

### Signing Request Flow (Temporal Entity with Custom TTL)

The M3 milestone introduces **SigningRequests** with a dedicated 30-minute TTL:

```cds
entity SigningRequests : temporal {
    key id                : UUID;
        build             : Association to TransactionBuilds;
        txBodyHash        : Blake2b256;
        unsignedTxCbor    : HexBytes;
        network           : String;
        status            : String; // 'pending', 'signed', 'verified', 'submitted', 'expired', 'failed'
        message           : String;
        cardanoCliCommand : String;
        createdAt         : DateTime;
        expiresAt         : DateTime;
        signedAt          : DateTime;
        verifiedAt        : DateTime;
        submittedAt       : DateTime;
}
```

#### External Signing Workflow (CardanoSignService at `/odata/v4/cardano-sign/`)

```
Client → POST /odata/v4/cardano-sign/CreateSigningRequest (with buildId)
  ↓
Service retrieves TransactionBuild by buildId
  ↓
Create SigningRequest with 30-minute TTL
  ↓
Generate Cardano CLI signing command
  ↓
Return signing instructions to client
  ↓
Client signs externally (CIP-30 wallet, CLI, hardware wallet)
  ↓
Client → POST /odata/v4/cardano-sign/SubmitVerifiedTransaction (with signed CBOR)
  ↓
Service verifies signature cryptographically
  ↓
Record verification in SignatureVerifications
  ↓
Submit to Cardano network
  ↓
Update SigningRequest status to 'submitted'
```

**TTL Behavior**: SigningRequests have a custom 30-minute expiration (not tied to `INDEX_TTL_MS`). When `GetSigningRequest` is called, the service automatically marks expired requests as 'expired'.

### Signature Verification (Non-Temporal Entity)

**SignatureVerifications** creates an immutable audit trail:

```cds
entity SignatureVerifications {
    key id                : UUID;
        signingRequest    : Association to SigningRequests;
        signedTxCbor      : HexBytes;
        isValid           : Boolean;
        witnessCount      : Integer;
        signerKeyHashes   : String; // Comma-separated list
        signerType        : String; // 'browser-wallet', 'cardano-cli', 'hardware-wallet'
        signerInfo        : String; // e.g., 'Nami', 'Eternl', 'Ledger'
        errorMessage      : String;
        verifiedAt        : DateTime;
}
```

**Behavior**: Every verification attempt is recorded, whether successful or failed. This provides a complete audit trail for compliance and security analysis.

### Address Association Entities (Non-Temporal)

M3 adds association entities for querying by address:

- **AddressSigningRequests**: Links addresses to their signing requests
- **AddressTransactionBuilds**: Links addresses to their transaction builds
- **AddressTransactions**: Links addresses to confirmed transactions with net amounts

These entities enable efficient queries like:
- "Show all pending signing requests for this address"
- "Show all transaction builds for this address"
- "Show transaction history with amounts for this address"

---

## Summary

This lazy indexing architecture provides:

✅ **Data Freshness**: Temporal entities respect TTL and auto-refresh\
✅ **Efficiency**: Immutable data (transactions, blocks) indexed once\
✅ **Performance**: All indexed data served from local database\
✅ **Flexibility**: No full blockchain sync required\
✅ **SAP Integration**: Full OData V4 compliance with $filter, $expand, etc.\
✅ **Audit Trail** (M3): Complete signing verification history for compliance\
✅ **Security** (M3): Private key isolation with external signing workflow

The combination of temporal and non-temporal entities ensures optimal balance between data freshness and query performance, while minimizing blockchain API calls.
