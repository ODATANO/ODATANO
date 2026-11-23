# ODATANO Production Deployment Guide

**Version:** v2.0.0-rc.x

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Environment Configuration](#environment-configuration)
3. [SAP BTP Cloud Foundry Deployment](#sap-btp-cloud-foundry-deployment)
4. [Database Configuration](#database-configuration)
5. [Performance Tuning](#performance-tuning)
6. [Health Monitoring](#health-monitoring)
7. [Mainnet Considerations](#mainnet-considerations)
8. [Troubleshooting](#troubleshooting)

---

## Pre-Deployment Checklist

- [ ] Node.js 22.5 or later and `@sap/cds` 10 on the target runtime
- [ ] Coming from 1.x: the steps of [Upgrading to 2.0](UPGRADE_2.0.md) are done
- [ ] `NODE_ENV=production` set
- [ ] `NETWORK` set to the target network (`mainnet`, `preview`, `preprod`)
- [ ] `BACKENDS` names at least one backend
- [ ] With `blockfrost` in `BACKENDS`: `BLOCKFROST_API_KEY` set, with the prefix of the network (see table)
- [ ] With `ogmios` in `BACKENDS`: the node is synced and its WebSocket is reachable
- [ ] `KOIOS_API_KEY` set if the public rate limit of Koios is too low
- [ ] With `HSM_ENABLED=true`: `HSM_PKCS11_MODULE`, `HSM_PIN` and `HSM_REQUIRES_ROLE` set
- [ ] Users hold their roles. `CardanoReader` reads. `CardanoUser` also builds, submits and signs.
      `CardanoAdmin` also operates the crawler, the worker and agent grants. A login without a role gets 403
- [ ] Outbound HTTPS (port 443) to the providers is allowed
- [ ] TLS ends in front of a public deployment
- [ ] `npm run build && npm run typecheck && npm test` pass

| Network | Address Prefix | Blockfrost Project Prefix (only with Blockfrost) |
|---------|---------------|--------------------------|
| `mainnet` | `addr1...` | `mainnetXXX` |
| `preview` | `addr_test1...` | `previewXXX` |
| `preprod` | `addr_test1...` | `preprodXXX` |

---

## Environment Configuration

A setting is an environment variable, or a key of `cds.requires.odatano-core` in a CAP project. The key
wins over the variable.

### Core Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NETWORK` | `preview` | `mainnet`, `preview` or `preprod` |
| `BACKENDS` | `koios` | Comma-separated: `koios`, `ogmios`, `blockfrost`, `odatano`. The order has no effect; [Backend Configuration](BACKEND_CONFIGURATION.md) says which backend answers what |
| `NODE_ENV` | `development` | `production` selects HANA and XSUAA (profile `[production]` in `package.json`) |
| `PORT` | `4004` | HTTP port |
| `DEBUG` | none | Comma-separated `cds.log` module names that log at debug level |

### API Keys

| Variable | Required | Description |
|----------|----------|-------------|
| `KOIOS_API_KEY` | No | Token that raises the public rate limit of Koios |
| `BLOCKFROST_API_KEY` | With `blockfrost` | Project id; its prefix has to match `NETWORK` |
| `OGMIOS_URL` | With `ogmios` | WebSocket URL |
| `ODATANO_URL`, `ODATANO_API_KEY` | With `odatano` | The other ODATANO and its gateway key. The URL is required on mainnet |

### Timeouts & Caching

| Variable | Default | `prod.mtaext.example` | Description |
|----------|---------|-----------|-------------|
| `PRIMARY_TIMEOUT_MS` | `30000` | `8000` | Time limit of one call to Ogmios or Blockfrost, and of one HTTP request to Koios |
| `FALLBACK_TIMEOUT_MS` | `60000` | `10000` | Time limit of one call to Koios or to another ODATANO |
| `INDEX_TTL_MS` | `3600000` | `600000` | How long a stored temporal row, such as an address or an account, is served before a backend is asked again |

### Optional Features

All three are off by default. The [Crawler Guide](CRAWLER_GUIDE.md) describes the crawler, the
[User Guide](USER_GUIDE.md) the wallet worker and agent grants; the [Security Guide](SECURITY_GUIDE.md#hsm-pkcs11-integration) describes the HSM.

```.env
# HSM signing
HSM_ENABLED=false
HSM_PKCS11_MODULE=                # required when enabled
HSM_PIN=                          # required when enabled; from a credential store, never in a file
HSM_REQUIRES_ROLE=                # required when enabled; the role a caller needs for the HSM actions
HSM_SLOT=0
HSM_KEY_LABEL=                    # label of the key, or HSM_KEY_ID

# Chain crawler
CRAWLER_ENABLED=false
CRAWLER_START_SLOT=               # required when enabled
CRAWLER_START_HASH=               # required when enabled
CRAWLER_START_HEIGHT=
CRAWLER_SOURCE=auto               # ogmios | pagination | auto
CRAWLER_CONFIRMATION_DEPTH=3
CRAWLER_BATCH_SIZE=20
CRAWLER_POLL_INTERVAL_MS=20000

# Wallet worker
WALLET_WORKER_ENABLED=false
ENCRYPTION_KEY=                   # required in production when a software key is given as iv:authTag:ciphertext
WALLET_WORKER_WALLETS=            # [{"walletId":"treasury","signerType":"hsm","requiresRole":"Treasurer"}]
WALLET_WORKER_MAX_CONCURRENT=4
WALLET_WORKER_CONFIRMATION_DEPTH=3
WALLET_WORKER_CONFIRMATION_TIMEOUT_MS=600000
WALLET_WORKER_POLL_INTERVAL_MS=2000
WALLET_WORKER_MAX_ATTEMPTS=3
WALLET_WORKER_RESUBMIT_ON_ROLLBACK=true
```

The crawler and the wallet worker run all the time once enabled and call the backends on their own
schedule. Count that into the rate limit and the cost of a provider. Chain-sync needs `ogmios` in
`BACKENDS`; a reachable Ogmios alone is not enough.

---

## SAP BTP Cloud Foundry Deployment

### Prerequisites

- SAP BTP account with Cloud Foundry enabled
- SAP HANA Cloud instance
- CLI tools: `cf` and `mbt` (MTA Build Tool)

### BTP Architecture

```
BTP Cloud Foundry
├── odatano-srv             CAP service with the seven OData services under /odata/v4/
├── odatano                 AppRouter: XSUAA login, routes to the service and to the wallet app
├── odatano-db-deployer     deploys the schema into the HDI container
├── odatano-app-deployer    uploads the wallet app (odatanoviewwallet.zip) to the HTML5 repository
└── Services
    ├── odatano-auth             XSUAA, created from xs-security.json
    ├── odatano-db               HANA HDI container
    ├── odatano-html5-repo-host  HTML5 repository, plan app-host
    └── odatano-html5-runtime    HTML5 repository, plan app-runtime
```

### mta.yaml

- The build runs `npm ci`, `cds-typer`, `tsc -p tsconfig.build.json`, `cds build --production` and
  `scripts/build/gen-srv-package.js`, in this order. `tsc` must come first: the module runs compiled
  JavaScript, and `gen-srv-package.js` refuses a build whose sources have no compiled twin.
- `gen-srv-package.js` writes the module's `package.json` with `@sap/cds`, the HANA adapter and
  `@sap/xssec` at the versions of the root `package-lock.json`, the root `overrides`, the optional
  `pkcs11js` and Node.js `^22.5.0 || ^24.0.0`. It writes a lockfile, and the module installs with
  `npm ci --omit=dev`.
- The build task (`.cdsrc.json`) is `nodejs`. It copies neither the root lockfile nor `.cdsrc.json` into
  `gen/srv`.
- `odatano-srv` runs one instance with the properties `NETWORK: preview`, `BACKENDS: koios` and
  `HSM_ENABLED: false`. It sets no memory and no disk size, so the defaults of the platform apply.
- The AppRouter gets 256M memory and 256M disk.

### xs-security.json

Scopes and role templates are shown under [xs-security.json](SECURITY_GUIDE.md#xs-securityjson) in the
Security Guide.

### Approuter Configuration (xs-app.json)

`app/router/xs-app.json` has three routes. All of them require an XSUAA login. The two routes to the
service set `csrfProtection: true`. The welcome page is `/odatanoviewwallet/index.html`.

| Path | Goes to |
|------|---------|
| `/odata/...` | the service (`srv-api`) |
| `/odatanoviewwallet/...` | the HTML5 repository |
| everything else | the service (`srv-api`) |

> **HTML5 repository names.** The repository removes dots from application names. The wallet app has the id
> `odatanoview.wallet` (`app/wallet/webapp/manifest.json`) and is served as `odatanoviewwallet`. The
> routes and the welcome page have to use the name without the dot, or the welcome page answers 503.

### Build & Deploy

```bash
# from the repository root; on Windows inside WSL, mbt does not build on native Windows or MSYS
npm ci && mbt build

cf login -a https://api.cf.<region>.hana.ondemand.com
cf deploy mta_archives/odatano_<version>.mtar -e prod.mtaext
```

`<version>` is `version:` of `mta.yaml`. Keep it equal to `package.json`; `npm version` does not change
`mta.yaml`.

### Environment Variables (`odatano-srv`)

`mta.yaml` sets `NETWORK`, `BACKENDS` and `HSM_ENABLED` as properties of the module. It holds no keys,
because it is committed. There are two ways to supply values.

**Extension descriptor (`prod.mtaext`).** It survives a redeploy and keeps secrets out of git.

1. Copy the template and fill in the values:
   ```bash
   cp prod.mtaext.example prod.mtaext   # prod.mtaext is git-ignored
   ```
2. Deploy with `-e prod.mtaext`. Its values replace the properties of `mta.yaml`.

`extends:` in the descriptor has to be the `ID:` of `mta.yaml` (`odatano`), and the module name has to be
`odatano-srv`.

**`cf set-env`.** For a single change. The next `cf deploy` overwrites it with the properties of `mta.yaml`.

```bash
cf set-env odatano-srv KOIOS_API_KEY "yourKoiosTokenHere"
cf set-env odatano-srv NETWORK "mainnet"
cf restage odatano-srv
```

### Important BTP Files

| File | Purpose |
|------|---------|
| `mta.yaml` | Multi-target application descriptor |
| `prod.mtaext.example` | Template for the values set at deploy time |
| `prod.mtaext` | Your copy with the real values, git-ignored |
| `xs-security.json` | XSUAA scopes and role templates |
| `app/router/xs-app.json` | Routes of the AppRouter |
| `app/wallet/xs-app.json` | Routes of the wallet app, part of its ZIP |
| `app/wallet/ui5.yaml` | UI5 build; `additionalFiles` has to list `xs-app.json` |

### Useful CF Commands

```bash
cf apps                          # state of the applications
cf logs odatano-srv --recent     # recent log
cf logs odatano-srv              # live log
cf services                      # service instances
cf set-env <app> <VAR> "<val>"   # set a variable
cf restart <app>                 # restart without restaging
cf restage <app>                 # restage with the new environment
cf html5-list                    # applications in the HTML5 repository (HTML5 plugin)
```

---

## Database Configuration

### Which database for what

| Database | Use | State |
|---|---|---|
| SQLite | Development, and a single instance without the crawler | The default. One connection, so one transaction at a time; a read that waits for a backend holds none. `Decimal` values above 2^53 lose precision (see "SQLite precision" in the User Guide). |
| PostgreSQL | The crawler, the crawler-fed UTxO set, the backfills, the wallet worker, several instances | The database the crawler and the UTxO set are operated on, on preview, preprod and mainnet. |
| SAP HANA | The BTP deployment (`NODE_ENV=production`): reads with lazy indexing, transaction building, signing | The crawler, the UTxO set, the backfills, the wallet worker and agent grants have not been tested on HANA. The secondary indexes ODATANO creates at start are skipped there. |

### SQLite (Development / Docker)

```json
{ "cds": { "requires": { "db": { "kind": "sqlite", "credentials": { "url": "db.sqlite" } } } } }
```

### PostgreSQL

The Docker image connects with `ODATANO_DB_URL`; see [Database](DOCKER_DEPLOYMENT.md#database) in the
Docker guide. A CAP project that uses the plugin configures `@cap-js/postgres` as its `db`.

### SAP HANA (Production / BTP)

Selected by `NODE_ENV=production` through `.cdsrc.json` of this repository. The npm package carries no
database or login configuration; a project that uses the plugin sets its own.

```json
{
  "cds": {
    "requires": {
      "[production]": {
        "db": {
          "kind": "hana",
          "pool": { "acquireTimeoutMillis": 30000, "min": 0, "max": 10 }
        },
        "auth": "xsuaa"
      }
    }
  }
}
```

The module `odatano-db-deployer` of `mta.yaml` deploys the schema into the HDI container. A container
created by 1.x is not migrated; [Upgrading to 2.0](UPGRADE_2.0.md#database) has the steps for a new one.

---

## Performance Tuning

### Timeouts

A request that fails over waits for each backend in turn. Its worst case is the sum of the time limits of
the backends it tries. Lower `PRIMARY_TIMEOUT_MS` and `FALLBACK_TIMEOUT_MS` for a faster failover;
`prod.mtaext.example` uses 8 and 10 seconds.

### Cache TTL

`INDEX_TTL_MS` is the time a stored temporal row is served before a backend is asked again:

```env
INDEX_TTL_MS=60000      # 1 minute, close to live
INDEX_TTL_MS=600000     # 10 minutes, the value of prod.mtaext.example
INDEX_TTL_MS=3600000    # 1 hour, the default
```

Blocks and transactions do not change on chain. They are stored once and do not expire.

### Resource Limits

- `mta.yaml` runs one instance of `odatano-srv` and sets no memory size.
- SQLite serves one instance. Several instances need PostgreSQL; see the table above for what is tested
  on HANA.

---

## Health Monitoring

Both probes answer without credentials and carry no secrets. Point a load balancer or an upstream gateway
at them, not at a service document: that one needs a login.

| Endpoint | Method | Answer |
|----------|--------|--------|
| `/odata/v4/cardano-indexer/getLiveness()` | GET | 200 `{ status: "alive", timestamp, uptime, version, network }` while the process runs. No backend and no database is asked |
| `/odata/v4/cardano-indexer/getReadiness()` | GET | 200 `{ status: "ready", timestamp, context, database, hsm }`, or 503 with `status: "not_ready"` while the app context, the database or a configured HSM is missing. `hsm` is `null` without an HSM |

The state of crawler, worker and backends needs a login: `getStatus()`, `GetWorkerStatus()`,
`GetNetworkInformation`.

---

## Mainnet Considerations

With `NETWORK=mainnet`:

- Addresses have to start with `addr1` and stake addresses with `stake1`.
- Koios is asked at `api.koios.rest`. A Blockfrost key needs the prefix `mainnet`.
- Ogmios has to be connected to a mainnet node.
- The `odatano` backend needs `ODATANO_URL`.

The [Security Guide](SECURITY_GUIDE.md) covers logins, roles and signing keys. The
[Docker guide](DOCKER_DEPLOYMENT.md#schema-changes-at-start) says what a schema change costs on a large
database.

---

## Troubleshooting

### Service Fails to Start

The log line `Failed to initialize blockchain components` names the cause: a setting that is refused, an
invalid key or a backend that cannot be reached. The process keeps running and its requests answer 503.

```bash
docker compose logs -f odatano          # Docker
cf logs odatano-srv --recent            # BTP

# are the providers reachable?
curl -s https://api.koios.rest/api/v1/tip
curl -s -H "project_id: $BLOCKFROST_API_KEY" https://cardano-mainnet.blockfrost.io/api/v0/health   # only with Blockfrost
```

### "SqlError: Could not find table or view"

The schema is not deployed.

- **BTP:** check the deployer with `cf logs odatano-db-deployer --recent`.
- **Docker:** the image deploys the schema at every start. Look for `schema deploy failed` in the log of
  the container, and check that `ODATANO_DB_DEPLOY` is not `never`.
- **Plugin:** run `node node_modules/@odatano/core/scripts/deploy-schema.mjs`. A plain `cds deploy` drops
  and recreates every table of a SQLite database.

### "All backends failed" (503)

No configured backend answered. Check each one:

```bash
curl https://api.koios.rest/api/v1/tip
curl -H "project_id: $BLOCKFROST_API_KEY" https://cardano-mainnet.blockfrost.io/api/v0/blocks/latest   # only with Blockfrost
curl http://localhost:1337/health
```

Check outbound HTTPS from inside the container:

```bash
docker exec odatano-service wget -q -O- https://api.koios.rest/api/v1/tip
```

### Blockfrost 403 / "Invalid project"

The prefix of the key does not match `NETWORK`: `mainnet` needs `mainnetXXX`, `preview` needs `previewXXX`.

### BTP: 503 for the Wallet App

A route uses the application id with its dot. See "HTML5 repository names" above. `cf html5-list` shows
the names the repository serves.

### BTP: 500 "Application does not have xs-app.json"

`xs-app.json` is missing from the ZIP of the wallet app. `app/wallet/ui5.yaml` has to list it:

```yaml
builder:
  customTasks:
    - name: ui5-task-zipper
      afterTask: generateVersionInfo
      configuration:
        archiveName: odatanoviewwallet
        additionalFiles:
          - xs-app.json
```

### MTA Build Fails on Windows

`mbt build` does not work on native Windows or MSYS. Build inside WSL; see [Build & Deploy](#build--deploy).

### Slow Responses

1. The first read of an entity asks a backend. Later reads come from the database.
2. A slow backend delays the failover: lower `PRIMARY_TIMEOUT_MS`.
3. A higher `INDEX_TTL_MS` asks the backends less often.
4. Check the state of the providers, for Blockfrost at [status.blockfrost.io](https://status.blockfrost.io).

### Port 4004 Already in Use

Set another port with `PORT`, for example `PORT=4005 npm start`.

---

## Additional Resources

- [Quick Start](../QUICK_START.md): first setup
- [User Guide](USER_GUIDE.md): API, wallet worker, agent grants
- [Crawler Guide](CRAWLER_GUIDE.md): the chain crawler and its backfills
- [Backend Configuration](BACKEND_CONFIGURATION.md): which backend answers what
- [Transaction Workflow](TRANSACTION_WORKFLOW.md): build, sign, submit
- [Security Guide](SECURITY_GUIDE.md): logins, roles, signing keys
- [Docker Deployment](DOCKER_DEPLOYMENT.md): image, compose stack, schema changes
- [SAP Integration Examples](SAP_INTEGRATION_EXAMPLES.md): calling the services from SAP systems
