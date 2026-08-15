# Backend Configuration Guide

**Version:** v2.0.0-rc.2 | **Last Updated:** August 2026

## Architecture Overview

ODATANO uses a **Multi-Backend Architecture** that intelligently routes requests between providers:

![alt text](<../assets/architecture & flow diagramms/backendconfig-ad.png>)

## How Backend Selection Works

The `BACKENDS` environment variable specifies which backends are **available**. The CardanoClient then automatically assigns them based on their capabilities:

| Backend | Role | Used For |
|---------|------|----------|
| **Ogmios** | Live Backend | UTxOs, Protocol Params, TX Submit |
| **Blockfrost** | Historical Backend | Blocks, Transactions, Metadata |
| **Koios** | Historical Backend (Fallback) | Same as Blockfrost |

```
BACKENDS=ogmios,blockfrost,koios
         │       │          │
         │       └──────────┴─── historicalBackends[] (Blockfrost primary, Koios fallback)
         │
         └─── liveBackend (Ogmios)
```

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Network: mainnet, preview, or preprod
NETWORK=preview

# BACKENDS: Choose from "ogmios,blockfrost,koios", "ogmios,blockfrost", "ogmios,koios", "blockfrost,koios", or "koios"
BACKENDS=ogmios,blockfrost

# Ogmios Configuration (required if using Ogmios)
OGMIOS_URL=ws://localhost:1337

# Blockfrost Configuration (required if using Blockfrost)
BLOCKFROST_API_KEY=your_blockfrost_key_here

# Transaction builder is Buildooor only — TX_BUILDERS is no longer needed (any value is ignored)

# Timeouts
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=8000
```

### Self-Hosted Blockfrost-Compatible Backends

Blockfrost is also exposed as a wire-compatible interface by several self-hosted
projects. ODATANO supports redirecting the Blockfrost backend at one of these via
`BLOCKFROST_CUSTOM_BACKEND` (env) or `blockfrostCustomBackend` (cds.requires):

| Project | Typical URL | Notes |
|---|---|---|
| Dolos (MiniBF) | `http://localhost:3010/api/v0` | Lightweight Cardano data node from txpipe. Requires a non-empty `project_id` header — ODATANO sends `self-hosted` when no key is configured. |
| Demeter Self-Hosted | `https://blockfrost-<project>.demeter.run/api/v0` | Use the per-project URL from the Demeter dashboard; `BLOCKFROST_API_KEY` may still be required by your tier. |

When `BLOCKFROST_CUSTOM_BACKEND` is set, ODATANO points the underlying
`@blockfrost/blockfrost-js` SDK at that URL; `BLOCKFROST_API_KEY` becomes optional.
If both are set, the URL controls routing and the key is sent as the `project_id`
header. Startup logs include `Blockfrost will use customBackend: <url>`.

Do not include a trailing slash in the URL — the SDK concatenates paths and a
trailing slash produces doubled slashes that some servers (Dolos in particular)
reject as 404.

## Routing Logic

The CardanoClient routes each operation to the appropriate backend type:

### Live Backend (Ogmios)
Used for **current state** and **transaction submission**:
- `getProtocolParameters()` - Current protocol parameters (M2)
- `getAddressUtxos(address)` - Current UTxO set (M2 transaction building)
- `submitTransaction(cbor)` - Transaction submission (M2)
- `getAddress(address)` - Address with current UTxOs
- `getAccount(stakeAddress)` - Current rewards/delegation
- `getPool(poolId)` - Live pool state
- `getNetworkInformation()` - Network constants

### Historical Backends (Blockfrost/Koios)
Used for **indexed/historical data**:
- `getBlock(hash)` - Block data
- `getTransaction(hash)` - Transaction details
- `getTransactionMetadata(hash)` - Transaction metadata
- `getDrep(drepId)` - DRep information

If multiple historical backends are configured, they are tried in order with automatic failover.

### Fallback Behavior
- If Ogmios is unavailable, historical backends handle live queries too
- Historical backends failover: Blockfrost → Koios (in configured order)
- If Blockfrost fails, falls back to Koios (if both configured)
- Timeout settings: Primary 30s (`PRIMARY_TIMEOUT_MS`), Fallback 60s (`FALLBACK_TIMEOUT_MS`)

## Benefits

- **Self-Hosted Critical Operations** - TX submission via your node
- **Fast Live Queries** - 10-50ms via Ogmios
- **Complete History** - Via Blockfrost/Koios
- **Automatic Failover** - CardanoClient handles retries

## Cost Comparison

| Setup | Storage | API Costs | TX Submit | M2 Transaction Building |
|-------|---------|-----------|-----------|------------------------|
| Ogmios + Blockfrost | ~10GB | Blockfrost fallback only | Self-hosted | Optimal |
| Blockfrost Only | 0GB | All queries | External API | Good |
| Koios Only | 0GB | None (free) | External API | Good |
| Ogmios Only | ~10GB | None | Self-hosted | Good (no history queries) |

**Recommendation:** `BACKENDS=ogmios,koios` offers the best balance

### Benefits Breakdown

**Ogmios + Koios (Recommended):**
- Fast transaction building (50-200ms protocol params from Ogmios)
- Self-hosted transaction submission (full control)
- Complete historical data (via Koios fallback)
- Automatic failover (Koios if Ogmios down)
- Lower Costs (Koios is free, Ogmios requires self-hosted node)

**Blockfrost Only (Simple Setup):**
- Quick setup (no node required)
- Transaction building works
- External transaction submission
- Higher API costs (all queries to Blockfrost)

**Koios Only (Zero Cost):**
- Completely free
- Transaction building works
- Rate limits with high traffic (no paid tier)
- External transaction submission
