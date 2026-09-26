# Backend Configuration Guide

**Version:** v2.0.0-rc.x | **Last Updated:** September 2026

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

### Live Backend first (Ogmios)
Used for **current state** and **transaction submission**; Blockfrost/Koios are the fallback:
- `getProtocolParameters()` - Current protocol parameters
- `submitTransaction(cbor)` - Transaction submission
- `getLatestBlock()`, `getLatestEpoch()`, `getCurrentSlot()`, `isUtxoUnspent()` - Tip state
- `getAccount(stakeAddress)` - Reward balance, pool and DRep delegation. Ogmios reports no
  controlled amount and no withdrawal totals (`'0'`); see "Crawled data before the backend"
  in the User Guide for the crawled replacement.
- `getPool(poolId)` - Pool parameters and live stake. Ogmios reports no block counts
  (`blocksEpoch` null) and no active stake.

### Historical Backends first (Blockfrost/Koios)
Used for **indexed/historical data**; Ogmios answers only where noted:
- `getBlock(hash)`, `getTransaction(hash)`, `getTransactionMetadata(hash)`,
  `getAddressTransactions(address)`, `getAddress(address)`, `getAssetInfo(unit)` - not on Ogmios
- `getAddressUtxos(address)` - Ogmios answers from the ledger as a fallback
- `getEpoch(epoch)` - Ogmios answers the current epoch only
- `getNetworkInformation()` - Ogmios answers from `queryLedgerState/treasuryAndReserves`:
  treasury, reserves and total supply (max − reserves); circulating, locked and stake totals
  stay `'0'`. The providers come first because they report circulation.
- `getDrep(drepId)` - DRep information. Ogmios (≥ 6.4) serves this too via the live
  ledger state as a fallback: only *registered* DReps are found (a retired DRep is a
  404, never `retired: true`), `expired` is derived from the mandate epoch and
  `lastActiveEpoch` is 0.

If multiple historical backends are configured, they are tried in order with automatic failover.

### Output references from the node ledger
When Ogmios is configured, the transaction builder resolves output references that are not
among the sender's UTxOs (the Plutus script UTxO, `forceInputs`, `referenceInputs`) with one
`queryLedgerState/utxo` lookup by reference: an absent output is unknown or already spent and
is rejected with a 400. Without Ogmios, or when the lookup fails, it fetches the producing
transaction and checks the address's live UTxOs, as before.

### Capabilities Only One Backend Has

Some operations are not routed with failover at all, because only one backend can serve them
correctly. They fail with `ProviderUnavailableError` when that backend is not configured:

| Operation | Backend | Why |
|---|---|---|
| `GetUTxOsByCredential` | Koios | Native `POST /credential_utxos`. Blockfrost has no credential-keyed endpoint; a fallback would silently miss bech32 variants of the same payment credential. |
| Transaction-builder script evaluation | Ogmios | Only `evaluateTransaction` gives script execution units for Plutus builds. |
| Crawler epoch snapshots (`CRAWLER_EPOCH_SNAPSHOTS`) | Koios | Needs the full pool/DRep set: `/pool_list` + batched `POST /pool_info` (and the DRep equivalents) turn a mainnet snapshot into ~100 requests. Blockfrost lists pool ids but has no batch info endpoint, so the same snapshot would be thousands of single requests — the snapshots log a warning and stay off instead. Koios answers with the set as it is *now*, so snapshots are only taken while the crawl is at the chain tip. |
| Crawler UTxO set import, `importUtxoSet` with `source: ogmios` | Ogmios | Acquires the node's ledger state at the crawler cursor (`acquireLedgerState` + whole-set `queryLedgerState/utxo`); the point must be within the node's volatile window, i.e. the crawl at the tip. No provider offers a whole-set dump. Mainnet: use `source: file` with a `cardano-cli query utxo --whole-utxo` dump instead. The per-block maintenance itself works on every source. |
| Certificate backfill, `backfillCertificates` | Ogmios | Replays the crawled range over a second chain-sync stream and writes only `TransactionCertificates` / `TransactionWithdrawals`. The pagination backends would need a request per block for the same range. |
| Crawler certificates (`CRAWLER_CERTIFICATES`) | Ogmios chain-sync or Koios | Certificates and withdrawals are block content on both: chain-sync delivers them decoded, Koios returns them in the same `/tx_info` call the crawl already makes. Blockfrost has no per-block variant (six extra requests per transaction), so on a Blockfrost-only crawl `TransactionCertificates` / `TransactionWithdrawals` stay empty and a warning is logged once. |

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
