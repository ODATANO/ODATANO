![alt text](docs/assets/odatano_logo/logo_odatano_white.png)

# Enterprise OData Services for the Cardano Blockchain

Funded by [Cardano Catalyst Fund 14](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk) all four milestones completed and approved (April 2026).

**ODATANO** is an SAP CAP–based service that exposes the Cardano blockchain via a standardized **OData V4** interface, enabling enterprise-grade read and write access with native transaction building.

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![npm version](https://img.shields.io/npm/v/@odatano/core?logo=npm)](https://www.npmjs.com/package/@odatano/core)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/core?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/core)
[![License](https://img.shields.io/badge/license-Apache%202.0-yellow)](LICENSE)


## Quick Start

### As CAP Plugin (recommended)

Add ODATANO to any existing SAP CAP project:

```bash
npm install @odatano/core @cap-js/sqlite
```

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "odatano-core": {
        "network": "preview",
        "backends": ["blockfrost"]
      }
    }
  }
}
```

Put your API key in a `.env` file in the project root (loaded automatically by `cds serve` / `cds watch`) — don't commit it to `package.json`:

```bash
# .env
BLOCKFROST_API_KEY=preview_your_api_key_here
```

```bash
cds deploy --to sqlite 
cds serve
```

> Config in `cds.requires.odatano-core` takes precedence over environment
> variables; a `blockfrostApiKey` set there would override the `.env` value.

> **Self-hosted Blockfrost-compatible node?** (Dolos MiniBF, Demeter Self-Hosted)
> Set `blockfrostCustomBackend` to the node's base URL (e.g. `http://localhost:3010/api/v0`).
> When set, `blockfrostApiKey` becomes optional. See the [Backend Configuration Guide](docs/guides/BACKEND_CONFIGURATION.md#self-hosted-blockfrost-compatible-backends).

### Standalone

Run ODATANO as a self-contained service (no host CAP project needed):

```bash
git clone https://github.com/ODATANO/ODATANO && cd ODATANO
npm ci
cp .env.example .env   # set BLOCKFROST_API_KEY, NETWORK, BACKENDS
cds deploy --to sqlite
cds serve
```

Or with Docker — this brings up a local **cardano-node + Ogmios + ODATANO** stack
(Preview), with the service pre-wired to the local Ogmios backend:

```bash
docker compose up -d                      # full stack
docker compose up -d cardano-node ogmios  # just the chain backend (pre-sync)
docker compose logs -f ogmios             # watch sync (/health: 202 syncing, 200 near tip)
```

> First sync from genesis takes hours; the node DB persists in a Docker volume so
> restarts resume. Until Ogmios catches up, historical queries fall back to
> Blockfrost (set `BLOCKFROST_API_KEY`).

Service available at `http://localhost:4004`. See the [Quick Start Guide](docs/QUICK_START.md#local-ogmios--cardano-node-docker) for the local Ogmios stack and full details.

## Dev Mode: Mocked Authentication

> **Heads-up.** `cds serve` uses CAP's mocked auth: `@requires: 'authenticated-user'` accepts any Basic-Auth header against a mock user (`alice`, `bob`, …) — passwords are not checked. Anonymous requests get 401, but anyone reaching the port can authenticate.
>
> Production needs the `[production]` profile (`NODE_ENV=production`), which switches to `auth: xsuaa`. Don't expose a dev-mode instance. See the [Security Guide](docs/guides/SECURITY_GUIDE.md#authentication-xsuaa).

## Services

| Service | Path | Purpose |
|---|---|---|
| CardanoODataService | `/odata/v4/cardano-odata/` | Read blockchain data (20 entities, 19 actions) |
| CardanoTransactionService | `/odata/v4/cardano-transaction/` | Build & submit transactions (13 actions) |
| CardanoSignService | `/odata/v4/cardano-sign/` | External signing + HSM (9 actions) |
| CardanoIndexerService | `/odata/v4/cardano-indexer/` | Chain crawler / pre-sync control (v2.0, off by default) |
| CardanoWorkerService | `/odata/v4/cardano-worker/` | Asynchronous wallet jobs (v2.0, off by default) |
| CardanoAgentService | `/odata/v4/cardano-agent/` | Agent grants: scoped bearer tokens for agents (v2.0, off by default) |

Both v2.0 services also publish **CAP events**, so a consumer can subscribe instead of polling —
in-process, no broker required:

```js
(await cds.connect.to('CardanoWorkerService')).on('jobConfirmed', ({ data }) => …)
(await cds.connect.to('CardanoIndexerService')).on('blockIndexed', ({ data }) => …)
```

## Agent grants (v2.0, off by default)

Hand an agent a **scoped, budgeted token** instead of a user. Design and rationale:
[AGENT_GRANTS_DESIGN.md](AGENT_GRANTS_DESIGN.md).

```bash
AGENT_GRANTS_ENABLED=true            # or cds.requires.odatano-core.agentGrants.enabled
AGENT_GRANTS_DELEGATE=mocked         # CAP auth kind that keeps authenticating non-token requests (default: configured kind)
```

1. An **Admin** issues a grant (`POST /odata/v4/cardano-agent/CreateAgentGrant`): an allow list of
   actions, optionally a worker `walletId` (required for `SubmitWalletJob`/`CancelJob`), allowed job
   kinds, a daily budget and an expiry. The response carries the token `odat_…` **once**; the
   server stores only its SHA-256.
2. The agent sends `x-agent-token: odat_…` on any of the six service paths. It runs as the principal
   `agent:<grantId>` with the single role `agent-grant`, never as the operator: every
   `@requires: 'Admin'` surface (pause/resume, HSM signing, grant administration) refuses it by
   construction. Reads and compute-only actions are always allowed; allow-listed actions each cost
   one budget unit per UTC day (a build is the service an agent buys); everything else is 403.
   Wallet jobs are pinned to the grant's wallet and visible only to the grant that queued them.
3. `GET /odata/v4/cardano-agent/GetGrantStatus()` tells the agent what it may do and how much budget
   is left; `RevokeAgentGrant` turns the token into an unknown token immediately.

Grantable: `Build*`, `SetCollateral`, `CreateSigningRequest`, `VerifySignature`, `Submit*`,
`CheckSubmissionStatus`, `SubmitWalletJob`, `CancelJob`. Never: `SignWithHsm*`, `Pause*`/`Resume*`,
`pauseCrawler`/`resumeCrawler`, grant administration.

Programmatic seams for other packages (`@odatano/x402` sells grants against a 402 payment):
`issueAgentGrant()`, `revokeAgentGrantById()`, `registerTransportLane()` from `@odatano/core`.

## Requirements

- **Node.js >= 22.5** and **@sap/cds >= 10** (peer dependency). CAP 9 hosts cannot load `@odatano/core@2`.
- Upgrading a consumer from 1.x: run **`cds deploy`**. 2.0 adds four tables (`CardanoSyncState`,
  `CardanoReorgLog`, `CardanoWorkerWallets`, `CardanoWalletJobs`) plus a `dedupKey` column; without
  the redeploy the new services answer `no such table` while the old ones keep working.

## Documentation

| Guide | Description |
|-------|-------------|
| [Quick Start](docs/QUICK_START.md) | Get running in 5 minutes |
| [User Guide](docs/guides/USER_GUIDE.md) | API usage, entities, and examples |
| [Developer Guide](docs/guides/DEVELOPER_GUIDE.md) | Architecture and development |
| [Transaction Workflow](docs/guides/TRANSACTION_WORKFLOW.md) | Build → Sign → Submit flow |
| [Security Guide](docs/guides/SECURITY_GUIDE.md) | Authentication, signing security, HSM |
| [Docker Deployment](docs/guides/DOCKER_DEPLOYMENT.md) | Container deployment |

## License

Apache License 2.0 - see [LICENSE](LICENSE)

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Project Lead**: Max Weber
- **Contact**: info@odatano.dev
