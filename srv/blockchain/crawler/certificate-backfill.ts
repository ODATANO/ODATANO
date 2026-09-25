import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { ChainPoint, ChainSyncHandle } from '../backends/cardano-backend';
import type { BlockData, Transaction } from '../../utils/types';
import { mapTransactionCertificates, mapTransactionWithdrawals } from '../../utils/mappers';
import { readCursor } from './sync-state';
import { Block, TransactionCertificates, TransactionWithdrawals } from '#cds-models/odatano/cardano';

const { SELECT, UPSERT } = cds.ql;
const logger = cds.log('CertificateBackfill');

/**
 * Fills `TransactionCertificates` and `TransactionWithdrawals` for blocks the crawl already
 * holds, from a second chain-sync stream. Only those two tables are written, keyed so a
 * repeat is idempotent; the cursor, the block and transaction rows stay untouched and the
 * live crawler keeps its own stream. A block the index does not know (rolled back since) is
 * skipped, so no row can point at a transaction that is not there.
 */

export class CertificateBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateBackfillError';
  }
}

export interface CertificateBackfillProgress {
  /** Slot of the last block handled. */
  atSlot: number;
  blocks: number;
  transactions: number;
  certificates: number;
  withdrawals: number;
}

export interface CertificateBackfillOptions {
  client: CardanoClient;
  /** First slot to cover; the stream intersects at the newest indexed block before it. */
  fromSlot: number;
  /** Last slot to cover; the stream ends at the first block past it. */
  toSlot: number;
  /** Rows are written per batch of blocks; smaller batches show progress sooner. */
  batchBlocks?: number;
  onProgress?: (p: CertificateBackfillProgress) => void;
}

export interface CertificateBackfillResult extends CertificateBackfillProgress {
  fromSlot: number;
  toSlot: number;
  /** The chain point the stream started after. */
  intersection: ChainPoint | 'origin';
}

/**
 * Newest indexed block strictly before `slot` inside the crawled range; the crawler's own
 * start point when none is. Lazily indexed blocks below the crawl start are never picked:
 * they may lie far back or on a fork the node no longer knows.
 */
export async function intersectionBefore(db: CapTransaction, slot: number): Promise<ChainPoint | 'origin'> {
  const cursor = await readCursor(db);
  const floor = cursor?.startSlot ?? null;
  const range = floor != null ? { between: floor, and: slot - 1 } : { '<': slot };
  const row = floor != null && slot - 1 < floor ? null : (await db.run(
    SELECT.one.from(Block).columns('hash', 'slot', 'height').where({ slot: range }).orderBy('slot desc') as any
  )) as { hash?: string; slot?: number | string; height?: number | string } | null;
  if (row?.hash && row.slot != null) return { slot: Number(row.slot), hash: row.hash, height: row.height == null ? undefined : Number(row.height) };
  if (floor != null && cursor?.startBlockHash) return { slot: floor, hash: cursor.startBlockHash };
  return 'origin';
}

export async function backfillCertificates(opts: CertificateBackfillOptions): Promise<CertificateBackfillResult> {
  const { client, fromSlot, toSlot } = opts;
  if (!Number.isInteger(fromSlot) || !Number.isInteger(toSlot) || fromSlot < 0 || toSlot < fromSlot) {
    throw new CertificateBackfillError(`Invalid slot range ${fromSlot}..${toSlot}`);
  }
  const backend = client.getChainSyncBackend();
  if (!backend) throw new CertificateBackfillError('No chain-sync backend available (the backfill streams from Ogmios).');
  const batchBlocks = Math.max(1, opts.batchBlocks ?? 200);

  const intersection = await cds.tx((tx) => intersectionBefore(tx, fromSlot));
  const points: ChainPoint[] | 'origin' = intersection === 'origin' ? 'origin' : [intersection];

  const progress: CertificateBackfillProgress = { atSlot: intersection === 'origin' ? 0 : intersection.slot, blocks: 0, transactions: 0, certificates: 0, withdrawals: 0 };

  /** One streamed block with its mapped rows, held until the batch is checked against the index. */
  interface Pending {
    hash: string;
    slot: number;
    transactions: number;
    certs: ReturnType<typeof mapTransactionCertificates>;
    withdrawals: ReturnType<typeof mapTransactionWithdrawals>;
  }
  let pending: Pending[] = [];

  /**
   * Writes a batch: the index's blocks of the batch's slot range are read once (a sequential
   * index range, not one random lookup per block) and only rows of blocks the index holds
   * are written; a block it never had (rolled back since) is skipped.
   */
  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const fromBatch = batch[0].slot, toBatch = batch[batch.length - 1].slot;
    await cds.tx(async (tx) => {
      const rows = (await tx.run(
        SELECT.from(Block).columns('hash').where({ slot: { between: fromBatch, and: toBatch } }) as any
      )) as Array<{ hash: string }>;
      const known = new Set(rows.map((r) => r.hash));
      const certs = [], withdrawals = [];
      for (const b of batch) {
        if (!known.has(b.hash)) { logger.warn(`Block ${b.hash} at slot ${b.slot} is not in the index — skipped`); continue; }
        certs.push(...b.certs);
        withdrawals.push(...b.withdrawals);
        progress.blocks++;
        progress.transactions += b.transactions;
        progress.certificates += b.certs.length;
        progress.withdrawals += b.withdrawals.length;
      }
      if (certs.length) await tx.run(UPSERT.into(TransactionCertificates).entries(certs));
      if (withdrawals.length) await tx.run(UPSERT.into(TransactionWithdrawals).entries(withdrawals));
    });
    progress.atSlot = toBatch;
    opts.onProgress?.({ ...progress });
  };

  let handle: ChainSyncHandle | null = null;
  let settled = false;
  const done = new Promise<void>((resolve, reject) => {
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    const onBlock = async (block: BlockData, txs: Transaction[]): Promise<void> => {
      if (settled) return;
      const slot = block.slot ?? 0;
      if (slot > toSlot) { finish(); return; }
      if (slot < fromSlot) return;   // between the intersection and the range: skipped, not counted
      pending.push({
        hash: block.hash, slot, transactions: txs.length,
        certs: txs.flatMap((t) => mapTransactionCertificates(t.hash, t.certificates ?? [])),
        withdrawals: txs.flatMap((t) => mapTransactionWithdrawals(t.hash, t.withdrawals ?? [])),
      });
      if (pending.length >= batchBlocks) await flush();
      if (slot === toSlot) finish();
    };
    backend.openChainSync(points, {
      rollForward: (block, txs) => onBlock(block, txs).catch(finish),
      // The handshake acknowledges the intersection; a reorg mid-run is the crawler's to undo,
      // it deletes the rows of the rolled-back transactions.
      rollBackward: async () => undefined,
      onError: async (err) => finish(err),
    }).then((h) => { handle = h; if (settled) void h.close().catch(() => undefined); }, finish);
  });

  try {
    await done;
    await flush();
  } finally {
    const h = handle as ChainSyncHandle | null;
    if (h) { try { await h.close(); } catch { /* best effort */ } }
  }
  logger.info(`Certificate backfill ${fromSlot}..${toSlot}: ${progress.blocks} blocks, ${progress.certificates} certificates, ${progress.withdrawals} withdrawals`);
  return { ...progress, fromSlot, toSlot, intersection };
}
