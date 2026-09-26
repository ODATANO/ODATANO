# ODATANO User Guide

**Version:** v2.0.0-rc.x | **Last Updated:** September 2026

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
{"txHash": "95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1"}
```

**Response Example (Transaction):**

```json
{
  "hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
  "blockHash": "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39",
  "slot": "12345678",
  "size": 450,
  "fee": "200000",
  "deposit": "0"
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
  "totalLovelace": "5000000",
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
GET /Addresses?$select=address,totalLovelace

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

**Fix:** Wait and retry (automatic failover after `PRIMARY_TIMEOUT_MS`, default 30s)

---

## FAQ

### Q: How long are results cached?

**A:** 
- **Temporal entities** (Addresses, Accounts): Configurable via `INDEX_TTL_MS` (default: 3600000 ms = 1 hour)
- **Non-temporal entities** (Transactions, Blocks): Permanent storage

📚 See [Indexing Concept](../concepts%20&%20architecture/INDEXING.md) for details

### Q: What's the difference between Blockfrost and Koios?

**A:**
- **Blockfrost:** Primary provider, faster (250-500 req/sec), requires API key
- **Koios:** Fallback provider, free (10 req/sec), no API key needed

Service tries the first configured backend (`PRIMARY_TIMEOUT_MS`, default 30s), then the next (`FALLBACK_TIMEOUT_MS`, default 60s)

### Q: Can I query mainnet?

**A:** Yes! Set `NETWORK=mainnet` and `BLOCKFROST_API_KEY=your_mainnet_key` in .env file

Supported: `mainnet`, `preview`, `preprod`

### Q: Why is my query slow?

**A:**
1. **First request:** 1-5 seconds (fetches from blockchain)
2. **Cached:** Instant (from database)
3. **Temporal data expired:** Re-fetches (check `INDEX_TTL_MS`)
4. **Provider timeout:** up to 30s primary + 60s fallback (`PRIMARY_TIMEOUT_MS` / `FALLBACK_TIMEOUT_MS`)

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
  "fee": "170000"
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
| `VerifyDataSignature` | Verify a CIP-30 `signData` (COSE_Sign1) message signature -- wallet login, no transaction |
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

### Wallet Login -- Verify a CIP-30 Data Signature

`VerifyDataSignature` verifies a **signed message** (CIP-30 `signData` / COSE_Sign1), **not** a transaction. It is the Cardano equivalent of "Sign-In with Ethereum": prove a user controls a wallet address without spending anything on-chain.

This is the only `CardanoSignService` action that does **not** require authentication (`@requires: 'any'`) -- by definition the caller is logging in and has no token yet. It is a stateless crypto check: no database write, no key access. Nonce issuance, replay protection, and session/JWT minting stay in your application.

**Typical flow:**

1. Your app issues a one-time, time-limited message (e.g. `MyApp login: <nonce>`).
2. The user signs it in their wallet via CIP-30 `signData(address, payload)`, which returns `{ signature, key }`.
3. Your app calls `VerifyDataSignature` with those values; on `valid: true` it mints a session.

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/VerifyDataSignature \
  -H "Content-Type: application/json" \
  -d '{
    "address": "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8",
    "coseSignature": "845869a30127...",
    "coseKey": "a40101032720...",
    "expectedPayload": "MyApp login: 7f3a9c1e"
  }'
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `address` | yes | Bech32 address the wallet claimed to sign with (base or enterprise, key-hash credential) |
| `coseSignature` | yes | Hex COSE_Sign1 CBOR -- the `signature` field from `signData` |
| `coseKey` | yes | Hex COSE_Key CBOR -- the `key` field from `signData` |
| `expectedPayload` | no | When set, the signed payload must equal this exactly (anti-replay). When omitted, the decoded payload is returned for you to check. |

**Response:**
```json
{
  "valid": true,
  "reason": "",
  "signedPayload": "MyApp login: 7f3a9c1e",
  "signerVkh": "2b59938fe8ab0e76054925a575b1c50e406594300cf8f7b09328b863"
}
```

The action verifies three things: (1) the Ed25519 signature over the COSE `Sig_structure`, (2) that the signer's public key hashes (`blake2b-224`) to the address payment credential, and (3) optionally that the payload matches `expectedPayload`. A forged or mismatched signature returns HTTP 200 with `valid: false` and a `reason` -- only malformed inputs (missing/invalid address, missing CBOR) return a 400.

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

## Upgrading from 1.x to 2.0

Three things are required, in this order:

1. **CAP 10 and Node >= 22.5** — `@odatano/core@2` declares `@sap/cds >=10` as a peer dependency;
   a CAP 9 host cannot load it.
2. **Run `cds deploy`.** 2.0 adds four tables (`CardanoSyncState`, `CardanoReorgLog`,
   `CardanoWorkerWallets`, `CardanoWalletJobs`) and a `dedupKey` column with a unique constraint.
   Skip this and the new services answer `no such table`, while `getStatus` / `GetWorkerStatus`
   return 500 — the pre-existing services keep working, so the omission is easy to miss.
3. **Adapt numeric parsing.** CAP 10 serializes `Decimal`, `Int64` and `$count` as JSON **strings**.

The crawler and the wallet worker are **off by default**; an upgraded deployment behaves exactly as
before until you enable them.

---

## Chain Crawler / Pre-Sync (v2.0, opt-in)

By default ODATANO indexes **lazily** (fetches from a backend on cache miss). v2.0 adds an optional **crawler** that pre-syncs `Blocks` and `Transactions` (+ inputs/outputs/assets/metadata) forward from a configured start block, so subsequent queries hit local data instead of a backend per request.

**Enable it** (plugin config or env):

```jsonc
"cds": { "requires": { "odatano-core": {
  "crawler": {
    "enabled": true,
    "startSlot": 12345678,
    "startBlockHash": "abc...",
    "source": "auto",            // ogmios (chain-sync, reorg-aware) | pagination (Blockfrost/Koios) | auto
    "confirmationDepth": 3        // stay N blocks behind the tip
  }
}}}
```

The crawler starts automatically on server boot and resumes from its cursor after a restart. Ogmios is the preferred source (native rollback/reorg handling); Blockfrost/Koios are the fallback. With `source: auto`, a crawl that had to start on pagination because Ogmios was not reachable yet (typically a node still replaying after a shared restart) retries the chain-sync backend every 30 seconds and hands over as soon as it is usable. Control + status via **CardanoIndexerService** at `/odata/v4/cardano-indexer/`:

```http
GET  /odata/v4/cardano-indexer/SyncState        # cursor: lastSlot, lastHeight, tip, syncStatus, errors
GET  /odata/v4/cardano-indexer/ReorgLog         # audit of handled rollbacks
GET  /odata/v4/cardano-indexer/getStatus()      # live run state summary (function -> GET); `source` = chain-sync | pagination | null
POST /odata/v4/cardano-indexer/pauseCrawler
POST /odata/v4/cardano-indexer/resumeCrawler
```

### What the crawl fills beyond blocks and transactions

A pre-synced range is meant to be a dataset, not a by-product of whoever happened to call the API,
so the crawler also fills the tables that analytics need:

| Table | What lands there | Default |
|---|---|---|
| `AssetHistory` | every mint and burn in the range, one row per (unit, transaction) | on |
| `Assets` | one row per native-asset unit seen: policyId, assetNameHex, decoded name, CIP-14 fingerprint | on (`bare`) |
| `PoolEpochSnapshots`, `DrepEpochSnapshots` | every pool and DRep once per epoch — only while the crawl is at the chain tip | off |
| `TransactionCertificates`, `TransactionWithdrawals` | every certificate (stake, pool, DRep) and reward withdrawal in the range | off |

```jsonc
"crawler": {
  "assetHistory": true,        // mint/burn rows — derived from the block, no provider call
  "assetCatalogue": "bare",    // "off" | "bare" (free) | "enrich" (adds registry name/ticker/decimals)
  "assetEnrichRate": 2,        // units per second, "enrich" only
  "epochSnapshots": false,     // pool/DRep snapshots — requires a Koios backend
  "certificates": false        // certificates + withdrawals — Ogmios chain-sync or Koios, not Blockfrost
}
```

The two defaults cost nothing: both are derived from data the crawler already holds. `"enrich"` and
`epochSnapshots` talk to a provider and are therefore opt-in; `epochSnapshots` needs Koios, because
it is the only backend that can enumerate the full pool and DRep set in batches.

`epochSnapshots` only records an epoch while the crawl has caught up to the chain tip. Koios
reports the pool and DRep set as it is *now* — there is no historical variant — so an epoch the
crawler merely passes through while backfilling is skipped rather than filled with today's numbers
under yesterday's epoch number. If you want snapshots for a past range, there is nothing the crawl
can reconstruct; run the crawler live from the point you care about.

`certificates` (`CRAWLER_CERTIFICATES`) writes one `TransactionCertificates` row per certificate and
kind — `stake_registration`, `stake_deregistration`, `pool_delegation`, `vote_delegation`,
`pool_registration`, `pool_retirement`, `drep_registration`, `drep_update`, `drep_retirement`, … —
with `stakeAddress`, `poolId`, `drepId`, `deposit` and the retirement `epoch` where the kind carries
them, plus one `TransactionWithdrawals` row per reward account withdrawn from. A Conway stake+vote
delegation becomes a `pool_delegation` and a `vote_delegation` row with the same `certIndex`, so the
Ogmios and Koios sources produce identical rows. Both are block content: Ogmios chain-sync delivers
them decoded and Koios returns them in the same `/tx_info` call the crawl already makes, so the knob
costs no extra request. Blockfrost has no per-block variant; on a Blockfrost-only crawl the tables
stay empty and the crawler logs a warning once. The current pool or DRep of a stake key is the newest
`pool_delegation` / `vote_delegation` row for it:

```
GET /odata/v4/cardano-odata/TransactionCertificates?$filter=stakeAddress eq 'stake_test1…' and kind eq 'pool_delegation'&$orderby=tx/slot desc&$top=1
```

Blocks crawled before `certificates` was switched on can be filled in afterwards. Turn the knob on
first, so new blocks carry the rows from then on, then run the backfill once for the gap:

```
POST /odata/v4/cardano-indexer/backfillCertificates   { "fromSlot": "…", "toSlot": "…" }
GET  /odata/v4/cardano-indexer/getStatus()            # → certificateBackfill.status: running | done | failed
```

Both slots are optional: `fromSlot` defaults to the crawl start, `toSlot` to the crawler cursor, and a
`toSlot` past the cursor is refused. The backfill opens a second Ogmios chain-sync stream that starts
at the newest crawled block below `fromSlot` and ends at the first block past `toSlot`. It writes
`TransactionCertificates` and `TransactionWithdrawals` only, keyed like the crawl, so a repeat is
idempotent; a block the index does not hold (rolled back since) is skipped. The crawler may keep
running. Rows are committed per 200 blocks, and `getStatus().certificateBackfill` reports range,
`atSlot`, counts and timestamps. One backfill runs per process at a time; the status is kept in
memory and reads `none` after a restart. Requires Ogmios (Admin).

Independent of any knob, every `TransactionInputs` row written since this version carries the
outpoint it consumed (`spentTxHash`, `spentOutputIndex`), so a UTxO can be traced from the output
that created it to the input that spent it. Rows indexed earlier keep `null` there until the range is
re-crawled.

### Crawler-fed UTxO set: balances without a provider

`utxoSet` (`CRAWLER_UTXO_SET`, off) makes the crawl maintain a UTxO set of its own, in separate,
non-temporal tables so the provider-fed `Addresses` / `AddressUTxOs` keep their one-hour TTL
semantics:

| Table | What lands there |
|---|---|
| `LedgerUTxOs` (+ `LedgerUTxOAssets`) | every output since the anchor; unspent while `spentTxHash eq null`, `spentTxHash` / `spentSlot` name the consumer |
| `LedgerAddresses` (+ `LedgerAddressAssets`) | running `totalLovelace`, `utxoCount` and asset balances per address, as of the crawl tip |
| `LedgerAccounts` | `controlledAmount`, `addressCount`, `utxoCount` per stake key (sum over its base addresses) |

Delegation stays a query over `TransactionCertificates` (turn `certificates` on as well); rewards are
ledger state and remain provider-fed.

The set needs an **anchor**: the node can only hand out its UTxO set for a recent point, never for
the crawl's start slot, so the mode starts from a one-off import and applies only blocks after the
anchor. Until that import has run the knob is inert and the crawler logs an error at start.

```
# 1. crawl to the tip, then pause
POST /odata/v4/cardano-indexer/pauseCrawler

# 2a. preview / preprod — acquire the set at the crawler cursor from the box's own node
POST /odata/v4/cardano-indexer/importUtxoSet   { "source": "ogmios" }

# 2b. mainnet — dump with cardano-cli (the whole-set Ogmios query is memory-heavy there)
cardano-cli query tip --mainnet                        # note slot + hash
cardano-cli query utxo --mainnet --whole-utxo --out-file utxo.json
cardano-cli query tip --mainnet                        # same hash? then the anchor is valid
jq -c 'to_entries[]' utxo.json > utxo.ndjson           # streamable, one entry per line
POST /odata/v4/cardano-indexer/importUtxoSet
     { "source": "file", "filePath": "/data/utxo.ndjson", "anchorSlot": "…", "anchorHash": "…" }

# 3. poll until status is "active", then resume
GET  /odata/v4/cardano-indexer/getStatus()             # → utxoSet.status
POST /odata/v4/cardano-indexer/resumeCrawler
```

The import refuses to start while the crawler holds its lease or when the cursor is already past
the anchor, and it holds the cursor lease itself for its whole duration, re-taking it inside every
write transaction, so `resumeCrawler` (on any instance) and a second import wait until it has
finished and a takeover stops it before the next batch commits. Before the first block after the
anchor is applied, the crawler checks that the anchor is exactly the block it followed last (the
cursor at that moment, which also covers an anchor at the configured start block); a snapshot taken
on a fork that was dropped again invalidates the set instead of seeding it. A reorg that reaches
behind the anchor invalidates the set too (`utxoSet.status = invalid`); re-run the import. A reorg
after the anchor is undone in place: rows the rolled-back blocks created are dropped, rows they
spent are reopened, every address either side touched is recounted from its open rows, and the
progress marker follows the cursor back. Switching `utxoSet` off while the crawler keeps running
leaves the set behind; on the next start with the knob on, a cursor ahead of the last applied slot
marks the set `invalid` rather than resuming from a gap. Rows that came with the snapshot carry
`createdSlot = null`.

**SQLite precision.** The development database stores every `Decimal` of this project as a
double (`@cap-js/sqlite`), so any amount above 2^53 (about 9.0 billion ADA — only supply-level aggregates get there — or a
token quantity above 9.007e15 units, i.e. a fraction of one 18-decimal token) is rounded there, by far less than one lovelace or one token, in the ledger tables as in `Epochs` and `NetworkInformation`. The
dump is parsed losslessly and the values are exact on PostgreSQL and HANA, where a deployment
runs. An exact SQLite would need `Lovelace` to be `Integer64` instead of `Decimal(20,0)`, a
schema-wide change that is not part of this feature.

```
GET /odata/v4/cardano-odata/LedgerAddresses('addr_test1…')?$expand=assets
GET /odata/v4/cardano-odata/LedgerUTxOs?$filter=address eq 'addr_test1…' and spentTxHash eq null&$expand=assets
GET /odata/v4/cardano-odata/LedgerAccounts('stake_test1…')?$expand=addresses
```

Freshness is the crawl's: `confirmationDepth` blocks behind the tip. A caller who needs the mempool
view keeps using `GetUTxOsByAddress`. All three sources report phase-2 validity (Ogmios `spends`,
Blockfrost and Koios `valid_contract` with their collateral inputs and output), so a failed-script
transaction consumes its collateral and produces only the collateral return on every path.

A catalogue row written by the crawl carries what the unit itself encodes, not supply or registry
metadata — those arrive the first time someone reads that asset through the API (or continuously
with `"enrich"`). Setting `assetCatalogue` to `"off"` and `assetHistory` to `false` restores the
pre-2.0.0-rc.12 behaviour exactly.

### Crawled data before the backend

Some values the lazy path used to take from a backend come from the crawled tables instead, but
only while the crawled data is complete for them. For the values that depend on the current chain
state this means a live crawler at the tip: `SyncState.syncStatus` is `synced` and its lease is held.
Otherwise the backend's value stays.

| Value | From | Condition |
|---|---|---|
| `Pools.blocksEpoch` | crawled `Blocks` of the current epoch with `slotLeader` = the pool | crawler at the tip, crawl started before the epoch |
| `Pools.blocksMinted` | all crawled `Blocks` of the pool | crawler at the tip, crawl started at or before the first Shelley slot |
| `Accounts.controlledAmount` | `LedgerAccounts.controlledAmount` + the reward balance | crawler at the tip, UTxO set `active` |
| `NetworkInformation.circulatingSupply` | total of `LedgerAddresses.totalLovelace` | crawler at the tip, UTxO set `active` |
| `Epochs.blockCount`, `txCount`, `fees`, `firstBlockTime`, `lastBlockTime` (crawled epochs) | crawled `Blocks` of the epoch | crawl started before the epoch |

The epoch totals are what makes an Ogmios-only crawl describe its epochs: Ogmios serves no past
epoch, so the crawler writes the row from its own blocks, with start and end time derived from the
slots and `output` / `activeStake` left empty. With a provider, the provider's row is kept and only
the totals are replaced.

`Blocks.slotLeader` is the bech32 id of the pool that produced the block on every backend. Crawls
before this version stored the Ogmios issuer key (64 hex characters) or the Koios VRF key
(`vrf_vk1…`) instead, which the pool counts above do not match. `scripts/migrate-slot-leader.mjs`
(repository checkout) turns the old values into one SQL update; it derives the pool id from an
issuer key and matches a VRF key against the registered pools of an Ogmios `stakePools` response:

```bash
psql -Atc "SELECT DISTINCT slotLeader FROM odatano_cardano_Blocks WHERE slotLeader NOT LIKE 'pool1%'" \
  | node scripts/migrate-slot-leader.mjs --stake-pools stake-pools.json > slot-leader.sql
psql -f slot-leader.sql
```

A VRF key of a pool that is no longer registered is listed as unmapped and left as it is;
`--extra-map` takes such values as `<old value> <pool id>` lines.

**Notes:** Ogmios needs a synced cardano-node (a [Mithril](https://docs.cardano.org/developer-resources/scalability-solutions/mithril) bootstrap speeds that up). Full-history mainnet pre-sync is large — start from a recent block. Numeric fields (slot, lovelace, amounts) serialize as **strings** (CAP 10).

---

## Wallet Worker (v2.0, opt-in)

The wallet worker executes transactions **asynchronously** on behalf of server-side wallets: you queue a job, the worker builds, signs (software key or HSM), submits, and tracks the transaction until it reaches the configured confirmation depth. Per wallet only ONE job is in flight at a time, so UTxO contention between your own transactions is impossible by construction.

**Enable it** (plugin config or env `WALLET_WORKER_ENABLED` + `WALLET_WORKER_WALLETS`):

```jsonc
"cds": { "requires": { "odatano-core": {
  "walletWorker": {
    "enabled": true,
    "wallets": [
      { "walletId": "treasury", "signerType": "software", "keyEnv": "TREASURY_SIGNING_KEY" },
      { "walletId": "minter",   "signerType": "hsm" }
    ],
    "confirmationDepth": 3,          // job is 'confirmed' at this depth
    "confirmationTimeoutMs": 600000, // unseen past this → failed:TX_DROPPED (safe to retry)
    "defaultMaxAttempts": 3          // transient build/submit failures retry with backoff
  }
}}}
```

Software wallets read their signing key from the env var named in `keyEnv` — the key never appears in config or DB. The worker wallet is **always** the sender/change target; callers cannot spend from foreign addresses through a worker wallet.

**Queue and track jobs** via **CardanoWorkerService** at `/odata/v4/cardano-worker/`:

```http
POST /odata/v4/cardano-worker/SubmitWalletJob
Content-Type: application/json

{
  "walletId": "treasury",
  "kind": "simpleAda",                       // simpleAda | metadata | multiAsset | mint | plutusSpend | submitSigned
  "requestJson": "{\"recipientAddress\":\"addr_test1...\",\"lovelaceAmount\":\"2000000\"}",
  "idempotencyKey": "invoice-4711"           // optional: same key = same job (safe retries)
}
```

`requestJson` carries the **same payload shape as the corresponding Build\* action** of the transaction service (e.g. `assetsJson`, `mintActionsJson`, `metadataJson`, the Plutus-spend fields); `senderAddress`/`changeAddress` are overridden with the wallet's address. The response returns a `jobId` immediately.

```http
GET  /odata/v4/cardano-worker/GetJobStatus(jobId=<uuid>)   # function -> GET, param in the URL
POST /odata/v4/cardano-worker/CancelJob        # pending jobs only
GET  /odata/v4/cardano-worker/GetWorkerStatus()            # running, wallets, executing, awaitingConfirmation, pendingJobs
POST /odata/v4/cardano-worker/PauseWorker      # Admin scope
POST /odata/v4/cardano-worker/ResumeWorker     # Admin scope
```

**Job lifecycle:** `pending → building → submitting → submitted → confirmed`, with `failed` (terminal, `errorCode` set) and `cancelled` branches. Transient failures during build/sign (provider outage, rate limit, HSM hiccup) retry with exponential backoff up to `maxAttempts`; deterministic rejections (validation, insufficient funds) fail immediately. `failed` and `cancelled` jobs release their `idempotencyKey` for a retry. After a chain rollback the worker re-submits the **same signed CBOR** — never a rebuild — so a double payment cannot occur.

**`idempotencyKey`:** a key is *owned* by one job at a time, enforced by a unique constraint in the database rather than by a lookup — so two retries that arrive at the same moment, on two app instances, still produce exactly one job (the loser of the race gets the winner's `jobId` back with `deduplicated: true`). `failed` and `cancelled` jobs release the key so the next retry really re-executes; `confirmed` jobs keep it, so a late duplicate resolves to the completed job instead of paying again.

**`submitting` (double-payment guard):** the signed transaction and its hash are written to the job row *before* the transaction is handed to a backend. A crash or an ambiguous submit therefore never leaves a job that merely looks un-submitted: the row stays `submitting`, which keeps holding the `idempotencyKey` (your retry gets the same job back, not a new payment) and blocks the wallet queue. The worker resolves it by re-submitting those exact bytes and, if that is rejected, by checking whether the transaction is already on-chain. Such a job only fails once the chain proves the transaction is absent and unusable (`SUBMIT_REJECTED`, or `TX_DROPPED` past the confirmation timeout). A job sitting in `submitting` while a backend is unreachable is intentional — it is waiting for an answer that is safe to act on.

**Operations:** job state lives in the DB (`CardanoWalletJobs`); multiple app instances coordinate via per-wallet leases — held by a heartbeat for as long as a job runs and re-checked immediately before the transaction is sent, so exactly one instance ever spends a given wallet, however long a build takes. Rolling deployments are safe. Confirmation tracking uses the crawler's block feed when the crawler is enabled, and falls back to polling otherwise. `PauseWorker`/`ResumeWorker` and the crawler actions require the **CardanoAdmin** role (`$XSAPPNAME.Admin` scope).

**Authorization:** `SubmitWalletJob` requires an authenticated user, and submitting a job for a wallet with `signerType: "hsm"` additionally requires the role configured in `HSM_REQUIRES_ROLE` / `hsm.requiresRole` — the same gate that protects the synchronous `SignWithHsm` actions. Callers without that role get **403**, so the async job path cannot be used to spend an HSM wallet around the sign service's role check. Software wallets remain gated on authentication alone; restrict the service further at the app-router/XSUAA level if the deployment needs that.

---

## Events — subscribe instead of polling (v2.0)

Both v2.0 subsystems publish CAP events. Because ODATANO ships as a **plugin**, a consumer
runs in the same process, so subscribing needs **no message broker and no
`cds.requires.messaging`** — connect to the service and listen:

```js
const indexer = await cds.connect.to('CardanoIndexerService');
indexer.on('blockIndexed', ({ data }) => {
  // data: { hash, slot, height, txHashes[], tipSlot, tipHeight }
});
indexer.on('reorg', ({ data }) => {
  // data: { forkSlot, forkHeight, blocksRolledBack } — everything above forkSlot is gone
});

const worker = await cds.connect.to('CardanoWorkerService');
worker.on('jobConfirmed', ({ data }) => {
  // data: { jobId, walletId, kind, txHash }
});
worker.on('jobFailed', ({ data }) => {
  // data: { jobId, walletId, kind, txHash, errorCode, errorMessage }
});
```

`jobConfirmed` / `jobFailed` fire once per job, on the terminal outcome only — they replace a
`GetJobStatus` poll loop. `blockIndexed` fires per crawled block, so treat it as a stream, not a
notification.

Three guarantees worth relying on:

- **Emitted after commit.** When an event arrives, the data it names is already readable — the
  job row shows `confirmed`, the block is queryable.
- **Failures are yours alone.** A subscriber that throws or hangs is logged and ignored; it cannot
  stall block ingestion or a wallet job.
- **Fire-and-forget, in-process.** There is no retry and no persistence. If you need at-least-once
  delivery across processes, configure a CAP messaging service — the same emits are then routed
  through it (with the outbox) without a change on our side.

Events do not appear in `$metadata`: OData V4 has no event concept, so this is additive and
invisible to existing HTTP clients.

---

## Support & Resources

- **Developer Guide:** [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)
- **Transaction Workflow:** [TRANSACTION_WORKFLOW.md](TRANSACTION_WORKFLOW.md) - Build → Sign → Submit
- **Backend Configuration:** [BACKEND_CONFIGURATION.md](BACKEND_CONFIGURATION.md) - Multi-backend setup
- **Test Docs:** [test/README.md](../../test/README.md) - 69 test files (52 unit / 1479 tests + 17 integration, vitest)
- **Architecture:** [docs/concepts & architecture/](../concepts%20&%20architecture/)
- **Issues:** [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Blockfrost:** https://docs.blockfrost.io/
- **Koios:** https://koios.rest/
- **Cardano:** https://docs.cardano.org/

---

**Version:** v2.0.0-rc.x\
**Status:** Production-Ready — OData V4 read service + transaction building + external signing with multi-provider failover
