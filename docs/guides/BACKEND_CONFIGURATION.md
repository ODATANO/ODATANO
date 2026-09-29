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
| **odatano** | Historical Backend | Another ODATANO instance, e.g. the public API (`api.<network>.odatano.dev`); replaces Blockfrost/Koios |

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

### Another ODATANO as backend (`odatano`)

An ODATANO without its own provider account can use another ODATANO instance as its backend —
typically the public API behind the gateway, which is itself crawled and served from its own node:

```bash
BACKENDS=odatano                  # or ogmios,odatano with a local node for live state
ODATANO_API_KEY=oda_…             # API key of the gateway
# ODATANO_URL=https://…           # default: https://api.preview.odatano.dev / https://api.preprod.odatano.dev; required on mainnet
```

```jsonc
"odatano-core": { "backends": ["odatano"], "odatanoApiKey": "oda_…", "odatanoUrl": "https://…" }
```

The backend speaks the remote instance's `CardanoBackendService` (`/odata/v4/cardano-backend/`),
which answers the provider shape, so every read, the crawler's pagination, epoch snapshots,
`GetUTxOsByCredential`, Plutus script evaluation and submit work as with Koios. Each call costs one
unit on the gateway; `x-access-units-left` is kept on the backend (`unitsLeft`). Stored transactions
come back without the phase-2 flag (`spendsCollaterals`) and `totalCollateral`.

The service is available on every ODATANO (`@requires: 'authenticated-user'`); an agent-grant token
may call its reads and `EvaluateTransaction`, `SubmitTransaction` needs the allow list. Stored blocks
and transactions are served from the instance's index, everything else through its own backends and
crawled data, as the read service does.

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
- `getAddress(address)` - UTxOs and balance from the ledger at the tip; type, script flag and
  stake address decoded from the address (`type` is `base` / `enterprise` / `pointer` /
  `reward` / `byron`, where Blockfrost reports `shelley` / `byron`). An address without UTxOs
  is an empty address, not a 404.
- `getAddressUtxos(address)` - UTxOs from the ledger at the tip
- `getDrep(drepId)` - Stake, deposit and mandate from `delegateRepresentatives`. Ogmios has no
  last activity (`lastActiveEpoch` 0); a DRep the ledger no longer lists (retired) is looked up
  at the providers.

### Historical Backends first (Blockfrost/Koios)
Used for **indexed/historical data**; Ogmios answers only where noted:
- `getBlock(hash)`, `getTransaction(hash)`, `getTransactionMetadata(hash)`,
  `getAddressTransactions(address)`, `getAssetInfo(unit)` - not on Ogmios
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
| `GetUTxOsByCredential` | Koios, another ODATANO, or the crawled UTxO set | Native `POST /credential_utxos`. Blockfrost has no credential-keyed endpoint; a fallback would silently miss bech32 variants of the same payment credential. With an active, synced crawler UTxO set (`CRAWLER_UTXO_SET`) the addresses of the credential come from `LedgerAddresses` and their outputs from Ogmios at the tip (or the crawled set without Ogmios), and Koios is not needed. |
| Transaction-builder script evaluation | Ogmios or another ODATANO | Only `evaluateTransaction` gives script execution units for Plutus builds. |
| Crawler epoch snapshots (`CRAWLER_EPOCH_SNAPSHOTS`) | Ogmios or Koios | Needs the full pool/DRep set. Ogmios (preferred) reads it from the node's ledger at the crawled block (`stakePools`, `stakePoolsPerformances`, `delegateRepresentatives`, `treasuryAndReserves`), which works while the block is within the node's last k blocks. Koios: `/pool_list` + batched `POST /pool_info` (and the DRep equivalents), ~100 requests on mainnet, and only while the crawl is at the chain tip, because Koios answers with the set as it is *now*. Blockfrost lists pool ids but has no batch info endpoint, so without Ogmios or Koios the snapshots log a warning and stay off. |
| Crawler UTxO set import, `importUtxoSet` with `source: ogmios` | Ogmios | Acquires the node's ledger state at the crawler cursor (`acquireLedgerState` + whole-set `queryLedgerState/utxo`); the point must be within the node's volatile window, i.e. the crawl at the tip. No provider offers a whole-set dump. Mainnet: use `source: file` with a `cardano-cli query utxo --whole-utxo` dump instead. The per-block maintenance itself works on every source. |
| Transaction backfill, `backfillTransactions` | Ogmios | Replays the crawled range over a second chain-sync stream; fills empty input fields (outpoint, datum, address) and writes `TransactionRedeemers`. |
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
