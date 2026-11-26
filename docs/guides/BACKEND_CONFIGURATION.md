# Backend Configuration Guide

**Version:** v2.0.0-rc.x

## Architecture Overview

ODATANO reads the chain through one or more backends. It sends each call to the backend that serves it
best and falls back to the others.

![Backend architecture](<../assets/architecture & flow diagramms/backendconfig-ad.png>)

## How Backend Selection Works

`BACKENDS` lists the backends that are available. The client assigns them by what they can do:

| Backend | Role | Used For |
|---------|------|----------|
| **Ogmios** | Live backend | UTxOs, protocol parameters, transaction submit |
| **Koios** | Historical backend, the default | Blocks, transactions, metadata. No account needed, a token is optional |
| **Blockfrost** | Historical backend | Same as Koios. Needs an API key or a self-hosted compatible node |
| **odatano** | Historical backend | Another ODATANO instance, for example the public API (`api.<network>.odatano.dev`). Takes the place of Koios and Blockfrost |

```
BACKENDS=ogmios,koios,blockfrost
         │       │     │
         │       └─────┴─── historicalBackends[] (fixed order: Blockfrost, Koios, odatano)
         │
         └─── liveBackend (Ogmios)
```

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Network: mainnet, preview, or preprod
NETWORK=preview

# BACKENDS: any combination of ogmios, koios, blockfrost, odatano (default: koios)
BACKENDS=ogmios,koios

# Ogmios URL (needed with ogmios in BACKENDS)
OGMIOS_URL=ws://localhost:1337

# Koios token (optional): works without on the public tier, a token raises the rate limit
# KOIOS_API_KEY=your_koios_token

# Blockfrost key (only with blockfrost in BACKENDS)
# BLOCKFROST_API_KEY=your_blockfrost_key_here

# Timeouts in milliseconds (defaults shown)
PRIMARY_TIMEOUT_MS=30000
FALLBACK_TIMEOUT_MS=60000

# PostgreSQL: statement timeout of API reads, 0 = off (crawler, backfills and worker have none)
READ_TIMEOUT_MS=15000
```

A CAP project sets the same values as keys of `cds.requires.odatano-core`. The
[Quick Start](../QUICK_START.md) lists the keys.

### Another ODATANO as backend (`odatano`)

An ODATANO without a provider account can use another ODATANO instance as its backend, for example the
public API:

```bash
BACKENDS=odatano                  # or ogmios,odatano with a local node for live state
ODATANO_API_KEY=oda_…             # API key of the gateway
# ODATANO_URL=https://…           # default: https://api.preview.odatano.dev / https://api.preprod.odatano.dev; required on mainnet
```

```jsonc
"odatano-core": { "backends": ["odatano"], "odatanoApiKey": "oda_…", "odatanoUrl": "https://…" }
```

- The backend calls the `CardanoBackendService` of the remote instance (`/odata/v4/cardano-backend/`). That
  service answers in the shape of a provider. Reads, the crawler's pagination, epoch snapshots,
  `GetUTxOsByCredential`, Plutus script evaluation and submit all work through it.
- Each call costs one unit on the gateway. The backend keeps the units the gateway reports as left in
  `unitsLeft`.
- Stored transactions carry the phase-2 flag (`spendsCollaterals`) but no `totalCollateral`. Their mint is
  left to the reader, which derives it from inputs and outputs.
- `GetNextBlocks` serves the stored parent hash of each block, null when it is unknown. Where two stored
  blocks share a height and the store cannot tell which follows, it answers 503.
- `IsRewardAccountRegistered(stakeAddress)` answers true, false or null from the remote's own sources.
- `GetAccount` answers its addresses as `{ address }` objects, the form every earlier version reads.

Every ODATANO offers this service:

- It needs the role `Read`. `EvaluateTransaction` and `SubmitTransaction` need `Transact` as well.
- An agent token may call the reads and `EvaluateTransaction`. `SubmitTransaction` must be on the allow
  list of the grant.
- Stored blocks and transactions come from the instance's index. Everything else goes through its own
  backends and crawled data, as in the read service.

### Self-Hosted Blockfrost-Compatible Backends

Several self-hosted projects speak the Blockfrost interface. `BLOCKFROST_CUSTOM_BACKEND`, or
`blockfrostCustomBackend` in `cds.requires.odatano-core`, points the Blockfrost backend at one of them:

| Project | Typical URL | Notes |
|---|---|---|
| Dolos (MiniBF) | `http://localhost:3010/api/v0` | Data node from txpipe. It requires a non-empty `project_id` header; ODATANO sends `self-hosted` when no key is configured. |
| Demeter Self-Hosted | `https://blockfrost-<project>.demeter.run/api/v0` | Use the URL of your project from the Demeter dashboard. Your tier may still require `BLOCKFROST_API_KEY`. |

- With `BLOCKFROST_CUSTOM_BACKEND` set, `BLOCKFROST_API_KEY` is optional.
- If both are set, requests go to the URL and the key is sent as the `project_id` header.
- The start log shows `Blockfrost will use customBackend: <url>`.
- Leave out a trailing slash. The SDK appends paths, and a doubled slash is a 404 on some servers, Dolos
  among them.

## Routing Logic

The client routes each operation to one kind of backend first.

### Live Backend first (Ogmios)

For current state and transaction submit. The providers (Koios, Blockfrost) are the fallback.

- `getProtocolParameters()`: current protocol parameters
- `submitTransaction(cbor)`: transaction submit. A refusal by the node is final
- `getLatestBlock()`, `getLatestEpoch()`, `getCurrentSlot()`, `isUtxoUnspent()`: state at the tip
- `getAccount(stakeAddress)`: reward balance, pool and DRep delegation, and the account's addresses
  without their UTxOs. Ogmios reports no controlled amount, no withdrawal, reserve or treasury totals and no
  lifetime rewards; those fields are null; [Crawled data before the backend](CRAWLER_GUIDE.md#crawled-data-before-the-backend) in the Crawler Guide describes
  the crawled replacement. For an account without a pool delegation Ogmios reports no balance, and the
  providers are asked.
- `getPool(poolId)`: pool parameters and live stake. Ogmios reports no block counts, no saturation and no
  active stake; those fields are null.
- `getAddress(address)`: UTxOs and balance from the ledger at the tip. Type, script flag and stake address
  are decoded from the address. `type` is `base`, `enterprise`, `pointer`, `reward` or `byron`; Blockfrost
  reports `shelley` or `byron`. An address without UTxOs is an empty address, not a 404.
- `getAddressUtxos(address)`: UTxOs from the ledger at the tip
- `getDrep(drepId)`: stake, deposit and mandate from `delegateRepresentatives`. Ogmios has no last
  activity (`lastActiveEpoch` is 0) and derives `expired` from the mandate epoch. A DRep the ledger no
  longer lists (retired) is looked up at the providers.

Transactions the crawler reads over Ogmios chain-sync:

- `Transactions.size` needs the transaction bytes. Ogmios sends them only when it is started with
  `--include-transaction-cbor`; without the flag `size` is null. The flag makes every chain-sync frame
  larger.
- `Transactions.deposit` is derived from the transaction's inputs, withdrawals, outputs, fee and
  treasury donation. It is null for a transaction with certificates or proposals while one of its
  spent inputs is not indexed (an output created before the crawl start).

### Historical Backends first (Koios/Blockfrost)

For indexed and historical data. Ogmios answers only where noted.

- `getBlock(hash)`, `getTransaction(hash)`, `getTransactionMetadata(hash)`,
  `getAddressTransactions(address)`, `getAssetInfo(unit)`: not on Ogmios
- `getEpoch(epoch)`: Ogmios answers the current epoch only
- `getNetworkInformation()`: the providers come first because they report circulation. Ogmios answers
  from `queryLedgerState/treasuryAndReserves`: treasury, reserves and total supply (max − reserves).
  Circulating, locked and stake totals stay `'0'` there.

Several historical backends are tried in a fixed order: Blockfrost, Koios, then another ODATANO. The order
in `BACKENDS` does not matter.

### Output references from the node ledger

Some output references are not among the sender's UTxOs: the Plutus script UTxO, `forceInputs`,
`referenceInputs`.

- With Ogmios the transaction builder resolves them with one `queryLedgerState/utxo` lookup by reference.
  An output the ledger does not hold is unknown or already spent, and the build is rejected with a 400.
- Without Ogmios, or when the lookup fails, the builder fetches the producing transaction and checks the
  live UTxOs of the address.

### Pool names and tickers

A pool registers the URL and the hash of a small metadata file with its name, ticker, homepage and
description. Koios and Blockfrost deliver these four fields. Ogmios delivers the URL and the hash only,
so with Ogmios as the backend that answers `Pools` the fields stay empty unless ODATANO loads the file:

```bash
POOL_METADATA_FETCH=true          # or "poolMetadataFetch": true in cds.requires.odatano-core
```

- The file is loaded when a pool is read and its cached row has expired, at most once per hash and process.
- It is used only when its bytes hash (blake2b-256) to the registered hash, it has at most 512 bytes and
  its fields keep the limits: name up to 50 characters, description up to 255, ticker 3 to 5.
- The request goes to a host the pool operator chose. ODATANO sends it over http or https only, follows at
  most five redirects, gives up after 3 seconds and refuses every address that is not public (loopback,
  private, link-local and similar ranges), for the first host and for every redirect.
- `Pools.metadataUrl` and `Pools.metadataHash` are filled with or without the switch.

### Capabilities Only One Backend Has

Some operations have no failover, because only certain backends can serve them. They fail with
`ProviderUnavailableError` when such a backend is not configured, unless the row says otherwise.

| Operation | Backend | Why |
|---|---|---|
| `GetUTxOsByCredential` | Koios, another ODATANO, or the crawled UTxO set | Koios has `POST /credential_utxos`. Blockfrost has no endpoint keyed by credential, and a fallback would miss other bech32 addresses of the same payment credential. With an active, synced crawler UTxO set (`CRAWLER_UTXO_SET`) Koios is not needed: the addresses of the credential come from `LedgerAddresses`, their outputs from Ogmios at the tip, or from the crawled set without Ogmios. |
| Script evaluation for Plutus builds | Ogmios or another ODATANO | The node's `evaluateTransaction` gives the execution units. Without one of the two the build does not fail: the builder evaluates the scripts itself and adds a buffer. |
| Crawler epoch snapshots (`CRAWLER_EPOCH_SNAPSHOTS`) | Ogmios or Koios | Needs the full set of pools and DReps. Ogmios, preferred, reads it from the node's ledger at the crawled block (`stakePools`, `stakePoolsPerformances`, `delegateRepresentatives`, `treasuryAndReserves`). That works while the block is within the node's last k blocks. Koios uses `/pool_list` and batched `POST /pool_info` plus the DRep equivalents, about 100 requests on mainnet. It answers with the set as it is now, so the crawl must be at the chain tip. Blockfrost lists pool ids but has no batch info endpoint. Without Ogmios or Koios the snapshots log a warning and stay off. |
| Token registry fill, `backfillAssetRegistry` | Koios, or no backend with `source: file` | The CIP-26 registry is off-chain. Koios lists it whole (`asset_token_registry`); Blockfrost has no list endpoint. With `source: file` the entries come from a checkout of the registry repository on the server. |
| Crawler account snapshots (`CRAWLER_ACCOUNT_SNAPSHOTS`) | Ogmios | Reads the reward accounts from the node's ledger at the snapshot block (`rewardAccountSummaries`, 2000 accounts per request, one acquired ledger state). The node lists an account delegated to a pool or a DRep, and Ogmios 7.0 reports the balance only with a pool delegation. No provider serves accounts as of a block. |
| Crawler UTxO set import, `importUtxoSet` with `source: ogmios` | Ogmios | Acquires the node's ledger state at the crawler cursor (`acquireLedgerState` and a whole-set `queryLedgerState/utxo`). The point must be within the node's volatile window, so the crawl has to be at the tip. No provider offers a whole-set dump. On mainnet use `source: file` with a `cardano-cli query utxo --whole-utxo` dump. The per-block maintenance works on every source. |
| Transaction backfill, `backfillTransactions` | Ogmios | Replays the crawled range over a second chain-sync stream. It fills empty input fields (outpoint, datum, address) and empty datum and reference-script fields of stored outputs, and writes `TransactionRedeemers` and `TransactionDatums`. |
| Output datum repair, `backfillOutputDatums` | Koios, Blockfrost or a remote ODATANO | Reads again, in batches, the transactions whose stored outputs hold a datum hash and no inline datum. Ogmios serves no transaction by hash; with Ogmios only, `backfillTransactions` fills the same fields from the node. |
| Certificate backfill, `backfillCertificates` | Ogmios | Replays the crawled range over a second chain-sync stream and writes only `TransactionCertificates` and `TransactionWithdrawals`. The pagination backends would need a request per block for the same range. |
| Crawler certificates (`CRAWLER_CERTIFICATES`) | Ogmios chain-sync or Koios | Certificates and withdrawals are block content on both: chain-sync delivers them decoded, Koios returns them in the `/tx_info` call the crawl already makes. Blockfrost has no per-block variant (six extra requests per transaction). On a Blockfrost-only crawl the two tables stay empty and a warning is logged once. |

### Fallback Behavior

- If Ogmios is unavailable, the historical backends answer the live queries too.
- Historical backends fail over in the fixed order Blockfrost, Koios, another ODATANO.
- The timeout belongs to the backend: Ogmios and Blockfrost get `PRIMARY_TIMEOUT_MS` (30 s), Koios and
  another ODATANO `FALLBACK_TIMEOUT_MS` (60 s). A call that times out is aborted.
- A refused key (401, 402, 403) and a rate limit (429) count as an outage: the next backend is asked, and
  the circuit breaker counts the failure. Any other 4xx is a verdict and ends the call; it is not a failure.
- `submitTransaction` stops at the first verdict. All backends submit to the same ledger.
- A block whose transaction list comes back shorter than its `txCount` is refused (503), and the crawler
  reads it again.
- Whether a reward account is registered: a node answer decides. Otherwise the providers are asked; a
  404 there means not registered. When no source can tell, the build continues and the node decides.
- A figure a backend does not report is null, not 0.

## Choosing a Setup

| `BACKENDS` | Needs | Limits |
|---|---|---|
| `ogmios,koios` | A synced cardano-node with Ogmios | None of the ones below. Live state and submit run on your node, history comes from Koios |
| `koios` (default) | Nothing | The public tier has a rate limit; `KOIOS_API_KEY` raises it. Submit goes through Koios. No node confirms the execution units of a script |
| `blockfrost` | An API key, or a self-hosted compatible node | Submit goes through Blockfrost. The operations above that name Koios or Ogmios are missing |
| `ogmios` | A synced cardano-node with Ogmios | No blocks, transactions or metadata by hash, no asset information, no transactions of an address, unless the chain crawler has stored them. Pool names need `POOL_METADATA_FETCH` |

With your own node use `ogmios,koios`. Without one, `koios` works with no setup.
