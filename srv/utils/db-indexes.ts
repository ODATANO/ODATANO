/**
 * Secondary indexes the CDS model cannot declare (temporal keys start with `validFrom`, so business-key
 * lookups would scan). Created at start with CREATE INDEX IF NOT EXISTS, unquoted identifiers so Postgres
 * folds them like @cap-js does; failures are logged, never fatal. HANA is skipped (column store, no IF NOT EXISTS).
 */
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
  { name: 'odatano_cardano_blocks_slot', table: 'odatano_cardano_Blocks', columns: 'slot' },
  { name: 'odatano_cardano_blocks_epoch', table: 'odatano_cardano_Blocks', columns: 'epochNumber' },
  // block counts per pool (Pools.blocksEpoch / blocksMinted from crawled blocks)
  { name: 'odatano_cardano_blocks_slotleader', table: 'odatano_cardano_Blocks', columns: 'slotLeader, slot' },
  // Transactions of a block (rollback `blockHash in`, OData filters by block / height)
  { name: 'odatano_cardano_transactions_block', table: 'odatano_cardano_Transactions', columns: 'blockHash' },
  { name: 'odatano_cardano_transactions_height', table: 'odatano_cardano_Transactions', columns: 'blockHeight' },
  // Input/output rows back to their transaction (`tx` association, stale-seq check of the crawler)
  { name: 'odatano_cardano_transactions_txseq', table: 'odatano_cardano_Transactions', columns: 'txSeq' },
  // GetMetadataByTxHash, rollback
  { name: 'odatano_cardano_transactionmetadata_tx', table: 'odatano_cardano_TransactionMetadata', columns: 'tx_hash' },
  // rollback `txHash in` (key is unit, txHash)
  { name: 'odatano_cardano_assethistory_tx', table: 'odatano_cardano_AssetHistory', columns: 'txHash' },
  // temporal entities: the business key behind validFrom
  { name: 'odatano_cardano_assets_unit', table: 'odatano_cardano_Assets', columns: 'unit' },
  { name: 'odatano_cardano_addresses_address', table: 'odatano_cardano_Addresses', columns: 'address' },
  { name: 'odatano_cardano_addressutxos_address', table: 'odatano_cardano_AddressUTxOs', columns: 'address_address' },
  { name: 'odatano_cardano_addressassets_address', table: 'odatano_cardano_AddressAssets', columns: 'address_address' },
  { name: 'odatano_cardano_utxoassets_address', table: 'odatano_cardano_UTxOAssets', columns: 'utxo_address_address' },
  { name: 'odatano_cardano_addresstransactions_tx', table: 'odatano_cardano_AddressTransactions', columns: 'tx_hash' },
  { name: 'odatano_cardano_accounts_stake', table: 'odatano_cardano_Accounts', columns: 'stakeAddress' },
  { name: 'odatano_cardano_pools_poolid', table: 'odatano_cardano_Pools', columns: 'poolId' },
  { name: 'odatano_cardano_dreps_drepid', table: 'odatano_cardano_Dreps', columns: 'drepId' },
  // agent token lane: one lookup by token hash per request
  { name: 'odatano_cardano_cardanoagentgrants_token', table: 'odatano_cardano_CardanoAgentGrants', columns: 'tokenHash' },
  // crawler-fed ledger state: "who spent this output" and delegation per stake key / pool / DRep
  { name: 'odatano_cardano_transactioninputs_spent', table: 'odatano_cardano_TransactionInputs', columns: 'spentTxHash, spentOutputIndex' },
  { name: 'odatano_cardano_transactioncertificates_stake', table: 'odatano_cardano_TransactionCertificates', columns: 'stakeAddress' },
  { name: 'odatano_cardano_transactioncertificates_pool', table: 'odatano_cardano_TransactionCertificates', columns: 'poolId' },
  { name: 'odatano_cardano_transactioncertificates_drep', table: 'odatano_cardano_TransactionCertificates', columns: 'drepId' },
  { name: 'odatano_cardano_transactionwithdrawals_stake', table: 'odatano_cardano_TransactionWithdrawals', columns: 'stakeAddress' },
  // crawler-fed UTxO set: open rows per address, "who spent", stake-key rollups, asset holders
  { name: 'odatano_cardano_ledgerutxos_address', table: 'odatano_cardano_LedgerUTxOs', columns: 'address, spentTxHash' },
  { name: 'odatano_cardano_ledgerutxos_spent', table: 'odatano_cardano_LedgerUTxOs', columns: 'spentTxHash' },
  { name: 'odatano_cardano_ledgeraddresses_stake', table: 'odatano_cardano_LedgerAddresses', columns: 'stakeAddress' },
  { name: 'odatano_cardano_ledgerutxoassets_unit', table: 'odatano_cardano_LedgerUTxOAssets', columns: 'unit' },
  { name: 'odatano_cardano_ledgeraddressassets_unit', table: 'odatano_cardano_LedgerAddressAssets', columns: 'unit' },
]);

/** The statement for one entry; exported so tests pin the shape. */
export function indexStatement(spec: IndexSpec, kind: string = 'sqlite'): string {
  const columns = kind === 'postgres' && spec.postgres ? spec.postgres : spec.columns;
  return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns})`;
}

/** Anything that runs a plain SQL string: the primary db service. */
export type SqlRunner = { run: (sql: string) => Promise<unknown>; kind?: string };

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
  for (const spec of DB_INDEXES) {
    try {
      await runner.run(indexStatement(spec, kind));
      ensured.push(spec.name);
    } catch (err) {
      failed.push(spec.name);
      logger.warn(`index ${spec.name} on ${spec.table} not ensured: ${String((err as Error)?.message ?? err)}`);
    }
  }
  if (failed.length === 0) logger.info(`${ensured.length} indexes ensured`);
  return { ensured, failed };
}
