<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/odatano-logo-on-dark.svg">
    <img src="https://cdn.jsdelivr.net/npm/@odatano/brand@1/logos/odatano-logo.svg" alt="ODATANO" height="84">
  </picture>
</p>

# Enterprise OData Services for the Cardano Blockchain

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![npm version](https://img.shields.io/npm/v/@odatano/core?logo=npm)](https://www.npmjs.com/package/@odatano/core)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/core?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/core)
[![License](https://img.shields.io/badge/license-Apache%202.0-yellow)](LICENSE)

**ODATANO** (`@odatano/core`) is an SAP CAP plugin that serves the Cardano blockchain as **OData V4**:
read chain data, build, sign and submit transactions. Funded by
[Cardano Catalyst Fund 14](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk).

## Quick Start

In an SAP CAP project:

```bash
npm install @odatano/core @cap-js/sqlite
```

Add to `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": { "kind": "sqlite" },
      "auth": { "users": { "alice": { "roles": ["Read", "Transact", "Sign"] } } },
      "odatano-core": { "network": "preview", "backends": ["koios"] }
    }
  }
}
```

```bash
cds deploy --to sqlite
cds serve
curl -u alice: http://localhost:4004/odata/v4/cardano/NetworkInformation
```

- **Backend.** Koios needs no account. Ogmios with a local node, Blockfrost and another ODATANO are the
  alternatives: [Backend Configuration](docs/guides/BACKEND_CONFIGURATION.md).
- **Login.** `alice` is a development user of CAP and the password is not checked, so never expose a
  development instance. In production your own authentication assigns the roles `Read`, `Transact`, `Sign` and `Admin`:
  [Security Guide](docs/guides/SECURITY_GUIDE.md).
- **Without a CAP project.** Clone this repository, or start cardano-node, Ogmios and ODATANO with
  `ODATANO_HTTP_PASSWORD=<password> docker compose up -d`: [Quick Start](docs/QUICK_START.md),
  [Docker Deployment](docs/guides/DOCKER_DEPLOYMENT.md).

## Services

| Service | Path | Purpose |
|---|---|---|
| CardanoODataService | `/odata/v4/cardano/` | Read chain data (33 entities, 22 actions) |
| CardanoTransactionService | `/odata/v4/cardano-transaction/` | Build and submit transactions, Plutus included (14 actions) |
| CardanoSignService | `/odata/v4/cardano-sign/` | External signing and HSM (9 actions) |
| CardanoIndexerService | `/odata/v4/cardano-indexer/` | Chain crawler, status and health probes |
| CardanoWorkerService | `/odata/v4/cardano-worker/` | Asynchronous wallet jobs |
| CardanoAgentService | `/odata/v4/cardano-agent/` | Scoped, budgeted tokens for agents |
| CardanoBackendService | `/odata/v4/cardano-backend/` | Chain data for another ODATANO that uses this one as its backend |

The crawler, the wallet worker and agent grants are off until configured. The indexer and the worker also
publish CAP events (`blockIndexed`, `jobConfirmed`), so a CAP application subscribes and does not poll. The
[User Guide](docs/guides/USER_GUIDE.md) and the [Crawler Guide](docs/guides/CRAWLER_GUIDE.md) describe all of it.

## Requirements

- Node.js 22.5 or later and `@sap/cds` 10 (peer dependency). A CAP 9 project cannot load `@odatano/core@2`.
- Coming from 1.x: [Upgrading to 2.0](docs/guides/UPGRADE_2.0.md).

## Documentation

| Guide | Content |
|---|---|
| [Quick Start](docs/QUICK_START.md) | Plugin, standalone and local node setup, first requests |
| [User Guide](docs/guides/USER_GUIDE.md) | Entities, actions, signing, wallet worker, agent grants, events |
| [Crawler Guide](docs/guides/CRAWLER_GUIDE.md) | Chain crawler, snapshots, backfills, UTxO set |
| [Transaction Workflow](docs/guides/TRANSACTION_WORKFLOW.md) | Build, sign and submit, Plutus contracts |
| [Backend Configuration](docs/guides/BACKEND_CONFIGURATION.md) | Koios, Ogmios, Blockfrost, another ODATANO |
| [Security Guide](docs/guides/SECURITY_GUIDE.md) | Authentication, roles, signing, HSM |
| [Docker Deployment](docs/guides/DOCKER_DEPLOYMENT.md) | Image, compose stack, database, health probes |
| [Production Deployment](docs/guides/PRODUCTION_DEPLOYMENT.md) | SAP BTP Cloud Foundry and HANA |
| [SAP Integration Examples](docs/guides/SAP_INTEGRATION_EXAMPLES.md) | Calling the services from S/4HANA and ABAP |
| [Upgrading to 2.0](docs/guides/UPGRADE_2.0.md) | What a 1.x deployment and its clients change |
| [Developer Guide](docs/guides/DEVELOPER_GUIDE.md) | Architecture and development |
| [Changelog](CHANGELOG.md) | Every change by version |

## License

Apache License 2.0, see [LICENSE](LICENSE).

## Support

- **Issues**: [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- **Project Lead**: Max Weber
- **Contact**: info@odatano.dev
