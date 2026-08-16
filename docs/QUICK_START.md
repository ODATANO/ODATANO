# ODATANO Quick Start Guide

**Version:** v2.0.0-rc.3 | **Last Updated:** August 2026

This guide gets you running the OData V4 service in minutes — either as a **plugin in your existing CAP project** or as a **standalone application**.

---

## Option A: Use as CAP Plugin

The fastest way to add Cardano blockchain access to any SAP CAP project.

### 1) Install

```bash
npm install @odatano/core @cap-js/sqlite
```

### 2) Configure

Add the `odatano-core` section to your project's `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "odatano-core": {
        "network": "preview",
        "backends": ["blockfrost"],
        "blockfrostApiKey": "preview_YOUR_BLOCKFROST_API_KEY"
      }
    }
  }
}
```

Get a free Blockfrost API key at [blockfrost.io](https://blockfrost.io).

All config options:

| Key | Default | Description |
|-----|---------|-------------|
| `network` | `preview` | `mainnet`, `preview`, or `preprod` |
| `backends` | `["koios"]` | `blockfrost`, `koios`, `ogmios` (array) |
| `blockfrostApiKey` | | Required if using blockfrost backend |
| `koiosApiKey` | | Optional for Koios |
| `ogmiosUrl` | | Required if using ogmios (e.g. `ws://localhost:1337`) |
| `txBuilders` | `["buildooor"]` | Buildooor only — not configurable (legacy values ignored) |
| `primaryTimeoutMs` | `30000` | Timeout for primary backend |
| `fallbackTimeoutMs` | `60000` | Timeout for fallback backends |
| `indexTtlMs` | `3600000` | Cache TTL (1 hour) |

### 3) Run

```bash
cds watch
```

All five services auto-register:
- **CardanoODataService** at `/odata/v4/cardano-odata/` — read blockchain data
- **CardanoTransactionService** at `/odata/v4/cardano-transaction/` — build & submit transactions
- **CardanoSignService** at `/odata/v4/cardano-sign/` — external signing workflow
- **CardanoIndexerService** at `/odata/v4/cardano-indexer/` — chain crawler / pre-sync control (v2.0, off by default)
- **CardanoWorkerService** at `/odata/v4/cardano-worker/` — asynchronous wallet jobs (v2.0, off by default)

> `getStatus`, `GetJobStatus` and `GetWorkerStatus` are OData **functions** — call them with
> HTTP GET and the parameters in the URL, e.g. `GET .../cardano-worker/GetWorkerStatus()`.
> POSTing to a function returns 405.

Both v2.0 services also publish **CAP events**, so a CAP consumer can subscribe rather than poll —
in-process, so no message broker is involved:

```js
(await cds.connect.to('CardanoWorkerService')).on('jobConfirmed', ({ data }) => …)  // jobId, txHash
(await cds.connect.to('CardanoIndexerService')).on('blockIndexed', ({ data }) => …) // hash, height, txHashes
```

### 4) Verify

```bash
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

### Programmatic Access (optional)

```typescript
import { getCardanoClient, getCardanoIndexer } from '@odatano/core';

// After CAP has started
const client = getCardanoClient();
const indexer = getCardanoIndexer();
```

---

## Option B: Standalone Development

Clone and run ODATANO as a full standalone application.

### 1) Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci
```

### 2) Configure Environment

```bash
# Linux/macOS (or Git Bash on Windows)
cp .env.example .env

# Windows PowerShell (alternative)
Copy-Item .env.example .env
```

Open `.env` and set at least your Blockfrost key. Supported variables:

```env
# Log level: trace | debug | info | warn | error | fatal
LOG_LEVEL=info

# Network: mainnet | preview | preprod (default: preview)
NETWORK=preview

# Blockfrost API key (https://blockfrost.io)
BLOCKFROST_API_KEY=your_api_key_here

# Timeouts (milliseconds)
PRIMARY_TIMEOUT_MS=30000
FALLBACK_TIMEOUT_MS=60000

# Enabled Backends (comma-separated): koios, blockfrost, ogmios
BACKENDS=koios

# Ogmios WebSocket URL (optional, for live data)
OGMIOS_URL=ws://localhost:1337

# Transaction builder is Buildooor only — TX_BUILDERS is no longer needed (any value is ignored)

# Lazy indexing TTL (milliseconds). Example: 60000 = 1 minute
INDEX_TTL_MS=3600000
KOIOS_API_KEY=

# --- HSM signing (optional; server-side keys) -------------------------------
HSM_ENABLED=false
# HSM_REQUIRES_ROLE is MANDATORY when HSM_ENABLED=true — startup throws ConfigError
# without it. It names the role required for SignWithHsm / SignAndSubmitWithHsm and
# for SubmitWalletJob against an HSM-backed wallet (403 ODATANO_FORBIDDEN otherwise).
HSM_REQUIRES_ROLE=
HSM_SLOT=0
HSM_PIN=
HSM_KEY_LABEL=cardano-signing-key

# --- Chain crawler / pre-sync (v2.0, off by default) ------------------------
CRAWLER_ENABLED=false
CRAWLER_START_SLOT=              # required when enabled
CRAWLER_START_HASH=              # required when enabled
CRAWLER_START_HEIGHT=
CRAWLER_SOURCE=auto              # ogmios | pagination | auto
CRAWLER_CONFIRMATION_DEPTH=3
CRAWLER_BATCH_SIZE=20
CRAWLER_POLL_INTERVAL_MS=20000
# chain-sync needs `ogmios` listed in BACKENDS — a reachable Ogmios alone is not enough

# --- Wallet worker (v2.0, off by default) -----------------------------------
WALLET_WORKER_ENABLED=false
# JSON array: [{"walletId":"treasury","signerType":"software","keyEnv":"TREASURY_KEY"}]
# signerType hsm | software; the software key is read from the env var named in keyEnv
# (plain 64-hex or AES-256-GCM iv:tag:ciphertext) and never persisted.
WALLET_WORKER_WALLETS=
WALLET_WORKER_MAX_CONCURRENT=4
WALLET_WORKER_CONFIRMATION_DEPTH=3
WALLET_WORKER_CONFIRMATION_TIMEOUT_MS=600000
WALLET_WORKER_POLL_INTERVAL_MS=2000
WALLET_WORKER_MAX_ATTEMPTS=3
WALLET_WORKER_RESUBMIT_ON_ROLLBACK=true

```

### 3) Initialize Database

```bash
cds deploy --to sqlite
```

This creates the SQLite database used for on-demand indexing and caching.

### 4) Start Server

**Development mode (recommended):**

```bash
npm run cds:watch
```

- Runs TypeScript directly with live reload
- No compiled files generated
- Auto-restarts on changes

**Production mode:**

```bash
npm start
```

- Compiles TypeScript → JavaScript
- Optimized for deployment

Server runs at: http://localhost:4004

Base service path: http://localhost:4004/odata/v4/cardano-odata

## Local Ogmios + cardano-node (Docker)

For live-data / Ogmios-backend development you can run a local Cardano node and
Ogmios bridge. The repo ships a `docker-compose.yml` that mirrors the CI sync
setup (same images, config, and node-11 topology).

**Prerequisites:** Docker Desktop. The `ghcr.io/odatano/ogmios` image must be
public (it is) — otherwise run `docker login ghcr.io` first.

```bash
# Bring up everything (cardano-node + Ogmios + ODATANO service)
docker compose up -d

# …or just the chain backend (e.g. to pre-sync), without building ODATANO:
docker compose up -d cardano-node ogmios

# Watch sync progress — /health returns 202 while syncing, 200 near tip
docker compose logs -f ogmios
curl http://localhost:1337/health        # look at "networkSynchronization"
```

Stop / reset:

```bash
docker compose down        # stop; keeps the synced node DB (node-db volume)
docker compose down -v     # also wipe the DB volume → full re-sync next time
```

**Notes**

- **First sync takes hours** (Preview from genesis). The node DB persists in the
  `node-db` volume, so restarts resume rather than re-syncing.
- The `odatano` service is pre-wired to the local Ogmios
  (`OGMIOS_URL=ws://ogmios:1337`, `BACKENDS=ogmios,blockfrost,koios`) and waits
  until Ogmios answers `/health` (connected to the node) — **not** for a full
  sync. Until Ogmios catches up, historical queries fall back to Blockfrost, so
  set a `BLOCKFROST_API_KEY` (env or `.env`).
- To point a **locally-run** (non-Docker) ODATANO at the stack, start only
  `cardano-node ogmios` and set `OGMIOS_URL=ws://localhost:1337` +
  `BACKENDS=ogmios,blockfrost` before `npm run cds:watch`.
- The node ↔ Ogmios IPC socket uses a named Docker volume (`node-ipc`) — required
  on Windows, where Unix domain sockets don't work over a host bind mount.
- `GenesisHashMismatch`? Your checkout converted the genesis JSON to CRLF. Fix:
  `git add --renormalize config/preview/cardano-node/` (a `.gitattributes` rule
  enforces LF for these files).

## First Requests

- Network information

```bash
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

- Latest block / epoch via OData queries:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Blocks?$orderby=height desc&$top=1"
curl "http://localhost:4004/odata/v4/cardano-odata/Epochs?$orderby=epoch desc&$top=1"
```

- Transaction by hash

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetTransactionByHash \
  -H "Content-Type: application/json" \
  -d '{"hash":"<64-hex-hash>"}'
```

- Address details

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAddressByBech32 \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'
```

- Pool / account / drep lookups

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetPoolById \
  -H "Content-Type: application/json" \
  -d '{"poolId":"pool1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAccountByStakeAddress \
  -H "Content-Type: application/json" \
  -d '{"stakeAddress":"stake_test1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetDrepById \
  -H "Content-Type: application/json" \
  -d '{"drepId":"drep1..."}'
```

- Address UTxOs and Assets

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetUTxOsByAddress \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetAssetsByAddress \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'
```

- Transaction metadata

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-odata/GetMetadataByTxHash \
  -H "Content-Type: application/json" \
  -d '{"txHash":"<64-hex-hash>"}'
```

Tip: You can also read by keys where applicable, e.g.:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('<64-hex-hash>')"
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1...')"
```

## Testing All Endpoints

For comprehensive API testing, ODATANO provides two convenient options:

### Automated Test Script

```bash
npx tsx scripts/testing/request_examples.ts
```

The [request_examples.ts](../scripts/testing/request_examples.ts) script automatically tests service endpoints with real test data from the preview network. It provides:

- Automatic testing of all service endpoints
- Real test data (block hashes, addresses, transaction hashes, etc.)
- Summary statistics (successful/failed requests)
- Detailed logging output

### Postman Collection

Import the [ODATANO M1 - Full Service Catalog](../scripts/ODATANO%20M1%20-%20Full%20Service%20Catalog.postman_collection.json) collection into Postman to:

- Manually test and explore all available endpoints
- View pre-configured requests with example data
- See detailed descriptions for each endpoint
- Modify parameters and experiment with the API

## Transaction Building (M2)

Build and submit transactions via the transaction service:

```bash
# Build simple ADA transfer
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'
```

See [Transaction Workflow Guide](guides/TRANSACTION_WORKFLOW.md) for signing and submission.

## External Signing (M3)

Create signing requests for external wallets (CIP-30 browser wallets, Cardano CLI, hardware wallets):

```bash
# 1. Build transaction first (returns buildId)
BUILD_RESPONSE=$(curl -s -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }')

# 2. Create signing request (returns signing instructions)
curl -X POST http://localhost:4004/odata/v4/cardano-sign/CreateSigningRequest \
  -H "Content-Type: application/json" \
  -d '{
    "buildId": "<buildId-from-step-1>",
    "message": "Please sign this transaction"
  }'

# 3. After signing externally, verify and submit
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SubmitVerifiedTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "signingRequestId": "<signingRequestId-from-step-2>",
    "signedTxCbor": "<signed-transaction-cbor>",
    "signerType": "browser-wallet",
    "signerInfo": "Nami"
  }'
```

**Signing Methods Supported:**
- **CIP-30 Browser Wallets**: Nami, Eternl, Yoroi, Flint (use `api.signTx()`)
- **Cardano CLI**: Use the `cardanoCliCommand` from signing request response
- **Hardware Wallets**: Ledger, Trezor via browser wallet extensions

See [Transaction Workflow Guide](guides/TRANSACTION_WORKFLOW.md) for complete external signing documentation.

## Testing

```bash
# All tests (59 files / 1921 tests: 44 unit + 15 integration, vitest)
npm test

# Coverage report
npm run test:coverage

# Only integration tests / only unit tests
npm run test:integration
npm run test:unit
```

For tests using live providers, set `BLOCKFROST_API_KEY` in your environment.
