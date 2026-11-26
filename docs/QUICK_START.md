# ODATANO Quick Start Guide

**Version:** v2.0.0-rc.x

Two ways to run the OData V4 service: as a plugin in a CAP project, or from this repository.

---

## Option A: Use as CAP Plugin

### 1) Install

```bash
npm install @odatano/core @cap-js/sqlite
```

### 2) Configure

Add to your project's `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "auth": { "users": { "alice": { "roles": ["Read", "Transact", "Sign"] } } },
      "odatano-core": {
        "network": "preview",
        "backends": ["koios"]
      }
    }
  }
}
```

- The services ask for the roles `Read`, `Transact` and `Sign`, and for `Admin` on operator actions. The
  `auth` entry gives them to the development user `alice`. In production your own authentication assigns them.
- Koios needs no account. A token from [koios.rest](https://koios.rest) is optional and raises the rate
  limit. Set it as `KOIOS_API_KEY` in a `.env` file or as `koiosApiKey` in the config. A value in the config
  wins over the environment variable.

Options of `odatano-core`:

| Key | Default | Description |
|-----|---------|-------------|
| `network` | `preview` | `mainnet`, `preview` or `preprod` |
| `backends` | `["koios"]` | Array of `koios`, `ogmios`, `blockfrost`, `odatano` |
| `koiosApiKey` | | Optional Koios token, raises the rate limit |
| `blockfrostApiKey` | | Needed with the `blockfrost` backend, unless `blockfrostCustomBackend` is set |
| `blockfrostCustomBackend` | | URL of a self-hosted Blockfrost-compatible node |
| `ogmiosUrl` | | Needed with the `ogmios` backend, for example `ws://localhost:1337` |
| `odatanoUrl` | public API of the network | Remote ODATANO for the `odatano` backend. Required on mainnet |
| `odatanoApiKey` | | Key for the remote ODATANO |
| `primaryTimeoutMs` | `30000` | Timeout for the primary backend |
| `fallbackTimeoutMs` | `60000` | Timeout for fallback backends |
| `indexTtlMs` | `3600000` | Cache TTL (1 hour) |
| `poolMetadataFetch` | `false` | Load pool names and tickers from the URL a pool registered. Needed with Ogmios alone |
| `readTimeoutMs` | `15000` | PostgreSQL: statement timeout of API reads in milliseconds, `0` = off |

The sections `crawler`, `walletWorker`, `hsm` and `agentGrants` are off by default. The
[Crawler Guide](guides/CRAWLER_GUIDE.md), the [User Guide](guides/USER_GUIDE.md) and the
[Security Guide](guides/SECURITY_GUIDE.md) describe them.
[Backend Configuration](guides/BACKEND_CONFIGURATION.md) describes the backends.

### 3) Run

```bash
cds deploy --to sqlite
cds watch
```

`cds deploy` creates `db.sqlite`. The plugin registers seven services:

| Service | Path | Purpose |
|---|---|---|
| CardanoODataService | `/odata/v4/cardano/` | Read chain data |
| CardanoTransactionService | `/odata/v4/cardano-transaction/` | Build and submit transactions |
| CardanoSignService | `/odata/v4/cardano-sign/` | External signing and HSM |
| CardanoIndexerService | `/odata/v4/cardano-indexer/` | Chain crawler control, off by default |
| CardanoWorkerService | `/odata/v4/cardano-worker/` | Asynchronous wallet jobs, off by default |
| CardanoBackendService | `/odata/v4/cardano-backend/` | Chain data for another ODATANO that uses this one as its `odatano` backend |
| CardanoAgentService | `/odata/v4/cardano-agent/` | Agent grants, off by default |

`getStatus`, `GetJobStatus` and `GetWorkerStatus` are OData functions. Call them with HTTP GET and the
parameters in the URL, for example `GET .../cardano-worker/GetWorkerStatus()`. A POST returns 405.

The indexer and the worker service publish CAP events. A CAP application subscribes in the same process,
without a message broker:

```js
(await cds.connect.to('CardanoWorkerService')).on('jobConfirmed', ({ data }) => …)  // jobId, txHash
(await cds.connect.to('CardanoIndexerService')).on('blockIndexed', ({ data }) => …) // hash, height, txHashes
```

### 4) Verify

```bash
curl -u alice: http://localhost:4004/odata/v4/cardano/NetworkInformation
```

`alice` is the development user from the config above and the password is not checked. Without a login
the answer is 401.

### Programmatic Access (optional)

```typescript
import { getCardanoClient, getCardanoIndexer } from '@odatano/core';

// After CAP has started
const client = getCardanoClient();
const indexer = getCardanoIndexer();
```

---

## Option B: Standalone Development

### 1) Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci
npm run clean     # npm ci compiles in place; without this, cds watch runs the compiled files
```

### 2) Configure Environment

```bash
# Linux/macOS (or Git Bash on Windows)
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

With the default `BACKENDS=koios` nothing else is needed. The main variables:

```env
NETWORK=preview                  # mainnet | preview | preprod
BACKENDS=koios                   # comma-separated: koios, ogmios, blockfrost, odatano
# KOIOS_API_KEY=                 # optional, raises the rate limit
# BLOCKFROST_API_KEY=            # only with blockfrost in BACKENDS
OGMIOS_URL=ws://localhost:1337   # only with ogmios in BACKENDS
```

The crawler, the wallet worker and HSM signing are off by default. Their variables are listed under
[Environment Configuration](guides/PRODUCTION_DEPLOYMENT.md#environment-configuration) in the Production
guide.

### 3) Initialize Database

```bash
npm run db:deploy
```

This creates `db.sqlite`, the database for on-demand indexing and caching.

### 4) Start Server

```bash
npm run cds:watch
```

The server runs at http://localhost:4004 and restarts when a source file changes. The read service is at
http://localhost:4004/odata/v4/cardano.

The repository defines four development users in `.cdsrc.json`: `alice` and `bob` hold `Read`, `Transact`
and `Sign`, `carol` holds `Read`, `admin` holds all four roles.

## Local Ogmios + cardano-node (Docker)

`docker-compose.yml` starts a Preview cardano-node, Ogmios and ODATANO. It needs Docker and a password for
the ODATANO login: set `ODATANO_HTTP_PASSWORD` in `.env` or in the shell, the compose file refuses to
start without it.

```bash
docker compose up -d                      # cardano-node, Ogmios and ODATANO
docker compose up -d cardano-node ogmios  # only the node and Ogmios

docker compose logs -f ogmios
curl http://localhost:1337/health         # 202 while syncing, 200 near the tip; see "networkSynchronization"

docker compose down                       # stop; keeps the volumes: the synced node database and the ODATANO SQLite file
docker compose down -v                    # also deletes the volumes; the next start syncs from genesis
```

- The first sync of Preview from genesis takes hours. A restart continues where the node stopped.
- The `odatano` container runs with `BACKENDS=ogmios,koios`. It waits until Ogmios answers `/health`, not
  for the full sync. Until Ogmios has caught up, Koios answers.
- The container asks for HTTP basic auth: user `odatano`, password `ODATANO_HTTP_PASSWORD`. Use
  `curl -u "odatano:$ODATANO_HTTP_PASSWORD"` there.
- To run ODATANO from the repository against the stack, start only `cardano-node ogmios`. Then set
  `OGMIOS_URL=ws://localhost:1337` and `BACKENDS=ogmios,koios` in `.env` and run `npm run cds:watch`.
- The node socket lives in the named volume `node-ipc`. Unix sockets do not work over a Windows host mount.
- `GenesisHashMismatch` means the checkout wrote the genesis JSON with CRLF. Restore the LF files:
  `rm config/preview/cardano-node/*.json && git checkout -- config/preview/cardano-node/`.

[Docker Deployment](guides/DOCKER_DEPLOYMENT.md) describes the image, its database and the health probes.

## First Requests

The requests below leave the credentials out. Add `-u alice:` in development; without a login the answer
is 401.

- Network information

```bash
curl -u alice: http://localhost:4004/odata/v4/cardano/NetworkInformation
```

- Latest block and latest epoch

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetLatestBlock \
  -H "Content-Type: application/json" -d '{}'

curl -X POST http://localhost:4004/odata/v4/cardano/GetLatestEpoch \
  -H "Content-Type: application/json" -d '{}'
```

- Transaction by hash

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetTransactionByHash \
  -H "Content-Type: application/json" \
  -d '{"hash":"<64-hex-hash>"}'
```

- Address details

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetAddressByBech32 \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'
```

- Pool, account and DRep

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetPoolById \
  -H "Content-Type: application/json" \
  -d '{"poolId":"pool1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano/GetAccountByStakeAddress \
  -H "Content-Type: application/json" \
  -d '{"stakeAddress":"stake_test1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano/GetDrepById \
  -H "Content-Type: application/json" \
  -d '{"drepId":"drep1..."}'
```

- UTxOs and assets of an address

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetUTxOsByAddress \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'

curl -X POST http://localhost:4004/odata/v4/cardano/GetAssetsByAddress \
  -H "Content-Type: application/json" \
  -d '{"address":"addr_test1..."}'
```

- Transaction metadata

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetMetadataByTxHash \
  -H "Content-Type: application/json" \
  -d '{"txHash":"<64-hex-hash>"}'
```

- Read by key

```bash
curl "http://localhost:4004/odata/v4/cardano/Transactions('<64-hex-hash>')"
curl "http://localhost:4004/odata/v4/cardano/Addresses('addr_test1...')"
```

A read by key fetches a row the database does not hold yet. A read of an entity set, such as `Blocks`
with `$filter` or `$orderby`, returns the rows the database holds.

## Testing All Endpoints

- **Script.** `npx tsx scripts/testing/request_examples.ts` calls the read service with test data from the
  preview network and prints a summary. The server has to run. See
  [request_examples.ts](../scripts/testing/request_examples.ts).
- **Postman.** The collections in [scripts/postman](../scripts/postman/) hold requests with example data
  for the read, transaction and signing services. Set Basic Auth in Postman, the collections carry no login.

## Transaction Building

Build a transaction with the transaction service. It needs the role `Transact`.

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'
```

The answer carries the unsigned transaction and the build `id`. The
[Transaction Workflow Guide](guides/TRANSACTION_WORKFLOW.md) describes signing and submitting.

## External Signing

The signing service creates a signing request for a wallet outside the server: a CIP-30 browser wallet,
the Cardano CLI or a hardware wallet. It needs the role `Sign`.

```bash
# 1. Build the transaction; the answer carries the build id
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'

# 2. Create the signing request; the answer carries its id
curl -X POST http://localhost:4004/odata/v4/cardano-sign/CreateSigningRequest \
  -H "Content-Type: application/json" \
  -d '{
    "buildId": "<id-from-step-1>",
    "message": "Please sign this transaction"
  }'

# 3. Sign outside the server, then verify and submit
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SubmitVerifiedTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "signingRequestId": "<id-from-step-2>",
    "signedTxCbor": "<signed-transaction-cbor>",
    "signerType": "browser-wallet",
    "signerInfo": "Eternl"
  }'
```

- **CIP-30 browser wallets** such as Eternl, Lace, Yoroi or Vespr sign with `api.signTx()`.
- **Cardano CLI**: the signing request carries the commands in `cardanoCliCommand`.
- **Hardware wallets** such as Ledger or Trezor sign through a browser wallet extension.

The [Transaction Workflow Guide](guides/TRANSACTION_WORKFLOW.md) has the details.

## Testing

```bash
# All tests (136 files: 116 unit + 20 integration, vitest)
npm test

# Coverage report
npm run test:coverage

# Only integration tests / only unit tests
npm run test:integration
npm run test:unit
```

`npm test` deletes `db.sqlite` and creates it new. Stop a running `cds watch` first, it holds the file.

The Koios integration suites run without a key. The Blockfrost suites need `BLOCKFROST_API_KEY` in your environment.
