# ODATANO Production Deployment Guide

**Version:** v1.0 | **Last Updated:** March 2026
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

- [ ] `NETWORK` set to target network (`mainnet`, `preview`, `preprod`)
- [ ] `BACKENDS` specifies at least one provider
- [ ] `BLOCKFROST_API_KEY` set and matching the target network prefix (`mainnetXXX`, `previewXXX`, `preprodXXX`)
- [ ] `TX_BUILDERS` configured (`csl`, `buildooor`, or both)
- [ ] `NODE_ENV=production` set
- [ ] Outbound HTTPS (port 443) to blockchain APIs is allowed
- [ ] If using Ogmios: Cardano Node fully synced, WebSocket reachable
- [ ] TLS/SSL termination configured for public-facing deployments
- [ ] Build passes: `npm run build && npm run typecheck && npm test`

| Network | Address Prefix | Blockfrost Project Prefix |
|---------|---------------|--------------------------|
| `mainnet` | `addr1...` | `mainnetXXX` |
| `preview` | `addr_test1...` | `previewXXX` |
| `preprod` | `addr_test1...` | `preprodXXX` |

---

## Environment Configuration

### Core Variables

| Variable | Required | Default | Production | Description |
|----------|----------|---------|-----------|-------------|
| `NETWORK` | Yes | `preview` | `mainnet` | Target Cardano network |
| `BACKENDS` | Yes | `koios` | `ogmios,koios` | Comma-separated backend providers (order = priority) |
| `NODE_ENV` | Yes | `development` | `production` | Activates HANA + XSUAA profiles |
| `TX_BUILDERS` | Yes | `buildooor` | `buildooor` | Transaction builder engines |
| `PORT` | No | `4004` | `4004` | HTTP server port |
| `LOG_LEVEL` | No | `info` | `info` | `error`, `warn`, `info`, `debug` |

### API Keys

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOCKFROST_API_KEY` | If using Blockfrost | Project ID (must match `NETWORK`) |
| `KOIOS_API_KEY` | No | Bearer token for higher rate limits |
| `OGMIOS_URL` | If using Ogmios | WebSocket URL |

### Timeouts & Caching

| Variable | Default | Production | Description |
|----------|---------|-----------|-------------|
| `PRIMARY_TIMEOUT_MS` | `30000` | `8000` | Primary backend timeout |
| `FALLBACK_TIMEOUT_MS` | `60000` | `10000` | Fallback backend timeout |
| `INDEX_TTL_MS` | `3600000` | `600000` | Cache TTL for temporal entities (addresses, accounts) |

### Production .env Template

```.env
NETWORK=mainnet
NODE_ENV=production
PORT=4004
LOG_LEVEL=info
BACKENDS=blockfrost,koios
BLOCKFROST_API_KEY=mainnetYourApiKeyHere
KOIOS_API_KEY=yourKoiosApiKeyHere
TX_BUILDERS=buildooor
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=10000
INDEX_TTL_MS=600000
```

---
## SAP BTP Cloud Foundry Deployment

### Prerequisites

- SAP BTP account with Cloud Foundry enabled
- SAP HANA Cloud instance provisioned
- CLI tools: `cf`, `mbt` (MTA Build Tool)

### BTP Architecture

```
BTP Cloud Foundry
├── odatano-srv (CAP Node.js Backend)
│   ├── CardanoODataService
│   ├── CardanoTransactionService
│   └── CardanoSignService
│
├── odatano-db-deployer (HDI Container Deployment)
│   └── Deploys schema to HANA Cloud
│
├── odatano (Approuter)
│   ├── Authentication (XSUAA)
│   ├── Routing to srv-api
│   └── Routing to HTML5 Apps
│
├── odatano-html5-repo-host
│   └── wallet.zip
│
└── Services
    ├── odatano-db (HANA Cloud HDI)
    ├── odatano-auth (XSUAA)
    ├── odatano-destination-service
    └── odatano-html5-repo-runtime
```

### mta.yaml (Key Modules)

```yaml
_schema-version: 3.3.0
ID: odatano
version: 1.0.0

build-parameters:
  before-all:
    - builder: custom
      commands:
        - npm ci
        - npx cds build --production --ws-pack

modules:
  - name: odatano-srv
    type: nodejs
    path: gen/srv
    parameters:
      instances: 1
      memory: 512M
      buildpack: nodejs_buildpack
    requires:
      - name: odatano-auth
      - name: odatano-db

  - name: odatano-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: odatano-db

resources:
  - name: odatano-auth
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json

  - name: odatano-db
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared
```

### xs-security.json

```json
{
  "scopes": [
    { "name": "$XSAPPNAME.Read", "description": "Read Cardano blockchain data" },
    { "name": "$XSAPPNAME.Transact", "description": "Build and submit Cardano transactions" },
    { "name": "$XSAPPNAME.Sign", "description": "Sign transactions and manage HSM" }
  ],
  "role-templates": [
    { "name": "CardanoReader", "description": "Read Cardano blockchain data", "scope-references": ["$XSAPPNAME.Read"] },
    { "name": "CardanoUser", "description": "Full access to Cardano services", "scope-references": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign"] }
  ],
  "authorities": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign"]
}
```

### Approuter Configuration (xs-app.json)

```json
{
  "welcomeFile": "/odatanoviewwallet/index.html",
  "authenticationMethod": "route",
  "routes": [
    {
      "source": "^/odata/(.*)$",
      "target": "/odata/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": true
    },
    {
      "source": "^/odatanoviewwallet/(.*)$",
      "target": "/odatanoviewwallet/$1",
      "service": "html5-apps-repo-rt",
      "authenticationType": "xsuaa"
    },
    {
      "source": "^/(.*)$",
      "target": "$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": true
    }
  ]
}
```

> **HTML5 Repo naming:** The HTML5 Application Repository removes dots from app names. The wallet app's `sap.app.id` (`manifest.json`) is `odatanoview.wallet`, so it is served under `odatanoviewwallet` in routes and `welcomeFile`. The dotted name must NOT appear in `app/router/xs-app.json` — a mismatch makes the welcome redirect 503.

### Build & Deploy

```bash
# Build from the repo root. On Windows, run mbt build in WSL — it does not
# work on native Windows/MSYS. The repo lives on the C: drive, mounted at /mnt/c:
cd /mnt/c/Users/<you>/ODATANO/ODATANO && npm ci && mbt build
```

> The mtar version comes from `version:` in `mta.yaml` — keep it in sync with `package.json` on each release (`npm version` does NOT update `mta.yaml`).

**Deploy:**

```bash
# Login
cf login -a https://api.cf.<region>.hana.ondemand.com

# Deploy MTA (filename matches the version in mta.yaml)
cf deploy mta_archives/odatano_1.7.10.mtar

# Set blockchain env vars
cf set-env odatano-srv NETWORK "mainnet"
cf set-env odatano-srv BACKENDS "blockfrost,koios"
cf set-env odatano-srv BLOCKFROST_API_KEY "mainnetYourKeyHere"
cf set-env odatano-srv TX_BUILDERS "buildooor"
cf set-env odatano-srv PRIMARY_TIMEOUT_MS "8000"
cf set-env odatano-srv FALLBACK_TIMEOUT_MS "10000"
cf set-env odatano-srv INDEX_TTL_MS "600000"

# Restage to apply
cf restage odatano-srv
```

### Important BTP Files

| File | Purpose |
|------|---------|
| `mta.yaml` | Multi-Target Application descriptor |
| `xs-security.json` | XSUAA security configuration |
| `app/router/xs-app.json` | Approuter routing rules |
| `app/wallet/xs-app.json` | HTML5 app routing (included in ZIP) |
| `app/wallet/ui5.yaml` | UI5 build config (must include `xs-app.json` in `additionalFiles`) |

### Useful CF Commands

```bash
cf apps                          # App status
cf logs odatano-srv --recent     # Recent logs
cf logs odatano-srv              # Live logs
cf services                      # List services
cf set-env <app> <VAR> "<val>"   # Set env var
cf restart <app>                 # Restart (no restage)
cf restage <app>                 # Restage with new env
cf html5-list -di odatano-destination-service -u  # List HTML5 apps
```

---

## Database Configuration

### SQLite (Development / Docker)

```json
{ "cds": { "requires": { "db": { "kind": "sqlite", "credentials": { "url": "db.sqlite" } } } } }
```

### SAP HANA (Production / BTP)

Automatically activated when `NODE_ENV=production`:

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

For high-throughput, increase pool: `"min": 2, "max": 20`.

The `odatano-db-deployer` module in `mta.yaml` handles HDI container schema deployment. If you get `SqlError: Could not find table or view`, verify this module deployed successfully (`cf logs odatano-db-deployer --recent`).

---

## Performance Tuning

### Timeout Strategy

| Scenario | `PRIMARY_TIMEOUT_MS` | `FALLBACK_TIMEOUT_MS` |
|----------|---------------------|----------------------|
| Ogmios as primary (local) | `5000` | `8000` |
| Blockfrost as primary (external) | `8000` | `10000` |

**Max request latency** = `PRIMARY_TIMEOUT_MS + (N-1) * FALLBACK_TIMEOUT_MS` where N = number of backends.

### Cache TTL

```env
INDEX_TTL_MS=600000     # 10 min (recommended production)
INDEX_TTL_MS=3600000    # 1 hour (low-change data)
INDEX_TTL_MS=60000      # 1 min (near-real-time)
```

Non-temporal entities (transactions, blocks) are cached permanently — blockchain data is immutable.

### Resource Limits

**Docker:**
```yaml
deploy:
  resources:
    limits:   { memory: 512M, cpus: '1.0' }
    reservations: { memory: 256M, cpus: '0.5' }
```

**BTP Cloud Foundry:**
```yaml
parameters:
  memory: 512M
  disk-quota: 1G
  instances: 1    # Use instances: 2+ with HANA for horizontal scaling
```

> SQLite limits to single-instance. Multi-instance scaling requires HANA.

---

## Health Monitoring

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/odata/v4/cardano-odata/$metadata` | GET | Service health (200 + XML) |
| `/odata/v4/cardano-transaction/$metadata` | GET | Transaction service health (200 + XML) |
| `/odata/v4/cardano-sign/$metadata` | GET | Signing service health (200 + XML) |


## Mainnet Considerations

Setting `NETWORK=mainnet` affects:
- Blockfrost endpoint: `cardano-mainnet.blockfrost.io`
- Address validation: expects `addr1...` / `stake1...` prefixes
- Ogmios must connect to a mainnet-synced node

### Security Best Practices

1. **Private key isolation** — ODATANO never handles private keys. All signing is external.
2. **XSUAA authentication** — Enable `auth: "xsuaa"` in the production profile.
3. **Rate limiting** — Use a reverse proxy in front of ODATANO.
4. **Audit trail** — TransactionBuilds, TransactionSubmissions, SigningRequests entities log all operations.
5. **Network isolation** — Expose only through a reverse proxy or API gateway.

---

## Troubleshooting

### Service Fails to Start

**"Failed to initialize blockchain components"** — Invalid API key or unreachable backend.

```bash
# Docker
docker-compose logs -f odatano

# BTP
cf logs odatano-srv --recent

# Verify Blockfrost key
curl -s -H "project_id: $BLOCKFROST_API_KEY" https://cardano-mainnet.blockfrost.io/api/v0/health
```

### "SqlError: Could not find table or view"

Database schema not deployed. On BTP, ensure the `odatano-db-deployer` module succeeded:

```bash
cf logs odatano-db-deployer --recent
```

For Docker, the schema deploys during image build — rebuild with `docker-compose build --no-cache`.

### "All backends failed" (503)

All configured backends are unreachable. Check each individually:

```bash
curl -H "project_id: $BLOCKFROST_API_KEY" https://cardano-mainnet.blockfrost.io/api/v0/blocks/latest
curl https://api.koios.rest/api/v1/tip
curl http://localhost:1337/health
```

Verify outbound HTTPS (port 443) from the container:
```bash
docker exec odatano-production wget -q -O- https://cardano-mainnet.blockfrost.io/api/v0/health
```

### Blockfrost 403 / "Invalid project"

API key prefix doesn't match `NETWORK`. `mainnet` requires `mainnetXXX`, `preview` requires `previewXXX`.

### BTP: 503 for Wallet Viewer

HTML5 Application Repository removes dots from app names. App ID `odatanoview.walletviewer` → route must use `odatanoviewwalletviewer`.

Diagnose: `cf html5-list -di odatano-destination-service -u`

### BTP: 500 "Application does not have xs-app.json"

`xs-app.json` not included in the wallet ZIP. Add to `additionalFiles` in `app/wallet/ui5.yaml`:

```yaml
builder:
  customTasks:
    - name: ui5-task-zipper
      afterTask: generateVersionInfo
      configuration:
        archiveName: wallet
        additionalFiles:
          - xs-app.json
```

### MTA Build Fails on Windows

Use WSL — `mbt build` doesn't work on Windows/MSYS. See [Build & Deploy](#build--deploy) above.

### Slow Responses

1. First request for an entity: 1-5s (blockchain fetch). Subsequent: near-instant (cache).
2. Lower timeouts for faster failover: `PRIMARY_TIMEOUT_MS=5000`
3. Increase `INDEX_TTL_MS` to reduce re-fetches.
4. Check Blockfrost status: [status.blockfrost.io](https://status.blockfrost.io)

### Port 4004 Already in Use

```bash
# Find the process
lsof -i :4004        # Linux/Mac
netstat -ano | findstr :4004  # Windows

# Or change port
PORT=4005 npm start
```

---

## Additional Resources

- [Quick Start Guide](../QUICK_START.md) — 5-minute setup
- [User Guide](USER_GUIDE.md) — API reference and OData queries
- [Developer Guide](DEVELOPER_GUIDE.md) — Architecture and coding patterns
- [Backend Configuration](BACKEND_CONFIGURATION.md) — Multi-backend details
- [Transaction Workflow](TRANSACTION_WORKFLOW.md) — Build, sign, submit
- [Docker Deployment](DOCKER_DEPLOYMENT.md) — Basic Docker setup
- [SAP Integration Examples](SAP_INTEGRATION_EXAMPLES.md) — Enterprise integration patterns

---