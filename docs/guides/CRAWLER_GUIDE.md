# ODATANO Crawler Guide

**Version:** v2.0.0-rc.x

How to run the chain crawler: its settings, what it stores, the backfills for older rows, the UTxO set,
input assets and the crawled chain as the authority. The API a client calls is in the
[User Guide](USER_GUIDE.md).

## Contents

- [Enable the crawler](#enable-the-crawler)
- [What the crawl fills beyond blocks and transactions](#what-the-crawl-fills-beyond-blocks-and-transactions)
- [Epoch snapshots](#epoch-snapshots)
- [Account snapshots](#account-snapshots)
- [Certificates and withdrawals](#certificates-and-withdrawals)
- [Inputs, redeemers and datums](#inputs-redeemers-and-datums)
- [Backfills](#backfills)
- [Asset decimals and registry fields](#asset-decimals-and-registry-fields)
- [Crawler-fed UTxO set: balances without a provider](#crawler-fed-utxo-set-balances-without-a-provider)
- [Crawled data before the backend](#crawled-data-before-the-backend)
- [Input assets](#input-assets)
- [The crawled chain as the authority](#the-crawled-chain-as-the-authority)

## Enable the crawler

By default ODATANO indexes lazily: it asks a backend when the database misses a row. The crawler reads the
chain forward from a start block and stores `Blocks` and `Transactions` with their inputs, outputs, assets
and metadata. A query on that range is answered from the database.

**Enable it** in the plugin configuration or with the `CRAWLER_*` environment variables:

```jsonc
"cds": { "requires": { "odatano-core": {
  "crawler": {
    "enabled": true,
    "startSlot": 12345678,
    "startBlockHash": "abc...",
    "source": "auto",            // "ogmios" = chain-sync, "pagination" = Blockfrost or Koios, "auto" = chain-sync when available
    "confirmationDepth": 3        // stay this many blocks behind the tip
  }
}}}
```

- The crawler starts with the server and resumes at its cursor after a restart.
- Ogmios chain-sync is the preferred source: it reports rollbacks itself. Pagination over Blockfrost or
  Koios is the fallback.
- With `source: auto`, a crawl on pagination retries chain-sync every 30 seconds and hands over when it
  is usable. That covers a start while Ogmios is not reachable, and a chain-sync stream that cannot be
  reopened during a run. With `source: ogmios` the crawler halts there instead.
- Pagination checks each block's parent hash against the cursor and runs fork recovery on a mismatch.

**Rollbacks.** A chain-sync rollback deletes the blocks above the fork point. The crawler refuses it and
deletes nothing in these cases:

- The node's tip is behind the cursor, for example after its database was restored from an older
  snapshot. The crawler waits for the node: `SyncState.nodeBehindSince` is set, `syncStatus` is `syncing`,
  and the crawled chain does not answer in place of the backends. With `source: auto` it crawls on
  pagination meanwhile. The next chain-sync block clears `nodeBehindSince`.
- The rollback goes to genesis, to a block that is not stored, or more than k blocks deep (2160 on mainnet
  and preprod, 432 on preview). That is an inconsistency, not a fork: `syncStatus` turns `error` with the
  reason in `lastError`. After 5 such refusals in a row the crawler halts; `resumeCrawler` starts it again.

**Epochs.** A crawled epoch row is `final` once the crawl has passed the epoch and its rollback horizon
(3k/f slots: 36 hours on mainnet and preprod, 7.2 hours on preview) has passed. Until then a read asks the
backend again.

Control and status are at `/odata/v4/cardano-indexer/`:

```http
GET  /odata/v4/cardano-indexer/SyncState        # cursor: lastSlot, lastHeight, tip, syncStatus, errors
GET  /odata/v4/cardano-indexer/ReorgLog         # the rollbacks the crawler handled
GET  /odata/v4/cardano-indexer/getStatus()      # run state; source = chain-sync, pagination or null; nodeBehindSince
POST /odata/v4/cardano-indexer/pauseCrawler     # Admin
POST /odata/v4/cardano-indexer/resumeCrawler    # Admin
```

`getStatus()` is a function: call it with GET.

## What the crawl fills beyond blocks and transactions

The crawler also fills the tables an analysis needs:

| Table | What lands there | Default |
|---|---|---|
| `AssetHistory` | every mint and burn in the range, one row per unit and transaction | on |
| `Assets` | one row per native-asset unit seen: policyId, assetNameHex, decoded name, CIP-14 fingerprint, `decimals` from the CIP-68 reference datum for units with label 333 or 444 | on (`bare`) |
| `PoolEpochSnapshots`, `DrepEpochSnapshots`, `EpochLedgerSnapshots` | every pool and DRep once per epoch, plus treasury, reserves and stake totals | off |
| `AccountEpochSnapshots` | the reward accounts the node reports, once per epoch: balance, amount credited, pool, DRep | off |
| `TransactionCertificates`, `TransactionWithdrawals` | every certificate (stake, pool, DRep) and reward withdrawal in the range | off |
| `TransactionRedeemers` | every redeemer: purpose, index, data (CBOR hex), execution units, the redeemed input or minted policy | on with Ogmios chain-sync |
| `TransactionDatums` | every witness-set datum: hash and the original CBOR bytes. Outputs with a datum hash and no inline datum refer to it | on with Ogmios chain-sync |

```jsonc
"crawler": {
  "assetHistory": true,        // mint and burn rows, derived from the block, no backend call
  "assetCatalogue": "bare",    // "off", "bare" (no backend call) or "enrich" (adds registry name, ticker, decimals)
  "assetEnrichRate": 2,        // units per second, "enrich" only
  "epochSnapshots": false,     // pool and DRep snapshots: Ogmios (node ledger) or Koios
  "accountSnapshots": false,   // reward accounts with the epoch snapshot: Ogmios, needs epochSnapshots
  "certificates": false        // certificates and withdrawals: Ogmios chain-sync or Koios, not Blockfrost
}
```

- The two defaults cost no backend call. Both are derived from data the crawler already holds.
- `"enrich"` and `epochSnapshots` ask a backend and are therefore off by default.
- A catalogue row written by the crawl carries what the unit itself encodes. Supply and registry fields
  arrive on the first read of the asset through the API, or continuously with `"enrich"`.
- `assetCatalogue: "off"` and `assetHistory: false` switch both off.

## Epoch snapshots

`epochSnapshots` (`CRAWLER_EPOCH_SNAPSHOTS`, off) needs Ogmios or Koios, the backends that can list every
pool and DRep.

With Ogmios:

- The snapshot of an epoch is read from the node's ledger state at the first crawled block of that epoch.
- It holds the pool parameters, live and active stake, saturation, and the DReps with deposit, mandate and
  delegator count.
- One `EpochLedgerSnapshots` row holds treasury, reserves, total supply, live and active stake, and the
  always-abstain and always-no-confidence stake.
- The node keeps ledger state for its last k blocks only: 2160 on mainnet and preprod, 432 on preview. A
  block further behind the tip is skipped. A later block of the same epoch that is close enough still
  records the snapshot.
- Rows carry `source` (`ogmios`) and `snapshotHash`. The live `Pools` and `Dreps` rows are not touched.
- `liveDelegators` and `blocksEpoch` are not in the ledger state and stay empty. `blocksMinted` is counted
  from crawled blocks when the crawl started at or before Shelley.
- The node's live view has no active stake. `activeStake` of epoch E is the live stake that the snapshot of
  epoch E-1 recorded at its first block. The first Ogmios snapshot therefore leaves it empty.

With Koios alone:

- Koios reports the pool and DRep set as it is now. An epoch is recorded only while the crawl is at the
  chain tip.
- An epoch the crawler passes while it catches up is skipped. It is not filled with today's numbers.

On both:

- Snapshots of a past range cannot be rebuilt. Run the crawler live from the point you care about.
- A reorg removes the snapshots taken at rolled-back blocks, and the epoch is taken again.
- `getStatus().epochSnapshots` shows the source the next snapshot would use and the newest snapshotted
  epoch.

## Account snapshots

`accountSnapshots` (`CRAWLER_ACCOUNT_SNAPSHOTS`, off) adds the reward accounts to the epoch snapshot,
read from the node at the same block. It needs `epochSnapshots` and Ogmios. One row per account and
epoch in `AccountEpochSnapshots`:

| Field | Meaning |
|---|---|
| `withdrawableAmount` | balance of the reward account at the snapshot block |
| `creditedAmount` | what the ledger added since the snapshot of the epoch before: the balance difference plus the withdrawals in between |
| `deposit`, `poolId`, `drepId` | key deposit and the delegations at that block |

The block of an epoch's snapshot is `EpochLedgerSnapshots.accountSnapshotSlot`.

- **Which accounts.** The crawler asks the node about every account it knows: the stake keys of the
  UTxO set (`utxoSet`) and the stake addresses of crawled certificates (`certificates`). With neither
  switched on there is nothing to ask. The node answers for an account that is delegated to a pool or
  to a DRep. A registered account without a delegation gets no row.
- **Balance.** Ogmios 7.0 reports the balance only for an account delegated to a pool. For an account
  delegated to a DRep alone `withdrawableAmount` is empty.
- **Credited amount.** It is the staking reward of the epoch boundary, and also a treasury withdrawal
  or a refunded proposal deposit paid to the account. It needs `certificates`, which stores the
  withdrawals, and the snapshot of the epoch before. It is empty when one of them is missing, when a block
  of the interval was stored without its withdrawals (`Blocks.withdrawalsReported`), and when the result
  would be below zero. The first epoch after the upgrade has it empty, because older blocks carry no
  marker until `backfillCertificates` ran over them.
- **Volume and time.** One row per reported account per epoch, about 1.3 million on mainnet. The node
  is asked in requests of 2000 accounts. 5000 accounts took half a second on preview.
- `getStatus().epochSnapshots` shows `accounts`, `lastAccountEpoch` and `lastAccountCount`.

```http
GET /AccountEpochSnapshots?$filter=stakeAddress eq 'stake1...'&$orderby=epoch desc
```

## Certificates and withdrawals

`certificates` (`CRAWLER_CERTIFICATES`, off) writes:

- one `TransactionCertificates` row per certificate and kind, with `stakeAddress`, `poolId`, `drepId`,
  `deposit` and the retirement `epoch` where the kind carries them
- one `TransactionWithdrawals` row per reward account withdrawn from

The kinds include `stake_registration`, `stake_deregistration`, `pool_delegation`, `vote_delegation`,
`pool_registration`, `pool_retirement`, `drep_registration`, `drep_update` and `drep_retirement`.

- A Conway certificate that delegates stake and vote becomes a `pool_delegation` row and a
  `vote_delegation` row with the same `certIndex`. Ogmios and Koios therefore produce the same rows.
- The knob costs no extra request. Ogmios chain-sync delivers certificates with the block, and Koios
  returns them in the `/tx_info` call the crawl makes anyway.
- Blockfrost has no per-block variant. On a crawl over Blockfrost alone the tables stay empty and the
  crawler logs a warning once.
- The current pool or DRep of a stake key is its newest `pool_delegation` or `vote_delegation` row:

```
GET /odata/v4/cardano/TransactionCertificates?$filter=stakeAddress eq 'stake_test1…' and kind eq 'pool_delegation'&$orderby=tx/slot desc&$top=1
```

## Inputs, redeemers and datums

These need no knob:

- Every `TransactionInputs` row carries the outpoint it consumed (`spentTxHash`, `spentOutputIndex`) and
  the `utxoData` of the spent output: datum hash, inline datum, reference-script hash. A UTxO can be
  followed from the output that created it to the input that spent it.
- `TransactionRedeemers` holds one row per redeemer, keyed `(tx, purpose, redeemerIndex)`. `data` is the
  PlutusData as CBOR hex, `mem` and `steps` are the execution units. A `spend` redeemer names the input it
  unlocks (`spentTxHash`, `spentOutputIndex`), a `mint` redeemer its `policyId`.
- `TransactionDatums` holds one row per witness-set datum, keyed `(tx, dataHash)`. `datum` is the CBOR as
  the transaction carried it.
- An output with `utxo_dataHash` and no inline datum is resolved through the datum the spending
  transaction supplied: `GET /TransactionDatums?$filter=dataHash eq '<hash>'`, or `$expand=datums` on
  `Transactions`.
- Redeemers and datums come with Ogmios chain-sync. A crawl on Blockfrost or Koios leaves both tables
  empty. Koios reports datums as JSON, not as the bytes.

Transaction rows hold the same ledger view whichever source the crawl used:

- Inputs are in ledger order: regular, collateral, reference, each by transaction hash and output index.
- After a failed script (phase 2) a transaction has only its collateral and reference inputs and the
  collateral return. Otherwise it has no collateral return.

`CardanoBackendService` returns stored transactions with `redeemers` and `datums`. An input whose outpoint
is not recorded comes back with `txHash` and `outputIndex` `null`. `GetTransaction` and
`GetTransactionsBatch` then take the transaction from a backend that can serve it.

## Backfills

A backfill completes rows that were stored before a field or a knob existed. All need `Admin` and run
detached. Progress is in `getStatus()` under the key in the last column. It is kept in memory and reads
`none` after a restart.

- Each kind runs once per process at a time. `pruneInputAssetCopies` and `restoreInputAssetCopies` never
  run together, and neither runs while `backfillTransactions` does.
- `cancelMaintenance(run)` stops a running backfill or walk at its next window, page or batch. `run` is the
  `getStatus()` key, for example `metadataBackfill`. What it wrote stays, and the status turns `cancelled`.
  A new start begins again at its first slot or key.
- The walks let other requests through between their steps, also on SQLite.

| Action | Fills | Backend | `getStatus()` key |
|---|---|---|---|
| `backfillCertificates(fromSlot, toSlot)` | `TransactionCertificates` and `TransactionWithdrawals` of blocks crawled without `certificates` | Ogmios | `certificateBackfill` |
| `backfillTransactions(fromSlot, toSlot)` | empty input and output fields, `TransactionRedeemers`, `TransactionDatums`; brings rows to the ledger view | Ogmios | `transactionBackfill` |
| `backfillOutputDatums()` | inline datum and reference script of outputs stored with a datum hash alone | Koios, Blockfrost or another ODATANO | `datumBackfill` |
| `backfillPaymentCredentials()` | `paymentCredential` of rows that lack it | none | `credentialBackfill` |
| `backfillAssetDecimals()` | `Assets.decimals` | none | `decimalsBackfill` |
| `backfillAssetRegistry(source, path)` | the CIP-26 registry fields of `Assets` | Koios, or none with `source: "file"` | `registryBackfill` |
| `backfillMetadataPositions(fromSlot, toSlot)` | `txSeq` of `TransactionMetadata` rows whose position is empty or differs | none | `metadataBackfill` |
| `backfillEpochs()` | block count, transaction count, fees, block times and `final` of crawled epochs | none | `epochBackfill` |
| `backfillAssetSlices()` | policy id, hex name, decoded name and fingerprint of every stored asset row | none | `sliceBackfill` |
| `recheckFailedSubmits()` | `submitted` again for a failed submission or signing request whose transaction is on chain with passing scripts, with a `resolution` note | the crawled chain, then a transaction lookup | `failedRecheck` |

**`backfillCertificates`.** Turn `certificates` on first, so new blocks carry the rows. Then run the
backfill once for the range crawled before:

```
POST /odata/v4/cardano-indexer/backfillCertificates   { "fromSlot": "…", "toSlot": "…" }
GET  /odata/v4/cardano-indexer/getStatus()            # → certificateBackfill.status: running, done or failed
```

- Both slots are optional. `fromSlot` defaults to the crawl start, `toSlot` to the crawler cursor. A
  `toSlot` past the cursor is refused.
- The backfill opens a second Ogmios chain-sync stream. It starts at the newest crawled block below
  `fromSlot` and ends at the first block past `toSlot`.
- It writes `TransactionCertificates` and `TransactionWithdrawals`, keyed like the crawl, and removes the
  rows of a transaction whose script phase failed (`removed`). A repeat changes nothing.
- It marks each block whose transactions all report their withdrawals (`Blocks.withdrawalsReported`), so
  account snapshots derive `creditedAmount` over it.
- A block the database does not hold, for example one rolled back since, is skipped.
- The crawler may keep running. Rows are committed per 200 blocks.
- `getStatus().certificateBackfill` reports the range, `atSlot`, `transactions`, `removed`, counts and
  timestamps.

**`backfillTransactions`.** Same range rules and lifecycle as `backfillCertificates`:

```
POST /odata/v4/cardano-indexer/backfillTransactions   { "fromSlot": "…", "toSlot": "…" }
GET  /odata/v4/cardano-indexer/getStatus()            # → transactionBackfill.status: running, done or failed
```

- It fills empty input fields only: the outpoint, `utxoData`, a missing address with its assets.
- It fills the empty datum and reference-script fields of stored outputs (`transactionBackfill.outputs`).
- It writes `TransactionRedeemers` and `TransactionDatums` (`transactionBackfill.datums`).
- It rewrites rows that an earlier Koios or Blockfrost crawl stored differently to the ledger view. Inputs
  are moved by their outpoint. The regular inputs of a failed script and outputs that were never produced
  are removed (`transactionBackfill.rewritten`).
- A transaction whose stored inputs cannot be matched is left as it is and counted in
  `transactionBackfill.skipped`. That is the case with another count, other flags, another address or
  lovelace amount per position, or no outpoint to move by.

**`backfillOutputDatums`.** An output read through Koios by an earlier version has its `utxo_dataHash` but
an empty `utxo_inlineDatum`, also where the datum is inline. Without Ogmios, this backfill repairs such rows
by reading the transactions again from the backend:

```
POST /odata/v4/cardano-indexer/backfillOutputDatums
GET  /odata/v4/cardano-indexer/getStatus()            # → datumBackfill: status, scanned, candidates, transactions, outputs, inputs, ledgerUtxos
```

- It walks `TransactionOutputs` in key order and reads every transaction that holds an output with a datum
  hash and no inline datum.
- It writes the inline datum and the reference-script fields to the output, to the inputs that spent it and
  to its `LedgerUTxOs` row. Only empty fields change.
- An output whose datum is given by hash alone stays as it is and is read again on a repeat.

**`backfillPaymentCredentials`.** Walks `TransactionOutputs`, `TransactionInputs` and `LedgerUTxOs` once in
key order and decodes the stored address. Rows that carry a credential are left alone, so a repeat changes
nothing. `AddressUTxOs` is a cache and refills itself.

```
POST /odata/v4/cardano-indexer/backfillPaymentCredentials
GET  /odata/v4/cardano-indexer/getStatus()            # → credentialBackfill: status, table, outputs, inputs, ledgerUtxos
```

**`backfillMetadataPositions`.** Walks the stored transactions by slot window and writes `txSeq` to the
metadata rows whose position is empty or differs. `GetMetadataByLabel` returns a row only once it has its
`txSeq`. Both slots are optional and default to the stored range.

```
POST /odata/v4/cardano-indexer/backfillMetadataPositions   { "fromSlot": "…", "toSlot": "…" }
GET  /odata/v4/cardano-indexer/getStatus()            # → metadataBackfill: status, atSlot, toSlot, rows
```

**`backfillAssetSlices`.** Brings every stored asset row to one form: policy id, hex name, decoded name
(null for an asset without a name) and CIP-14 fingerprint. It covers `TransactionOutputAssets`,
`TransactionInputAssetCopies`, `LedgerUTxOAssets`, `LedgerAddressAssets`, `UTxOAssets` and
`AddressAssets`, and changes only rows that differ, so a repeat changes nothing.

```
POST /odata/v4/cardano-indexer/backfillAssetSlices
GET  /odata/v4/cardano-indexer/getStatus()            # → sliceBackfill: status, table, outputs, inputs, ledgerUtxos, ledgerAddresses, utxoSlices, addressSlices
```

`backfillAssetDecimals` and `backfillAssetRegistry` are described in the next section, `backfillEpochs`
under [Crawled data before the backend](#crawled-data-before-the-backend).

## Asset decimals and registry fields

`Assets.decimals` is the number of decimal places of a token.

- For a unit with CIP-68 label 333 or 444 it is the `decimals` field of the reference datum. The datum is
  read from the output that holds the reference NFT in the crawled chain.
- The NFT is followed from its latest mint through the spending transactions, so a metadata update shows
  up. A datum given by hash is taken from `TransactionDatums`.
- For any other unit it is the CIP-26 registry value (`registryDecimals`).
- The crawler sets it when it writes the catalogue row, and again on every block whose outputs carry a
  reference NFT. The lazy path sets it when it writes the row.
- `backfillAssetDecimals` pages the catalogue by unit and fills older rows. A repeat refreshes the values.

```
POST /odata/v4/cardano-indexer/backfillAssetDecimals
GET  /odata/v4/cardano-indexer/getStatus()            # → decimalsBackfill: status, scanned, candidates, filled
```

The CIP-26 registry fields are off-chain data: `registryName`, `registryTicker`, `registryDecimals`,
`registryDescription`, `registryUrl`, `registryLogo`. The lazy path takes them from the backend when it
writes a row. The crawler's catalogue rows carry none. `backfillAssetRegistry` fills them from one of two
sources.

**From the registry's repository** (`source: "file"`):

```bash
# mainnet: cardano-token-registry, folder mappings. preview and preprod: metadata-registry-testnet, folder registry
git clone --depth 1 https://github.com/cardano-foundation/cardano-token-registry /data/token-registry
```
```
POST /odata/v4/cardano-indexer/backfillAssetRegistry
{"source": "file", "path": "/data/token-registry/mappings"}
```

- `path` is a folder the server can read, in the image a mounted volume.
- Every entry file is read once and written to the `Assets` rows of its unit. No backend and no network is
  involved.
- `absent` counts registry units the database has no `Assets` row for. The import does not create rows.
- `skipped` counts entries that describe a script, not an asset.
- Pull the repository and run it again to pick up new entries.

**From Koios** (`source: "koios"`, the default):

```
POST /odata/v4/cardano-indexer/backfillAssetRegistry
```

- It fills every unit the registry lists (Koios `asset_token_registry`), about 8,000 on mainnet.
- Each unit is read from the backend, 4 per second. Every slice of the unit receives the values, `decimals`
  only where it is still empty.
- The crawler may keep running. A repeat refreshes the values.

```
GET  /odata/v4/cardano-indexer/getStatus()            # → registryBackfill: status, units, processed, filled, absent, skipped, failed
```

## Crawler-fed UTxO set: balances without a provider

`utxoSet` (`CRAWLER_UTXO_SET`, off) makes the crawl keep a UTxO set of its own. It lives in separate tables
without a TTL. The provider-fed `Addresses` and `AddressUTxOs` keep their one-hour TTL.

| Table | What lands there |
|---|---|
| `LedgerUTxOs` with `LedgerUTxOAssets` | Every output since the anchor. A row is unspent while `spentTxHash eq null`; `spentTxHash` and `spentSlot` name the spending transaction. `utxo_referenceScriptHash`, `utxo_referenceScriptSize` (bytes) and `utxo_referenceScriptType` (`native`, `plutusV1` to `plutusV3`) describe a reference script on the output |
| `LedgerAddresses` with `LedgerAddressAssets` | Running `totalLovelace`, `utxoCount` and asset balances per address, as of the crawl tip |
| `LedgerAccounts` | `controlledAmount`, `addressCount`, `utxoCount` per stake key, summed over its base addresses |

- With the reference-script fields a consumer can leave such outputs out of its coin selection, or price
  the Conway reference-script fee.
- Delegation stays a query over `TransactionCertificates`, so turn `certificates` on as well.
- Rewards are ledger state and still come from a backend.

The set needs an **anchor**: a one-off import of the UTxO set at a recent block. The node hands out its
UTxO set only for a recent point, never for the start slot of the crawl. The crawler then applies only the
blocks after the anchor. Until the import has run, the knob does nothing and the crawler logs an error at
start.

```
# 1. crawl to the tip, then pause
POST /odata/v4/cardano-indexer/pauseCrawler

# 2a. preview / preprod — acquire the set at the crawler cursor from the box's own node
POST /odata/v4/cardano-indexer/importUtxoSet   { "source": "ogmios" }

# 2b. mainnet — dump with cardano-cli (the whole-set Ogmios query is memory-heavy there)
cardano-cli query tip --mainnet                        # note slot + hash
cardano-cli query utxo --mainnet --whole-utxo --out-file utxo.json
cardano-cli query tip --mainnet                        # same hash? then the anchor is valid
jq -c 'to_entries[]' utxo.json > utxo.ndjson           # streamable, one entry per line
POST /odata/v4/cardano-indexer/importUtxoSet
     { "source": "file", "filePath": "/data/utxo.ndjson", "anchorSlot": "…", "anchorHash": "…" }

# 3. poll until status is "active", then resume
GET  /odata/v4/cardano-indexer/getStatus()             # → utxoSet.status
POST /odata/v4/cardano-indexer/resumeCrawler
```

**Repairing an import**

- The import loads the rows first and derives the sums at the end: `LedgerAddresses`,
  `LedgerAddressAssets`, `LedgerAccounts`.
- If only that last phase fails, rebuild the sums from the loaded rows, crawler paused:
  `importUtxoSet { "source": "aggregates" }`. It uses the stored anchor. A cursor that moved past the
  anchor is set back to it, and the blocks after it are crawled again. It refuses once blocks have been
  applied to the set.
- Rows imported from a dump carry the reference script of their output (hash, size, type) as the dump
  prints it.
- A set imported without those columns is completed in place, crawler paused:
  `importUtxoSet { "source": "scripts", "filePath": "/data/utxo.ndjson" }` reads the same dump again and
  writes only the rows that carry a script. Without `filePath`, the unspent rows that hold a hash but no
  size are asked at the node (Ogmios). The set stays `active` throughout.

**Locks**

- The import refuses to start while the crawler holds its lease, or when the cursor is already past the
  anchor.
- It holds the cursor lease for its whole duration and takes it again inside every write transaction.
  `resumeCrawler` on any instance and a second import wait until it has finished. A takeover stops it
  before the next batch commits.

**Anchor check and reorgs**

- Before the first block after the anchor is applied, the crawler checks that the anchor is exactly the
  block it followed last. That also covers an anchor at the configured start block. A snapshot taken on a
  fork that was dropped invalidates the set.
- A reorg that reaches behind the anchor invalidates the set too (`utxoSet.status = invalid`). Run the
  import again.
- A reorg after the anchor is undone in place. Rows the rolled-back blocks created are dropped, rows they
  spent are reopened, and the address and account sums are taken back by the amounts those blocks added.
  The progress marker follows the cursor back.
- Switching `utxoSet` off while the crawler keeps running leaves the set behind. On the next start with the
  knob on, a cursor ahead of the last applied slot marks the set `invalid`.
- Rows that came with the snapshot carry `createdSlot = null`.

**SQLite precision.** SQLite stores every `Decimal` of this project as a double (`@cap-js/sqlite`). An
amount above 2^53 keeps about 16 significant digits there. In lovelace that is about 9.0 billion ADA, which
only supply totals reach. For a token it is a quantity above 9.007e15 units, a fraction of one token with
18 decimals. This holds for the ledger tables as for `Epochs` and `NetworkInformation`. PostgreSQL and HANA
hold the exact values, and the dump is parsed without loss.

```
GET /odata/v4/cardano/LedgerAddresses('addr_test1…')?$expand=assets
GET /odata/v4/cardano/LedgerUTxOs?$filter=address eq 'addr_test1…' and spentTxHash eq null&$expand=assets
GET /odata/v4/cardano/LedgerAccounts('stake_test1…')?$expand=addresses
```

- The set is as fresh as the crawl: `confirmationDepth` blocks behind the tip. A caller who needs the
  mempool view keeps using `GetUTxOsByAddress`.
- All three sources report whether a script failed (phase 2): Ogmios through `spends`, Blockfrost and Koios
  through `valid_contract` with their collateral inputs and output. A transaction with a failed script
  consumes its collateral and produces only the collateral return, on every path.

## Crawled data before the backend

Some values come from the crawled tables and not from a backend, but only while the crawled data is
complete for them. For a value that depends on the current chain state this needs a live crawler at the
tip: `SyncState.syncStatus` is `synced` and the crawler holds its lease. Otherwise the backend's value
stays.

| Value | From | Condition |
|---|---|---|
| `Pools.blocksEpoch` | crawled `Blocks` of the current epoch with `slotLeader` = the pool | crawler at the tip, crawl started before the epoch |
| `Pools.blocksMinted` | all crawled `Blocks` of the pool | crawler at the tip, crawl started at or before the first Shelley slot |
| `Accounts.controlledAmount` | `LedgerAccounts.controlledAmount` + the reward balance | crawler at the tip, UTxO set `active` |
| `Accounts` → `Address` | `LedgerAddresses` of the stake key with their unspent `LedgerUTxOs`. Also on Ogmios alone, whose account has no address list | crawler at the tip, UTxO set `active` |
| `NetworkInformation.circulatingSupply` | `SyncState.utxoSetLovelace`: the lovelace over the unspent `LedgerUTxOs`, set by the import, moved by every applied or rolled-back block and recomputed at every crawler start before the first block | crawler at the tip, UTxO set `active`, `utxoSetLovelace` not null |
| `GetUTxOsByCredential` | addresses from `LedgerAddresses.paymentCredential`, their unspent `LedgerUTxOs` checked at the node by output reference | crawler at the tip, UTxO set `active`, credential column filled |
| `Addresses`, `GetAddressByBech32`, `GetAssetsByAddress`, `GetUTxOsByAddress` | the unspent `LedgerUTxOs` of the address checked at the node by output reference, balance summed over them, type and stake address decoded from the address | crawler at the tip, UTxO set `active` |
| `GetLatestTransactionsByAddress`, `AddressTransactions` | outputs the address received and spent since the anchor, net amounts per transaction | crawler at the tip, UTxO set `active`; addresses older than the anchor ask a provider when fewer than `limit` crawled transactions exist |
| `Pools.activeStake`, `activeSize` | `PoolEpochSnapshots` of the running epoch (source `ogmios`) | crawler at the tip, backend reports no active stake |
| `Accounts.withdrawalsSum` | sum of `TransactionWithdrawals` | crawler at the tip, certificates crawled since Shelley, backend reports none |
| `Epochs.blockCount`, `txCount`, `fees`, `firstBlockTime`, `lastBlockTime` of crawled epochs | crawled `Blocks` of the epoch | crawl started before the epoch |

**`GetUTxOsByCredential`** needs no Koios this way.

- `LedgerAddresses.paymentCredential` is filled in the background after an import. Until it is complete,
  the action keeps using Koios.
- The node check is a keyed lookup: Ogmios `queryLedgerState/utxo` by output reference. It drops outputs
  spent after the crawler cursor. Without Ogmios the answer is the set as of the cursor.
- Outputs created after the cursor are missing. On chain-sync that is the block being written, on
  pagination the last `confirmationDepth` blocks.
- The node's address query is not used here: it scans the whole UTxO set on every call. That scan is what
  an address read costs on an instance without an active set.

**Epoch totals** let a crawl on Ogmios alone describe its epochs.

- Ogmios serves no past epoch, so the crawler writes the row from its own blocks. Start and end time are
  derived from the slots. `output` and `activeStake` stay empty.
- With a provider, the provider's row is kept and only the totals are replaced.
- The crawler writes the totals when it passes an epoch.
- `backfillEpochs` writes them again for every epoch the crawl covers in full, and creates the row of an
  epoch that has none. It reads the stored blocks only and may be repeated. Requires Admin.

```
POST /odata/v4/cardano-indexer/backfillEpochs
GET  /odata/v4/cardano-indexer/getStatus()            # → epochBackfill: status, atEpoch, toEpoch, updated, created
```

**`Blocks.slotLeader`** is the bech32 id of the pool that produced the block, on every backend. A database
crawled by an earlier version can hold the Ogmios issuer key (64 hex characters) or the Koios VRF key
(`vrf_vk1…`), which the pool counts above do not match. `scripts/migrate-slot-leader.mjs` in the repository
turns those values into one SQL update. It derives the pool id from an issuer key and matches a VRF key
against the registered pools of an Ogmios `stakePools` response:

```bash
psql -Atc "SELECT DISTINCT slotLeader FROM odatano_cardano_Blocks WHERE slotLeader NOT LIKE 'pool1%'" \
  | node scripts/migrate-slot-leader.mjs --stake-pools stake-pools.json > slot-leader.sql
psql -f slot-leader.sql
```

A VRF key of a pool that is no longer registered is listed as unmapped and left as it is.
`--extra-map` takes such values as `<old value> <pool id>` lines.

## Input assets

The assets of a transaction input (`TransactionInputs/assets`, `TransactionInputAssets`) are the assets
of the output it spent. An input reads them from one of two places, never from both:

- a stored copy of them, kept with the input (`TransactionInputAssetCopies`), or
- the spent output itself, which the input points at (`TransactionInputs.spentTxSeq`).

The answer is the same either way; the cost differs:

| | Copy | Reference to the output |
|---|---|---|
| Storage | Every asset of every spent output is stored twice | Stored once |
| Reading one transaction | One lookup | One lookup per input |
| Reading the inputs of many transactions in a row | One contiguous range | One lookup per input, scattered over the chain |

Measured on a mainnet database (PostgreSQL, 1.5 billion copy rows, 402 GB): the input assets of 400
transactions read in 7 to 36 ms from the copies, and in 0.5 to 0.8 s from the outputs when the pages are
not cached. At the tip the difference is small.

What decides which place an input uses:

- **New blocks.** `inputAssetCopies` (`CRAWLER_INPUT_ASSET_COPIES`, off): off points an input at its
  spent output when that output is stored, and keeps a copy otherwise. On keeps a copy for every input.
- **Transactions indexed on demand** and blocks stored by an earlier version have copies.
- **`pruneInputAssetCopies(fromSlot, toSlot, slotWindow)`** (Admin) moves the inputs of a slot range from
  copies to their output.
- **`restoreInputAssetCopies(fromSlot, toSlot, slotWindow)`** (Admin) is the way back: it writes the copies
  again from the outputs.

`pruneInputAssetCopies` in detail:

- The slots are those of the spending transaction, and both are required.
- An input moves only when its spent output is stored and holds exactly the assets of the copy. Then the
  copy is deleted.
- An input is left when its spent output is not stored, such as an output from before the start of the
  crawl, or when the output differs from the copy.
- Progress is in `getStatus().copyPrune`: `referenced` inputs moved, `kept` inputs left as they were,
  `deleted` copy rows. `restoreInputAssetCopies` reports in `getStatus().copyRestore`.

Disk space on PostgreSQL:

- The space of the deleted copies is free once the table is rewritten:
  `VACUUM FULL odatano_cardano_transactioninputassetcopies`, which locks the table while it runs.
- The walk also rewrites every input it moves. Run `VACUUM (PARALLEL 0) odatano_cardano_transactioninputs`
  between slot ranges, so the next range reuses that space. Without it the inputs table and two of its
  indexes grow by the rows rewritten.
- A plain `VACUUM` uses parallel workers on this table and is faster. In a container it needs a `shm_size`
  above `maintenance_work_mem`, else it ends with `could not resize shared memory segment`.

Both walks:

- run on PostgreSQL and SQLite, detached, one transaction per window of slots (`slotWindow`, 20 000 unless
  given). The crawler may keep running.
- report progress once per window. A larger window does not make the walk faster.
- roll back and end when a window would leave an input with copies and a reference.

A consumer that reads long ranges of inputs, such as an analytics job that recomputes history, wants copies
for the range it reads. Older history can be pruned.

## The crawled chain as the authority

With a crawl that started at or before the first Shelley slot and runs at the tip, the database
holds every block and transaction since Shelley. `authoritative` (`CRAWLER_AUTHORITATIVE`, off)
then answers a lookup the database misses with 404 and does not ask Blockfrost or Koios:

| Lookup | Answer from the crawled chain |
|---|---|
| `Blocks`, `GetBlockByHash` | 404 `not in the crawled chain up to slot …` |
| `Transactions`, `GetTransactionByHash` | same |
| `GetMetadataByTxHash` | empty list for a crawled transaction without metadata; 404 for an unknown one |
| `Assets`, `GetAssetInfo` | supply = mints − burns and the mint count from `AssetSupply`, which the crawler keeps per block (computed once at the first crawler start, in the background before the first block; until then the backend answers), first mint (transaction and time), CIP-25 payload (label 721) of the latest mint; registry fields from the stored `Assets` rows (filled by the lazy path or `backfillAssetRegistry`), `decimals` from the CIP-68 reference datum when the chain holds one. 404 for a unit never minted. Needs `assetHistory` crawled since Shelley |
| `GetAssetHistory` | the crawled `AssetHistory` rows, newest first |

- The same answers apply without the knob when no configured backend can serve the lookup at all, as on a
  deployment with Ogmios alone. A miss is then a 404 and not a 503.
- Two gaps remain. Blocks and transactions of the Byron era, on mainnet and preprod before Shelley, are not
  in the database. Neither are those of the last `confirmationDepth` blocks. Both answer 404.

**Notes.** Ogmios needs a synced cardano-node; a
[Mithril](https://docs.cardano.org/developer-resources/scalability-solutions/mithril) bootstrap shortens
the sync. A crawl of the whole mainnet history is large. Start from a recent block unless you need the
history.
