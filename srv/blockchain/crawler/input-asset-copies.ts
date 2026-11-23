import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { TransactionInputs } from '#cds-models/odatano/cardano';
import { slotRangeOf, walkSlotWindows, type SlotRange } from './window-plan';
import { bulkSqlKind, connectedDbKind } from '../../utils/db-kind';

const logger = cds.log('InputAssetCopies');

// An input reads its assets from a stored copy or, through `spentTxSeq`, from the output it spent.
// It has one of the two, never both. The prune moves the inputs of a slot range from copies to the
// reference, the restore moves them back. Both walk by the slot of the spending transaction.

const INPUTS = 'odatano_cardano_TransactionInputs';
const COPIES = 'odatano_cardano_TransactionInputAssetCopies';
const TRANSACTIONS = 'odatano_cardano_Transactions';
const OUTPUTS = 'odatano_cardano_TransactionOutputs';
const OUTPUT_ASSETS = 'odatano_cardano_TransactionOutputAssets';
/** Columns of an asset row besides its key, the same in the copies and in the output assets. */
export const ASSET_COLUMNS = ['asset_quantity', 'asset_policyId', 'asset_assetNameHex', 'asset_assetName', 'asset_fingerprint'];

export interface InputCopyPruneProgress {
  atSlot: number; // slot the walk has reached
  toSlot: number; // last slot of the walk
  referenced: number; // inputs that read from their output now
  kept: number; // inputs of the walked slots left without a reference
  deleted: number; // copy rows deleted
}

export interface InputCopyRestoreProgress {
  atSlot: number; // slot the walk has reached
  toSlot: number; // last slot of the walk
  restored: number; // inputs that read from a copy again
  rows: number; // copy rows written
}

export interface CopyWalkOptions<P> {
  fromSlot: number;
  toSlot: number;
  slotWindow?: number; // slots per transaction
  onProgress?: (p: P) => void;
  shouldStop?: () => boolean; // stops the walk before the next window
}

const supported = (kind: string): boolean => bulkSqlKind(kind) !== null;
/** The two window bounds as numbered parameters, so a statement can name each more than once. */
const bounds = (kind: string): [string, string] => (kind === 'postgres' ? ['$1', '$2'] : ['?1', '?2']);

// Points the inputs of a window at their output. Only where the output is stored and holds
// exactly the asset rows of the input's copy, so the input reads the same assets afterwards.
export function referenceStatement(kind: string): string | null {
  if (!supported(kind)) return null;
  const [lo, hi] = bounds(kind);
  const copy = `c.input_txSeq = i.txSeq AND c.input_inputIndex = i.inputIndex`;
  const spent = `a.output_txSeq = t.txSeq AND a.output_outputIndex = i.spentOutputIndex`;
  return `UPDATE ${INPUTS} AS i SET spentTxSeq = t.txSeq FROM ${TRANSACTIONS} AS t ` +
    `WHERE t.hash = i.spentTxHash AND i.spentTxSeq IS NULL AND i.txSeq >= ${lo} AND i.txSeq < ${hi} ` +
    `AND EXISTS (SELECT 1 FROM ${OUTPUTS} AS o WHERE o.txSeq = t.txSeq AND o.outputIndex = i.spentOutputIndex) ` +
    `AND NOT EXISTS (SELECT 1 FROM ${COPIES} AS c WHERE ${copy} AND NOT EXISTS (` +
    `SELECT 1 FROM ${OUTPUT_ASSETS} AS a WHERE ${spent} AND a.unit = c.unit AND a.asset_quantity = c.asset_quantity)) ` +
    `AND (SELECT count(*) FROM ${COPIES} AS c WHERE ${copy}) = (SELECT count(*) FROM ${OUTPUT_ASSETS} AS a WHERE ${spent})`;
}

// Deletes the copies of the inputs of a window that have a reference. The inputs carry the window
// bounds too: without them the database may read every input to find those with a reference.
export function deleteCopiesStatement(kind: string): string | null {
  if (!supported(kind)) return null;
  const [lo, hi] = bounds(kind);
  return `DELETE FROM ${COPIES} WHERE input_txSeq >= ${lo} AND input_txSeq < ${hi} AND EXISTS (` +
    `SELECT 1 FROM ${INPUTS} AS i WHERE i.txSeq = ${COPIES}.input_txSeq AND i.inputIndex = ${COPIES}.input_inputIndex ` +
    `AND i.spentTxSeq IS NOT NULL AND i.txSeq >= ${lo} AND i.txSeq < ${hi})`;
}

/** Counts the inputs of a window that have no reference. */
export function keptStatement(kind: string): string | null {
  if (!supported(kind)) return null;
  const [lo, hi] = bounds(kind);
  return `SELECT count(*) AS n FROM ${INPUTS} WHERE txSeq >= ${lo} AND txSeq < ${hi} AND spentTxSeq IS NULL`;
}

/** Writes the copies of the inputs of a window that have a reference, from the outputs they spent. */
export function restoreCopiesStatement(kind: string): string | null {
  if (!supported(kind)) return null;
  const [lo, hi] = bounds(kind);
  const columns = ASSET_COLUMNS.join(', ');
  return `INSERT INTO ${COPIES} (input_txSeq, input_inputIndex, unit, ${columns}) ` +
    `SELECT i.txSeq, i.inputIndex, a.unit, ${ASSET_COLUMNS.map(c => `a.${c}`).join(', ')} FROM ${INPUTS} AS i ` +
    `JOIN ${OUTPUT_ASSETS} AS a ON a.output_txSeq = i.spentTxSeq AND a.output_outputIndex = i.spentOutputIndex ` +
    `WHERE i.txSeq >= ${lo} AND i.txSeq < ${hi}`;
}

/** Takes the reference from the inputs of a window, once their copies are written. */
export function dropReferenceStatement(kind: string): string | null {
  if (!supported(kind)) return null;
  const [lo, hi] = bounds(kind);
  return `UPDATE ${INPUTS} SET spentTxSeq = NULL WHERE txSeq >= ${lo} AND txSeq < ${hi} AND spentTxSeq IS NOT NULL`;
}

// Counts the inputs of a window that have copies and a reference. The view would show their
// assets twice, so a window that leaves one behind is rolled back.
export function bothStatement(kind: string): string | null {
  if (!supported(kind)) return null;
  const [lo, hi] = bounds(kind);
  return `SELECT count(*) AS n FROM ${INPUTS} AS i WHERE i.txSeq >= ${lo} AND i.txSeq < ${hi} AND i.spentTxSeq IS NOT NULL ` +
    `AND EXISTS (SELECT 1 FROM ${COPIES} AS c WHERE c.input_txSeq = i.txSeq AND c.input_inputIndex = i.inputIndex)`;
}

async function assertOneSource(tx: CapTransaction, check: string, window: [number, number]): Promise<void> {
  const [found] = await tx.run(check, window) as Array<{ n: number | string }>;
  const both = Number(found?.n ?? 0);
  if (both > 0) throw new Error(`${both} inputs between txSeq ${window[0]} and ${window[1]} would have copies and a reference; the window is left unchanged`);
}

/** Rows a plain statement changed; the drivers answer with their own result object. */
function changed(result: unknown): number {
  const r = result as { changes?: number; rowCount?: number } | number | undefined;
  return typeof r === 'number' ? r : Number(r?.changes ?? r?.rowCount) || 0;
}

function statementFor(build: (kind: string) => string | null): string {
  const sql = build(connectedDbKind());
  if (!sql) throw new Error(`Input asset copies are pruned and restored on PostgreSQL and SQLite only (database kind: ${connectedDbKind() || 'none'})`);
  return sql;
}

/** Walks the windows of the asked slots that hold stored inputs. Null when there is none. */
async function walk<P extends { atSlot: number; toSlot: number }>(
  opts: CopyWalkOptions<P>,
  progress: P,
  step: (tx: CapTransaction, window: [number, number]) => Promise<void>
): Promise<SlotRange | null> {
  const range = await slotRangeOf(TransactionInputs, opts);
  if (!range) return null;
  progress.toSlot = range.to;
  await walkSlotWindows(range, {
    slotWindow: opts.slotWindow,
    shouldStop: opts.shouldStop,
    afterWindow: (atSlot) => { progress.atSlot = atSlot; opts.onProgress?.({ ...progress }); },
  }, step);
  return range;
}

// Moves the inputs of the slot range from copies to the reference. Per window, in one transaction:
// set the reference where the output's assets equal the copy, then delete the copies of those inputs.
export async function pruneInputAssetCopies(opts: CopyWalkOptions<InputCopyPruneProgress>): Promise<InputCopyPruneProgress> {
  const reference = statementFor(referenceStatement);
  const remove = statementFor(deleteCopiesStatement);
  const count = statementFor(keptStatement);
  const check = statementFor(bothStatement);
  const progress: InputCopyPruneProgress = { atSlot: 0, toSlot: 0, referenced: 0, kept: 0, deleted: 0 };
  const range = await walk(opts, progress, async (tx, window) => {
    const referenced = changed(await tx.run(reference, window));
    const deleted = changed(await tx.run(remove, window));
    await assertOneSource(tx, check, window);
    const [left] = await tx.run(count, window) as Array<{ n: number | string }>;
    progress.referenced += referenced;
    progress.deleted += deleted;
    progress.kept += Number(left?.n ?? 0);
  });
  if (range) logger.info(`input asset copies pruned: ${progress.referenced} inputs read from their output, ${progress.kept} left without a reference,${progress.deleted} rows deleted, slots ${range.from} to ${range.to}`);
  return progress;
}

// Moves the inputs of the slot range back to copies. Per window, in one transaction: write the
// copies from the outputs, then take the reference from those inputs.
export async function restoreInputAssetCopies(opts: CopyWalkOptions<InputCopyRestoreProgress>): Promise<InputCopyRestoreProgress> {
  const write = statementFor(restoreCopiesStatement);
  const release = statementFor(dropReferenceStatement);
  const check = statementFor(bothStatement);
  const progress: InputCopyRestoreProgress = { atSlot: 0, toSlot: 0, restored: 0, rows: 0 };
  const range = await walk(opts, progress, async (tx, window) => {
    const rows = changed(await tx.run(write, window));
    const restored = changed(await tx.run(release, window));
    await assertOneSource(tx, check, window);
    progress.rows += rows;
    progress.restored += restored;
  });
  if (range) logger.info(`input asset copies restored: ${progress.restored} inputs, ${progress.rows} rows, slots ${range.from} to ${range.to}`);
  return progress;
}
