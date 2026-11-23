# Indexing

**Version:** v2.0.0-rc.x

ODATANO stores chain data in its database in two ways:

- **On demand.** A read that misses the database fetches the data from a backend and stores it. This is
  the default.
- **By crawler.** An optional crawler stores every block and its transactions ahead of the requests.

Both write the same tables. Once stored, the data answers `$filter`, `$expand`, `$orderby`, `$top` and
`$skip` from the database.

## Temporal and Permanent Data

**Temporal entities** hold state that changes. They use CAP's `temporal` aspect, which adds the key fields
`validFrom` and `validTo`. A read returns the row that is valid now. A stored row is valid for
`INDEX_TTL_MS`, by default one hour. After that the next read fetches the data again and stores a new row;
the old one stays.

| Entity | Content |
|---|---|
| NetworkInformation | Supply and stake totals |
| Pools, Dreps | State of a pool, of a DRep |
| Assets | Supply, mint data and registry fields of a token |
| Addresses, AddressAssets, AddressUTxOs, UTxOAssets | Balance, assets and UTxOs of an address |
| Accounts | Delegation and rewards of a stake address |
| TransactionBuilds | Unsigned transactions built for a caller |

A collection read of `AddressAssets` or `AddressUTxOs` that names the address indexes it on a miss. The
address is named by a `$filter` on `address_address` or by navigation from `Addresses`.

**All other entities** have no `validFrom` and `validTo`, and `INDEX_TTL_MS` does not apply to them. Among
them:

- Blocks, Epochs, Transactions and their inputs, outputs, assets and metadata. An Epochs row is read from
  the backend again until it is `final`: the epoch has ended and no rollback can reach it.
- AssetHistory: mint and burn events, keyed by unit and transaction hash
- The epoch snapshots: one row per pool, DRep and reward account per epoch, and the network figures of
  that epoch
- TransactionSubmissions, SigningRequests and SignatureVerifications. A signing request has its own
  expiry, 30 minutes by default.

`db/schema.cds` has every entity.

## Indexing on Demand

```
GET /Transactions('<hash>')
  1. Look for the row. Found: answer from the database.
  2. Miss: read the transaction from a backend.
  3. Look again, then store it with its inputs, outputs, assets and metadata.
  4. Run the client's query and answer.
```

For a temporal entity, step 1 finds only a row that is still valid. An expired row counts as a miss.

A navigation indexes its parent first: `Transactions('<hash>')/inputs`, `Addresses('<a>')/utxos`,
`Blocks('<hash>')/epoch`, `Accounts('<s>')/Address`, and an input's or output's `address`. `$expand` of
those targets does the same. All backend reads of a navigation run before its first write.

The request transaction holds no database connection while the backend answers. That matters on SQLite,
which has one connection. `indexMissing` in `srv/cardano-service.ts` implements the steps. Each index
method of `CardanoIndexer` has a `fetch` half that reads and a `store` half that writes.

## Crawler

The crawler is off by default. `CRAWLER_ENABLED=true` and a start block switch it on; see the
[Crawler Guide](../guides/CRAWLER_GUIDE.md).

| | On demand | Crawler |
|---|---|---|
| Trigger | A read that misses | Continuous, from the start block on |
| Scope | The entity that was asked for | Every block with its transactions, inputs, outputs, assets and metadata |
| Expiry | `INDEX_TTL_MS` on temporal entities | None |
| Write path | `CardanoIndexer.index*` per entity | `CardanoIndexer.indexBlockFull`: one UPSERT per table per block, in one transaction |

Blocks and transactions do not expire, so the on-demand path finds crawled rows and calls no backend for
them. Data outside the crawled range is still fetched on demand. With `CRAWLER_AUTHORITATIVE=true`, and a
crawl that starts at Shelley and has reached the tip, a block or transaction that is not stored is a 404
without a backend call.

**Sources.** Ogmios chain-sync is the primary source. Pagination over Koios or Blockfrost is the fallback.

**Cursor.** `CardanoSyncState` is one row: last slot, hash and height, the tip, `syncStatus` and the error
count. A database lease on that row makes sure one instance crawls per deployment.

**Reorgs.** A rollback deletes everything after the fork point in one transaction, moves the cursor back
and writes a `CardanoReorgLog` row. Chain-sync reports a rollback itself. Pagination finds it by comparing
parent hashes.

### What the crawler fills besides blocks and transactions

| Table | Source | Setting |
|---|---|---|
| `AssetHistory` | The mint field of the block (Ogmios, Koios). On Blockfrost: outputs minus inputs per unit | `CRAWLER_ASSET_HISTORY`, on by default |
| `Assets` | One row per new unit: policy id, asset name, CIP-14 fingerprint | `CRAWLER_ASSET_CATALOGUE=bare`, the default |
| `PoolEpochSnapshots`, `DrepEpochSnapshots`, `EpochLedgerSnapshots` | Every pool, every DRep and the ada pots, once per epoch | `CRAWLER_EPOCH_SNAPSHOTS` |
| `AccountEpochSnapshots` | Reward accounts with the epoch snapshot, Ogmios only | `CRAWLER_ACCOUNT_SNAPSHOTS` |
| `TransactionCertificates`, `TransactionWithdrawals` | Block content from Ogmios chain-sync or Koios | `CRAWLER_CERTIFICATES` |
| `TransactionRedeemers`, `TransactionDatums` | Block content from Ogmios chain-sync | Always |
| `LedgerUTxOs`, `LedgerAddresses`, `LedgerAccounts` and their asset tables | The UTxO set, kept current per block after a snapshot import | `CRAWLER_UTXO_SET` |

**Asset rows from the crawler.** A row the crawler writes for a new unit carries no supply and no registry
data. Its `validFrom` and `validTo` are both `1970-01-01T00:00:00.000Z`, so it is expired from the start:

- An OData read does not see it. The first keyed read is a miss, and the on-demand path stores the full row.
- A program that reads the database directly sees the whole catalogue. `validTo > validFrom` selects the
  full rows.
- The stamp is fixed, not the current time. `Assets` is keyed by `validFrom` and `unit`, so the crawler
  writes one row per unit however often it sees the unit, and never the key of a full row.

**Mint and burn.** On Blockfrost the amount is the difference between outputs and inputs. When an input of
a transaction is not stored, because its output is older than the crawl start, the difference is unknown.
The crawler then records no mint or burn for that transaction and logs it. A transaction whose script
phase failed mints nothing. A reorg removes the mint rows with their transactions.

**Epoch snapshots.** A snapshot must show the state of its epoch, not today's state:

- Ogmios reads the ledger at the first crawled block of the epoch. That works while the block is within
  the node's last k blocks (2160 on mainnet and preprod, 432 on preview).
- Koios reports the current state only. The crawler takes a snapshot from Koios only while it crawls in
  the epoch of the chain tip.
- An epoch passed outside that window has no snapshot. The crawler logs the gap.
- A reorg deletes the snapshot rows taken at a block after the fork point.

## Settings

| Variable       | Default   | Description                                              |
| -------------- | --------- | -------------------------------------------------------- |
| `INDEX_TTL_MS` | `3600000` | How long a temporal row is valid, in milliseconds        |
| `NETWORK`      | `preview` | `mainnet`, `preview` or `preprod`                        |
| `BACKENDS`     | `koios`   | Any of `koios`, `ogmios`, `blockfrost`, `odatano`; the order does not matter |

The crawler settings are in the [Crawler Guide](../guides/CRAWLER_GUIDE.md).
