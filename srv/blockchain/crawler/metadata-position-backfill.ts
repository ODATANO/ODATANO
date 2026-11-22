import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { TX_SEQ_SLOT_FACTOR } from '../../utils/mappers';
import { Transactions, TransactionMetadata } from '#cds-models/odatano/cardano';

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
  /** Slots per statement. */
  slotWindow?: number;
  onProgress?: (p: MetadataPositionProgress) => void;
}

const METADATA_TABLE = 'odatano_cardano_TransactionMetadata';
const TRANSACTIONS_TABLE = 'odatano_cardano_Transactions';

// One UPDATE per window that takes the position from the transaction row. Null for databases
// other than Postgres and SQLite, which update transaction by transaction.
export function metadataPositionStatement(kind: string): string | null {
  if (kind !== 'postgres' && kind !== 'sqlite' && kind !== 'better-sqlite') return null;
  const [lo, hi] = kind === 'postgres' ? ['$1', '$2'] : ['?', '?'];
  return `UPDATE ${METADATA_TABLE} AS m SET txSeq = t.txSeq FROM ${TRANSACTIONS_TABLE} AS t ` +
    `WHERE t.hash = m.tx_hash AND m.txSeq IS NULL AND t.txSeq >= ${lo} AND t.txSeq < ${hi}`;
}

async function fillWindow(tx: CapTransaction, lo: number, hi: number): Promise<number> {
  const sql = metadataPositionStatement((cds.db as { kind?: string } | undefined)?.kind ?? '');
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
    rows += Number(await tx.run(UPDATE.entity(TransactionMetadata).set({ txSeq: Number(t.txSeq) }).where({ tx_hash: t.hash, txSeq: null }))) || 0;
  }
  return rows;
}

export async function backfillMetadataPositions(opts: MetadataPositionOptions = {}): Promise<MetadataPositionProgress> {
  const slotWindow = opts.slotWindow ?? 20_000;
  const bounds = (await cds.tx((tx: CapTransaction) => tx.run(
    SELECT.one.from(Transactions).columns('min(txSeq) as lo', 'max(txSeq) as hi')
  ))) as { lo?: number | string | null; hi?: number | string | null } | undefined;
  const progress: MetadataPositionProgress = { atSlot: 0, toSlot: 0, rows: 0 };
  if (bounds?.lo == null || bounds.hi == null) return progress;

  const firstSlot = Math.floor(Number(bounds.lo) / TX_SEQ_SLOT_FACTOR);
  progress.toSlot = Math.floor(Number(bounds.hi) / TX_SEQ_SLOT_FACTOR);
  for (let slot = firstSlot; slot <= progress.toSlot; slot += slotWindow) {
    const next = slot + slotWindow;
    progress.rows += await cds.tx((tx: CapTransaction) => fillWindow(tx, slot * TX_SEQ_SLOT_FACTOR, next * TX_SEQ_SLOT_FACTOR));
    progress.atSlot = Math.min(next - 1, progress.toSlot);
    opts.onProgress?.({ ...progress });
  }
  logger.info(`metadata positions: ${progress.rows} rows filled up to slot ${progress.toSlot}`);
  return progress;
}
