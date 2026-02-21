# Backend Configuration Guide

## Architecture Overview

ODATANO uses a **Multi-Backend Architecture** that intelligently routes requests between providers:

```
┌────────────────────────────────────────────┐
│          ODATANO Application               │
└────────────────────────────────────────────┘
                  │
         ┌────────┴─────────┐
         │  CardanoClient   │
         │ (Orchestrator)   │
         └────────┬─────────┘
                  │
      ┌───────────┴──────────┐
      │                      │
┌─────▼──────┐    ┌─────────▼────────┐
│  Ogmios    │    │  Blockfrost/     │
│  Backend   │    │  Koios Backend   │
└────────────┘    └──────────────────┘
      │                      │
┌─────▼──────┐    ┌─────────▼────────┐
│ LIVE DATA  │    │ HISTORICAL DATA  │
│            │    │                  │
│ • Protocol │    │ • Blocks         │
│   Params   │    │ • Transactions   │
│ • UTxOs    │    │ • Metadata       │
│ • Epoch    │    │ • DReps          │
│ • Pools    │    │                  │
│ • Accounts │    │                  │
│ • TX Submit│    │                  │
└────────────┘    └──────────────────┘
```

## How Backend Selection Works

The `BACKENDS` environment variable specifies which backends are **available**. The CardanoClient then automatically assigns them based on their capabilities:

| Backend | Role | Used For |
|---------|------|----------|
| **Ogmios** | Live Backend | UTxOs, Protocol Params, TX Submit |
| **Blockfrost** | Historical Backend | Blocks, Transactions, Metadata |
| **Koios** | Historical Backend (Fallback) | Same as Blockfrost |

**Important:** This is NOT a simple failover chain. The CardanoClient routes requests to the appropriate backend type:

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

# Backend Selection
# Specifies AVAILABLE backends - CardanoClient assigns roles automatically:
#   - ogmios → liveBackend (if present)
#   - blockfrost, koios → historicalBackends[] (in order listed)
#
# Examples:
#   - "ogmios,blockfrost" → Ogmios for live, Blockfrost for historical
#   - "ogmios,blockfrost,koios" → Ogmios for live, Blockfrost+Koios for historical
#   - "blockfrost,koios" → No live backend, Blockfrost primary + Koios fallback
#   - "koios" → Koios only (default)
BACKENDS=ogmios,blockfrost

# Ogmios Configuration (required if using Ogmios)
OGMIOS_URL=ws://localhost:1337

# Blockfrost Configuration (required if using Blockfrost)
BLOCKFROST_KEY=your_blockfrost_project_id_here

# Transaction Builders (M2)
# Options: csl, buildooor, or both (comma-separated)
# Default: csl,buildooor
TX_BUILDERS=csl,buildooor

# Timeouts
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=8000
```

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
- Timeout settings: Primary 8s, Fallback 10s

## Benefits

- **Self-Hosted Critical Operations** - TX submission via your node
- **Fast Live Queries** - 10-50ms via Ogmios
- **Complete History** - Via Blockfrost/Koios
- **Automatic Failover** - CardanoClient handles retries

## Configuration Examples

### Recommended: Ogmios + Blockfrost (M2 Optimal)
```bash
BACKENDS=ogmios,blockfrost
OGMIOS_URL=ws://localhost:1337
BLOCKFROST_KEY=your_key_here
TX_BUILDERS=csl,buildooor
```
- **Best for M2 transaction building**
- Live protocol parameters via Ogmios
- Fast UTxO queries for transaction construction
- Self-hosted transaction submission
- Historical data fallback via Blockfrost

### Ogmios Only (Limited Historical Data)
```bash
BACKENDS=ogmios
OGMIOS_URL=ws://localhost:1337
TX_BUILDERS=csl,buildooor
```
- Transaction building works
- Transaction submission works
- Block/Transaction history queries may fail
- No fallback if Ogmios is down

### Blockfrost Only (No Self-Hosted Node)
```bash
BACKENDS=blockfrost
BLOCKFROST_KEY=your_key_here
TX_BUILDERS=csl,buildooor
```
- All queries work
- Transaction building works
- No local node needed (simplest setup)
- Transaction submission via external API
- Higher API costs

### Koios Only (Free, No API Key)
```bash
BACKENDS=koios
TX_BUILDERS=csl,buildooor
```
- All queries work
- Transaction building works
- Free (no API key needed)
- Rate limits apply (10 req/sec)
- Transaction submission via external API

### Multi-Backend Fallback Chain
```bash
BACKENDS=ogmios,blockfrost,koios
OGMIOS_URL=ws://localhost:1337
BLOCKFROST_KEY=your_key_here
TX_BUILDERS=csl,buildooor
```
- Maximum redundancy
- Ogmios -> Blockfrost -> Koios failover
- Best uptime guarantee
- More complex configuration

## Docker Compose Example

```yaml
services:
  cardano-node:
    image: ghcr.io/intersectmbo/cardano-node:10.1.3
    volumes:
      - cardano-preview-db:/data
      - cardano-preview-ipc:/ipc
      - ./config/preview/cardano-node:/config
    command: run --config /config/config.json --topology /config/topology.json

  ogmios:
    image: cardanosolutions/ogmios:v6.14.0
    ports:
      - "1337:1337"
    volumes:
      - cardano-preview-ipc:/ipc
    depends_on:
      - cardano-node

  odatano:
    build: .
    ports:
      - "4004:4004"
    environment:
      NETWORK: preview
      BACKENDS: ogmios,blockfrost
      OGMIOS_URL: ws://ogmios:1337
      BLOCKFROST_KEY: ${BLOCKFROST_KEY}
      TX_BUILDERS: csl,buildooor
      INDEX_TTL_MS: 600000
    depends_on:
      - ogmios
```

## Migration Guide

### From Blockfrost-Only to Ogmios + Blockfrost

1. Start Cardano Node + Ogmios containers:
   ```bash
   # Using docker-compose (recommended)
   docker-compose up -d cardano-node ogmios

   # Or manually
   docker run -d --name cardano-node-preview \
     -v cardano-preview-db:/data \
     -v cardano-preview-ipc:/ipc \
     ghcr.io/intersectmbo/cardano-node:10.1.3

   docker run -d --name ogmios-preview \
     -p 1337:1337 \
     -v cardano-preview-ipc:/ipc \
     cardanosolutions/ogmios:v6.14.0
   ```

2. Wait for Node to sync (this may take hours for first sync):
   ```bash
   curl http://localhost:1337/health | jq .networkSynchronization
   # Wait until > 0.95 (95% synced)
   ```

3. Update `.env`:
   ```bash
   BACKENDS=ogmios,blockfrost
   OGMIOS_URL=ws://localhost:1337
   BLOCKFROST_KEY=your_existing_key
   TX_BUILDERS=csl,buildooor
   ```

4. Restart ODATANO - no code changes needed!

## Cost Comparison

| Setup | Storage | API Costs | TX Submit | M2 Transaction Building |
|-------|---------|-----------|-----------|------------------------|
| Ogmios + Blockfrost | ~10GB | Blockfrost fallback only | Self-hosted | Optimal |
| Blockfrost Only | 0GB | All queries | External API | Good |
| Koios Only | 0GB | None (free) | External API | Good |
| Ogmios Only | ~10GB | None | Self-hosted | Good (no history queries) |

**Recommendation:** `BACKENDS=ogmios,blockfrost` offers the best balance

### Benefits Breakdown

**Ogmios + Blockfrost (Recommended):**
- Fast transaction building (50-200ms protocol params from Ogmios)
- Self-hosted transaction submission (full control)
- Complete historical data (via Blockfrost fallback)
- Automatic failover (Blockfrost if Ogmios down)
- Lower Blockfrost costs (only used for historical queries)

**Blockfrost Only (Simple Setup):**
- Quick setup (no node required)
- Transaction building works
- External transaction submission
- Higher API costs (all queries to Blockfrost)

**Koios Only (Zero Cost):**
- Completely free
- Transaction building works
- Rate limits (10 req/sec)
- External transaction submission
