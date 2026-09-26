# Changelog

## [v2.0.0-rc.21] - txSeq keys, ledger lookups and crawled data before the backend

Input/output tables are keyed by chain position; existing databases need `migrate-txseq` once before the first start.

### Breaking

- `TransactionInputs`, `TransactionOutputs`, `TransactionInputAssets` and
  `TransactionOutputAssets` are keyed by `Transactions.txSeq` (`slot * 65536 + txIndex`, new
  column) instead of the transaction hash. Inserts land at the end of the key index instead of at
  random positions, which keeps the crawl rate constant as the tables grow and shrinks their
  indexes by about half.
  - The rows no longer carry `tx_hash` (`input_tx_hash` / `output_tx_hash` on the asset rows).
    The transaction is reached through the `tx` navigation (`tx/hash`, `$expand=tx`), and a
    transaction's rows through `Transactions('<hash>')/inputs` and `/outputs`. Keyed reads use
    `TransactionInputs(txSeq=…,inputIndex=…)`.
  - An existing database needs `migrate-txseq` (image mode) or `scripts/migrate-txseq.mjs` once
    before the first start of this version; the additive schema deployment cannot change the
    keys of tables that hold rows.

### Changed

- `Blocks.slotLeader` is the bech32 pool id of the block producer on every backend. Koios
  (`/block_info` `pool`) and Ogmios chain-sync (blake2b-224 of the issuer key) delivered the
  VRF key and the issuer key before. `scripts/migrate-slot-leader.mjs` turns the old values of
  existing rows into an SQL update (issuer keys derived, VRF keys matched against an Ogmios
  `stakePools` response).
- Plutus spends, `forceInputs` and `referenceInputs` resolve output references outside the
  sender's UTxOs through the node ledger (Ogmios `queryLedgerState/utxo`) when Ogmios is
  configured: one lookup proves existence and spendability. Without Ogmios, or when the
  lookup fails, the producing transaction is fetched as before.
- `CheckSubmissionStatus` and the wallet worker's recovery of an interrupted submit look up the
  transaction in the local index (crawled transactions) before asking a backend.
- While the crawler runs at the tip, `Pools`, `Accounts` and `NetworkInformation` take values
  from crawled data over the backend's:
  - `Pools.blocksEpoch` counts crawled blocks of the current epoch (crawl covering the whole
    epoch); `Pools.blocksMinted` all crawled blocks (crawl starting at or before Shelley).
    New index on `Blocks(slotLeader, slot)`.
  - `Accounts.controlledAmount` = UTxOs under the stake key (`LedgerAccounts`) + reward
    balance, with the crawled UTxO set active.
  - `NetworkInformation.circulatingSupply` = total of `LedgerAddresses`, with the crawled UTxO
    set active.
- Crawled epoch rows carry `blockCount`, `txCount`, `fees`, `firstBlockTime` and
  `lastBlockTime` summed over the crawled blocks when the crawl started before the epoch. An
  Ogmios-only crawl no longer writes zero totals for the current epoch and now writes rows for
  past epochs too (bounds from the slots, `output` / `activeStake` empty).
- `getNetworkInformation` asks the providers first and falls back to Ogmios.

### Added

- Ogmios `getNetworkInformation` from `queryLedgerState/treasuryAndReserves`: treasury,
  reserves, total supply (max − reserves); circulating, locked and stake totals stay `'0'`.
- `Accounts.poolId` / `Accounts.drepId` associations are filled from the backend's delegation.

### Fixed

- `GetLatestBlock` no longer stores the header-only ledger tip Ogmios answers with (size, fees
  and slot leader unknown); it returns the stored row of that hash when there is one instead of
  overwriting it. The crawl removes other rows at a crawled height that no transaction references,
  which also clears a rolled-back tip stored from Blockfrost or Koios.
- `BackendInitError` names the cause (`Failed to initialize backend: ogmios (<reason>)`), and
  `AllBackendsFailedError` lists why backends were skipped when none was called.
- Ogmios `getPool`: `vrfKeyHash` is filled (was always empty); `blocksEpoch` is null instead of 0.
- Ogmios `getAccount`: `poolId` and `drepId` are filled from the reward-account summary
  (were always null); predefined DReps map to `drep_always_abstain` /
  `drep_always_no_confidence`.
- Ogmios UTxOs (`GetUTxOsByAddress`, UTxO-set import) carry the reference-script hash in
  `scriptRef` (was always empty); chain-sync outputs carry `referenceScriptHash`.

## [v2.0.0-rc.20] - certificate backfill over crawled blocks

Certificates and withdrawals can be filled in for blocks crawled before `crawler.certificates` was on.

### Added

- `backfillCertificates(fromSlot, toSlot)` on `CardanoIndexerService` (Admin): a second
  chain-sync stream (Ogmios) over the already crawled range writes `TransactionCertificates`
  and `TransactionWithdrawals` only, keyed as the crawl writes them, so a repeat is idempotent.
  `fromSlot` defaults to the crawl start, `toSlot` to the cursor; `toSlot` may not pass the
  cursor. The stream intersects at the newest crawled block below `fromSlot` (the crawl
  start point when there is none) and ends at the first block past `toSlot`. A block the
  index does not hold is skipped. The crawler may keep running; rows are written per 200
  blocks. Runs detached; `getStatus().certificateBackfill` reports `{status, fromSlot,
  toSlot, atSlot, blocks, certificates, withdrawals, startedAt, finishedAt, error}`,
  process-local (`none` after a restart). One backfill per process at a time.
- `srv/blockchain/crawler/certificate-backfill.ts` (`backfillCertificates`,
  `intersectionBefore`); unit tests for the range, the skipped block, the end condition and
  a stream error.

### Fixed

- Ogmios frame guard: every open chain-sync stream registers its own report callback and
  removes it on close. A second stream no longer replaces the crawler's callback, so an
  unparseable frame still halts the crawler's stream with an error.

## [v2.0.0-rc.19] - crawler-fed ledger state: certificates, outpoints, UTxO set

The crawl now carries certificates, withdrawals, input outpoints and, opt-in, a UTxO set of its own.

### Added

- `crawler.utxoSet` / `CRAWLER_UTXO_SET` (default `false`): the crawl maintains its own UTxO
  set in new non-temporal tables `LedgerUTxOs` (+`LedgerUTxOAssets`), `LedgerAddresses`
  (+`LedgerAddressAssets`), `LedgerAccounts`, exposed read-only on `CardanoODataService`.
  Unspent = `spentTxHash eq null`; running `totalLovelace` / `utxoCount` / asset balances per
  address, `controlledAmount` per stake key. Applied inside the block transaction.
- `importUtxoSet(source, filePath, anchorSlot, anchorHash)` on `CardanoIndexerService`
  (Admin): one-off anchor import, `source: ogmios` at the crawler cursor or `source: file`
  from a `cardano-cli query utxo --whole-utxo` dump (`.json`, or `.ndjson` via
  `jq -c 'to_entries[]'`). Crawler must be paused; cursor must not be past the anchor. Runs
  detached; `getStatus().utxoSet` reports `{enabled, status, anchorSlot, anchorHash,
  importedAt, error}`. Anchor and status persist in `CardanoSyncState.utxoSet*`.
- Only blocks after the anchor are applied; a reorg after it drops what the rolled-back
  blocks created, reopens what they spent and recounts the touched addresses; a reorg
  before it marks the set `invalid` (re-import). Without an active anchor the knob is inert
  and the crawler logs an error at start.
- Safety: the import holds the cursor lease for its duration and re-takes it inside every
  write transaction (crawler start and a second import are refused cluster-wide, a
  takeover aborts before the next commit and writes nothing further); the anchor is
  verified against the crawler cursor before the first apply (covers the configured start
  block); `CardanoSyncState.utxoAppliedSlot` tracks ledger progress, a reorg moves it back
  with the cursor and a cursor ahead of it invalidates the set at start; cardano-cli dumps
  are parsed losslessly (`parseJsonLossless`); the Ogmios whole-set query runs on its own
  WebSocket connection so live queries stay at the tip.
- Koios `/tx_info` mapper now carries `valid_contract`, `collateral_inputs`,
  `collateral_output` and `reference_inputs` (`spendsCollaterals`, `isCollateral`,
  `isReference`), so the collateral-fee, mint-delta and ledger paths are exact on Koios too.
  Certificates/withdrawals are requested from Koios only while `crawler.certificates` is on
  (`PaginatingBackend.configureCrawl`).
- Import lease read-back no longer requires `desiredRunning` (the cluster is paused during
  an import); a ledger invalidation decided inside a block transaction takes effect in
  memory only after that transaction committed; the reorg undo and the progress-marker
  reset run from the persisted set state, also in a process with the mode off.
- Known limitation (documented, pre-existing): `@cap-js/sqlite` stores every `Decimal` as
  a double, so amounts above 2^53 lovelace are rounded on SQLite in all tables; exact on
  PostgreSQL and HANA.
- `decodeShelleyAddress()` in `srv/utils/mappers.ts` (type, script flag, stake address from
  the address bytes); `LedgerStateBackend` (`queryUtxoSetAt`) on the Ogmios backend; five
  new secondary indexes on the ledger tables.

- `TransactionInputs.spentTxHash` / `spentOutputIndex`: the consumed outpoint on every
  input row, all paths, no knob. Null on rows written before this version.
- `TransactionCertificates` (key `tx, certIndex, kind`; `stakeAddress`, `poolId`, `drepId`,
  `deposit`, `epoch`) and `TransactionWithdrawals` (key `tx, stakeAddress`; `lovelace`),
  exposed read-only on `CardanoODataService`, compositions on `Transactions`.
- `crawler.certificates` / `CRAWLER_CERTIFICATES` (default `false`): writes both tables per
  block in the block transaction. Ogmios chain-sync and Koios `/tx_info` (`_certs`,
  `_withdrawals` on the batch call); Blockfrost reports none and the indexer warns once.
- Certificate kinds normalized across sources (`stake_registration`, `pool_delegation`,
  `vote_delegation`, `pool_retirement`, `drep_registration`, …); a Conway stake+vote
  delegation is two rows with one `certIndex`; unknown types keep the raw source name.
- `credentialToStakeAddress()` / `credentialToDrepId()` in `srv/utils/mappers.ts` for the
  bare Ogmios credentials.
- Reorg deletes the new rows with their transactions; five new secondary indexes
  (`spentTxHash, spentOutputIndex`; certificate `stakeAddress`, `poolId`, `drepId`;
  withdrawal `stakeAddress`).

## [v2.0.0-rc.18] - start-up fixes reach the standalone server

### Fixed

- `installPostgresOrderNulls()` and `ensureDbIndexes()` run in
  `initializeAppContext`, shared by the plugin path and the standalone served
  hook. rc.16 / rc.17 called them from `initializeFromConfig` only, so the
  standalone server (`cds serve`, the container image) never ran them.
- Standalone on Postgres: `$top` reads render `ORDER BY … ASC` and use the
  rc.16 indexes; start log shows `PgOrderNulls` and `18 indexes ensured`.
- No schema change, no new index, no config change.

## [v2.0.0-rc.17] - ORDER BY without NULLS on Postgres

### Fixed

- `$top` / `$orderby` reads on PostgreSQL use the indexes again. `@cap-js/postgres`
  renders every ordering term as `ASC NULLS FIRST` / `DESC NULLS LAST`, the opposite
  of a btree index, so every `$top` read sorted the whole table (`Blocks?$top=1`:
  0.8 to 7.6 s over 2M rows).
- `srv/utils/pg-order-nulls.ts` wraps the renderer's `_orderBy` once at start
  (`installPostgresOrderNulls`) and drops the clause for `key`, `not null` and
  temporal `validFrom` columns. Nullable columns and an explicit `nulls` keep it;
  the nullable `height` still needs its rc.16 `DESC NULLS LAST` index.
- A Postgres deployment whose driver no longer exposes the hook logs a warning
  and runs as before.
- No schema change, no new index. Rendered through the real driver in the unit test.

## [v2.0.0-rc.16] - secondary indexes

### Fixed

- The reads no longer scan their tables. `cds deploy` creates primary keys
  only, and the temporal entities (Assets, Pools, Accounts, Addresses,
  AddressUTxOs, AddressAssets, UTxOAssets, Dreps) carry `validFrom` FIRST in
  their key, so every lookup by unit, poolId, stakeAddress or address read the
  whole table; Blocks by height, slot and epoch, Transactions by block and
  height, TransactionMetadata by tx and AssetHistory by tx (crawler rollback)
  had no index at all. On the hosted preprod box (930k blocks, 1.4M
  transactions, 521k metadata rows) that was 200 ms for the latest block,
  1.0 s for `GetMetadataByTxHash`, 78 ms for `GetAssetInfo`, 168 ms for a
  block by height, 767 ms for one rollback lookup; with the indexes 0.2 ms
  each, the latest block through the OData layer 10 ms instead of 156.
- The buffered usage counters of rc.15: the flush timer no longer runs under
  the unit-test mode override (it raced the explicit flush of the test on a
  slow full-suite run), and a flush without a database service keeps its
  deltas instead of failing them one by one.
- `$orderby=height desc` on Blocks is rendered as `ORDER BY height DESC NULLS
  LAST`, which a plain index cannot serve backwards (still a 200 ms sort with
  the plain index in place). Blocks carry a second index `(height DESC NULLS
  LAST)` on PostgreSQL / HANA (`height DESC` on SQLite) for exactly that
  shape; the plain one stays for ascending order and equality.

### Changed

- The transport lane caches a resolved token (the grant row) for
  `AGENT_TOKEN_CACHE_MS` (`agentGrants.tokenCacheMs`, default 10 s, 0 = off)
  instead of one SELECT per request. Only positive results are cached, so an
  unknown, revoked or just-rotated token is never remembered; `validUntil`
  is checked per request against the cached row; the budget and usage
  counters never read the cached row for admission (their UPDATEs are
  conditional on the database). Revoke, rotate and update drop the entry on
  this process at once (a lookup in flight during the change does not
  re-cache its row); another replica honours them when its entry expires,
  at most 10 s later. Seconds, not minutes, on purpose.

### Added

- `srv/utils/db-indexes.ts`: the list (`DB_INDEXES`, 18 entries) and
  `ensureDbIndexes()`, run at every start from `initializeFromConfig` with
  `CREATE INDEX IF NOT EXISTS` (idempotent, plain SQL for SQLite and
  PostgreSQL, identifiers unquoted so Postgres folds them like the tables;
  a failing statement is logged and skipped; HANA is skipped altogether, its
  CREATE INDEX has no IF NOT EXISTS and the column store needs none). The
  agent token lane's lookup by `tokenHash` is on the list too.

### Notes

- No schema change for `cds deploy`. A plain CREATE INDEX locks the table
  against writes while it builds, so on a large live PostgreSQL create the
  set once beforehand with CONCURRENTLY under the same names; the start is
  then a no-op. On the hosted box the build took 1 to 7 s per index, 230 MB in
  all.

## [v2.0.0-rc.15] - buffered grant usage counters

### Changed

- The agent grant hook no longer writes the usage counter per request on
  PostgreSQL and HANA. Every admitted call was `calls + 1` on the row
  (grant, day, service, action), awaited before the handler ran, so all calls
  of one grant and action queued on that row's lock: 100 parallel reads
  through the gateway on one grant landed at 30 to 50 calls per second on
  the hosted preprod box while the reads themselves took milliseconds. The
  deltas are now summed in memory and written by one timer per second, one
  UPDATE (or INSERT) per touched key; a refund of a refused request goes to
  the same key. `GetGrantUsage` flushes the buffer before it reads, so its
  answer stays exact; a crash loses at most one second of counters, which is
  accounting, not admission. The daily budget (`maxJobsPerDay`) is untouched:
  its conditional UPDATE is the admission itself and stays synchronous.
- SQLite keeps the awaited per-request write: a timer writing on a second
  connection while a request transaction is open is the WAL snapshot race
  (`SQLITE_BUSY_SNAPSHOT`) this hook must never cause. A request inside its
  own changeset transaction keeps it on every database (its rollback is the
  refund).

### Added

- `flushGrantUsage()` and `pendingGrantUsageKeys()` in `srv/utils/agent-grants`
  (the flush also runs on `cds.on('shutdown')`).

### Notes

- No schema change, no migration. One replica per database is assumed for the
  buffer, as it already is for the rate limiters.

## [v2.0.0-rc.14] - crawler source recovery

### Fixed

- The crawler no longer stays on pagination for the rest of the process when
  no chain-sync backend was usable at start. On a box that restarts node and
  ODATANO together the node replays its ledger for minutes while ODATANO is
  up in seconds, so Ogmios refused its init and the crawl degraded to
  Blockfrost/Koios pagination — some fifty times slower — without ever looking
  back. With `source: auto` the crawler now retries the chain-sync backend
  every 30 seconds while on pagination — on its own timer, so neither an
  idle poll interval nor a slow batch delays the retry — and hands over as
  soon as it is usable: a pending poll sleep is cut short, a block in flight
  is completed first, and the rest of the batch is streamed instead.
- `blocksEpoch` is `null` instead of `0` on rows filled from Koios, which has
  no per-epoch block count. A consumer can now tell "unknown" from a real
  zero; Blockfrost rows are unchanged.
- `liveSaturation` widened from `Decimal(5, 4)` to `Decimal(9, 4)` on `Pools`
  and `PoolEpochSnapshots`. The value is a fraction, and on a test network a
  single pool can hold several times the saturation point: the first preprod
  snapshot already had a pool at 7.6 against a ceiling of 9.9999, and one pool
  past it fails the whole epoch's snapshot.

### Added

- `getStatus()` on `CardanoIndexerService` reports `source` — `chain-sync` or
  `pagination` for the crawler in this process, `null` when this instance is
  not the one crawling. A crawl degraded to pagination still advances the
  cursor, so this is how monitoring tells the two apart.

### Notes

- Schema change (column widening): a deployment coming from rc.13 needs a
  schema update (`cds deploy`).

## [v2.0.0-rc.13] - pool saturation unit

### Fixed

- Koios reports `live_saturation` in percent, Blockfrost as a fraction, and both
  values were passed through unchanged into a `Decimal(5, 4)` column. Every pool
  at or above 10 % saturation overflowed the column, and because a snapshot
  writes all pools in one statement, `CRAWLER_EPOCH_SNAPSHOTS` never wrote a
  single row on a Koios backend — it retried every 30 seconds instead. The Koios
  mapper now converts to the fraction the model expects (75.42 % -> 0.7542),
  which also corrects `Pools.liveSaturation` on the lazy read path.

### Notes

- `Pools` rows written from Koios before this release hold percent values until
  their temporal slice expires and is re-read. `PoolEpochSnapshots` was empty on
  those deployments, so nothing has to be corrected there.

## [v2.0.0-rc.12] - crawler coverage for analytics

### Added

- The crawler now fills the tables analytics needs, not only blocks and
  transactions:
  - `AssetHistory` — every mint and burn of the crawled range, taken from the
    ledger's mint field (Ogmios, Koios) or the output-minus-input delta
    (Blockfrost). On by default, no provider call (`CRAWLER_ASSET_HISTORY`).
  - `Assets` — one row per native-asset unit seen, derived from the unit itself:
    policyId, assetNameHex, decoded name, CIP-14 fingerprint. Supply and
    registry data are still filled in by the lazy path on first read. On by
    default, no provider call (`CRAWLER_ASSET_CATALOGUE=bare`); `enrich`
    resolves the registry in the background.
  - `PoolEpochSnapshots` / `DrepEpochSnapshots` — new read-only entities, one
    dated observation per pool and DRep per epoch, so stake and governance read
    as a time series instead of current state. Taken only while the crawl is at
    the chain tip, because the enumerating providers report the set as it is now
    and take no epoch parameter. Off by default (`CRAWLER_EPOCH_SNAPSHOTS`),
    requires Koios.
- `EnumeratingBackend` capability (full pool/DRep listing), implemented by Koios.

### Fixed

- Blockfrost inputs now carry `isCollateral` / `isReference`. The mapper filled
  two field names nothing reads, so a reference input was indistinguishable from
  a consumed one and `TransactionInputs.isReference` was always false.
- A phase-2 failure fetched through Blockfrost now reports the collateral the
  ledger charged as its fee, not the declared fee that was never collected —
  the correction the chain-sync path has had since rc.11.

### Notes

- Ranges crawled by an earlier build keep their empty `AssetHistory` and
  `Assets` tables until they are crawled again. `CRAWLER_ASSET_CATALOGUE=off`
  with `CRAWLER_ASSET_HISTORY=false` restores rc.11 behaviour.

## [v2.0.0-rc.11] - phase-2 fees, over-deep chain-sync frames

### Fixed

- Phase-2-invalid transactions carried the fee declared in the transaction body.
  The ledger charges the collateral instead, so `Transactions.fee` and the
  derived `Blocks.fees` understated every failed script transaction — 127 of
  them over a preprod backfill from 2026-01-01, 287 185 600 lovelace, and the
  only divergence in an otherwise byte-identical comparison against
  cardano-db-sync. `mapOgmiosTx` now takes the body's `total_collateral` where
  it declares one, and `CardanoIndexer.applyCollateralFees()` derives the rest
  from the resolved collateral inputs minus the collateral return. A collateral
  input that cannot be resolved (produced before the crawl start) keeps the
  declared fee and is logged, rather than summing short. Only the Ogmios
  chain-sync path was affected; Blockfrost and Koios pass through untouched.
- A chain-sync frame nested deeper than the client's parser can handle no longer
  ends the process. `@cardano-ogmios/client` parses every frame with a recursive
  descent parser plus an equally recursive `sanitize`; preprod block 5183974
  carries a native script nested 10 774 levels deep (205 kB as JSON), and the
  `RangeError` surfaced as an unhandled rejection from a socket handler nobody
  awaits — the server died, Docker restarted it, the crawler hit the same block
  again, 53 times in seven minutes, and `lastError` stayed empty throughout. The
  frame guard wraps `safeJSON.parse`: the fast path is unchanged, an overflowing
  frame has integers beyond 2^53 rewritten as strings and is parsed with V8's
  iterative `JSON.parse`, and the guard never throws. A frame that survives
  neither parser becomes a `ChainSyncFrameError` naming the block; with
  `source: 'auto'` the crawler fetches that block through the paginating backend
  and resumes chain-sync instead of halting. It still halts under
  `source: 'ogmios'`, without a paginating backend, or when the frame named no
  block.

### Notes

- Transactions indexed by an earlier build keep the declared fee; only blocks
  crawled from this version on carry the collateral. Re-crawl the affected
  blocks, or correct the rows in place — a phase-2 failure is the only
  transaction the crawler stores without a regular input, which identifies the
  set without consulting another indexer.

## [v2.0.0-rc.10] - PostgreSQL hardening

### Fixed

- PostgreSQL: asset names containing a NUL byte or invalid UTF-8 halted the
  crawler ("unsupported Unicode escape sequence"). `decodeAssetName()` now
  returns the hex form for such names (`assetNameHex` was always exact), and a
  db-level sanitizer strips U+0000 from every row this plugin writes — crawler
  and lazy paths alike.
- PostgreSQL: metadata labels >= 2^63 overflowed the int64 key
  `TransactionMetadata.id` and halted the crawler. Labels now map into int64
  exactly (two's complement, exact beyond 2^53); `label` keeps the original
  text. Non-numeric labels are skipped with a warning instead of producing an
  invalid key.
- Crawler restart loop: a block whose persist keeps failing no longer restarts
  the crawler every 5 s. The standby delay backs off (5 s → 5 min) after a local
  failure, and a block that PostgreSQL/HANA/SQLite deterministically rejects
  5 restarts in a row latches the crawler off with `lastError = "poison block
  …"`; `resumeCrawler()` continues once the cause is fixed. Transient failures
  (DB outage, timeouts) never latch.

### Notes

- Metadata rows for labels above 2^53 indexed by an earlier rc build carry a
  rounded `id`; re-indexing such a transaction writes the exact key beside it.
  Delete those rows before re-crawling if you need a clean table (they are
  rare: standard labels are far below 2^53).

## [v2.0.0] - CAP 10, chain crawler / pre-sync, wallet worker

### Added (rc.9)

- PostgreSQL in the image: `ODATANO_DB_URL=postgres://user:pw@host:5432/db`
  (`sslmode=disable|require|verify-full`) selects `@cap-js/postgres`; the
  entrypoint waits for the listener and deploys the schema on every boot
  (CAP's additive evolution; `ODATANO_DB_DEPLOY=never` skips it). Without a
  URL the image stays on SQLite at `ODATANO_DB_PATH` (default
  `/data/db.sqlite`, seeded on the first boot). `migrate` mode copies a
  SQLite file into a freshly deployed PostgreSQL through CAP
  (`docker compose run --rm --no-deps odatano migrate --from /data/db.sqlite`;
  `scripts/migrate-sqlite-to-postgres.mjs`, row counts verified). The
  mapping is pinned in `test/unit/docker-cds-config.test.ts`.

### Changed (rc.8)

- Transport auth moves to `@odatano/cap-auth`. With agent grants enabled the
  plugin sets `cds.requires.auth.impl` to that package (a host's own impl is
  kept as its `delegateImpl`) and registers the `x-agent-token` lane from
  `srv/utils/agent-token-auth.ts`; the package runs its basic lane
  (timing-safe compare, failure throttle), the registered lanes, then CAP's
  own strategy for `kind`, and sends no terminal 401 of its own. The lane
  registry, delegate loader and `agentGrantsDelegate*` options leave this
  package; `registerTransportLane` and the lane types are re-exported from
  `@odatano/cap-auth`. The contract table runs against the real server
  (`test/integration/transport-auth-contract.test.ts`).
- The Docker image runs `NODE_ENV=production` with HTTP basic auth
  (`ODATANO_HTTP_PASSWORD`, `ODATANO_HTTP_USER` default `odatano`,
  `ODATANO_HTTP_ROLES` default `Admin`, `ODATANO_AUTH=dummy` for local
  testing) through `docker/cds-config.mjs` and `docker/entrypoint.sh` (node
  as PID 1). `getLiveness()` and `VerifyDataSignature` stay anonymous;
  everything else challenges. The compose file no longer sets
  `CDS_REQUIRES_AUTH=mocked`.

### Fixed (rc.8)

- `getLiveness()` and `VerifyDataSignature` were anonymous only under
  `NODE_ENV=development`. CAP treats a service WITHOUT a service-level
  `@requires` as `authenticated-user` in production before it looks at the
  operation, so the rc.7 element-level layout still answered 401 to anonymous
  probes on a production container (the hosted odatano-preprod runs in
  development mode, which is why it worked there). Both services now carry
  `@requires: 'any'` at the service level; every element keeps its own
  requirement, nothing else changes for callers. The model test pins it.

All notable changes to ODATANO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Fixed (rc.7)

- **`getLiveness()` and `VerifyDataSignature` answered 401 under basic/XSUAA
  auth.** CAP checks a service-level `@requires` before the operation's own
  annotation, so an operation's `@requires: 'any'` never applied: the rc.6
  Docker `HEALTHCHECK` flagged the container unhealthy, and the anonymous
  CIP-30 verify behind wallet login only ever worked under mocked auth.
  `CardanoIndexerService` and `CardanoSignService` now carry the
  `authenticated-user` requirement on each entity and operation instead of on
  the service (pause/resume stay Admin, HSM actions keep `hsm.requiresRole`);
  auto-exposed entities remain unreachable directly (405) and guarded via
  navigation. Nothing else changes for callers.
- **SQLite busy timeout.** `cds.requires.db.client.timeout = 5000` (node:sqlite
  `DatabaseSync` option): a second connection on the same file — the previous
  test file's process still winding down, a detached write — now waits up to
  5 s instead of failing at once with `database is locked`.

### Added (rc.6) — agent-grant lifecycle, Ogmios DRep

- **Agent grants: rotate, update and usage history; grant admin rate limit
  configurable; unauthenticated liveness.** `CardanoAgentService` gains
  `RotateAgentGrantToken` (fresh token, old one unknown from the next request),
  `UpdateAgentGrant` (label, allow list, job kinds, daily budget, expiry;
  absent = untouched, explicit `null` = cleared; wallet binding immutable;
  `409 GRANT_REVOKED` on a revoked grant) and `GetGrantUsage(grantId, since,
  until)` (admitted calls per service and action over up to 366 days, from the
  new `CardanoAgentGrantUsage` counters — run `cds deploy`). Semantics match
  the gateway's peer services, so one client drives them all.
  `AGENT_GRANT_ADMIN_RATE_LIMIT` / `agentGrants.adminRateLimit` (default
  10/h per principal) now covers all four administration actions.
  `CardanoIndexerService.getLiveness()` answers without credentials
  (`@requires: 'any'`); the Docker `HEALTHCHECK` and compose probe use it.
- **DRep lookup via Ogmios.** `OgmiosBackend.getDrep` now queries the live
  ledger state (`queryLedgerState/delegateRepresentatives`, Ogmios ≥ 6.4)
  instead of declaring the method unsupported, so `GetDRepById` works on an
  Ogmios-only setup. Routing is unchanged (Blockfrost/Koios first). Ogmios only
  lists registered DReps: a retired DRep is a 404 there, `expired` is derived
  from the mandate epoch, `lastActiveEpoch` is 0.

### Added (rc.5) — agent grants

- **`CardanoAgentService`** (`/odata/v4/cardano-agent/`): scoped, budgeted bearer
  tokens for agents. `CreateAgentGrant` /
  `RevokeAgentGrant` are Admin-only; the token `odat_…` is returned once and
  stored as SHA-256. `AgentGrants` (Admin; a token sees its own row) and
  `GetGrantStatus()` (token self-service: allow list, wallet, remaining budget,
  expiry). New table `CardanoAgentGrants`.
- **Token principal.** A request with `x-agent-token` runs as `agent:<grantId>`
  with the single role `agent-grant`, never as the operator, so every
  `@requires: 'Admin'` surface refuses it. Reads and compute-only actions are
  always allowed; allow-listed actions (`Build*`, `SetCollateral`,
  `CreateSigningRequest`, `VerifySignature`, `Submit*`, `CheckSubmissionStatus`,
  `SubmitWalletJob`, `CancelJob`) cost one budget unit per UTC day; everything
  else is 403. Wallet jobs are pinned to the grant's wallet (`walletId`
  injected, `allowedJobKinds` narrowed) and scoped to the grant through
  `createdBy = agent:<grantId>`.
- **Transport lane** (`srv/utils/agent-token-auth.ts`), installed as
  `cds.requires.auth.impl` by `activateAgentGrants()` — called from the plugin
  (consumer apps) and from `srv/server.ts` (standalone `cds serve`) — when
  `cds.requires.odatano-core.agentGrants.enabled` / `AGENT_GRANTS_ENABLED=true`
  is set: admits the token header on the six service paths (unknown 401,
  expired 410, 20 failed attempts per client per 15 min → 429) and delegates
  every other request to the CAP strategy configured before
  (`agentGrants.delegate`, default: the configured `auth.kind`). Off by default:
  no behaviour change for existing consumers.
- **Public API** for other packages: `issueAgentGrant()`, `revokeAgentGrantById()`,
  `registerTransportLane()` (the seams `@odatano/x402` uses to sell grants and
  add its payment lane), plus `hashAgentToken`, `AGENT_TOKEN_HEADER`,
  `AGENT_ALLOWLISTABLE_ACTIONS`, `AGENT_ALWAYS_ALLOWED_EVENTS`.
- Tests: `test/unit/agent-grants.test.ts`, `test/unit/agent-token-auth.test.ts`,
  `test/integration/agent-grants.test.ts`. Verified live on the hosted preprod
  instance (Ogmios backend): 36 end-to-end checks — issue, self-service status,
  free reads, Admin gates, allow list, budget with refund and 429, revoke.

### Fixed (rc.5)

- **Dockerfile compiled into `dist/` but served from `srv/`.** `RUN npm run build`
  emitted to `dist/` (tsconfig.json), while `cds serve srv` resolves each
  service's `@impl` as `srv/<name>.js` and the runtime image has no TypeScript
  loader. The image only ever worked because stale in-place `.js` twins from a
  previous `build:plugin` sat in the build context; a clean checkout produced a
  container that crashed with `Cannot find module '/app/srv/…-service'`. Now
  `RUN npm run build:plugin` (in place, `tsconfig.build.json`).
- **Polling could confirm a rolled-back transaction (wallet worker).** Once a
  tx had been found at some height, the confirmation tracker stopped looking
  it up and confirmed on the tip alone; without the crawler there is no reorg
  signal, so a tx found at height 100, rolled back, with the tip reaching 102
  became `confirmed` at depth 3. The polling path now re-reads the tx before
  confirming any inclusion not seen in the current round: gone → the
  confirmation point is cleared (same-CBOR re-submit as after a crawler reorg)
  and the tip is re-learned; moved → re-anchored at the new height and judged
  there.
- **Repeated state transitions reported success (wallet worker).** The
  guarded transition ignored the UPDATE's affected rows and only checked the
  row's status afterwards, so `markConfirmed` twice returned `true` twice and
  two trackers bumped `jobsConfirmed` to 2 for one job. Transitions now report
  whether THIS call moved the row; the confirmation tracker emits the terminal
  event and the stats bump only from the winner.
- **Job deduplication crossed principal boundaries (wallet worker).** The
  idempotency claim was (walletId, kind, key) regardless of who submitted, so
  a second agent grant using `order-1` on the same wallet received the first
  agent's job id as a "deduplicated" success and never got its own job. The
  stored claim (`dedupKey`) is now scoped to the submitting principal
  (`dedupKeyFor(createdBy, key)`: a hash of owner + key, plain key for an
  owner-less caller); the caller-visible `idempotencyKey` is unchanged. Rows
  written before this change keep their plain claim; a retry by an owned
  principal creates a fresh job for them.
- **Enabling agent grants discarded a host's own `auth.impl`.** Activation
  replaced `cds.requires.auth.impl` and the lane then delegated to CAP's
  built-in strategy for `kind`, so a custom gate (a consumer's own auth
  middleware) stopped running for every non-token request, on every path. The
  original impl is now kept as `agentGrantsDelegateImpl` and resolved like CAP
  resolves it (relative to `cds.root`); the lane only adds the token path in
  front of it. `agentGrants.delegate` accepts `custom` for that case and
  defaults to it when a custom impl is configured.
- **Budgeted actions deadlocked inside a `$batch` changeset.** The hook charged
  the daily budget on a detached connection while the changeset's open
  transaction held SQLite's single pooled connection: two `SubmitWalletJob`
  parts in one atomicity group never returned. The hook now detects an
  already-begun request transaction (`ready`/`dbc` on `cds.tx(req)`) and
  charges on it; the changeset's rollback is then the refund. Plain requests
  keep the detached charge (spend sticks, no lock across backend calls).
- **A late refund reduced the wrong day's budget.** The refund selected the
  window by the current date; a request charged at 23:59 and refused after
  midnight gave its unit to the new day. `consumeDailyBudget` now returns the
  charged window and the refund names it.
- **Agent-grant hook wrote `lastUsedAt` fire-and-forget**, racing the request's
  own transaction: on SQLite in WAL mode the handler's first UPSERT then failed
  with `database is locked` (`SQLITE_BUSY_SNAPSHOT`), a 500 seen live on the
  second build within a minute. Every write the hook makes is now awaited before
  the handler runs; the budget refund on a refused request is deferred off the
  failing request's tick.

> Shipping first as **v2.0.0-rc.1**, published to npm as `latest` (14-08-2026) —
> a plain `npm i @odatano/core` installs the RC. `^2.0.0` does not match a
> pre-release, so pin `@odatano/core@2.0.0-rc.5` in `package.json`; consumers
> that need to stay on the 1.x line pin `@odatano/core@^1.11.0`.
>
> **v2.0.0-rc.2** (15-08-2026): keyed reads honour `$expand`/`$select`,
> `cds watch` startup fix. **v2.0.0-rc.3** (16-08-2026): keyed reads no longer
> answer with a row the query excludes. See *Fixed* below — no schema change,
> no `cds deploy` needed when coming from rc.1 or rc.2.
> **v2.0.0-rc.4** (20-08-2026): multi-policy mints (per-action
> `mintingPolicyScript` + `redeemerJson` in `mintActionsJson`) and
> `extraOutputsJson` on `BuildMintTransaction`. Additive; no schema change,
> no `cds deploy` needed when coming from rc.1-rc.3.
> **v2.0.0-rc.5** (07-09-2026): agent grants (`CardanoAgentService`, scoped
> bearer tokens for agents, off by default) and wallet-worker fixes. Adds the
> `CardanoAgentGrants` table: run `cds deploy` once when coming from rc.1-rc.4.

### ⚠ Breaking

- **SAP CAP 10** — peer dependency is now `@sap/cds >=10` (was `^9`). Consumer projects on CAP 9 must upgrade before adopting `@odatano/core@2`.
- **Node.js >= 22.5** — required by `@cap-js/sqlite` v3 (`node:sqlite` floor).
- **Numeric OData fields serialize as strings** — CAP 10 renders `Decimal`, `Int64` and `$count` values as JSON strings. API clients that parse these fields as JSON numbers must be adapted.
- **XSUAA role separation** — the `$XSAPPNAME.Admin` scope (crawler/worker control) is no longer part of the `CardanoUser` role template or the app authorities; assign the new `CardanoAdmin` template explicitly. Existing `CardanoUser` role collections lose crawler/worker control on redeploy (intentional least-privilege fix).
- **Database redeploy required** — 2.0 adds five tables (`CardanoSyncState`, `CardanoReorgLog`, `CardanoWorkerWallets`, `CardanoWalletJobs`, `CardanoAgentGrants` — the last one since rc.5) plus a `dedupKey` column and its unique constraint on the jobs table. Consumers upgrading from 1.x must run `cds deploy`; without it the new services answer `no such table` and `getStatus`/`GetWorkerStatus` return 500. (Verified against a real 1.10 consumer project.)

### Added

- **Chain crawler / pre-sync (opt-in)** — `CRAWLER_ENABLED` / `cds.requires.odatano-core.crawler`: streams the chain forward from a configured start block into `Blocks`/`Transactions` (+inputs/outputs/assets/metadata) so queries hit local data instead of a backend per request. Ogmios chain-sync (native rollForward/rollBackward) with Blockfrost/Koios pagination fallback, parent-hash reorg recovery, cursor (`CardanoSyncState`) + audit log (`CardanoReorgLog`), cluster-safe via DB lease. New **CardanoIndexerService** (`/odata/v4/cardano-indexer/`): SyncState + ReorgLog (read-only), `getStatus` / `pauseCrawler` / `resumeCrawler` (Admin).
- **Wallet worker (opt-in)** — `WALLET_WORKER_ENABLED` / `cds.requires.odatano-core.walletWorker`: asynchronous per-wallet transaction queue (build → sign → submit → confirm) with software/HSM signers, idempotency keys, exponential retry, per-wallet DB leases (multi-instance safe), and a confirmation tracker (crawler hook or polling) with rollback re-submit of the SAME signed CBOR. New **CardanoWorkerService** (`/odata/v4/cardano-worker/`): `SubmitWalletJob` / `CancelJob` / `GetJobStatus` / `GetWorkerStatus` / `PauseWorker` / `ResumeWorker`.
- **CAP events on both v2.0 services** — consumers can subscribe instead of polling.
  `CardanoIndexerService` publishes `blockIndexed` (hash, slot, height, txHashes, tip) and `reorg`
  (forkSlot, forkHeight, blocksRolledBack); `CardanoWorkerService` publishes the terminal
  `jobConfirmed` and `jobFailed` (jobId, walletId, kind, txHash, + errorCode/errorMessage).
  ODATANO runs in the consumer's process as a plugin, so this needs no broker and no
  `cds.requires.messaging`; configuring one later routes the same emits through it. All emits
  happen AFTER the corresponding commit, are fire-and-forget, and swallow subscriber failures so a
  broken observer cannot stall the crawler or a wallet job. Events are absent from `$metadata`
  (OData V4 has no event concept), so the change is additive for existing HTTP clients.
- **KoiosBackend.getDrep** with the new Koios schema.
- **Multi-policy mints** (rc.4) — `mintActionsJson` entries accept optional per-action `mintingPolicyScript` (CBOR hex, pre-applied) and `redeemerJson` (JSON-encoded PlutusData string); absent fields fall back to the top-level policy/redeemer. A bare asset name expands under the action's own policy id, and a full unit must carry it. Actions resolving to the same policy must carry the same redeemer. Applies to `BuildMintTransaction`, the combined spend+mint flow of `BuildPlutusSpendTransaction`, and the wallet-worker lane; per-action redeemers get `__INPUT_IDX__` placeholder resolution.
- **`extraOutputsJson` on `BuildMintTransaction`** (rc.4) — same entry shape as on `BuildPlutusSpendTransaction` (`address`, `lovelaceAmount`, `assets`, `inlineDatumJson`, `referenceScriptHex`, max 32, per-entry min-ADA check). When present, the extra outputs carry the minted assets and the primary recipient output stays ADA(+datum)-only; coin selection requests the extra outputs' lovelace plus, per asset unit, the output demand the transaction's own mints do not cover.

### Changed

- **Test suite migrated from Jest to Vitest 4** (unit + integration projects, coverage via `@vitest/coverage-v8`). 1983 tests across 62 files (46 unit + 16 integration).
- **Integration suites for both v2.0 subsystems** — `test/integration/wallet-worker.test.ts` (real CAP + real SQLite, backends stubbed: guards the deployed `UNIQUE(walletId, kind, dedupKey)`, real transactions and the OData layer; needs no network or funds) and `test/integration/crawler.test.ts` (real Ogmios: contiguous ingest, recovery from a fork staged while the crawler was down, `getStatus`; self-skips when Ogmios is unreachable or behind the tip, so it runs in both CI lanes).
- **HarmonicLabs stack bumped**: `buildooor` 0.2.9, `cardano-ledger-ts` ^0.5.6, `cardano-costmodels-ts` ~1.6.1 (Plutus V3 cost model at `N_COST_MODEL_PLUTUS_V3` = 350, post-Plomin²).
- **Vendored patches removed** — upstream releases contain both fixes: `keep-relevant.ts` (buildooor keepRelevant) and `auxiliary-data-patch.ts` (ledger-ts Conway tag-259 AuxiliaryData decode).
- Dependency security pass: `axios` ^1.17.1, `fast-uri` ^3.1.5, approuter `body-parser` override — `npm audit` clean (prod + dev).

### Fixed

- **Keyed reads no longer answer with a row the query excludes.** A keyed read whose query legitimately matched nothing — a composite key whose second value does not match (`TransactionMetadata(id=721,tx_hash='…')` for a label the transaction does not carry), or a `$filter` that excludes the row — fell back to the row found for the entity's main key and returned it with a 200. Such requests now return 404. Affects all keyed reads of `Blocks`, `Epochs`, `Pools`, `Accounts`, `Dreps`, `Assets`, `Addresses`, `Transactions` and `TransactionMetadata`.
- **Keyed reads honour `$expand` / `$select`.** `GET Transactions('<hash>')?$expand=inputs,outputs` (and every other keyed read of `Blocks`, `Epochs`, `Pools`, `Accounts`, `Dreps`, `Assets`, `Addresses`, `Transactions`, `TransactionMetadata`) returned the bare row and dropped the query options; only the collection form honoured them. Keyed reads now index on a miss and then run the client's own query, so they behave exactly like the collection form. For temporal entities the handler widens the request's validity window before its first DB statement so the slice written during the request is visible to that query (expired slices stay hidden). Composite-key reads (`TransactionMetadata(id=…,tx_hash=…)`) honour both keys.
- **`cds watch` no longer logs `ERR_MODULE_NOT_FOUND` at startup.** The boot-time re-drive of interrupted deferred submissions used an extensionless dynamic `import()` that tsx cannot resolve, so it never ran from TypeScript sources; compiled builds were unaffected. Now a lazy `require`.
- Hardening pass: wallet-worker request transformation for all job kinds (shared parsers in `srv/utils/tx-request-parsers.ts`), crawler reorg guards (null-slot fork point, Blockfrost `CHAIN_POINT_MISMATCH` signal, Koios partial-batch rejection), confirmation-depth correctness across rollbacks, multi-instance-safe crash recovery and lease CAS, idempotency-key release for cancelled jobs.

#### Wallet worker — payment safety

- **HSM-backed wallet jobs now require the configured signing role.** `SubmitWalletJob` was gated on `authenticated-user` only, so any authenticated account could queue a value transfer with an arbitrary recipient and amount that the server-held HSM key would sign — bypassing the `hsm.requiresRole` gate the synchronous `SignWithHsm` path enforces. The role is now checked against both the instance's wallet config and the registered wallet row (403, new `ODATANO_FORBIDDEN` code).
- **A crash around submit can no longer cause a duplicate payment.** New durable pre-submit state **`submitting`**: the signed CBOR and its hash are committed *before* the transaction can reach a backend, and the row stays non-terminal so it keeps holding its idempotency key. Interrupted submits are reconciled against the chain — the exact stored bytes are re-submitted, never a rebuild — instead of being failed as `PROCESS_RESTART`, which released the key and let the documented caller retry build and pay a *second* transaction.
- **The per-wallet lease survives long builds.** Only one renewal happened before the build, so a build+sign exceeding `WORKER_LEASE_TTL_MS` (15s — routine with a multi-backend build plus an HSM round-trip) let another instance adopt the wallet while the first kept working. A heartbeat now renews for the whole execution, and ownership is fenced again immediately before the irreversible submit.
- **Idempotency is enforced by the database, not by a lookup.** Unique constraint `(walletId, kind, dedupKey)` via `@assert.unique.dedup` — two concurrent retries of the same key could both read "no such job" and both insert. The loser of the race now returns the winner's job. `dedupKey` carries the caller key while the job owns it and the job's own ID otherwise, so keyless jobs never contend and terminal jobs release the key without depending on per-database NULL semantics.

#### Chain crawler — reorg across a restart

- **Chain-sync recovers from a fork it slept through.** Only a single intersection point (the cursor) was offered to Ogmios, so a cursor orphaned while the crawler was down produced `No intersection found` and killed the ingest pipeline. The crawler now offers a ladder of its own crawled ancestors — dense over the last 10 blocks, doubling out to −16384 — so the node intersects at the last common block and reports an ordinary `rollBackward`, which the existing reorg handling resolves. The dense head keeps shallow rollbacks (the common case) exact instead of rolling back further than necessary.
- **A crashed crawler no longer stays down across restarts.** Every terminal error cleared `desiredRunning`, which no restart undoes — a dropped chain-sync socket (a routine node restart) silently disabled the pre-sync until an operator called `resumeCrawler`. Only unrecoverable configuration failures latch the cluster now; runtime failures leave `syncStatus: error` with `desiredRunning: true` so coming back up resumes.

## [v1.11.0] - 08-08-2026: Coin-selection + error-handling improvements

### Changed

- Enhanced coin-selection logic and error handling in the Buildooor transaction path; Plutus V3 cost-model handling updated to the current parameter count (`N_COST_MODEL_PLUTUS_V3`).
- Vendored `keep-relevant.ts` removed — buildooor 0.2.9 ships the fixed `keepRelevant` upstream.

## [v1.10.0] - 16-07-2026: Deadlock guard + deferred submit

### Added

- **Deferred submit** for in-process consumers: `SubmitVerifiedTransaction`/HSM flows can persist the signed tx and hand the network submit to a detached transaction, with restart re-drive (`redriveInterruptedSubmissions`).
- **Nested-transaction deadlock guard** (`srv/utils/tx-utils.ts`): `detachedTx` with pool-timeout diagnosis and abort fencing; `runWithoutAmbientTx` for CAP ambient-tx isolation.

## [v1.9.2] - 26-06-2026: Typed script-parameter application

### Added

- **Typed script parameters in `applyScriptParameters`** (`srv/utils/tx-build-helper.ts`, new exported `encodeScriptParam` + `ScriptParamUplcType`). A parameter entry may now be `{ "uplc": "data" | "bytes" | "int" | "bool" | "unit", "value": … }`, applied to the parameterized script as a UPLC constant of that **native type** instead of always as `Data`:
  - `data` → `UPLCConst.data(jsonToPlutusData(value))` (value: PlutusData JSON)
  - `bytes` → `UPLCConst.byteString(value)` (value: even-length hex string)
  - `int` → `UPLCConst.int(value)` (value: number | numeric string)
  - `bool` → `UPLCConst.bool(value)` / `unit` → `UPLCConst.unit`

  **Why:** some compilers type scalar parameters natively rather than as `Data` — e.g. Pebble, where `param owner: PubKeyHash` expects a native `bytestring`; applying it as a `Data`-wrapped bytestring makes the validator reject (`case: expected constr or constant value`). The previous Data-only application could not parameterize such scripts. The off-chain side must know each param's UPLC type (which it does — it authors/consumes the contract), and can now mix native and Data params in one call (e.g. a native `PubKeyHash` plus a `Data` `TxOutRef`).

### Changed

- **`applyScriptParameters` is fully backward-compatible in effect.** A **bare PlutusData entry** (e.g. `{ "bytes": "ab.." }`, `{ "constructor": 0, … }`) is treated as shorthand for `{ "uplc": "data", … }` — the Aiken / CIP-57 blueprint convention where every parameter is `Data`. Existing `scriptParamsJson` inputs produce **byte-identical** applied scripts; no consumer or on-chain behavior changes.

## [v1.9.0] - 14-06-2026: Hardening pass — backend resilience, schema correctness, durable signing & tx-build robustness

A broad correctness-and-resilience pass across every layer (PR #60, `dev/general-improvements`). No new OData actions, but several **schema data-type changes**, **error-status changes**, and **public-surface tightenings** that consumers should be aware of. Highlights: all read entities are now `@readonly` (writes → 405), Epoch/Metadata time/label columns widened to avoid overflow/truncation, Ogmios stops fabricating placeholder data and is skipped for unsupported methods, the signing/submit flow is now crash-durable, and Buildooor protocol-param/datum/collateral/metadata handling is hardened.

### Added

- **UTxO-only indexing fallback for `GetUTxOsByAddress`** (`srv/blockchain/cardano-indexer.ts`, `srv/cardano-service.ts`). New `CardanoIndexer.indexAddressUtxos(tx, addr)` indexes only the live UTxO set via `getAddressUtxos` — no `getAddress` (address-aggregation) call and no parent `Addresses` row (same pattern as `indexCredentialUtxos`). `GetUTxOsByAddress` now falls back to it when **no** configured backend supports `getAddress` (detected as `AllBackendsFailedError` with zero collected errors — every backend skipped the method). Net effect: an **Ogmios-only deployment can now serve `GetUTxOsByAddress`** (Ogmios has the live UTxO set but not address aggregation) instead of failing.
- **`SigningInstructions.cardanoCliCommand`** (`srv/utils/types.ts`, `srv/cardano-sign-service.ts`): signing instructions now include a copy-pasteable `cardano-cli` signing recipe for CLI / hardware signers.
- **`extractPaymentCredential(address)`** (`srv/utils/validators.ts`): decodes a Shelley bech32 address to its 28-byte payment-credential hash + an `isScript` flag, or `null` for undecodable / stake addresses. Used to bind signature verification to the build's fee-payer key.
- **`getStatus().backends`** (`src/index.ts`): the programmatic status object now reports the configured backend list via `cardanoClient.listBackends()`.
- **`CardanoBackend.unsupportedMethods?: ReadonlySet<string>`** (`srv/blockchain/backends/cardano-backend.ts`): backends can declare methods they don't support; the orchestrator skips them without counting a circuit-breaker failure.

### Changed

- **All 20 read-service entity projections are now `@readonly`** (`srv/cardano-service.cds`). External `CREATE` / `UPDATE` / `DELETE` against `CardanoODataService` entities now return **HTTP 405** instead of mutating the cache that is served as authoritative blockchain data. Behavior change for any consumer that was (incorrectly) writing to these projections.
- **Schema data-type corrections** (`db/schema.cds`, `db/types.cds`) — these change the OData `$metadata` types consumers see:
  - `Epochs.startTime` / `endTime` / `firstBlockTime` / `lastBlockTime`, `Transactions.blockTime` / `slot`, `Assets.initialMintTime`, `AssetHistory.blockTime`: `Integer` → **`Integer64`** (32-bit Integer overflows for Unix-second timestamps after 2038-01-19).
  - `TransactionMetadata.id`: `Integer` → **`Integer64`** (the metadata label is a uint64; the 32-bit column overflowed for labels > 2³¹).
  - `MetadataLabel` type: `String(5)` → **`String(20)`** (a uint64 label is up to 20 digits; `String(5)` truncated any label above 5 digits).
  - `Assets.assetNameHex`: `HexBytes` (`String(5000)`) → **`String(64)`** (32-byte ledger cap = 64 hex).
  - Key columns `Pools.poolId`, `Dreps.drepId`, `Accounts.stakeAddress`, address fields: `String` → **`Bech32`** (bounded type).
  - `Pools`, `Dreps` and `Assets` entities are now **`temporal`**, so live pool/drep/asset stats refresh on TTL lapse instead of freezing on first index.
- **`ASSET_UNIT_REGEX` tightened to the 32-byte ledger cap** (`srv/utils/const.ts`): asset-name portion bounded to 0-64 hex. `GetAssetInfo` / `GetAssetHistory` descriptions updated from "0-128 hex" to "0-64 hex; ledger caps asset names at 32 bytes". Over-long asset names now reject with a clear 400.
- **`GetAssetHistory` `limit` is clamped to 1-100** (`srv/cardano-service.ts`, `srv/cardano-service.cds`): previously unbounded; now `Math.min(Math.max(limit, 1), 100)`.
- **`SubmitSignedTransaction` now verifies its `network` parameter** against the deployment network (previously silently ignored).
- **Error-status corrections** (consumer-visible HTTP codes):
  - Missing build / submission record → **404 `NotFoundError`**.
  - Malformed tx CBOR → **400 `TX_PARSE_FAILED`**.
  - Script-parameter application failures in `BuildMintTransaction` / `BuildPlutusSpendTransaction` → field-attributed **400**.
  - `AllBackendsFailedError` with no collected errors (every backend skipped the method) now surfaces **503** instead of **502**.
  - `normalizeBackendError`: address-shaped hints (`invalid address` / `malformed address`) now classify as **404** before the generic validation hints; removed `not available` / bare `no data` from the not-found hints so provider **outages** stay **503** (and circuit-breaker-eligible) instead of being mislabeled 404.
- **Durable, crash-safe signing/submit flow** (`srv/cardano-sign-service.ts`):
  - `SubmitVerifiedTransaction` now submits in **3 committed phases** (claim → `submitting`, network submit outside any open DB lock, finalize → `submitted`). A post-accept crash leaves a durable `submitting` record instead of silently reverting to `pending`/`verified` with no on-chain trace.
  - `VerifySignature` atomically claims `pending` → `signed` before verifying, fixing a concurrent-verify double-insert race.
  - Expiry transitions are now status-filtered (only `pending` requests may expire).
  - Signature verification is now **bound to the unsigned tx body's `required_signers` (extra_signatories) plus the build's fee-payer key**, not just any present witness.
- **HSM hardening** (`srv/blockchain/signing/hsm-signer.ts`): rejects on failed verification, fully clears the PIN across singleton + env + config, slot documented as an index.
- **Buildooor tx-build hardening** (`srv/blockchain/transaction-building/buildooor-tx.ts`, `srv/blockchain/cardano-tx-builder.ts`):
  - All protocol parameters mapped with null guards; backend cost-model **arrays converted to named-key form** (raw arrays crash Buildooor's CEK machine); the `TxBuilder` is rebuilt per request when the `network#epoch` fingerprint changes.
  - `datumHash` now carried into resolved `TxOut`s and fabricated script UTxOs so datum preimages reach the witness set (fixes `MissingRequiredDatums` on hash-locked spends).
  - **Collateral**: picks the smallest ADA-only UTxO covering the 5-ADA floor and returns the excess via explicit `collateralReturn`.
  - **Metadata**: text/bytes > 64 bytes are chunked (UTF-8-safe), `0x` byte strings supported, non-integer numbers and invalid labels/keys rejected with clear **400s**.
  - **UPLC 1.0.0 (Plutus V1/V2) scripts are now rejected** at build time instead of being silently hashed as V3 (which produced a wrong policy ID / unspendable address).
  - Force / reference / script UTxOs are verified unspent before building (clear **400** instead of a node-side rejection).
- **`TxBuildRequest.lovelaceAmount` is now typed `string`** (`srv/utils/types.ts`): OData `Lovelace` is `Decimal(20,0)` and arrives as a string at runtime (CAP preserves precision); validators accept `string | number | bigint`.
- **Backend pagination fixes** (`srv/blockchain/backends/*`):
  - Blockfrost: `getAddressUtxos` / account-addresses use the `...All` variants — the plain variants capped at 100 entries and **silently truncated larger wallets**.
  - Koios: `address_txs` sorted newest-first before limiting; transactions fetched via `getTransactionsBatch` instead of an unbounded `Promise.all`; extended `reference_script` object unwrapped.
- **Ogmios data-correctness fixes** (`srv/blockchain/backends/ogmios-backend.ts`):
  - Protocol-parameter **Ratio strings** (e.g. `"3/1000"`) parsed properly — `Number()` previously yielded `NaN` for `rho`, `tau`, `a0` and exec-unit prices; the `rho`/`tau` swap is fixed.
  - `getAccount` extracts lovelace from `{ ada: { lovelace } }` value objects (was rendering `"[object Object]"`).
  - Network-aware epoch geometry via new `EPOCH_CONFIG_BY_NETWORK` and Shelley-anchored slot times from the genesis infos the tx builder uses.
  - Ogmios **no longer fabricates `getAddress` / `getNetworkInformation` placeholder data** (which `preferLive` routing then preferred over correct historical data) and now maps inline datums onto UTxOs.
- **Backend capability routing & resilience** (`srv/blockchain/cardano-client.ts`, `srv/blockchain/circuit-breaker.ts`):
  - Orchestrator skips a backend for any method in its `unsupportedMethods` set without counting a circuit-breaker failure.
  - **All 4xx responses are exempted from the circuit breaker** — a definitive answer from a healthy backend must not take it out of rotation.
  - New `callWithResilience` wraps every single-backend path with a breaker gate + timeout — most importantly `evaluateTransaction`, which previously hung Plutus builds indefinitely on a dead Ogmios socket.
  - Lazy Ogmios reconnect on dead sockets, retryable client init, half-open probe cap.
- **Caching / lifecycle / config robustness** (`srv/server.ts`, `src/plugin.ts`, `srv/blockchain/cardano-indexer.ts`, `srv/blockchain/cardano-client.ts`):
  - `indexTtlMs` is now wired into the indexer's cache TTL (was hardcoded 60s).
  - Config loading moved inside the served-hook `try` (a malformed config previously crashed the **plugin-mode** bootstrap); `bootstrapError` is now set in plugin mode too.
  - Plugin mode now honors `SKIP_AUTO_INIT=true` (matches `srv/server.ts`), so consumer test suites can mount the plugin without opening real backend connections.

### Fixed

- **`mapBlock` stores a real `null` `slotLeader`** instead of a placeholder; BigInt asset-quantity fallback added (`srv/utils/mappers.ts`).
- **Hash-length-only `scriptRef` written into the `Blake2b256` column** for Koios CBOR-truncation cases (`srv/utils/mappers.ts`).
- **Falsy-key guard** in `indexOnMissRead` (`srv/cardano-service.ts`): `key &&` skipped validation for falsy keys like `epoch=0` or an empty string; now an explicit `null`/`undefined` check.
- **`READ AssetHistory` now runs through `handleRequest`** (was returning `req.query` raw, bypassing error handling).
- Malformed witness sets now produce a warning instead of an opaque failure during signing.

### Internal

- **Type-aware ESLint enabled** (`eslint.config.mjs`): `projectService` + curated typed rules, CAP lifecycle hooks exempted, generated/repro artifacts ignored; `src/**` added to `tsconfig.json` include.
- **Dead code removed**: unused exports/request fields (`parseOptionalJson*`, `containsIndexPlaceholder`, `feeLovelace`, `executionUnits`) and their tests; `ProtocolParameters` type imported from the package root; `__INPUT_IDX__` regex made case-insensitive.
- **Tx-building paths consolidated**: shared `_resolveInputRefs`, `_buildSimpleTransfer`, and `_buildMintEntries` across `cardano-tx-builder.ts` and `buildooor-tx.ts`.
- **Test additions**: `indexAddressUtxos` unit tests, OgmiosBackend `unsupportedMethods` cases, and updated error-handling expectations across the unit and integration suites. Suite total now **35 suites (25 unit + 10 integration)**, 1549 tests, 96.58% statement coverage.
- Version bumped `1.8.0` → `1.9.0`.


## [v1.8.0] - 09-06-2026: Drop CSL and make Buildooor the sole transaction builder

Removes the `@emurgo/cardano-serialization-lib-nodejs` (CSL) dependency entirely. Buildooor (`@harmoniclabs/buildooor`) becomes the single transaction-building engine, and all hashing / signature-verification work moves onto the HarmonicLabs raw-CBOR stack. Net effect: **−2806 lines**, one fewer native WASM dependency, and the long-standing Plutus V3 `PPViewHashesDontMatch` bug is resolved by construction.

### Changed

- **Buildooor is now the only transaction builder.** `TxBuilderRegistry` and the builder-factory indirection are gone — `CardanoTransactionBuilder` constructs `BuildooorTxBuilder` directly. `TransactionBuilderName` is narrowed to the single literal `'buildooor'`; the `TX_BUILDERS` env var / `txBuilders` config key is still accepted for backward compatibility but is effectively a no-op (any value resolves to Buildooor). No public read/write OData action signatures changed.
- **Transaction-body hash and Ed25519 signature verification ported off CSL** to `@harmoniclabs/cbor` + `@harmoniclabs/crypto` (`srv/blockchain/signing/signature-verifier.ts`, `srv/utils/tx-build-helper.ts`, `srv/utils/signing-helper.ts`). The body hash is now computed as `blake2b_256` over the **original** transaction-body bytes (`CborArray` index 0, via `subCborRef`) with no re-serialization — so the hash always matches what was signed, and operating at the raw-CBOR level also sidesteps the `@harmoniclabs/cardano-ledger-ts` `AuxiliaryData.fromCbor` bug on metadata-only `aux_data`.

### Fixed

- **CSL `PPViewHashesDontMatch` on Plutus V3 — resolved.** With CSL removed, Buildooor computes the correct `scriptDataHash` for both mint and spend builds (raw-CBOR, byte-preserving body hash), so Plutus V3 transactions no longer fail script-data-hash validation on submit.
- **Buildooor no longer aborts unsigned-tx builds on local script evaluation failure** (`srv/blockchain/transaction-building/buildooor-tx.ts`, commit `8a77cbf`). Buildooor evaluates every Plutus script locally inside `build()`; unlike CSL it would throw if that evaluation errored, turning script-bearing builds (e.g. parameterized validators applied via `scriptParamsJson` + `lockOnScript`) into HTTP 500s. A shared `SCRIPT_BUILD_OPTS` with an `onScriptInvalid` handler now downgrades a local evaluation failure to a warning and still returns the unsigned CBOR + fee estimate — restoring the pre-Buildooor contract where on-chain validation at submit time is authoritative. Validators that pass local evaluation are unaffected, so genuine failures surfaced by Ogmios (`ctx.evaluateTransaction`) are still reported. Fixes the two `tx-handler-validation` cases (`scriptParams + lockOnScript + fingerprint`, `BuildPlutusSpendTransaction — lockOnScript`).
- **`extractVkeyWitnesses` parses witness pairs defensively** (`signature-verifier.ts`): a malformed or unexpected witness structure previously threw a runtime `TypeError` via unchecked CBOR casts and surfaced as an opaque internal error. Entries that are not a `[vkey, signature]` pair of byte strings are now skipped via `instanceof` guards.
- **`getTxHashFromCbor` hex validation rejects odd-length input** (`tx-build-helper.ts`): a hex byte string must be even-length, so `"abc"` now fails with the clear `Invalid input: txCbor must be a valid hex string` instead of a confusing downstream `Failed to parse transaction CBOR`.

### Removed

- **Dependency `@emurgo/cardano-serialization-lib-nodejs`** dropped from `package.json` (it remains only as a transitive, never-imported dependency of `@blockfrost/blockfrost-js`).
- **Source**: `srv/blockchain/transaction-building/csl-tx.ts` (1064 lines) and `srv/blockchain/transaction-building/tx-builder-registry.ts` (69 lines).
- **Tests**: `test/unit/csl-tx-builder.test.ts` (767 lines), `test/unit/tx-builder-registry.test.ts` (172 lines), `test/integration/tx.csl.test.ts`.

### Added

- **Dependencies** promoted to direct: `@harmoniclabs/cbor`, `@harmoniclabs/crypto`, `@harmoniclabs/uint8array-utils` (previously transitive via Buildooor; now imported directly for hashing + signature verification).

### Internal

- **`scripts/testing/lock-ada-at-script-preview.ts`** ported off CSL — `deriveScriptAddress` now uses the same server path (`Script.fromCbor(...).hash` → `scriptHashToEnterpriseAddress`) so a fresh install with CSL removed still resolves all imports and derives an identical enterprise script address.
- **Docs** refreshed to reflect the single-builder architecture: `DEVELOPER_GUIDE.md` source tree (lists `cardano-tx.ts` interface + `buildooor-tx.ts`, registry line removed), plus `QUICK_START.md`, `BACKEND_CONFIGURATION.md`, `PRODUCTION_DEPLOYMENT.md`, `TRANSACTION_WORKFLOW.md`, `INDEXING.md`, and `README.md`.
- **Test suite** migrated off the CSL/registry fixtures across `tx-handler-validation`, `signing-services`, `signing`, `cardano-tx-builder`, `server`, and the shared `tx-test-suite` harness; CI workflows (`test.yaml`, `ogmios-sync.yaml`) updated.
- Version bumped `1.7.9` → `1.8.0`.


## [v1.7.9] - 15-05-2026: Koios getCurrentSlot — wire-shape fix + /tip simplification

### Fixed

- **Koios `/block_info` mapper read `slot_no` / `epoch_slot_no`** — fields that Koios has never returned. The real wire keys are `abs_slot` and `epoch_slot` (stable since Koios v1). Symptom: every call through `KoiosBackend.getLatestBlock()` produced a `BlockData` whose `.slot` and `.epochSlot` were `undefined`, which made the v1.7.8 `getCurrentSlot()` implementation throw `ProviderUnavailableError: koios: latest block has no slot` on every chain-tip query. Cascaded into anything ttl-bounded: x402 nonce checks, ttl-bounded tx builds, `getCurrentSlot`-routed paths on Koios-only deployments. One-line mapping correction at `srv/blockchain/backends/koios-backend.ts:214-216` (`epoch_no` was already correct). Direct `getBlock(hash)` callers also benefit — previously they received a `BlockData` with `undefined` slot fields silently.

### Changed

- **`KoiosBackend.getCurrentSlot()` rewritten to read `/tip` directly.** Previously it called `getLatestBlock()`, which fetched `/tip` and then `/block_info` for that tip's hash — two round-trips for a single integer. The new implementation reads `abs_slot` straight off `/tip`. Side benefits: avoids a real race where `/tip` returns a freshly-minted hash that `/block_info` then returns `[]` for several seconds while Koios's read replicas catch up (was surfacing as a spurious `NotFoundError` propagating out of `getCurrentSlot`), and removes the chain-tip-only path's dependency on `getLatestBlock`'s mapper. Negative-path behavior preserved: empty `/tip` → `NotFoundError`, `/tip` row missing `abs_slot` → `ProviderUnavailableError`.

### Internal

- **Test fixture corrected** in `test/unit/koios-backend.test.ts`: `getCurrentSlot` mock now uses the real Koios `/tip` shape (`abs_slot` / `epoch_slot`) instead of the never-real `slot_no` / `epoch_slot_no`, which is the reason the original mapper bug slipped through unit tests. Two new negative cases added (empty `/tip` returning `NotFoundError` after 3 retries; `/tip` row missing `abs_slot` returning `ProviderUnavailableError`).
- Version bumped `1.7.8` → `1.7.9`.




## [v1.7.8] - 13-05-2026: getCurrentSlot() and isUtxoUnspent() with Multi-Backend Implementations

### Added

- **`CardanoClient.getCurrentSlot(): Promise<number>`** — convenience wrapper over `getLatestBlock().slot` with a guaranteed non-null return. Throws `ProviderUnavailableError` when the backend's latest block reports a null slot (very early chain or backend lag). Centralizes the `null` → error translation that consumers were re-inventing per call site. Method routing: `preferLive: true`.
- **`CardanoClient.isUtxoUnspent(txHash, outputIndex): Promise<boolean>`** — checks whether a UTxO is still spendable. Returns `false` for both spent UTxOs and txs that never existed on chain; throws on transport/provider failure. Replaces x402's prior 3-arg shim (`(txHash, outputIndex, holdingAddress)`) which required a separate `getTransactionByHash` to resolve the address first — saves one chain round-trip per nonce check on the facilitator happy path. Method routing: `preferLive: true`.
- **Per-backend implementations** with edge-case parity across all three providers:
  - **Blockfrost** — `/txs/{hash}/utxos` → `outputs[].consumed_by_tx` (null ⇒ unspent, string ⇒ spent). Output entries are matched by `output_index` (not array position) for defensive ordering. `consumed_by_tx` is an optional field on the Blockfrost openapi type (added in server v0.1.59, mid-2024) — if absent, ODATANO throws `ProviderUnavailableError` so the router falls through to the next backend rather than silently lying with "always true".
  - **Koios** — `POST /utxo_info` with `_utxo_refs: ["<txHash>#<index>"]` and `_extended: false` → `is_spent === false`. Empty response array maps to `false` (nonexistent UTxO). `txHash` is lowercased before building the ref to match Koios's case-sensitive lookups.
  - **Ogmios** — `queryLedgerState/utxo` with `{ outputReferences: [{ transaction: { id: txHash }, index }] }` (schema-typed param shape). Non-empty result ⇒ unspent; empty ⇒ spent OR nonexistent (Ogmios can't distinguish).
- **Fast-path on invalid `outputIndex`** — negative or non-integer values short-circuit to `false` without a network round-trip on all three backends.

### Changed

- **Error semantics for unsupported / provider-down paths** (commit `af17b46`): generic `Error` throws upgraded to typed `ProviderUnavailableError` so callers can branch on the error class and the router's circuit breaker registers them as backend failures rather than uncategorized exceptions. Affected sites:
  - `OgmiosBackend.getDrep`, `getAssetInfo`, `ensureNotShutdown` — capability mismatch + shutdown guard now carry the `ogmios` backend name on the typed error.
  - `CardanoClient.evaluateTransaction` — missing evaluating backend now throws `ProviderUnavailableError` instead of bare `Error`.
- **Transaction-validation errors in tx builders** (commit `af17b46`): missing-script-UTxO throws in `CardanoTransactionBuilder._resolveReferenceInputs` and `BuildooorTxBuilder` are now `TransactionValidationError` instead of generic `Error`. Surfaces as HTTP 400 with a structured code through `handleRequest()` rather than a generic 500.

### Fixed

- **Test typecheck cleanups** (pre-existing on `main`, unblocking `tsc --noEmit`):
  - `test/unit/cardano-tx-builder.test.ts:298` — `ScriptValidator` requires `purpose`; mock validator object was missing it.
  - `test/unit/errors.test.ts:614` — `BackendInitError.originalError` is typed `unknown`; access narrowed via `as Error | undefined`.
  - `test/unit/ogmios-backend.test.ts:500` — `ScriptValidator` is `string | { purpose, index }`; structured branch narrowed via type assertion.
  - `test/unit/plugin.test.ts` — `cds.listeners` / `cds.emit` / `cds.removeAllListeners` are runtime EventEmitter methods not on the public typed `cds` import; single typed alias `cdsBus = cds as unknown as EventEmitter` added.

### Internal

- **`CardanoBackend` interface** (`srv/blockchain/backends/cardano-backend.ts`): two new required method signatures inserted after `getLatestBlock()`. All three backends implement them — no `?:` optional escape hatch.
- **`CardanoClient` routing**: two new `METHOD_ROUTING` entries (`getCurrentSlot`, `isUtxoUnspent`, both `preferLive: true`). No request-coalescing (consistent with other live-tip methods like `getLatestBlock`).
- **Test additions** (mocked, no live preprod): `test/unit/blockfrost-backend.test.ts` (+9 cases — slot null, consumed states, out-of-range/negative index, 404, missing field), `test/unit/koios-backend.test.ts` (+7 cases — is_spent true/false/empty, lowercasing, negative + non-integer index), `test/unit/ogmios-backend.test.ts` (+5 cases — non-empty/empty result, outputReferences shape assertion, negative index), `test/unit/cardano-client.test.ts` (+4 cases — Ogmios-preferred routing + historical fallback for both methods).
- Version bumped `1.7.7` → `1.7.8`.




## [v1.7.7] - 06-05-2026: Self-Hosted Blockfrost-Compatible Backends

### Added

- **`blockfrostCustomBackend` config + `BLOCKFROST_CUSTOM_BACKEND` env var**: optional base URL that redirects ODATANO's Blockfrost backend at a Blockfrost-wire-compatible self-hosted node — Dolos MiniBF, Demeter Self-Hosted, or any compatible proxy. Forwarded straight through to `@blockfrost/blockfrost-js`'s upstream `customBackend` option; the entire Blockfrost surface (blocks, txs, utxos, assets, governance, mint history) works against the self-hosted node with zero ODATANO-side mapping changes.
- **API key becomes optional** when `BLOCKFROST_CUSTOM_BACKEND` is set: the `BlockfrostBackend` constructor now accepts `(network, timeoutMs, projectId, customBackend?)` and requires only `projectId OR customBackend` (matching the upstream SDK validator at `@blockfrost/blockfrost-js/lib/utils/index.js`). When pointed at a customBackend without a key, ODATANO sends `self-hosted` as the `project_id` header — Dolos rejects empty header values even though it doesn't authenticate against them. Startup-log line `Blockfrost will use customBackend: <url>` makes the redirect visible to operators.
- **`CardanoClientConfig.blockfrostCustomBackend?: string`** added to the public TypeScript surface (re-exported from `src/index.ts`). Additive — non-breaking.

### Changed

- **`loadConfigFromEnv` warning** at `srv/server.ts`: the `BLOCKFROST_API_KEY is not set` warning now fires only when both `BLOCKFROST_API_KEY` AND `BLOCKFROST_CUSTOM_BACKEND` are empty — previously a confusing warning would appear for self-hosted setups that only set the URL.

### Internal

- **Light URL validation**: `loadConfigFromEnv` rejects `BLOCKFROST_CUSTOM_BACKEND` values that do not begin with `http://` or `https://` upfront, with a clear error message — matches the existing throw style used for timeout validation.
- **Test additions**: `test/unit/blockfrost-backend.test.ts` constructor describe block expanded to 6 cases (missing-both error path, projectId-only, customBackend-only, customBackend forwarded into SDK, dummy `'self-hosted'` substitution, customBackend omitted when absent). New `test/integration/blockfrost-custom-backend.test.ts` (4 cases) exercises the real SDK against `nock` — the only way to prove URL forwarding actually works end-to-end vs. just being stored on the options object.
- Version bumped `1.7.6` → `1.7.7`.


## [v1.7.6] - 02-05-2026: Inline Datums, Credential Queries, Asset Info, Mint/Burn History

Driven by CHAINFEED's Sprint-1 oracle-adapter integration feedback. Goal: every direct Koios/Blockfrost call CHAINFEED currently bypasses the bridge with should be routable through ODATANO instead.

### Added

- **Inline-datum hydration on `AddressUTxOs`**: `utxodata.inlineDatum` is now populated for every UTxO returned by `GetUTxOsByAddress` / `Addresses.utxos` / cached child rows. Previously the field existed in the schema but was discarded by the Blockfrost mapper, which forced consumers (e.g. Indigo CDP / Liqwid / Minswap V2 readers) to issue ~500 extra `GetTransactionByHash` calls per protocol-state read. New helper `inlineDatumToHex(datum)` in `srv/utils/tx-build-helper.ts` normalizes Blockfrost's CBOR-hex strings, Koios's `_extended` `{bytes, value}` wrapper, and raw `PlutusData` JSON forms to a single canonical lowercase hex CBOR — consistent regardless of which backend served the row.
- **`GetUTxOsByCredential` action** on `CardanoODataService`: returns UTxOs across **all** bech32 forms sharing a 28-byte payment credential (key hash or script hash). Solves the Indigo-style "two bech32 variants of the same script" problem (`addr1z…` with stake-cred vs `addr1w…` without) with a single round-trip. Always-fresh fetch (no cache check) — credential queries serve dApp state-read use cases that need current data. New backend method `getCredentialUtxos(credHash)`, new indexer method `indexCredentialUtxos`, new validator `isValidCredential(s)` (56-char lowercase hex) backed by `HEX_56_REGEX` in `srv/utils/const.ts`. **Koios-only** — `CardanoClient.getCredentialUtxos` throws `ProviderUnavailableError` on Blockfrost-/Ogmios-only deployments rather than silently returning incomplete results from a one-bech32 fallback. Concurrent calls for the same credential are deduplicated through a new `credCoalescer` (analogous to the existing `txCoalescer` / `addrCoalescer`).
- **`Assets` entity + `GetAssetInfo` action**: native-asset metadata lookup (total supply, mint/burn count, initial mint tx, CIP-25 on-chain metadata, CIP-26 off-chain Cardano-Foundation registry fields). Closes the gap that previously forced consumers to call Blockfrost / Minswap directly for supply telemetry. Multi-backend (Blockfrost via `assetsById`, Koios via `POST /asset_info`); Ogmios throws "not supported". Backend divergence is documented in the action description: Blockfrost lacks `initialMintTime` (would need an extra tx fetch), Koios provides it from `creation_time`. New `mapAsset(providerData, max_age)` mapper, new `indexAsset(tx, unit)` indexer method.
- **`AssetHistory` entity + `GetAssetHistory(unit, limit)` action**: paged mint/burn-event lookup for "supply growth rate" telemetry (CHAINFEED Sprint-2 use case for DJED / iUSD adapters). Free-standing (not a Composition) and `@readonly` because mint events are immutable on-chain — UPSERT keyed on `(unit, txHash)` is idempotent. **Koios-preferred routing** in `CardanoClient.getAssetHistory` (provides block timestamps via `block_time`); Blockfrost is the fallback and now backfills `blockTime` / `blockHeight` via concurrent `api.txs(...)` calls (cost: 1 extra API call per history entry, capped at `MAX_CONCURRENT = 10`; failed fetches leave the timestamp fields null rather than aborting the whole call). Both backends derive `action: 'mint' | 'burn'` and absolute `quantity`: Blockfrost from the `action: 'minted'/'burned'` enum, Koios from the sign of `quantity`.
- **`Addresses.utxoCount`**: pre-aggregated UTxO count on the `Addresses` entity. Removes the need for dashboard / health-check consumers to fetch and `.length` the full UTxO array client-side. Populated from the existing `getAddress` response — no extra API call.

### Changed

- **Inline-datum format harmonized across backends**. Previously `AddressUTxOs.utxodata.inlineDatum` and `TransactionInputs/Outputs.utxoData.inlineDatum` could carry hex CBOR (Blockfrost), JSON-stringified PlutusData (Koios `getAddressUtxos`), or a raw object wrapper (Koios `getTransaction`). All three paths now route through `inlineDatumToHex(...)` and produce hex CBOR or `null`. Cached rows from before this release have stale formats until their TTL expires.
- **`Buildooor _parseInlineDatum` removed** from `srv/blockchain/transaction-building/buildooor-tx.ts` — the JSON-string and raw-object branches became defensive dead code after the inline-datum normalization. The remaining call site at `_mapMultiAssetUtxoToLedgerUtxo` now invokes `dataFromCbor(utxo.inlineDatum)` directly. Corresponding branch-coverage tests removed from `test/unit/buildooor-tx-builder.test.ts`.
- **CDS using-clauses**: `db/schema.cds` now imports `Blake2b224` and `HexBytes` (used by the new `Assets` entity); `srv/cardano-service.cds` now imports `AssetUnit` (used as parameter type on the two new asset actions).

### Internal

- **CardanoClient routing matrix expanded** — `getAssetInfo` (preferLive: false, both Blockfrost + Koios), `getAssetHistory` (Koios-preferred, Blockfrost-fallback), `getCredentialUtxos` (Koios-required, throws otherwise). The Koios-/Blockfrost-/Ogmios-feature matrix is now documented in `.claude/CLAUDE.md` under "Backend-Specific Features (no fallback)".
- **Test additions**: `test/unit/tx-build-helper.test.ts` (12 cases for `inlineDatumToHex`), `test/unit/validators.test.ts` (5 cases for `isValidCredential`), `test/unit/blockfrost-backend.test.ts` (+8 cases: address-utxos hydration + asset-info + asset-history), `test/unit/koios-backend.test.ts` (+12 cases: credential-utxos + asset-info + asset-history), `test/unit/cardano-client.test.ts` (4 cases for credential-routing hard-fail), `test/unit/cardano-indexer.test.ts` (+8 cases for `indexCredentialUtxos` / `indexAsset` / `indexAssetHistory`), `test/unit/mappers.test.ts` (+5 cases for `mapAsset`, `mapAssetHistory`, `Address.utxoCount`).
- Version bumped `1.7.5` → `1.7.6`.

### Known limitations

- **Asset entity field availability differs per backend**: `initialMintTime` is null on Blockfrost (would require 1 extra tx fetch per asset); CIP-25 `onchainMetadata` shape varies per minter and is stored as a JSON-stringified `LargeString` (consumers parse it). The action `@description` calls this out.
- **`AddressUTxOs` rows from before this release**: `utxoCount` and the new normalized `inlineDatum` only appear after the parent address's TTL (`indexTtlMs`, default 1 h) lapses and `indexAddress` re-runs.
- **`AssetHistory` Blockfrost cost**: backfilling block metadata costs 1 extra `api.txs(...)` call per entry (see `Added`). For `limit=100`, that's ≤101 Blockfrost calls; consumers paying per-call should size `limit` appropriately. Concurrency capped at `MAX_CONCURRENT = 10`.


## [v1.7.5] - 27-04-2026 - CBOR Tx Parsing + Script Address Utilities + Validity Bounds

### Added

- **`ParseTransactionCbor` action** on `CardanoODataService`: decodes a hex-encoded transaction CBOR (signed or unsigned) into a structured representation (inputs/outputs/fee/witnesses/auxiliary data). Implementation lives in pure utilities at `srv/cbor/parse.ts` and is re-exported from `src/index.ts` for direct programmatic use.
- **CBOR hex validation** for `ParseTransactionCbor`: explicit length cap and hex-shape checks reject oversized payloads upfront (memory-exhaustion guard) and surface dedicated error codes from `srv/utils/error-codes.ts`.
- **`lockOnScript` flag** on `BuildPlutusSpendTransaction`: when `true`, change is sent back to the script address instead of the sender — required for stateful validators that must keep their UTxO under the script.
- **`DeriveScriptAddress` action**: derives the bech32 script address (network-aware) from a Plutus V3 validator hex, optionally applying script parameters first. Useful for clients that need the address before locking funds.
- **`ExtractPaymentKeyHash` action**: bech32-decodes a payment address and returns the 28-byte payment credential hash — convenience for building required-signers / datum fields client-side.
- **Validity-window bounds** (`validityStartMs` / `validityEndMs`): both Build endpoints accept Posix-ms validity bounds. Buildooor converts via `posixToSlot()` using `GENESIS_INFOS_BY_NETWORK` (const.ts); CSL still ignores them pending the PPViewHashesDontMatch fix.

### Changed

- **Buildooor validity-window passthrough**: when no explicit bounds are provided, Buildooor falls back to `DEFAULT_VALIDITY_START_OFFSET_MS` (-2 min) / `DEFAULT_VALIDITY_END_OFFSET_MS` (+1 h) to absorb clock skew while staying generous for human sign+submit latency.
- **`getTxHashFromCbor` parameter rename**: `signedTxCbor` → `txCbor`. The function accepts both signed and unsigned CBOR (hash is body-only). JSDoc and validation error messages updated accordingly.
- **`BlockfrostBackend` constructor**: network is now passed explicitly into `BlockFrostAPI` to fix preprod initialization, which previously fell back to mainnet under certain `cardanoNetwork` resolution paths.
- **Validity-bounds validation** added to `validateTransactionInputs()`: rejects non-numeric values, negative timestamps, more than `MAX_POSIX_MS_DIGITS` (13) digits, and `validityStartMs > validityEndMs`.

### Fixed

- **Forced/reference input UTxO synthesis**: `_resolveForceInputs` and `_resolveReferenceInputs` now copy `dataHash` and `referenceScriptHash` from `Transaction.outputs[]` into the synthesized `UTxO`'s `datumHash` / `scriptRef` fields. Previously dropped, which prevented Buildooor input-side ref-script preservation from seeing them on resolved (non-sender) UTxOs.
- **`forcedInputsUsed` accuracy** (CSL): mint and Plutus-spend paths now derive the count from the actual `_partitionForcedInputs` result instead of `req.forceInputs.length`. Eliminates over-count from request-side duplicates and refs not present in `ctx.utxos`. The Plutus-spend path additionally subtracts the script-UTxO ref so it never counts toward forced inputs.
- **`MAX_POSIX_MS_DIGITS` doc**: corrected the comment ("year 9999" → "Unix ms timestamps through ~Nov 2286"). The 13-digit cap itself is unchanged.

### Internal

- New `srv/cbor/` module: `parse.ts` (decoder) + `index.ts` (barrel). Pure utilities — no CSL or Buildooor dependency.
- Version bumped `1.6.1` → `1.7.5`. Intermediate `1.7.0`–`1.7.3` were not released externally.

## [v1.6.1] - 18-04-2026 - CIP-33 Reference Scripts + Buildooor 0.2.6 Upgrade

### Added

- **CIP-33 reference script deploy** (`referenceScriptHex` parameter): attach a Plutus V3 validator as a referenceScript on the primary output so consumers can deploy ref-scripts through ODATANO instead of bypassing it.
  - Available on `BuildSimpleAdaTransaction`, `BuildMultiAssetTransaction`, `BuildMintTransaction`, `BuildPlutusSpendTransaction`.
  - Supported by both Buildooor and CSL builders. CSL uses `PlutusScript.new_v3()` (CBOR-wrapped) per the v15 hashing rule.
  - Note: attaching a ref script inflates output min-ADA significantly (typically 15–30+ ADA depending on script size). Consumers must supply enough `lovelaceAmount` to cover it — a `TransactionValidationError` is thrown upfront with the required min-ADA if underfunded.
- **Per-extraOutput `referenceScriptHex`**: each entry in `extraOutputsJson` may now carry its own `referenceScriptHex`, enabling "spend + deploy ref-script on a dedicated extra output" flows in a single atomic transaction.
- **Input-side `refScript` preservation** (Buildooor only, Koios-sourced UTxOs): when a forced or reference input carries its ref-script bytes, the Buildooor UTxO mapper now passes them through for local Plutus evaluation. Blockfrost and Ogmios backends return hash-only `scriptRef` today — those UTxOs continue to resolve server-side at validation.

### Changed

- **Buildooor upgrade**: `@harmoniclabs/buildooor` bumped from `^0.1.28` to `^0.2.6`. Buildooor's public API is byte-identical between these versions; the migration is driven entirely by transitive deps.
- **Cardano ledger types**: `@harmoniclabs/cardano-ledger-ts` bumped from `^0.4.6` to `^0.5.1`.
- **Cost models**: `@harmoniclabs/cardano-costmodels-ts` bumped from `~1.3.0` to `~1.4.0`. The 1.4.0 API dropped `.toBuffer()` on `costModelsToLanguageViewCbor()` return values, now a raw `Uint8Array`.
- **CBOR / UPLC encoding sites**: removed `.toBuffer()` on nine call sites in `buildooor-tx.ts`, `csl-tx.ts`, `signing-helper.ts`, `hsm-signer.ts`, `tx-build-helper.ts`, and two integration test sites. The `@harmoniclabs/cbor` 2.x and `@harmoniclabs/uplc` 2.x packages now return `Uint8Array` directly, matching `toHex()` consumption.
- **`applyScriptParameters` (tx-build-helper.ts)**: rewritten for uplc 2.x — `compileUPLC()` now returns `Uint8Array` directly; output `toString()` replaced with `toHex()` (needed because `Uint8Array.toString()` returns a CSV of bytes, not hex).
- **Blockfrost-js pin**: `@blockfrost/blockfrost-js` narrowed from `^6.0.0` to `~6.0.0` to keep nock-based test mocks aligned with the 6.0.x HTTP behaviour (6.1.x retries trigger `times()` mock exhaustion).

### Fixed

- **Buildooor transaction build crashes** with `costModelsToLanguageViewCbor(...).toBuffer is not a function` — root cause was the v1.5.x `cardano-costmodels-ts` pin leaking 1.4.0 through the `^` range. The Buildooor upgrade + removed `.toBuffer()` calls close this permanently.
- **Test suite hygiene** (caused by transitive-dep drift, not production regressions):
  - `cardano-client.test.ts`: `setupBlockfrostHealthMock` was mocking `/api/health`, but `BlockfrostBackend.init()` hits `/api/v0/blocks/latest`. Corrected, plus added `.times(5)` on 500-response mocks to absorb got's default 5xx retries during init.
  - `koios-backend.test.ts`: `fetchWithRetryOnEmpty` performs 1 initial + 3 retries = 4 attempts. Two tests that mocked `.times(2)` were leaking unhandled async errors (via the 2000 ms retry `setTimeout`) into subsequent tests. Corrected to `.times(4)`.
  - `error-paths.test.ts` circuit-breaker test: `nock.pendingMocks()` counting was unreliable because got's internal retries consume multiple HTTP requests per backend-level call. Replaced with `jest.spyOn(backend, 'getNetworkInformation')` to count backend invocations directly.
  - `hsm-signer.test.ts`: `jest.mock('pkcs11js', ...)` now uses `{ virtual: true }` so the suite runs on machines without the optional `pkcs11js` native module installed.
  - `server.test.ts`: removed the stale "should rethrow served hook initialization errors" test — contradicts the served hook's intentional error-swallow (plugin contract: host app must not crash on plugin init failure).

### Internal

- CDS `extraOutputsJson` `@description` expanded to document the new per-entry `referenceScriptHex` field.
- Version bumped `1.5.2` → `1.6.1` (first 1.6.x release).

### Known limitations

- **Hash-only `scriptRef` resolution**: Blockfrost and Ogmios return `referenceScriptHash` only, not the script bytes. A future release may add a `/scripts/{hash}/cbor` resolver so hash-only UTxOs reach Koios parity for local Plutus evaluation.
- **CSL still rejects `__INPUT_IDX__` placeholders**: input-index placeholder substitution remains Buildooor-only (CSL's coin selection is opaque to enumeration).

### Follow-ups (deferred)

- `/scripts/{hash}/cbor` resolver across all three backends.
- Normalizing `UTxO.scriptRef` into separate `referenceScriptHash` and `referenceScript` fields (currently overloaded).
- Upgrading Buildooor beyond 0.2.6.

---

## [v1.0] - 12-03-2026 - Production Release

### Added

- **Request Coalescing**: Deduplicates concurrent backend requests for the same resource, reducing redundant API calls and improving performance under load
- **CardanoIndexer Unit Tests**: 19 new tests covering entity mapping, cache TTL validation, error handling, and metadata indexing edge cases
- **Request Coalescer Tests**: 3 new tests for concurrent deduplication, retry-after-failure, and key isolation
- **Expanded Test Coverage**: Additional branch coverage tests for validators, backends, transaction handlers, and builders

### Changed

- **Hardened Error Handling**: Improved null/undefined guards across service layer, address flags, and debug logging
- **Protocol Parameters Refresh**: Hardened refresh logic with improved input validation and datum mapping
- **Koios Backend Resilience**: Added retry-on-empty-array for block and epoch queries, null/array validation before array access
- **Service Layer Resilience**: Strengthened error propagation, edge case handling, and fallback behavior
- **Performance Optimizations**: Batch methods and request coalescing for transaction fetching (N+1 query elimination)
- **Authentication**: Added `@requires: 'authenticated-user'` on all 3 services with XSUAA production configf

### Fixed

- Type safety improvements across codebase
- Edge cases in protocol parameter parsing and cost model handling
- Plutus datum mapping errors for spend transactions with Koios/Buildooor combination
- Various small bugs in backend logic and service handlers

### Documentation

- Updated all documentation to v1.0
- Reworked performance report with raw benchmark result files
- Updated test statistics: 31 test suites (21 unit + 10 integration), 1285 tests, 99% statement coverage

### Stats

- **Test Suites**: 31 (21 unit + 10 integration)
- **Tests**: 1285 (all passing)
- **Statement Coverage**: 99%
- **CDS Entities**: 29
- **Actions**: 34 (15 read + 11 transaction + 8 signing)
- **Services**: 3 (CardanoODataService, CardanoTransactionService, CardanoSignService)
- **Backends**: 3 (Blockfrost, Koios, Ogmios)

---

## [v0.3-milestone3] - 26-02-2026 - Milestone 3: External Signing & SAP Integration

### Added

- **External Signing Module**: Complete external signing workflow with private key isolation
  - `ExternalSignerModule` - Signing request creation and workflow management
  - `SignatureVerifier` - Cryptographic signature verification
  - CIP-30 browser wallet support (Nami, Eternl, Yoroi, etc.)
  - Cardano CLI signing support
  - HSM signing support (PKCS#11 compatible hardware wallets)

- **CardanoSignService** (`/odata/v4/cardano-sign/`): New dedicated signing workflow service (3rd CDS service)

- **5 New Entities** for signing workflow:
  - `SigningRequests` - Unsigned transaction export with TTL-based expiration
  - `SignatureVerifications` - Cryptographic verification results and audit trail
  - `AddressSigningRequests` - Address-to-signing-request associations
  - `AddressTransactionBuilds` - Address-to-build associations
  - `AddressTransactions` - Address transaction history with net amounts

- **5 External Signing Actions** (OData POST endpoints on CardanoSignService):
  - `CreateSigningRequest` - Create signing request for external signing
  - `GetSigningRequest` - Retrieve signing request (auto-expires if TTL exceeded)
  - `VerifySignature` - Cryptographically verify signed transaction
  - `SubmitVerifiedTransaction` - Verify and submit in one step
  - `GetSigningRequestsByAddress` - Get signing requests for an address

- **Centralized App Context Architecture**: Refactored initialization in `server.ts`
  - `getAppContext()` - Get singleton application context
  - `getCardanoIndexer()` - Convenience function for services
  - `getCardanoClient()` - Convenience function for services
  - `createTestContext()` - Create isolated test contexts
  - `shutdownAppContext()` - Graceful connection cleanup

- **CIP-30 Wallet Integration**:
  - `combineTransactionWithWitnesses()` - Combine unsigned TX with CIP-30 witness set
  - `isWitnessSetCbor()` - Detect witness set vs full transaction
  - Automatic handling in SubmitVerifiedTransaction

- **HSM Signing Integration** (Hardware Security Module):
  - `SignWithHsm` - Sign transaction using configured HSM (PKCS#11)
  - `SignAndSubmitWithHsm` - Sign and submit transaction atomically via HSM
  - `GetHsmStatus` - Check HSM connection status, key info, and Cardano address

- **Signing Workflow States**: `SigningStatus` enum
  - `pending` - Request created, awaiting signing
  - `signed` - Transaction has been signed
  - `verified` - Signature verified, ready for submission
  - `submitted` - Transaction submitted to network
  - `expired` - Request expired (30 minute default TTL)
  - `failed` - Signing or verification failed

- **New Test Suites** (5 new test files):
  - `signing-services.test.ts` - External signing integration tests
  - `signing.test.ts` - SignatureVerifier and ExternalSignerModule unit tests
  - `hsm-signer.test.ts` - HSM signer unit tests
  - `cip14-fingerprint.test.ts` - CIP-14 asset fingerprint computation tests
  - `tx-build-helper.test.ts` - Transaction build helper utility tests

- **Production Deployment Guide**: `PRODUCTION_DEPLOYMENT.md` with deployment patterns (incl. BTP)

- **SAP Integration Examples**: New guide with detailed examples of SAP workflows integrated with ODATANO, including screenshots and ABAP code snippets for real-world use cases (e.g., invoice payment verification, tokenized asset management)

- **Security Guide**: `SECURITY.md` with best practices for secure deployment, key management, and external signing workflows

- **Postman Collection M3**: Pre-configured requests for all M3 endpoints (signing, Plutus, HSM)

- **2 New Transaction Actions** (Plutus Smart Contracts & Collateral):
  - `BuildPlutusSpendTransaction` - Spend UTxO locked at a Plutus validator script address (supports PlutusV3, redeemer/datum JSON, Ogmios execution unit evaluation, optional `inlineDatumJson` for state-machine continuing outputs)
  - `SetCollateral` - Ensure a dedicated ADA-only collateral UTxO exists for Plutus transactions (auto-checks address UTxOs, builds self-send if needed)

- **End-to-End Plutus Scripts**:
  - `lock-ada-at-script-preview.ts` - Lock ADA at a PlutusV3 script address with inline datum
  - `plutus-spend-preview.ts` - Spend locked UTxO with redeemer, verified on Preview testnet
  - `send-ada-hsm-preview.ts` - HSM signing workflow on Preview testnet
  - `sign-cbor.ts` - Offline CBOR signing (Cardano CLI pattern)

- **Plutus Parameterized Validator Support**:
  - `scriptParamsJson` on `BuildMintTransaction` and `BuildPlutusSpendTransaction` — apply UPLC parameters to unapplied validators, returns `scriptHash` (= policy ID)
  - `requiredSignersJson` — set `required_signers` in tx body for Plutus `extra_signatories` checks
  - `inlineDatumJson` on `BuildMintTransaction` — attach inline datum on minted token output (for spend validators that read `InlineDatum`)
  - `inlineDatumJson` on `BuildPlutusSpendTransaction` — attach inline datum on continuing output (state-machine patterns)
  - `mintRedeemerJson` — custom redeemer for minting policy (defaults to integer 0)
  - `fingerprint` — CIP-14 asset fingerprint (`asset1...`) returned in `BuildMintTransaction` response

- **`lockOnScript`** on `BuildMintTransaction` and `BuildPlutusSpendTransaction`:
  - When `true` and `scriptParamsJson` is provided, routes the output to the enterprise script address derived from the applied script hash
  - Returns `scriptAddress` (bech32) in the response — eliminates consumer-side script address computation
  - New `scriptAddress` field on `TransactionBuilds` entity

- **Extended Transaction Actions for Script Locking**:
  - `BuildSimpleAdaTransaction` now supports optional `outputDatumJson` and `assetsJson` — send ADA + native assets with inline datum to script addresses
  - `BuildMultiAssetTransaction` now supports optional `outputDatumJson` — attach inline datum when sending assets to script addresses

### Changed

- Architecture refactored to centralized App Context pattern
- Services now use `getCardanoIndexer()` instead of direct instantiation
- Test suite updated: 29 test files (19 unit + 10 integration), 1122 tests
- Enhanced error handling with signing-specific error cases

---

## [v0.2-milestone2] - 2025-01-25 - Milestone 2: Transaction Build & Submit

### Added

- **Transaction Builder Module**: Dual-builder architecture with CSL (Cardano Serialization Lib) and Buildooor engines
- **Transaction Types**: Support for 4 transaction types
  - Simple ADA transfers
  - Token minting with policy scripts
  - Multi-asset transfers (ADA + native tokens)
  - Transactions with metadata
- **6 Transaction Actions** (OData POST endpoints):
  - `BuildSimpleAdaTransaction` - Build simple ADA transfer
  - `BuildTransactionWithMetadata` - Build ADA transfer with metadata
  - `BuildMintTransaction` - Build token minting transaction
  - `BuildMultiAssetTransaction` - Build multi-asset transfer
  - `SubmitTransaction` - Submit signed transaction to Cardano
  - `SubmitSignedTransaction` - Submit externally built transaction
- **Ogmios Live Backend**: WebSocket-based real-time data access for protocol parameters, UTxO queries, and transaction submission
- **TX Builder Registry**: Factory pattern for runtime builder selection and initialization
- **End-to-End Example Scripts**:
  - `send-ada-preview.ts` - Simple ADA transfer workflow
  - `mint-token-preview.ts` - Token minting workflow
  - `send-ada-with-metadata-preview.ts` - Metadata transaction workflow
  - `send-multi-asset-preview.ts` - Multi-asset transfer workflow
- **Postman Collection M2**: Pre-configured requests for all transaction endpoints
- **Transaction Error Handling**: 5 specialized error scenarios
  - Insufficient funds (`ODATANO_INSUFFICIENT_FUNDS`)
  - Invalid input data (`ODATANO_INVALID_INPUT`)
  - Invalid signature (`ODATANO_TX_VALIDATION_FAILED`)
  - Network failure (`ODATANO_PROVIDER_UNAVAILABLE`)
  - Duplicate transaction (`ODATANO_TX_ALREADY_SUBMITTED`)
- **327 new tests** (6 new test suites): Ogmios Tests, Transaction builder tests (CSL, Buildooor), mocked submission tests, error handling tests
- **Transaction Workflow Documentation**: Build → Sign → Submit flow guide

### Changed

- Extended multi-provider architecture: Ogmios (live) + Blockfrost (primary historical) + Koios (fallback)
- Updated test suite: 692 tests across 19 test suites (from 340 tests / 11 suites)
- Enhanced error handling with 8 specialized error classes

### Technical Details

- UTXO selection: LargestFirstMultiAsset strategy
- Fee calculation: Based on current protocol parameters
- Output format: CBOR hex (unsigned transactions)
- External signing: Cardano CLI, browser wallets, hardware wallets supported

---

## [v0.1-milestone1] - 2024-12-29 - Milestone 1: OData Read Service

### Added

- **Project Infrastructure**
  - Public GitHub repository with Apache 2.0 license
  - SAP CAP project structure with complete scaffolding
  - CI/CD pipeline with automated tests on Node.js 20.x and 22.x
  - Code coverage reporting via Codecov (96%+ statement, 81%+ branch)
  - Docker deployment support

- **OData V4 Service** (`/odata/v4/cardano-odata`)
  - Full OData V4 query support: `$filter`, `$select`, `$expand`, `$top`, `$skip`, `$count`, `$orderby`
  - SAP Fiori UI annotations for rapid UI development
  - Multi-network support: mainnet, preview, preprod

- **18 Entities** defining Cardano Core Components:
  - `NetworkInformation` - Network statistics (supply, stake)
  - `Blocks` - Block headers
  - `Epochs` - Epoch summaries
  - `Transactions` - Transaction details with inputs/outputs
  - `TransactionInputs` - Inputs of a transaction
  - `TransactionOutputs` - Outputs of a transaction
  - `TransactionInputAssets` - Assets per transaction input
  - `TransactionOutputAssets` - Assets per transaction output
  - `TransactionMetadata` - Transaction metadata by tx + label
  - `Addresses` - Address balances and metadata
  - `AddressAssets` - Native assets at an address
  - `AddressUTxOs` - Unspent outputs at an address
  - `UTxOAssets` - Assets contained in a specific UTxO
  - `Pools` - Stake pools
  - `Accounts` - Stake accounts
  - `Dreps` - Delegated representatives
  - `AddressTransactions` - Address transaction history
  - `LedgerProtocolParameters` - Protocol parameters

- **15 Read Actions** (OData POST endpoints):
  - `GetNetworkInformation`
  - `GetBlockByHash`
  - `GetEpochByNumber`
  - `GetTransactionByHash`
  - `GetMetadataByTxHash`
  - `GetAddressByBech32`
  - `GetUTxOsByAddress`
  - `GetAssetsByAddress`
  - `GetPoolById`
  - `GetAccountByStakeAddress`
  - `GetDrepById`
  - `GetLatestTransactionsByAddress`
  - `GetLatestBlock`
  - `GetLatestEpoch`
  - `GetLedgerProtocolParameters`

- **Multi-Provider Architecture**
  - Blockfrost (primary, 8s timeout)
  - Koios (fallback, 10s timeout)
  - Automatic failover on timeout, network error, or backend error
  - Response normalization into canonical internal data model

- **Lazy On-Demand Indexing**
  - Data fetched from Cardano on first access
  - Persisted with TTL-based refresh (configurable via `INDEX_TTL_MS`)
  - Temporal entities: only currently valid rows returned
  - No background jobs; all refresh is request-driven

- **Input Validation**
  - Transaction/pool/drep IDs: 64-char hex validation
  - Addresses: network-aware bech32 validation
  - Stake addresses: network-aware bech32 stake HRP validation

- **340 Tests** across 11 test suites:
  - Integration tests for Blockfrost and Koios backends
  - OData query feature tests
  - Error handling and failover tests
  - Input validation tests

- **Documentation Package**
  - Quick Start Guide
  - Developer Guide (architecture, setup, development)
  - User Guide (deployment, querying, examples)
  - Docker Deployment Guide
  - Data Model Documentation
  - Indexing Concept Documentation
  - Error Handling Documentation
  - Postman Collection M1

### Technical Stack

- SAP CAP v9.x
- TypeScript v5.9
- Node.js v20.x / v22.x
- SQLite (persistent caching via @cap-js/sqlite)
- Jest v29.x (testing)

---

## Links

- [GitHub Repository](https://github.com/ODATANO/ODATANO)
- [v1.0 Release](https://github.com/ODATANO/ODATANO/releases/tag/v1.0)
- [Milestone 1 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.1-milestone1)
- [Milestone 2 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.2-milestone2)
- [Milestone 3 Release](https://github.com/ODATANO/ODATANO/releases/tag/v0.3-milestone3)
- [Catalyst Proposal](https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk)
