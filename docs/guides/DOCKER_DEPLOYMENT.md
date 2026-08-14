# Docker Deployment

**Version:** v2.0.0-rc.1 | **Last Updated:** August 2026

## What the stack contains

`docker-compose.yml` starts **three** services, not one:

| Service | Image | Role |
|---|---|---|
| `cardano-node` | `ghcr.io/intersectmbo/cardano-node:11.0.1` | Full node. Syncs the chain into the `node-db` volume and exposes a socket via `node-ipc`. |
| `ogmios` | `ghcr.io/odatano/ogmios:v6.14.0.2` | WebSocket bridge to the node on port `1337`. Healthy once it is *connected* to the node. |
| `odatano` | `odatano:${VERSION:-0.1.0}` (built locally) | The API on port `4004`, wired to `BACKENDS=ogmios,blockfrost,koios` and `OGMIOS_URL=ws://ogmios:1337`. |

`odatano` waits for the Ogmios healthcheck (`condition: service_healthy`), which reports healthy as
soon as Ogmios can talk to the node — **not** when the chain is fully synced. Expect the node to
need hours on a first start; until it catches up, Ogmios answers `202` instead of `200` and the
Ogmios-backed paths return stale or empty results while Blockfrost/Koios still serve.

> On a restart the node first **validates its existing ChainDB** ("Validating chunk N of M"). It
> creates `/ipc/node.socket` only when that finishes, so Ogmios logs `HealthFailedToConnect` until
> then. That is normal startup, not a failure.

## Quick Start

### Build from source

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO

cp .env.example .env          # then set BLOCKFROST_API_KEY
docker compose up -d          # builds the odatano image, starts all three services

# follow the node's initial sync
docker compose logs -f cardano-node

# once Ogmios reports healthy:
curl http://localhost:1337/health
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

### Backends only

To run just the node + Ogmios and point a local (non-container) ODATANO at them:

```bash
docker compose up -d cardano-node ogmios
# then in your local .env: OGMIOS_URL=ws://localhost:1337
```

### Pre-built image

```bash
curl -O https://raw.githubusercontent.com/ODATANO/ODATANO/main/docker-compose.yml

# Pin the version the compose file interpolates, and use the published image
# instead of the local build by commenting out the `build:` block of `odatano`.
echo "VERSION=2.0.0-rc.1" >> .env
echo "BLOCKFROST_API_KEY=your-key" >> .env

docker compose up -d
```

`VERSION` is the supported way to select the tag — `image: odatano:${VERSION:-0.1.0}` reads it from
`.env`. Hardcoding a tag into the compose file is not necessary.

### Database schema

The container ships an empty SQLite database. **When upgrading a 1.x deployment to 2.0, run
`cds deploy` against the mounted database** — 2.0 adds `CardanoSyncState`, `CardanoReorgLog`,
`CardanoWorkerWallets`, `CardanoWalletJobs` and a `dedupKey` column. Without it the crawler and
worker endpoints answer `no such table` while the older services keep working.

### Health probes

```bash
curl http://localhost:1337/health                                    # Ogmios: 200 near tip, 202 while syncing
curl http://localhost:4004/odata/v4/cardano-odata/\$metadata          # API liveness (compose healthcheck)
curl http://localhost:4004/odata/v4/cardano-indexer/getStatus\(\)      # crawler cursor + progress (if enabled)
curl http://localhost:4004/odata/v4/cardano-worker/GetWorkerStatus\(\) # worker state + queue depth (if enabled)
```

Note the last two are OData **functions** — HTTP GET with `()`. POST returns 405.

## Configuration

The `.env` file configures the service. Copy `.env.example` as a starting point:

```env
# Required: Blockfrost API Key (get from https://blockfrost.io)
BLOCKFROST_API_KEY=your-blockfrost-api-key-here

# Network: mainnet, preview, preprod (default: preview)
NETWORK=preview

# Backends: blockfrost, koios, or both comma-separated (default: blockfrost,koios)
BACKENDS=blockfrost,koios

# Cache TTL in milliseconds (default: 3600000 = 1 hour)
INDEX_TTL_MS=3600000
KOIOS_API_KEY=
OGMIOS_URL=ws://ogmios:1337   # set by docker-compose; only needed when running outside it

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

## Commands

```bash
# Start
docker compose up -d

# Logs
docker compose logs -f

# Stop
docker compose down
```
