// Secondary indexes the CDS model cannot declare, created at start. Temporal keys start with validFrom,
// so lookups by business key would scan without them. Failures are logged, never fatal.
// HANA is skipped because it has no CREATE INDEX IF NOT EXISTS.
import cds from '@sap/cds';

const logger = cds.log('DbIndexes');

export interface IndexSpec {
  /** Index name; lower case, table-prefixed, so it cannot collide across tables. */
  name: string;
  /** Table name as @cap-js creates it (namespace_Entity). */
  table: string;
  /** Column list, comma separated, in the order the lookups use. */
  columns: string;
  /** PostgreSQL spelling when it differs (SQLite knows no NULLS in an index definition). */
  postgres?: string;
}

/** Every entry answers a query the service or the crawler actually runs. */
export const DB_INDEXES: readonly IndexSpec[] = Object.freeze([
  // Blocks: latest (ORDER BY height DESC), byHeight, crawler `height in`, rollback `slot >`, epoch filters
  { name: 'odatano_cardano_blocks_height', table: 'odatano_cardano_Blocks', columns: 'height' },
  // CAP renders `$orderby=height desc` as DESC NULLS LAST, which the plain ASC NULLS LAST
  // index cannot serve backwards; the plain one stays for ASC and equality.
  { name: 'odatano_cardano_blocks_height_desc', table: 'odatano_cardano_Blocks', columns: 'height DESC', postgres: 'height DESC NULLS LAST' },
  // NULLS FIRST serves both orders CAP renders by default: ASC NULLS FIRST and, read backwards, DESC NULLS LAST
  { name: 'odatano_cardano_blocks_slot_nf', table: 'odatano_cardano_Blocks', columns: 'slot', postgres: 'slot NULLS FIRST' },
  { name: 'odatano_cardano_blocks_epoch', table: 'odatano_cardano_Blocks', columns: 'epochNumber' },
  // the first block at or after a point in time (`$filter=time ge …&$orderby=time`)
  // CAP sorts a nullable column as ASC NULLS FIRST or DESC NULLS LAST on PostgreSQL; this serves both
  { name: 'odatano_cardano_blocks_time', table: 'odatano_cardano_Blocks', columns: 'time', postgres: 'time NULLS FIRST' },
  // block counts per pool (Pools.blocksEpoch / blocksMinted from crawled blocks)
  { name: 'odatano_cardano_blocks_slotleader', table: 'odatano_cardano_Blocks', columns: 'slotLeader, slot' },
  // Transactions of a block in block order (rollback `blockHash in`, GetBlockTransactions)
  { name: 'odatano_cardano_transactions_block_idx', table: 'odatano_cardano_Transactions', columns: 'blockHash, txIndex' },
  { name: 'odatano_cardano_transactions_height', table: 'odatano_cardano_Transactions', columns: 'blockHeight' },
  // Input/output rows back to their transaction (`tx` association, stale-seq check of the crawler)
  { name: 'odatano_cardano_transactions_txseq', table: 'odatano_cardano_Transactions', columns: 'txSeq' },
  // GetMetadataByTxHash, rollback
  { name: 'odatano_cardano_transactionmetadata_tx', table: 'odatano_cardano_TransactionMetadata', columns: 'tx_hash' },
  { name: 'odatano_cardano_transactionmetadata_label_seq', table: 'odatano_cardano_TransactionMetadata', columns: 'id, txSeq' },
  // rollback `txHash in` (key is unit, txHash); newest events of a unit
  { name: 'odatano_cardano_assethistory_tx', table: 'odatano_cardano_AssetHistory', columns: 'txHash' },
  { name: 'odatano_cardano_assethistory_unit_height', table: 'odatano_cardano_AssetHistory', columns: 'unit, blockHeight DESC', postgres: 'unit, blockHeight DESC NULLS LAST' },
  // temporal entities: the business key behind validFrom
  { name: 'odatano_cardano_assets_unit', table: 'odatano_cardano_Assets', columns: 'unit' },
  { name: 'odatano_cardano_addresses_address', table: 'odatano_cardano_Addresses', columns: 'address' },
  { name: 'odatano_cardano_addressutxos_address', table: 'odatano_cardano_AddressUTxOs', columns: 'address_address' },
  { name: 'odatano_cardano_addressassets_address', table: 'odatano_cardano_AddressAssets', columns: 'address_address' },
  { name: 'odatano_cardano_utxoassets_address', table: 'odatano_cardano_UTxOAssets', columns: 'utxo_address_address' },
  // rollback `hash in` / `utxo_hash in`: the keys start with validFrom and the address
  { name: 'odatano_cardano_addressutxos_hash', table: 'odatano_cardano_AddressUTxOs', columns: 'hash' },
  { name: 'odatano_cardano_utxoassets_hash', table: 'odatano_cardano_UTxOAssets', columns: 'utxo_hash' },
  // rollback `snapshotSlot >`: the keys start with the epoch
  { name: 'odatano_cardano_poolepochsnapshots_slot', table: 'odatano_cardano_PoolEpochSnapshots', columns: 'snapshotSlot' },
  { name: 'odatano_cardano_drepepochsnapshots_slot', table: 'odatano_cardano_DrepEpochSnapshots', columns: 'snapshotSlot' },
  // every pool or DRep of one epoch; the keys start with the pool or DRep
  { name: 'odatano_cardano_poolepochsnapshots_epoch', table: 'odatano_cardano_PoolEpochSnapshots', columns: 'epoch' },
  { name: 'odatano_cardano_drepepochsnapshots_epoch', table: 'odatano_cardano_DrepEpochSnapshots', columns: 'epoch' },
  { name: 'odatano_cardano_epochledgersnapshots_slot', table: 'odatano_cardano_EpochLedgerSnapshots', columns: 'snapshotSlot' },
  { name: 'odatano_cardano_addresstransactions_tx', table: 'odatano_cardano_AddressTransactions', columns: 'tx_hash' },
  { name: 'odatano_cardano_accounts_stake', table: 'odatano_cardano_Accounts', columns: 'stakeAddress' },
  { name: 'odatano_cardano_pools_poolid', table: 'odatano_cardano_Pools', columns: 'poolId' },
  { name: 'odatano_cardano_dreps_drepid', table: 'odatano_cardano_Dreps', columns: 'drepId' },
  // agent token lane: one lookup by token hash per request
  { name: 'odatano_cardano_cardanoagentgrants_token', table: 'odatano_cardano_CardanoAgentGrants', columns: 'tokenHash' },
  // crawler-fed ledger state: "who spent this output" and delegation per stake key / pool / DRep
  { name: 'odatano_cardano_transactioninputs_spent', table: 'odatano_cardano_TransactionInputs', columns: 'spentTxHash, spentOutputIndex' },
  // outputs to / inputs from a payment credential in slot order (txSeq); datum lookup by hash across txs
  { name: 'odatano_cardano_transactionoutputs_paycred', table: 'odatano_cardano_TransactionOutputs', columns: 'utxo_paymentCredential, txSeq' },
  { name: 'odatano_cardano_transactioninputs_paycred', table: 'odatano_cardano_TransactionInputs', columns: 'utxoData_paymentCredential, txSeq' },
  { name: 'odatano_cardano_transactiondatums_hash', table: 'odatano_cardano_TransactionDatums', columns: 'dataHash' },
  { name: 'odatano_cardano_transactioncertificates_stake', table: 'odatano_cardano_TransactionCertificates', columns: 'stakeAddress' },
  { name: 'odatano_cardano_transactioncertificates_pool', table: 'odatano_cardano_TransactionCertificates', columns: 'poolId' },
  { name: 'odatano_cardano_transactioncertificates_drep', table: 'odatano_cardano_TransactionCertificates', columns: 'drepId' },
  { name: 'odatano_cardano_transactionwithdrawals_stake', table: 'odatano_cardano_TransactionWithdrawals', columns: 'stakeAddress' },
  // all accounts of one epoch; the key starts with the stake address
  { name: 'odatano_cardano_accountepochsnapshots_epoch', table: 'odatano_cardano_AccountEpochSnapshots', columns: 'epoch' },
  // crawler-fed UTxO set: open rows per address, "who spent", stake-key rollups, asset holders
  { name: 'odatano_cardano_ledgerutxos_address', table: 'odatano_cardano_LedgerUTxOs', columns: 'address, spentTxHash' },
  // newest created and spent rows of an address (latest transactions from the UTxO set)
  { name: 'odatano_cardano_ledgerutxos_address_created', table: 'odatano_cardano_LedgerUTxOs', columns: 'address, createdSlot' },
  { name: 'odatano_cardano_ledgerutxos_address_spent', table: 'odatano_cardano_LedgerUTxOs', columns: 'address, spentSlot' },
  { name: 'odatano_cardano_ledgerutxos_spent', table: 'odatano_cardano_LedgerUTxOs', columns: 'spentTxHash' },
  { name: 'odatano_cardano_ledgerutxos_paycred', table: 'odatano_cardano_LedgerUTxOs', columns: 'utxo_paymentCredential, spentTxHash' },
  { name: 'odatano_cardano_ledgeraddresses_stake', table: 'odatano_cardano_LedgerAddresses', columns: 'stakeAddress' },
  { name: 'odatano_cardano_ledgeraddresses_paycred', table: 'odatano_cardano_LedgerAddresses', columns: 'paymentCredential' },
  { name: 'odatano_cardano_ledgerutxoassets_unit', table: 'odatano_cardano_LedgerUTxOAssets', columns: 'unit' },
  { name: 'odatano_cardano_ledgeraddressassets_unit', table: 'odatano_cardano_LedgerAddressAssets', columns: 'unit' },
  // wallet worker: jobs by status, and the jobs of one wallet with its next due job in dispatch order
  { name: 'odatano_cardano_cardanowalletjobs_status', table: 'odatano_cardano_CardanoWalletJobs', columns: 'status' },
  { name: 'odatano_cardano_cardanowalletjobs_next', table: 'odatano_cardano_CardanoWalletJobs', columns: 'walletId, status, priority, createdAt' },
]);

/** Indexes an entry above replaces; dropped at start. */
export const DROPPED_DB_INDEXES: readonly string[] = Object.freeze([
  'odatano_cardano_transactions_block',
  'odatano_cardano_cardanowalletjobs_due',
  'odatano_cardano_cardanowalletjobs_wallet',
  'odatano_cardano_blocks_slot',
]);

/** The statement for one entry; exported so tests pin the shape. */
export function indexStatement(spec: IndexSpec, kind: string = 'sqlite'): string {
  if (kind !== 'postgres') return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.columns})`;
  // CONCURRENTLY keeps the table writable while a large index builds
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.postgres ?? spec.columns})`;
}

/** Anything that runs a plain SQL string: the primary db service. */
export type SqlRunner = { run: (sql: string, params?: unknown[]) => Promise<unknown>; kind?: string };

/** A pg client as the PostgreSQL service's connection factory creates it. */
interface PgClient { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
interface PgFactory { create: () => Promise<PgClient>; destroy: (dbc: PgClient) => Promise<void> | void }

// PostgreSQL builds an index CONCURRENTLY only outside a transaction, and every statement of the
// service runs inside one. A connection from the service's own factory runs it outside.
async function withOwnConnection<T>(db: SqlRunner, fn: (run: SqlRunner['run']) => Promise<T>): Promise<T> {
  const factory = (db as { factory?: PgFactory }).factory;
  if (!factory) throw new Error('the PostgreSQL service has no connection factory');
  const dbc = await factory.create();
  try {
    const schema = (db as { options?: { credentials?: { schema?: string } } }).options?.credentials?.schema;
    if (schema) await dbc.query(`SET search_path TO "${schema.replace(/"/g, '""')}", public`);
    return await fn(async (sql, params) => (await dbc.query(sql, params)).rows);
  } finally {
    await factory.destroy(dbc);
  }
}

/** Names of our indexes in this schema that are invalid; only a failed concurrent build leaves one. */
export const INVALID_INDEXES_STATEMENT =
  'SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  'WHERE NOT i.indisvalid AND n.nspname = current_schema() AND c.relname = ANY($1)';

// One instance at a time builds the indexes. An index another instance is still building is
// invalid too, so without this lock a second start would drop it and kill that build.
export const INDEX_LOCK_STATEMENT = "SELECT pg_try_advisory_lock(hashtext('odatano_db_indexes.' || current_schema())) AS locked";
export const INDEX_UNLOCK_STATEMENT = "SELECT pg_advisory_unlock(hashtext('odatano_db_indexes.' || current_schema()))";

/** Creates every missing index; a failing statement is logged and skipped, the others still run. */
export async function ensureDbIndexes(runner: SqlRunner | undefined = cds.db as unknown as SqlRunner | undefined): Promise<{ ensured: string[]; failed: string[] }> {
  const ensured: string[] = [];
  const failed: string[] = [];
  if (!runner) {
    logger.debug('no database service connected, indexes skipped');
    return { ensured, failed };
  }
  const kind = String(runner.kind ?? 'sqlite');
  if (kind === 'hana') {
    logger.info('HANA: secondary indexes not created (column store, no IF NOT EXISTS)');
    return { ensured, failed };
  }
  const ensure = async (run: SqlRunner['run']) => {
    const concurrently = kind === 'postgres' ? 'CONCURRENTLY ' : '';
    if (kind === 'postgres') {
      const invalid = await run(INVALID_INDEXES_STATEMENT, [DB_INDEXES.map(s => s.name)]) as Array<{ name: string }>;
      for (const { name } of invalid ?? []) {
        logger.warn(`index ${name} is invalid after an interrupted build; rebuilding it`);
        await run(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`)
          .catch((err: unknown) => logger.warn(`invalid index ${name} not dropped: ${String((err as Error)?.message ?? err)}`));
      }
    }
    for (const name of DROPPED_DB_INDEXES) {
      await run(`DROP INDEX ${concurrently}IF EXISTS ${name}`)
        .catch((err: unknown) => logger.warn(`index ${name} not dropped: ${String((err as Error)?.message ?? err)}`));
    }
    for (const spec of DB_INDEXES) {
      try {
        await run(indexStatement(spec, kind));
        ensured.push(spec.name);
      } catch (err) {
        failed.push(spec.name);
        logger.warn(`index ${spec.name} on ${spec.table} not ensured: ${String((err as Error)?.message ?? err)}`);
      }
    }
  };
  if (kind === 'postgres') {
    const skipped = await withOwnConnection(runner, async (run) => {
      const [lock] = await run(INDEX_LOCK_STATEMENT) as Array<{ locked: boolean }>;
      if (!lock?.locked) return true;
      try {
        await ensure(run);
      } finally {
        await run(INDEX_UNLOCK_STATEMENT).catch(() => undefined);
      }
      return false;
    });
    if (skipped) {
      logger.info('another instance is building the indexes; skipped here');
      return { ensured, failed };
    }
  } else {
    await ensure((sql, params) => runner.run(sql, params));
  }
  if (failed.length === 0) logger.info(`${ensured.length} indexes ensured`);
  return { ensured, failed };
}
