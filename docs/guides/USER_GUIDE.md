# ODATANO User Guide

**Project:** ODATANO - OData V4 Service for Cardano Blockchain\
**Version:** 0.1.0 (Milestone 1 Complete)\
**Last Updated:** December 2025

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [API Endpoints](#api-endpoints)
3. [Query Examples](#query-examples)
4. [Error Responses](#error-responses)
5. [Authentication](#authentication)
6. [Rate Limiting & Performance](#rate-limiting--performance)
7. [Known Limitations](#known-limitations)
8. [FAQ](#faq)

---

## Getting Started

### What is ODATANO?

ODATANO is an **OData V4 service** that provides read-only access to Cardano
blockchain data. It allows you to query transactions, addresses, and metadata
through a standard OData interface.

**Key Features:**

- ✅ Query Cardano transactions, blocks, epochs by hash/number
- ✅ Fetch address balances, UTxOs, and native assets
- ✅ Access transaction metadata (by tx hash)
- ✅ Query pools, accounts (stake addresses), and DReps
- ✅ Automatic failover between multiple providers (Blockfrost → Koios)
- ✅ Intelligent caching with configurable TTL (via `INDEX_TTL_MS`)
- ✅ RESTful OData V4 API with full query support ($filter, $select, $expand, $top, $skip, $count, $orderby)
- ✅ Support for multiple networks (mainnet, preview, preprod)

### Supported Networks

- **Mainnet:** Production Cardano network (addresses start with `addr1`)
- **Preview:** Preview testnet (addresses start with `addr_test1`)
- **Preprod:** Pre-production testnet (addresses start with `addr1`)

Configure via `NETWORK` environment variable (default: `preview`)

### Base URL

```
http://localhost:4004/odata/v4/cardano-odata
```

### Service Document

View all available entities and actions:

```
http://localhost:4004/odata/v4/cardano-odata/$metadata
```

---

## API Endpoints

### 1. Network & Epoch

```http
GET /NetworkInformation
GET /Blocks?$orderby=height desc&$top=1
GET /Epochs?$orderby=epoch desc&$top=1
```

Action (equivalent for network info):

```http
POST /GetNetworkInformation
```

### 2. Transaction Lookup

#### Get All Transactions (collection)

```http
GET /Transactions
```

**Response:**

```json
{
  "value": []
}
```

Supports OData query options, e.g. `$top`, `$filter`, `$select`, `$expand`.

#### Get Transaction by Hash (Action)

```http
POST /GetTransactionByHash
Content-Type: application/json

{
  "hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"
}
```

**Response (Success - 200):**

```json
{
  "hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
  "block_hash": "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39",
  "slot": 12345678,
  "size": 450,
  "fee": "200000",
  "deposit": "0",
  "invalidBefore": null,
  "invalidHereafter": "12345700"
}
```

**Address format note:** Use a Cardano address matching your configured network
HRP (`addr1...` for mainnet, `addr_test1...` for preview/preprod). Examples:

- ✅ Valid (preview): `addr_test1qz0wmc...`
- ✅ Valid (mainnet): `addr1qz0wmc...`
- ❌ Invalid: `0x123456...` (Ethereum format)

**Response (Invalid Hash - 400):**

```json
{
  "error": {
    "code": "400",
    "message": "Invalid transaction hash format"
  }
}
```

---

### 3. Addresses, UTxOs, and Assets

#### Get All Addresses (collection)

```http
GET /Addresses
```

**Response:**

```json
{
  "value": []
}
```

#### Get Address by Bech32 (Action)

```http
POST /GetAddressByBech32
Content-Type: application/json

{
  "address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0"
}
```

**Response (Success - 200):**

```json
{
  "address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0",
  "balance": "5000000",
  "assets": [
    {
      "policyId": "7eae28f73815e14bf9f4d6f94c6f03cc0e3e5aa9d9e2c4b1a8f7e6d5c4b3a2",
      "assetName": "SUNDAE",
      "quantity": "1000"
    }
  ]
}
```

**Response (Invalid Address - 400):**

```json
{
  "error": {
    "code": "400",
    "message": "Invalid address format"
  }
}
```

#### Get UTxOs by Address (Action)

```http
POST /GetUTxOsByAddress
Content-Type: application/json

{
    "address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0"
}
```

#### Get Assets by Address (Action)

```http
POST /GetAssetsByAddress
Content-Type: application/json

{
    "address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0"
}
```

---

### 4. Pools, Accounts, and Dreps

#### Pools

```http
GET /Pools('pool1...')

POST /GetPoolById
Content-Type: application/json

{
  "poolId": "pool1..."
}
```

#### Accounts

```http
GET /Accounts('stake_test1...')

POST /GetAccountByStakeAddress
Content-Type: application/json

{
  "stakeAddress": "stake_test1..."
}
```

#### Dreps

```http
GET /Dreps('drep1...')

POST /GetDrepById
Content-Type: application/json

{
  "drepId": "drep1..."
}
```

---

### 4. Metadata Query

#### Get Metadata by Transaction (Action)

```http
POST /GetMetadataByTxHash
Content-Type: application/json

{
  "tx_hash": "95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1"
}
```

---

## Query Examples

### Example 1: Query a Specific Transaction

**Request:**

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash \
  -H "Content-Type: application/json" \
  -d '{
    "hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"
  }'
```

**Using PowerShell:**

```powershell
$body = @{
  hash = "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

**Using Python:**

```python
import requests
import json

url = "http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash"
payload = {
    "hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"
}

response = requests.post(url, json=payload)
print(json.dumps(response.json(), indent=2))
```

---

### Example 2: Check Address Balance

**Request:**

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAddressByBech32 \
  -H "Content-Type: application/json" \
  -d '{
    "address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0"
  }'
```

**Using JavaScript/Node.js:**

```javascript
const fetch = require("node-fetch");

const response = await fetch(
  "http://localhost:4004/odata/v4/cardano-odata/GetAddressByBech32",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address:
        "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0",
    }),
  },
);

const data = await response.json();
console.log(data);
```

---

### Example 4: Check Service Metadata

Discover all available endpoints and entity structure:

```bash
curl http://localhost:4004/odata/v4/cardano-odata/\$metadata
```

This returns the complete OData metadata document with all entity definitions,
properties, and actions.

---

## Error Responses

### Status Code Reference

| Code    | Meaning             | Example                                           |
| ------- | ------------------- | ------------------------------------------------- |
| **200** | Success             | Transaction found and returned                    |
| **400** | Bad Request         | Invalid hash format or missing parameter          |
| **404** | Not Found           | Transaction/address/resource doesn't exist        |
| **429** | Too Many Requests   | Rate limit exceeded (retry after X seconds)       |
| **500** | Server Error        | Internal service error                            |
| **503** | Service Unavailable | All provider backends down/timeout (Blockfrost + Koios) |

### Common Error Messages

#### Invalid Hash Format (400)

```json
{
  "error": {
    "code": "400",
    "message": "Invalid transaction hash format"
  }
}
```

**Fix:** Use 64-character hexadecimal string

- ✅ Valid: `0000000000000000000000000000000000000000000000000000000000000000`
- ❌ Invalid: `000000000000000000000000000000000000000000000000000000000000000`
  (63 chars)
- ❌ Invalid: `ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ`
  (contains Z)

#### Invalid Address Format (400)

```json
{
  "error": {
    "code": "400",
    "message": "Invalid address format"
  }
}
```

**Fix:** Use Cardano address matching your configured network:

**For NETWORK=preview or NETWORK=preprod:**

- ✅ Valid: `addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0...`
- ❌ Invalid: `addr1qz0wmc...` (mainnet address on testnet config)

**For NETWORK=mainnet:**

- ✅ Valid: `addr1qz0wmc8twf9l8pf3vk7r3v2u0y0...`
- ❌ Invalid: `addr_test1qz0wmc...` (testnet address on mainnet config)

**Always invalid:**

- ❌ `0x123456...` (Ethereum format)
- ❌ `DdzFF82cd...` (Legacy Byron format - not supported)

#### Missing Required Parameter (400)

```json
{
  "error": {
    "code": "400",
    "message": "Missing hash parameter"
  }
}
```

**Fix:** Include required field in request body:

```json
{
  "hash": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

#### Provider Not Available (503)

```json
{
  "error": {
    "code": "503",
    "message": "Provider service unavailable"
  }
}
```

**Fix:**

- Check internet connection
- Wait for provider to recover
- Try again in 30 seconds
- Check Blockfrost/Koios status pages

#### Resource Not Found (404)

```json
{
  "error": {
    "code": "404",
    "message": "Resource not found"
  }
}
```

**Fix:**

- Verify transaction/address exists on testnet
- Use a different hash or address
- Check testnet explorer: https://preview.cexplorer.io

---

## Authentication

### Public Access

Local development does not require authentication.

### Future: API Keys

When deployed to production, API key authentication will be required:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://cardano-api.example.com/odata/v4/cardano-odata/...
```

---

## Rate Limiting & Performance

### Caching & Data Persistence

ODATANO uses **Lazy On-Demand Indexing** for optimal performance:

**Temporal Entities** (configurable via `INDEX_TTL_MS`):
- Addresses, Accounts, NetworkInformation
- TTL-based refresh (default: 60000ms = 1 minute)
- Example: `INDEX_TTL_MS=300000` for 5-minute cache

**Non-Temporal Entities** (permanent storage):
- Transactions, Blocks, Epochs
- Indexed once, served instantly forever
- No re-fetching needed

**Performance:**
- First request: 1-5 seconds (fetched from blockchain)
- Subsequent requests: Instant (served from database)

📚 **For complete indexing architecture and data flow:** See [Lazy On-Demand Indexing Concept](../concepts%20&%20architecture/INDEXING.md)

### Rate Limits (Provider Level)

Provider limits vary by plan and infrastructure.

**Blockfrost (Primary):** requires API key; generous throughput depending on
plan.

**Koios (Fallback):** community-run; no API key required; lower throughput.

### Performance Tips

1. **Reuse query results** - Cache results on your end too
2. **Query in batches** - If possible, group related queries
3. **Use filtering** - Add OData `$filter` to reduce response size
4. **Avoid repeated queries** - Check results are cached (5 min)

**Example - Using OData Filtering (Future):**

```http
GET /Transactions?$filter=blockHeight gt 1000 and blockHeight lt 2000
```

---

## Known Limitations

### Current Version (1.0.0)

**Read-Only Operations**

- ✅ Query transactions, addresses, metadata, UTxOs, assets
- ✅ Network information, latest block/epoch data
- ❌ Create, update, or delete operations not supported (blockchain is
  immutable)
- ❌ Write operations to blockchain not in scope (use wallet software)

**Data Completeness**

- ✅ Transaction details (hash, block, slot, fee, size, validity intervals)
- ✅ Transaction inputs/outputs with assets
- ✅ Address balance, UTxOs, and native assets
- ✅ Transaction metadata (by tx hash)
- ✅ Network information (supply, stake)
- ✅ Blocks and epochs data
- ✅ Stake pools (pool ID, metadata, status)
- ✅ Accounts (stake address, rewards, withdrawals)
- ✅ DReps (governance representatives)
- ⚠️ Smart contract execution details (limited to redeemer data)
- ⚠️ Historical data (depends on provider retention)

**Performance**

- ✅ Instant cache hits (configurable TTL via `INDEX_TTL_MS`)
- ⚠️ First request slower (depends on provider: Blockfrost ~1-2s, Koios ~2-5s)
- ⚠️ Batch operations follow OData standards but no custom optimizations

**Network Support**

- ✅ Mainnet fully supported
- ✅ Preview testnet fully supported
- ✅ Preprod testnet fully supported
- ⚠️ Network must be configured before deployment (affects address validation)

### Provider Limitations

**Blockfrost:**

- Max 250-500 requests/second (depending on tier)
- Requires API key for production
- Maintains centralized database

**Koios:**

- Max 10 requests/second
- Community-run infrastructure
- No API key required
- May have occasional availability issues

---

## FAQ

### Q: How long are results cached?

**A:** Caching behavior depends on data type:

- **Temporal entities** (Addresses, Accounts): Configurable via `INDEX_TTL_MS` (default: 60000ms = 1 minute)
- **Non-temporal entities** (Transactions, Blocks): Permanent storage, no expiration
- Configure via: `INDEX_TTL_MS=60000` in your .env file

📚 For details, see [Lazy On-Demand Indexing Concept](../concepts%20&%20architecture/INDEXING.md)

### Q: What's the difference between Blockfrost and Koios?

**A:**

- **Blockfrost:** Official, faster (250-500 req/sec), requires API key
- **Koios:** Community-run, free (10 req/sec), no API key needed

The service automatically tries Blockfrost first, then falls back to Koios if it
fails.

### Q: Can I query mainnet?

**A:** Yes! Configure the `NETWORK` environment variable:

```bash
# In your .env file
NETWORK=mainnet
BLOCKFROST_KEY=your_mainnet_api_key
```

Supported networks: `mainnet`, `preview`, `preprod`. Each network requires a
corresponding Blockfrost API key for that network.

### Q: Why is my query slow?

**A:**

1. **First time querying this data?** Wait 1-5 seconds (blockchain fetch)
2. **Already cached?** Should be instant (database lookup)
3. **Temporal data expired?** Will re-fetch (check `INDEX_TTL_MS` setting)
4. **Provider timeout?** Failover to Koios takes up to 16 seconds (8s per backend)
5. **Increase TTL for temporal entities:** `INDEX_TTL_MS=300000` (5 minutes)

**Note:** Transactions are never slow after first fetch (permanent storage)

### Q: What if the provider is down?

**A:** The service automatically failsover:

1. Try Blockfrost (8 sec timeout)
2. If fails, try Koios (8 sec timeout)
3. If both fail, return 503 Service Unavailable

### Q: Can I delete or modify transactions?

**A:** No, this is a **read-only** service. Blockchain transactions cannot be
modified. You can only query existing data.

### Q: What address format should I use?

**A:** Use Cardano **bech32** format matching your configured network:

**Preview/Preprod Testnet:**

- `addr_test1qz0wmc...` ✅ Correct (payment address)
- `stake_test1uz0wmc...` ✅ Correct (stake address)

**Mainnet:**

- `addr1qz0wmc...` ✅ Correct (payment address)
- `stake1uz0wmc...` ✅ Correct (stake address)

**Invalid formats:**

- `DdzFF82cd...` ❌ Wrong (legacy Byron base58 format)
- `0x123456...` ❌ Wrong (Ethereum format)

### Q: How do I get valid test data?

**A:**

1. Use testnet faucet: https://testnet.cardanofaucet.io
2. Send test ADA to your address
3. Make transactions on testnet
4. Query those transactions through ODATANO

### Q: Is the API free to use?

**A:** Yes, public preview is free. Blockfrost has free tier limits (250
req/sec). Production usage may require registration.

### Q: Can I use this from the browser?

**A:** Yes, via CORS-enabled requests. The OData service supports browser-based
queries.

**Example - From Browser:**

```javascript
const response = await fetch(
  "http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash: "0".repeat(64) }),
  },
);
```

### Q: What's the difference between collections and actions?

**Collections (GET):**

```http
GET /Transactions        # Returns collection of all transactions
```

**Actions (POST):**

```http
POST /GetTransactionByHash  # Executes action to find specific transaction
```

### Q: How do I integrate this into my application?

**A:** See the [Developer Guide](DEVELOPER_GUIDE.md) for integration examples
in:

- Node.js/Express
- Python/Flask
- C#/.NET
- JavaScript/React

---

## Support & Resources

- **Documentation:** See [Developer Guide](DEVELOPER_GUIDE.md)
- **Test Documentation:** See [Test README](../../test/README.md) (249 tests, ~99% coverage)
- **Architecture Concepts:** See [docs/concepts & architecture/](../concepts%20&%20architecture/)
- **Issues:** Check [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Blockfrost Docs:** https://docs.blockfrost.io/
- **Koios Docs:** https://koios.rest/
- **Cardano Docs:** https://docs.cardano.org/

---

**Last Updated:** December 2025\
**Version:** 0.1.0 (Milestone 1 Complete)\
**Status:** Production-Ready — OData V4 service with lazy indexing and multi-provider failover
