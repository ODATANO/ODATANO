# Docker Deployment

**Version:** v2.0.0-rc.x

## What the stack contains

`docker-compose.yml` starts three services:

| Service | Image | Role |
|---|---|---|
| `cardano-node` | `ghcr.io/intersectmbo/cardano-node:11.0.1` | Full node on Preview. Syncs the chain into the volume `node-db` and offers its socket in the volume `node-ipc`. |
| `ogmios` | `cardanosolutions/ogmios:v7.0.0` | WebSocket bridge to the node on port `1337`. Healthy once it is connected to the node. |
| `odatano` | `odatano:${VERSION:-0.1.0}`, built locally | The API on port `4004`, with `BACKENDS=ogmios,koios` and `OGMIOS_URL=ws://ogmios:1337`. |

`odatano` starts when Ogmios is healthy. Healthy means connected to the node, not synced. A first sync
takes hours. Until the node has caught up, Ogmios answers `/health` with `202` instead of `200`. Results
that come from Ogmios are stale or empty in that time; Koios still answers.

> On a restart the node first checks its stored chain (`Validating chunk N of M` in its log). It creates
> `/ipc/node.socket` only after that, so Ogmios logs `HealthFailedToConnect` until then. This is a normal
> start, not a failure.

## Quick Start

### Build from source

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO

echo "ODATANO_HTTP_PASSWORD=choose-a-password" > .env
docker compose up -d          # builds the odatano image and starts all three services

# the first sync of the node
docker compose logs -f cardano-node

# once Ogmios is healthy:
curl http://localhost:1337/health
curl -u odatano:choose-a-password http://localhost:4004/odata/v4/cardano/NetworkInformation
```

Both ports are published on `127.0.0.1` only. Ogmios has no authentication, so keep `1337` local.
To serve the API to other hosts, put a reverse proxy in front of `4004` or change the `ports` entry of
the `odatano` service in `docker-compose.yml`.

### Backends only

To run the node and Ogmios alone and point a local ODATANO at them:

```bash
docker compose up -d cardano-node ogmios
# then in your local .env: OGMIOS_URL=ws://localhost:1337
```

### Pre-built image

Every release is published as `ghcr.io/odatano/odatano:<version>`. A release candidate does not move the
tag `latest`, so name the version:

```bash
docker run -d --name odatano -p 127.0.0.1:4004:4004 -v odatano-data:/data \
  -e ODATANO_HTTP_PASSWORD=choose-a-password \
  -e NETWORK=preview -e BACKENDS=koios \
  ghcr.io/odatano/odatano:<version>
```

To use it in the compose stack, set `image:` of the `odatano` service to that name and remove its
`build:` block.

### Authentication

The image uses HTTP basic auth through `@odatano/cap-auth`. The entrypoint builds the login from these
variables (`docker/cds-config.mjs`):

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_HTTP_PASSWORD` | required | Password of the operator user |
| `ODATANO_HTTP_USER` | `odatano` | Operator user |
| `ODATANO_HTTP_ROLES` | `Read,Transact,Sign,Admin` | Comma-separated roles of the user. `Read` alone gives a read-only login |
| `ODATANO_AUTH` | `basic` | `dummy` = no authentication, for local tests only. It starts only with the next variable |
| `ODATANO_ALLOW_UNAUTHENTICATED` | unset | `yes-anyone-who-reaches-the-port-is-admin` confirms `ODATANO_AUTH=dummy`. Every start then logs an error line |
| `ODATANO_TRUST_PROXY` | `0` | Number of reverse proxies in front of the container, 0 to 10. The login throttle then keys on the client address before them. Needs `@odatano/cap-auth` 0.2.0; with an older one the start refuses |

The image runs with `NODE_ENV=production` and holds no development users. The operator user is the only
login.

Requests without a login reach only `getLiveness()`, `getReadiness()`, `VerifyDataSignature` and the
`$metadata` of the sign and indexer services. Everything else is challenged. Agent tokens (`x-agent-token`, `AGENT_GRANTS_ENABLED=true`) pass on the
service paths.

After 20 failed logins in 15 minutes for one client address and user, the answer is 429 with `Retry-After`,
for the right password too. Unknown agent tokens are throttled the same way per client address; a valid
token is always admitted.

Behind a reverse proxy, set `ODATANO_TRUST_PROXY` to the number of proxies. Otherwise every client shares
the proxy's address, and one guessing client locks the operator out. The port must then be reachable only
through the proxy: a client that reaches it directly writes its own `X-Forwarded-For` and picks a new key
per request.

### Database

| Variable | Default | Purpose |
|---|---|---|
| `ODATANO_DB_URL` | unset | `postgres://user:pw@host:5432/db` selects PostgreSQL (`sslmode=disable\|require\|verify-full`) |
| `ODATANO_DB_PATH` | `/data/db.sqlite` | SQLite file when no URL is set. The first start creates it |
| `ODATANO_DB_DEPLOY` | `auto` | `never` skips the schema deployment at start |
| `ODATANO_DB_WAIT_SECONDS` | `60` | How long the start waits for PostgreSQL to accept connections |
| `ODATANO_SQLITE_TIMEOUT_MS` | `5000` | How long a SQLite writer waits for the lock |

The compose file keeps `/data` in the volume `odatano-data`, so the SQLite file survives
`docker compose down` and the one-off `run` containers below see it.

To move a SQLite deployment to PostgreSQL, stop the service and run the `migrate` mode of the image once,
with `ODATANO_DB_URL` set to the new, empty database:

```bash
docker compose run --rm --no-deps odatano migrate --from /data/db.sqlite
```

It brings the SQLite file to the schema of this version, deploys the schema to PostgreSQL, copies every
table through CAP and compares the row counts. Then start the service with `ODATANO_DB_URL` set.

### Schema changes at start

Every start brings the database to the schema of the image, on PostgreSQL and on SQLite, before the
service listens. It runs in two parts:

1. The changes CAP's additive deployment refuses, each only where the database still needs it:
   - `TransactionInputs`, `TransactionOutputs` and their asset tables keyed by `Transactions.txSeq`
     instead of the transaction hash.
   - `Blocks.time` from text to a timestamp.
   - The columns `walletId` and `allowedJobKinds` of `CardanoAgentGrants` removed.
   - The table `TransactionInputAssets` renamed to `TransactionInputAssetCopies`. The old name becomes a
     view (see [Input assets](CRAWLER_GUIDE.md#input-assets) in the Crawler Guide).
2. CAP's additive deployment: new tables, new columns, and every view.

Part 1 runs in one transaction. It refuses while a crawler holds its lease, so stop every instance that
uses the database. On PostgreSQL two instances that start at once deploy one after the other; the second
logs that it waits. A SQLite file created by an earlier image has no record of its schema (`cds_model`);
the first start writes one from the tables and columns the file holds.

On a large database run both parts as a step of their own. The start itself then has nothing left to do:

```bash
docker compose stop odatano
docker compose run --rm --no-deps odatano migrate-schema --dry-run   # the steps that are due, nothing changed
docker compose run --rm --no-deps odatano deploy-schema --dry-run    # the same report
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
- The txSeq step copies four tables. Plan disk space for a second copy of them. On PostgreSQL run
  `VACUUM (PARALLEL 0) odatano_cardano_transactions` afterwards. Measured: 68 million rows in 15 minutes
  on a 1 GB PostgreSQL. Without `PARALLEL 0` the PostgreSQL container needs a `shm_size` above
  `maintenance_work_mem`.
- The other steps change no rows.
- The service creates missing table indexes at start. On PostgreSQL it builds them `CONCURRENTLY` in the
  background while the service answers; one instance builds, the others skip. Queries a new index serves
  are slow until it exists. On SQLite the start waits for the indexes before it answers.

A plugin deployment runs `node node_modules/@odatano/core/scripts/deploy-schema.mjs` with its own `db`
configuration, `--dry-run` first. A plain `cds deploy` drops and recreates every table of a kept SQLite
database.

### Health probes

```bash
curl http://localhost:1337/health                                    # Ogmios: 200 near tip, 202 while syncing
curl http://localhost:4004/odata/v4/cardano-indexer/getLiveness\(\)    # API liveness, no credentials (Docker/compose healthcheck)
curl http://localhost:4004/odata/v4/cardano-indexer/getReadiness\(\)   # 200 ready, 503 while context, database or a configured HSM is missing
curl -u "odatano:$ODATANO_HTTP_PASSWORD" http://localhost:4004/odata/v4/cardano-indexer/getStatus\(\)      # crawler cursor + progress (if enabled)
curl -u "odatano:$ODATANO_HTTP_PASSWORD" http://localhost:4004/odata/v4/cardano-worker/GetWorkerStatus\(\) # worker state + queue depth (if enabled)
```

The last two are OData functions: HTTP GET with `()`, and POST answers 405. They need the login; the
probes above them do not.

## Configuration

Compose reads `.env` only to fill in its own file. The `odatano` service receives these variables:

| Variable | Value in `docker-compose.yml` |
|---|---|
| `NETWORK` | `preview`, fixed. The node configuration in `config/preview` belongs to it |
| `BACKENDS` | from `.env`, default `ogmios,koios` |
| `OGMIOS_URL` | `ws://ogmios:1337` |
| `KOIOS_API_KEY`, `BLOCKFROST_API_KEY` | from `.env`, optional |
| `PRIMARY_TIMEOUT_MS`, `FALLBACK_TIMEOUT_MS` | `15000` |
| `INDEX_TTL_MS` | `600000` |
| `ODATANO_HTTP_PASSWORD` | from `.env`, required |
| `ODATANO_TRUST_PROXY` | from `.env`, default `0` |
| `AGENT_GRANTS_ENABLED` | from `.env`, default `false` |
| `PORT` | `4004` |

- Add every other setting to the `environment` list of the `odatano` service. That holds for the variables
  of the tables above, such as `ODATANO_HTTP_ROLES` and `ODATANO_DB_URL`, and for the crawler and the
  wallet worker. [Environment Configuration](PRODUCTION_DEPLOYMENT.md#environment-configuration) in the
  Production guide lists them.
- `VERSION` in `.env` names the tag of the image the stack builds.
- The image sets `NODE_ENV=production` itself.
- HSM signing is not available in the image: it contains no PKCS#11 binding.

## Commands

```bash
docker compose up -d      # start
docker compose logs -f    # logs
docker compose down       # stop and remove the containers; the volumes stay, the SQLite file included
```
