![alt text](docs/assets/odatano_logo/logo_odatano_white.png)

# Enterprise OData Services for the Cardano Blockchain

Funded by [Cardano Catalyst Fund 14](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk) — all four milestones completed and approved (April 2026).

**ODATANO** is an SAP CAP–based service that exposes the Cardano blockchain via a standardized **OData V4** interface, enabling enterprise-grade read and write access with native transaction building.

[![Tests](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/ODATANO/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/ODATANO)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)]()
[![CAP](https://img.shields.io/badge/SAP%20CAP-9.x-blue)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@odatano/core)](https://www.npmjs.com/package/@odatano/core)

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
        "backends": ["blockfrost"],
        "blockfrostApiKey": "preview_your_api_key_here",
        "blockfrostCustomBackend": "",
        "txBuilders": ["buildooor"]
      }
    }
  }
}
```

```bash
cds deploy --to sqlite 
cds serve
```

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

Or with Docker:

```bash
docker-compose up -d
```

Service available at `http://localhost:4004`. See [Quick Start Guide](docs/QUICK_START.md) for full details.

## Dev Mode: Mocked Authentication

> **Heads-up.** `cds serve` uses CAP's mocked auth: `@requires: 'authenticated-user'` accepts any Basic-Auth header against a mock user (`alice`, `bob`, …) — passwords are not checked. Anonymous requests get 401, but anyone reaching the port can authenticate.
>
> Production needs the `[production]` profile (`NODE_ENV=production`), which switches to `auth: xsuaa`. Don't expose a dev-mode instance. See the [Security Guide](docs/guides/SECURITY_GUIDE.md#authentication-xsuaa).

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
- **Project Lead**: Max Weber (max@maxalexweber.de)
