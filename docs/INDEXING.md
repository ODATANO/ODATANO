# Lazy On-Demand Indexing via SQL or HANA DB (Architecture Concept)

ODATANO uses a **Lazy On-Demand Indexing** model for Cardano blockchain data.\
This means that data is indexed _only when it is first requested_, not
pre-synchronized.

When a client (e.g., SAP system, UI5 app, ABAP logic, or any OData consumer)
queries an address, transaction, or UTxO for the first time, ODATANO:

1. Checks if the entity exists in the local database
2. If not → fetches it live from the Cardano blockchain
3. Normalizes and persists it into the ODATANO schema
4. Returns the enriched OData response

All subsequent reads are **instant** because the data is now locally indexed.

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
- Building drill-downs in real time

### Full OData Compatibility

Once indexed, the data supports the full OData query set:

- `$filter`
- `$expand`
- `$orderby`
- `$top` / `$skip`
- `$search`

### Efficiency

- First read: live blockchain call + persistence
- Future reads: fast local DB lookup
