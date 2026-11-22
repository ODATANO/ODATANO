# Docker Deployment

**Version:** v2.0.0-rc.x | **Last Updated:** September 2026

## What the stack contains

`docker-compose.yml` starts **three** services, not one:

| Service | Image | Role |
|---|---|---|
| `cardano-node` | `ghcr.io/intersectmbo/cardano-node:11.0.1` | Full node. Syncs the chain into the `node-db` volume and exposes a socket via `node-ipc`. |
| `ogmios` | `cardanosolutions/ogmios:v7.0.0` | WebSocket bridge to the node on port `1337`. Healthy once it is *connected* to the node. |
| `odatano` | `odatano:${VERSION:-0.1.0}` (built locally) | The API on port `4004`, wired to `BACKENDS=ogmios,koios` and `OGMIOS_URL=ws://ogmios:1337`. |

`odatano` waits for the Ogmios healthcheck (`condition: service_healthy`), which reports healthy as
soon as Ogmios can talk to the node — **not** when the chain is fully synced. Expect the node to
need hours on a first start; until it catches up, Ogmios answers `202` instead of `200` and the
Ogmios-backed paths return stale or empty results while Koios still serves.

> On a restart the node first **validates its existing ChainDB** ("Validating chunk N of M"). It
> creates `/ipc/node.socket` only when that finishes, so Ogmios logs `HealthFailedToConnect` until
> then. That is normal startup, not a failure.

## Quick Start

### Build from source

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO

cp .env.example .env          # then set ODATANO_HTTP_PASSWORD; KOIOS_API_KEY is optional
docker compose up -d          # builds the odatano image, starts all three services

# follow the node's initial sync
docker compose logs -f cardano-node

# once Ogmios reports healthy:
curl http://localhost:1337/health
curl http://localhost:4004/odata/v4/cardano/NetworkInformation
```

Both ports are published on `127.0.0.1` only. Ogmios has no authentication, so keep `1337` local.
To serve the API to other hosts, put a reverse proxy in front of `4004` or change the `ports` entry of
the `odatano` service in `docker-compose.yml`.

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
echo "VERSION=2.0.0-rc.3" >> .env
echo "ODATANO_HTTP_PASSWORD=choose-a-password" >> .env
echo "KOIOS_API_KEY=your-koios-token" >> .env   # optional, raises the Koios rate limit

docker compose up -d
```

`VERSION` is the supported way to select the tag — `image: odatano:${VERSION:-0.1.0}` reads it from
`.env`. Hardcoding a tag into the compose file is not necessary.

### Authentication

The image runs `NODE_ENV=production` with HTTP basic auth through `@odatano/cap-auth`
(`docker/cds-config.mjs`, `docker/entrypoint.sh`):

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_HTTP_PASSWORD` | required | Password of the operator user |
| `ODATANO_HTTP_USER` | `odatano` | Operator user |
| `ODATANO_HTTP_ROLES` | `Read,Transact,Sign,Admin` | Comma-separated roles of the user. `Read` alone gives a read-only login |
| `ODATANO_AUTH` | `basic` | `dummy` = unauthenticated, local testing only |

Anonymous requests reach only `getLiveness()`, `getReadiness()` and `VerifyDataSignature`; everything else is
challenged. Agent tokens (`x-agent-token`, `AGENT_GRANTS_ENABLED=true`) pass on the service paths.

### Database

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_DB_URL` | unset | `postgres://user:pw@host:5432/db` selects PostgreSQL (`sslmode=disable\|require\|verify-full`); the schema is brought up to date on every boot (`ODATANO_DB_DEPLOY=never` skips it) |
| `ODATANO_DB_PATH` | `/data/db.sqlite` | SQLite file when no URL is set; seeded on the first boot, and brought up to date on every later one |
| `ODATANO_SQLITE_TIMEOUT_MS` | `5000` | How long a SQLite writer waits for the lock |

Moving an existing SQLite deployment to PostgreSQL: stop the service, then run the image's
`migrate` mode once against the freshly created database and start the service with
`ODATANO_DB_URL` set:

```bash
docker compose run --rm --no-deps odatano migrate --from /data/db.sqlite
```

It brings the SQLite file to the schema of this version, deploys the schema to PostgreSQL, copies
every table through CAP and verifies the row counts.

### Schema changes at start

Every start brings the database to the schema of the image, on PostgreSQL and on SQLite, before the
service listens. It runs in two parts:

1. The changes CAP's additive deployment refuses, each only where the database still needs it:
   - `TransactionInputs`, `TransactionOutputs` and their asset tables keyed by `Transactions.txSeq`
     instead of the transaction hash (databases from before that layout).
   - `Blocks.time` from text to a timestamp.
   - The columns `walletId` and `allowedJobKinds` of `CardanoAgentGrants` removed.
   - The table `TransactionInputAssets` renamed to `TransactionInputAssetCopies`; the old name becomes a
     view (see "Input assets" in the User Guide).
2. CAP's additive deployment: new tables, new columns, and every view.

Part 1 runs in one transaction and refuses while a crawler holds its lease, so every instance on
the database has to be stopped. A SQLite file created by an earlier image has no record of its
schema (`cds_model`); the first start writes one from the tables and columns the file holds.

On a large database run both parts as a step of their own, so the start itself has nothing left to do:

```bash
docker compose stop odatano
docker compose run --rm --no-deps odatano migrate-schema --dry-run   # the steps that are due, nothing changed
docker compose run --rm --no-deps odatano deploy-schema              # part 1 and part 2, then exits
docker compose up -d odatano
```

`migrate-schema` without `--dry-run` runs part 1 alone. The views are missing from then until part 2
ran, so a program that reads the database directly has to wait for it.

What to plan for:

- The steps of part 1 cannot be undone, and an earlier image does not run on the changed database.
  Back up the database before the first start of this version; the backup is the only way back.
- `Blocks.time` rewrites the table and its indexes once. Measured on a copy of a mainnet database:
  9.7 million rows in 1.6 to 2.7 minutes, 3.5 GB of write-ahead log.
- The txSeq step copies four tables: plan disk space for a second copy of them, and on PostgreSQL run
  `VACUUM (PARALLEL 0) odatano_cardano_transactions` afterwards. Measured: 68 million rows in 15 minutes
  on a 1 GB PostgreSQL. Without `PARALLEL 0` the PostgreSQL container needs a `shm_size` above
  `maintenance_work_mem`.
- The other steps change no rows.
- The server recreates its table indexes on the next start, which takes a while on a large database.

A plugin deployment runs `node node_modules/@odatano/core/scripts/migrate-schema.mjs` with its own `db`
configuration and then `cds deploy`.

### Health probes

```bash
curl http://localhost:1337/health                                    # Ogmios: 200 near tip, 202 while syncing
curl http://localhost:4004/odata/v4/cardano-indexer/getLiveness\(\)    # API liveness, no credentials (Docker/compose healthcheck)
curl http://localhost:4004/odata/v4/cardano-indexer/getReadiness\(\)   # 200 ready, 503 while context, database or a configured HSM is missing
curl http://localhost:4004/odata/v4/cardano-indexer/getStatus\(\)      # crawler cursor + progress (if enabled)
curl http://localhost:4004/odata/v4/cardano-worker/GetWorkerStatus\(\) # worker state + queue depth (if enabled)
```

Note the last two are OData **functions** — HTTP GET with `()`. POST returns 405.

## Configuration

The `.env` file configures the service. Copy `.env.example` as a starting point:

```env
# Network: mainnet, preview, preprod (default: preview)
NETWORK=preview

# Backends, comma-separated: koios, ogmios, blockfrost, odatano (default: koios; docker-compose: ogmios,koios)
BACKENDS=ogmios,koios

# Koios token (optional, https://koios.rest): raises the public-tier rate limit
KOIOS_API_KEY=

# Blockfrost API key, only with blockfrost in BACKENDS (https://blockfrost.io)
# BLOCKFROST_API_KEY=

# Cache TTL in milliseconds (default: 3600000 = 1 hour)
INDEX_TTL_MS=3600000
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

# --- Chain crawler / pre-sync (off by default) ------------------------
CRAWLER_ENABLED=false
CRAWLER_START_SLOT=              # required when enabled
CRAWLER_START_HASH=              # required when enabled
CRAWLER_START_HEIGHT=
CRAWLER_SOURCE=auto              # ogmios | pagination | auto
CRAWLER_CONFIRMATION_DEPTH=3
CRAWLER_BATCH_SIZE=20
CRAWLER_POLL_INTERVAL_MS=20000
# chain-sync needs `ogmios` listed in BACKENDS — a reachable Ogmios alone is not enough

# --- Wallet worker (off by default) -----------------------------------
WALLET_WORKER_ENABLED=false
# JSON array: [{"walletId":"treasury","signerType":"software","keyEnv":"TREASURY_KEY"}]
# signerType hsm | software; the software key is read from the env var named in keyEnv
# (plain 64-hex or AES-256-GCM iv:tag:ciphertext) and never persisted.
WALLET_WORKER_WALLETS=
# Optional per wallet: "requiresRole":"<role>". Only callers with that role may queue jobs for it.
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
