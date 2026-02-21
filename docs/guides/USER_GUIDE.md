# ODATANO User Guide

**Project:** ODATANO - OData V4 Service for Cardano Blockchain\
**Version:** 0.3.17\
**Last Updated:** February 2026

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [API Endpoints](#api-endpoints)
3. [OData Query Examples](#odata-query-examples)
4. [Error Responses](#error-responses)
5. [FAQ](#faq)

---

## Getting Started

### What is ODATANO?

ODATANO is an **OData V4 service** that provides access to Cardano blockchain data and transaction building through a standard REST API.

**Key Features:**

- ✅ Query transactions, blocks, epochs, pools, accounts, DReps
- ✅ Fetch address balances, UTxOs, and native assets
- ✅ Access transaction metadata
- ✅ **Build unsigned transactions** (ADA transfers, token minting, multi-asset) - M2
- ✅ **Submit signed transactions** to Cardano network - M2
- ✅ **External signing workflow** (CIP-30 wallets, Cardano CLI, hardware wallets) - M3
- ✅ **Signature verification** with cryptographic validation - M3
- ✅ **Complete audit trail** for signing requests and verifications - M3
- ✅ Automatic failover (Ogmios → Blockfrost → Koios)
- ✅ Intelligent caching (configurable TTL)
- ✅ Full OData V4 support ($filter, $select, $expand, $top, $skip, $count, $orderby)
- ✅ Multi-network support (mainnet, preview, preprod)

### Supported Networks

- **Mainnet:** Production (addresses: `addr1...`, `stake1...`)
- **Preview:** Testnet (addresses: `addr_test1...`, `stake_test1...`)
- **Preprod:** Pre-production (addresses: `addr1...`)

Configure via `NETWORK` environment variable (default: `preview`)

### Base URL

```
http://localhost:4004/odata/v4/cardano-odata
```

### Service Metadata

View all available entities and actions:

```
http://localhost:4004/odata/v4/cardano-odata/$metadata
```

---

## API Endpoints

### Network Information

```http
GET /NetworkInformation
POST /GetNetworkInformation
```

### Blocks & Epochs

```http
GET /Blocks?$orderby=height desc&$top=1
GET /Epochs?$orderby=epoch desc&$top=1

POST /GetBlockByHash
{"hash": "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39"}

POST /GetEpochByNumber
{"epochNumber": 123}
```

### Transactions

```http
GET /Transactions
GET /Transactions('2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83')

POST /GetTransactionByHash
{"hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"}

POST /GetMetadataByTxHash
{"tx_hash": "95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1"}
```

**Response Example (Transaction):**

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

### Addresses & Assets

```http
GET /Addresses
GET /Addresses('addr_test1...')

POST /GetAddressByBech32
{"address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0"}

POST /GetUTxOsByAddress
{"address": "addr_test1..."}

POST /GetAssetsByAddress
{"address": "addr_test1..."}
```

**Response Example (Address):**

```json
{
  "address": "addr_test1qz0wmc...",
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

### Pools, Accounts & DReps

```http
GET /Pools('pool1...')
POST /GetPoolById
{"poolId": "pool1..."}

GET /Accounts('stake_test1...')
POST /GetAccountByStakeAddress
{"stakeAddress": "stake_test1..."}

GET /Dreps('drep1...')
POST /GetDrepById
{"drepId": "drep1..."}
```

---

## OData Query Examples

### Example 1: Query Transaction by Hash

**cURL:**

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash \
  -H "Content-Type: application/json" \
  -d '{"hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"}'
```

**PowerShell:**

```powershell
$body = @{hash = "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"} | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash" `
  -Method POST -ContentType "application/json" -Body $body
```

**JavaScript:**

```javascript
const response = await fetch(
  "http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hash: "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
    }),
  }
);
const data = await response.json();
console.log(data);
```

### Example 2: Check Address Balance

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAddressByBech32 \
  -H "Content-Type: application/json" \
  -d '{"address": "addr_test1qz0wmc8twf9l8pf3vk7r3v2u0y0l0kz0m0n0p0q0r0s0t0u0v0w0x0y0z0"}'
```

### Example 3: Use OData Query Options

```http
# Get latest block
GET /Blocks?$orderby=height desc&$top=1

# Get transactions with filtering
GET /Transactions?$filter=slot gt 12345678&$top=10

# Select specific fields
GET /Addresses?$select=address,balance

# Expand related entities
GET /Transactions?$expand=inputs,outputs
```

---

## Error Responses

### Status Code Reference

| Code | Meaning | Example |
|------|---------|---------|
| **200** | Success | Transaction found |
| **400** | Bad Request | Invalid hash format, missing parameter |
| **404** | Not Found | Transaction/address doesn't exist |
| **429** | Rate Limit | Too many requests |
| **500** | Server Error | Internal error |
| **503** | Service Unavailable | All providers down/timeout |

### Common Errors

**Invalid Hash Format (400):**

```json
{"error": {"code": "400", "message": "Invalid transaction hash format"}}
```

**Fix:** Use 64-character hexadecimal string
- ✅ Valid: `2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83`
- ❌ Invalid: `invalid` (not hex), `123...` (wrong length)

**Invalid Address Format (400):**

```json
{"error": {"code": "400", "message": "Invalid address format"}}
```

**Fix:** Use correct Cardano bech32 address for your network
- ✅ Preview/Preprod: `addr_test1...`, `stake_test1...`
- ✅ Mainnet: `addr1...`, `stake1...`
- ❌ Invalid: `0x123...` (Ethereum), `DdzFF82cd...` (Byron)

**Missing Parameter (400):**

```json
{"error": {"code": "400", "message": "Missing hash parameter"}}
```

**Fix:** Include required field in request body

**Resource Not Found (404):**

```json
{"error": {"code": "404", "message": "Resource not found"}}
```

**Fix:** Verify transaction/address exists on the configured network (check testnet explorer: https://preview.cexplorer.io)

**Provider Unavailable (503):**

```json
{"error": {"code": "503", "message": "Provider service unavailable"}}
```

**Fix:** Wait and retry (automatic failover to Koios after 8s timeout)

---

## FAQ

### Q: How long are results cached?

**A:** 
- **Temporal entities** (Addresses, Accounts): Configurable via `INDEX_TTL_MS` (default: 60s)
- **Non-temporal entities** (Transactions, Blocks): Permanent storage

📚 See [Indexing Concept](../concepts%20&%20architecture/INDEXING.md) for details

### Q: What's the difference between Blockfrost and Koios?

**A:**
- **Blockfrost:** Primary provider, faster (250-500 req/sec), requires API key
- **Koios:** Fallback provider, free (10 req/sec), no API key needed

Service tries Blockfrost first (8s timeout), then Koios (8s timeout)

### Q: Can I query mainnet?

**A:** Yes! Set `NETWORK=mainnet` and `BLOCKFROST_KEY=your_mainnet_key` in .env file

Supported: `mainnet`, `preview`, `preprod`

### Q: Why is my query slow?

**A:**
1. **First request:** 1-5 seconds (fetches from blockchain)
2. **Cached:** Instant (from database)
3. **Temporal data expired:** Re-fetches (check `INDEX_TTL_MS`)
4. **Provider timeout:** Up to 16s (8s per backend)

**Note:** Transactions are cached permanently after first fetch

### Q: Can I delete or modify transactions?

**A:** No, this is **read-only**. Blockchain data is immutable.

### Q: What address format should I use?

**A:** Cardano **bech32** format matching your network:
- **Preview/Preprod:** `addr_test1...`, `stake_test1...`
- **Mainnet:** `addr1...`, `stake1...`
- **Invalid:** `DdzFF82cd...` (Byron), `0x123...` (Ethereum)

### Q: How do I get valid test data?

**A:**
1. Testnet faucet: https://testnet.cardanofaucet.io
2. Send test ADA to your address
3. Make transactions on testnet
4. Query through ODATANO

### Q: Is the API free to use?

**A:** Yes, public preview is free. Blockfrost has free tier limits (250 req/sec).

### Q: Can I use this from the browser?

**A:** Yes, via CORS-enabled requests.

```javascript
const response = await fetch(
  "http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash: "2b82...7efe83" }),
  }
);
```

### Q: What's the difference between collections (GET) and actions (POST)?

**A:**
- **Collections (GET):** Query entity sets (e.g., `GET /Transactions`)
- **Actions (POST):** Execute specific operations (e.g., `POST /GetTransactionByHash`)

### Q: What if the provider is down?

**A:** Automatic failover:
1. Try Blockfrost (8s timeout)
2. If fails, try Koios (8s timeout)
3. If both fail, return 503

---

---

## Transaction Building (M2)

### Build & Submit Transactions

ODATANO M2 adds transaction building and submission capabilities.

**Transaction Service Base URL:**
```
http://localhost:4004/odata/v4/cardano-transaction
```

### Build Simple ADA Transfer

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'
```

**Response:**
```json
{
  "id": "uuid-here",
  "unsignedTxCbor": "84a50081825820...",
  "txBodyHash": "abc123...",
  "fee": 170000
}
```

### Submit Signed Transaction

After signing externally (cardano-cli, browser wallet):

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/SubmitTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "buildId": "uuid-from-build",
    "signedTxCbor": "84a5008182..."
  }'
```

### Available Transaction Actions

| Action | Description |
|--------|-------------|
| `BuildSimpleAdaTransaction` | Build ADA-only transfer |
| `BuildTransactionWithMetadata` | Build ADA transfer with metadata |
| `BuildMultiAssetTransaction` | Build multi-asset transfer |
| `BuildMintTransaction` | Build token minting transaction |
| `BuildPlutusSpendTransaction` | Spend UTxO locked at a Plutus script address |
| `SetCollateral` | Ensure a dedicated ADA-only collateral UTxO exists |
| `SubmitTransaction` | Submit previously built transaction |
| `SubmitSignedTransaction` | Submit externally built transaction |

See [Transaction Workflow Guide](TRANSACTION_WORKFLOW.md) for complete documentation.

---

## External Signing (M3)

ODATANO M3 adds a complete external signing workflow with private key isolation via the **CardanoSignService**.

**Sign Service Base URL:**
```
http://localhost:4004/odata/v4/cardano-sign
```

### External Signing Workflow

```
1. Build Transaction    → Returns unsigned CBOR (CardanoTransactionService)
2. Create Signing Request → Returns signing instructions & TTL (CardanoSignService)
3. Sign Externally      → Use CIP-30 wallet or Cardano CLI
4. Verify & Submit      → Cryptographically verify and submit (CardanoSignService)
```

### Create Signing Request

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/CreateSigningRequest \
  -H "Content-Type: application/json" \
  -d '{
    "buildId": "uuid-from-build-response",
    "message": "Please sign this transaction"
  }'
```

**Response:**
```json
{
  "id": "signing-request-uuid",
  "txBodyHash": "abc123...",
  "unsignedTxCbor": "84a50081825820...",
  "status": "pending",
  "expiresAt": "2026-02-05T12:30:00Z",
  "cardanoCliCommand": "cardano-cli transaction sign --tx-body-file tx.raw..."
}
```

### Verify and Submit

After signing externally:

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SubmitVerifiedTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "signingRequestId": "signing-request-uuid",
    "signedTxCbor": "84a5008182...",
    "signerType": "browser-wallet",
    "signerInfo": "Nami"
  }'
```

### Available External Signing Actions (CardanoSignService)

| Action | Description |
|--------|-------------|
| `CreateSigningRequest` | Create signing request with TTL (30 min default) |
| `GetSigningRequest` | Get signing request status (auto-marks expired) |
| `VerifySignature` | Cryptographically verify signed transaction |
| `SubmitVerifiedTransaction` | Verify and submit in one step |
| `GetSigningRequestsByAddress` | Get signing requests for an address |
| `GetTransactionBuildsByAddress` | Get transaction builds for an address |
| `SignWithHsm` | Sign transaction with HSM (server-side, returns signing request) |
| `SignAndSubmitWithHsm` | Sign with HSM and submit to blockchain in one step |
| `GetHsmStatus` | Check HSM connection status and key information |

### Signing Methods Supported

| Method | Description |
|--------|-------------|
| **CIP-30 Browser Wallets** | Nami, Eternl, Yoroi, Flint, etc. |
| **Cardano CLI** | Command-line signing with payment.skey |
| **Hardware Wallets** | Ledger, Trezor via browser extensions |
| **HSM (PKCS#11)** | YubiHSM, AWS CloudHSM, Thales Luna -- automated server-side signing |

### HSM Signing (Server-Side)

ODATANO supports automated server-side signing via PKCS#11-compatible Hardware Security Modules. Unlike external signing, the private key never leaves the HSM chip -- the server sends a hash, and the HSM returns a signature.

**Check HSM Status:**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/GetHsmStatus \
  -H "Content-Type: application/json" -d '{}'
```

**Response:**
```json
{
  "connected": true,
  "keyId": "0x0001",
  "keyLabel": "cardano-signing-key",
  "publicKeyHash": "a1b2c3...",
  "cardanoAddress": "addr_test1..."
}
```

**Sign Only (creates signing request + verification audit trail):**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SignWithHsm \
  -H "Content-Type: application/json" \
  -d '{"buildId": "uuid-from-build-response"}'
```

**Sign and Submit (one-step automated flow):**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SignAndSubmitWithHsm \
  -H "Content-Type: application/json" \
  -d '{"buildId": "uuid-from-build-response"}'
```

**Response:**
```json
{
  "id": "submission-uuid",
  "txHash": "71f3d8c1...",
  "status": "submitted"
}
```

HSM signing requires configuration. See [Security Guide](SECURITY_GUIDE.md#hsm-pkcs11-integration) for setup instructions.

### Signing Status States

| Status | Description |
|--------|-------------|
| `pending` | Request created, awaiting signing |
| `signed` | Transaction has been signed |
| `verified` | Signature verified, ready for submission |
| `submitted` | Transaction submitted to network |
| `expired` | TTL exceeded (30 minutes default) |
| `failed` | Signing or verification failed |

See [Transaction Workflow Guide](TRANSACTION_WORKFLOW.md) for complete documentation.

---

## Support & Resources

- **Developer Guide:** [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)
- **Transaction Workflow:** [TRANSACTION_WORKFLOW.md](TRANSACTION_WORKFLOW.md) - Build → Sign → Submit
- **Backend Configuration:** [BACKEND_CONFIGURATION.md](BACKEND_CONFIGURATION.md) - Multi-backend setup
- **Test Docs:** [test/README.md](../../test/README.md) - 25 test files, 96%+ coverage
- **Architecture:** [docs/concepts & architecture/](../concepts%20&%20architecture/)
- **Issues:** [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Blockfrost:** https://docs.blockfrost.io/
- **Koios:** https://koios.rest/
- **Cardano:** https://docs.cardano.org/

---

**Version:** 0.3.9\
**Status:** Production-Ready — OData V4 read service + transaction building + external signing with multi-provider failover
