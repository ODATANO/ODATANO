import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { Transactions, TransactionMetadata } from '#cds-models/odatano/cardano';
import { slotRangeOf, walkSlotWindows } from './window-plan';
import { bulkSqlKind, connectedDbKind } from '../../utils/db-kind';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('MetadataPositionBackfill');

// Writes the chain position of its transaction to TransactionMetadata rows that lack it, so a
// label can be read along the chain. Walks the stored transactions by slot window. Idempotent.

export interface MetadataPositionProgress {
  /** Slot the walk has reached. */
  atSlot: number;
  /** Last slot that holds a stored transaction. */
  toSlot: number;
  /** Metadata rows that received their position. */
  rows: number;
}

export interface MetadataPositionOptions {
  /** First slot to walk; default the first stored transaction. */
  fromSlot?: number | null;
  /** Last slot to walk; default the last stored transaction. */
  toSlot?: number | null;
  /** Slots per statement. */
  slotWindow?: number;
  onProgress?: (p: MetadataPositionProgress) => void;
  /** Stops the walk before the next window. */
  shouldStop?: () => boolean;
}

const METADATA_TABLE = 'odatano_cardano_TransactionMetadata';
const TRANSACTIONS_TABLE = 'odatano_cardano_Transactions';

// One UPDATE per window that takes the position from the transaction row. Null for databases
// other than Postgres and SQLite, which update transaction by transaction. The only way into the
// metadata table is the join on tx_hash: a filter on txSeq would let the planner scan for it.
export function metadataPositionStatement(kind: string): string | null {
  const bulk = bulkSqlKind(kind);
  if (!bulk) return null;
  const [lo, hi] = bulk === 'postgres' ? ['$1', '$2'] : ['?', '?'];
  return `UPDATE ${METADATA_TABLE} AS m SET txSeq = t.txSeq FROM ${TRANSACTIONS_TABLE} AS t ` +
    `WHERE t.hash = m.tx_hash AND t.txSeq >= ${lo} AND t.txSeq < ${hi} AND m.txSeq IS DISTINCT FROM t.txSeq`;
}

async function fillWindow(tx: CapTransaction, lo: number, hi: number): Promise<number> {
  const sql = metadataPositionStatement(connectedDbKind());
  if (sql) {
    // a plain statement answers with the driver's result object
    const result = await tx.run(sql, [lo, hi]) as { changes?: number } | undefined;
    return Number(result?.changes) || 0;
  }
  const txs = (await tx.run(
    SELECT.from(Transactions).columns('hash', 'txSeq').where({ txSeq: { '>=': lo, '<': hi } })
  )) as Array<{ hash: string; txSeq: number | string }> ?? [];
  let rows = 0;
  for (const t of txs) {
    // the same rule as the bulk statement: a row without its transaction's position, or with another one
    const seq = Number(t.txSeq);
    rows += Number(await tx.run(UPDATE.entity(TransactionMetadata).set({ txSeq: seq }).where({ tx_hash: t.hash, txSeq: null }))) || 0;
    rows += Number(await tx.run(UPDATE.entity(TransactionMetadata).set({ txSeq: seq }).where({ tx_hash: t.hash, txSeq: { '!=': seq } }))) || 0;
  }
  return rows;
}

export async function backfillMetadataPositions(opts: MetadataPositionOptions = {}): Promise<MetadataPositionProgress> {
  const progress: MetadataPositionProgress = { atSlot: 0, toSlot: 0, rows: 0 };
  const range = await slotRangeOf(Transactions, opts);
  if (!range) return progress;
  progress.atSlot = range.from;
  progress.toSlot = range.to;
  await walkSlotWindows(range, {
    slotWindow: opts.slotWindow,
    shouldStop: opts.shouldStop,
    afterWindow: (atSlot) => { progress.atSlot = atSlot; opts.onProgress?.({ ...progress }); },
  }, async (tx, [lo, hi]) => { progress.rows += await fillWindow(tx, lo, hi); });
  logger.info(`metadata positions: ${progress.rows} rows filled, slots ${range.from} to ${progress.atSlot}`);
  return progress;
}
