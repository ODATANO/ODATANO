import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { ChainPoint } from '../backends/cardano-backend';
import type { Transaction, TxInputLine } from '../../utils/types';
import { mapTransactionInputAssets, mapTransactionRedeemers, txSeqOf } from '../../utils/mappers';
import { chunk, IN_CHUNK } from '../../utils/collections';
import { streamCrawledBlocks } from './certificate-backfill';
import type { LedgerLookup } from '../ledger-state';
import { TransactionInputs, TransactionInputAssets, TransactionOutputs, TransactionOutputAssets, TransactionRedeemers } from '#cds-models/odatano/cardano';

const { SELECT, UPDATE, UPSERT, DELETE } = cds.ql;
const logger = cds.log('TransactionBackfill');

/**
 * Completes transactions the crawl already holds from a second chain-sync stream: input
 * outpoints (spentTxHash / spentOutputIndex), the spent output's datum and reference-script
 * hash, a missing input address, and the redeemers. Only empty input fields are filled; a
 * transaction whose stored inputs do not line up with the stream is left as it is.
 */

export class TransactionBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionBackfillError';
  }
}

export interface TransactionBackfillProgress {
  /** Slot of the last block handled. */
  atSlot: number;
  blocks: number;
  transactions: number;
  /** Input rows that got at least one field. */
  inputs: number;
  redeemers: number;
  /** Transactions whose stored rows differed from the ledger view (order, inputs or outputs the ledger did not apply) and were rewritten. */
  rewritten: number;
  /** Transactions left as they are: stored inputs differ from the stream. */
  skipped: number;
}

/** Resolves bare chain-sync inputs from the index (CardanoIndexer.resolveInputs). */
export interface InputResolver {
  resolveInputs(tx: CapTransaction, txs: Transaction[], ledger?: LedgerLookup): Promise<void>;
}

export interface TransactionBackfillOptions {
  client: CardanoClient;
  indexer: InputResolver;
  fromSlot: number;
  toSlot: number;
  batchBlocks?: number;
  onProgress?: (p: TransactionBackfillProgress) => void;
}

export interface TransactionBackfillResult extends TransactionBackfillProgress {
  fromSlot: number;
  toSlot: number;
  intersection: ChainPoint | 'origin';
}

interface StoredInputRow {
  txSeq: number | string;
  inputIndex: number;
  address_address: string | null;
  spentTxHash: string | null;
  spentOutputIndex: number | null;
  utxoData_dataHash: string | null;
  utxoData_inlineDatum: string | null;
  utxoData_referenceScriptHash: string | null;
  isCollateral: boolean | null;
  isReference: boolean | null;
}

const key = (txSeq: number | string, inputIndex: number): string => `${Number(txSeq)}#${Number(inputIndex)}`;
const lovelaceOf = (i: TxInputLine): string | null => i.amount?.find((a) => a.unit === 'lovelace')?.quantity ?? null;

/**
 * Stored input and streamed input describe the same outpoint: same flags, same outpoint where
 * one is stored, same address and lovelace where both sides know them. A stored address the
 * stream cannot resolve is unverifiable, so it does not match.
 */
function sameInput(row: StoredInputRow, fresh: TxInputLine, storedLovelace: string | null): boolean {
  if (Boolean(row.isCollateral) !== Boolean(fresh.isCollateral) || Boolean(row.isReference) !== Boolean(fresh.isReference)) return false;
  if (row.spentTxHash != null) {
    return row.spentTxHash === fresh.txHash && Number(row.spentOutputIndex) === fresh.outputIndex;
  }
  if (!row.address_address) return true;
  if (!fresh.address) return false;
  if (row.address_address !== fresh.address) return false;
  const freshLovelace = lovelaceOf(fresh);
  return storedLovelace == null || freshLovelace == null || String(storedLovelace) === String(freshLovelace);
}

/**
 * Stored rows in the stream's order when they hold the same outpoints with the same flags, each
 * once; null otherwise (a row without outpoint cannot be placed).
 */
function reorderByOutpoint(rows: StoredInputRow[], fresh: TxInputLine[]): StoredInputRow[] | null {
  if (rows.length !== fresh.length || rows.some((r) => r.spentTxHash == null)) return null;
  const byOutpoint = new Map<string, StoredInputRow[]>();
  for (const r of rows) {
    const k = `${r.spentTxHash}#${Number(r.spentOutputIndex)}#${Boolean(r.isCollateral)}#${Boolean(r.isReference)}`;
    byOutpoint.set(k, [...(byOutpoint.get(k) ?? []), r]);
  }
  const ordered: StoredInputRow[] = [];
  for (const f of fresh) {
    const k = `${f.txHash}#${f.outputIndex}#${Boolean(f.isCollateral)}#${Boolean(f.isReference)}`;
    const r = byOutpoint.get(k)?.shift();
    if (!r) return null;
    ordered.push(r);
  }
  return ordered;
}

/** Columns of `row` that are empty and `fresh` can fill. */
function missingFields(row: StoredInputRow, fresh: TxInputLine): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (row.spentTxHash == null && fresh.txHash) {
    set.spentTxHash = fresh.txHash;
    set.spentOutputIndex = fresh.outputIndex;
  }
  if (row.utxoData_dataHash == null && fresh.dataHash) set.utxoData_dataHash = fresh.dataHash;
  if (row.utxoData_inlineDatum == null && fresh.inlineDatum) set.utxoData_inlineDatum = fresh.inlineDatum;
  if (row.utxoData_referenceScriptHash == null && fresh.referenceScriptHash) set.utxoData_referenceScriptHash = fresh.referenceScriptHash;
  if (!row.address_address && fresh.address) {
    set.address_address = fresh.address;
    set.hasAddresses = true;
    set.hasAssets = (fresh.amount ?? []).length > 0;
  }
  return set;
}

/** Empty columns of one stored input and the values that fill them. */
interface InputFill {
  txSeq: number;
  inputIndex: number;
  set: Record<string, unknown>;
}

const INPUTS_TABLE = 'odatano_cardano_TransactionInputs';
/** Rows per statement; one JSON parameter each. */
const FILL_CHUNK = 5000;

/** Fill columns in the order the JSON records and the SET list use them. */
const FILL_COLUMNS: Array<[column: string, sqlType: string]> = [
  ['spentTxHash', 'text'],
  ['spentOutputIndex', 'integer'],
  ['utxoData_dataHash', 'text'],
  ['utxoData_inlineDatum', 'text'],
  ['utxoData_referenceScriptHash', 'text'],
  ['address_address', 'text'],
  ['hasAddresses', 'boolean'],
  ['hasAssets', 'boolean'],
];

/**
 * One UPDATE per chunk: the fills travel as a JSON array and are joined on (txSeq, inputIndex).
 * COALESCE keeps any value that is already there. Postgres and SQLite; other databases get one
 * UPDATE per row.
 */
export function inputFillStatement(kind: string): string | null {
  const set = FILL_COLUMNS
    .map(([c]) => c.startsWith('has')
      ? `${c} = CASE WHEN v.address_address IS NOT NULL AND t.address_address IS NULL THEN v.${c} ELSE t.${c} END`
      : `${c} = COALESCE(t.${c}, v.${c})`)
    .join(', ');
  if (kind === 'postgres') {
    const cols = [['txSeq', 'bigint'], ['inputIndex', 'integer'], ...FILL_COLUMNS].map(([c, ty]) => `${c.toLowerCase()} ${ty}`).join(', ');
    return `UPDATE ${INPUTS_TABLE} AS t SET ${set} FROM json_to_recordset($1::json) AS v(${cols}) ` +
      'WHERE t.txSeq = v.txseq AND t.inputIndex = v.inputindex';
  }
  if (kind === 'sqlite' || kind === 'better-sqlite') {
    const cols = ['txSeq', 'inputIndex', ...FILL_COLUMNS.map(([c]) => c)]
      .map((c) => `json_extract(value, '$.${c.toLowerCase()}') AS ${c}`).join(', ');
    return `UPDATE ${INPUTS_TABLE} AS t SET ${set} FROM (SELECT ${cols} FROM json_each(?)) AS v ` +
      'WHERE t.txSeq = v.txSeq AND t.inputIndex = v.inputIndex';
  }
  return null;
}

/** Writes the fills of a batch: bulk statement where the database has one, else row by row. */
async function writeInputFills(tx: CapTransaction, fills: InputFill[]): Promise<void> {
  if (!fills.length) return;
  const sql = inputFillStatement((cds.db as { kind?: string } | undefined)?.kind ?? '');
  if (!sql) {
    for (const f of fills) await tx.run(UPDATE.entity(TransactionInputs).set(f.set).where({ txSeq: f.txSeq, inputIndex: f.inputIndex }));
    return;
  }
  for (const part of chunk(fills, FILL_CHUNK)) {
    const records = part.map((f) => {
      const r: Record<string, unknown> = { txseq: f.txSeq, inputindex: f.inputIndex };
      for (const [c] of FILL_COLUMNS) r[c.toLowerCase()] = f.set[c] ?? null;
      return r;
    });
    await tx.run(sql, [JSON.stringify(records)]);
  }
}

/**
 * Rewrites the input rows of one transaction as the ledger view: the kept rows (and their assets)
 * move to their position, rows left out are dropped, empty fields are filled on the way.
 */
async function rewriteInOrder(tx: CapTransaction, seq: number, ordered: StoredInputRow[], fresh: TxInputLine[]): Promise<void> {
  const assets = (await tx.run(SELECT.from(TransactionInputAssets).where({ input_txSeq: seq }))) as Array<Record<string, unknown>> ?? [];
  const newIndex = new Map(ordered.map((r, i) => [Number(r.inputIndex), i]));
  const rows = ordered.map((r, i) => ({ ...r, ...missingFields(r, fresh[i]), txSeq: seq, inputIndex: i }));
  // assets of rows the ledger view drops go with them
  const movedAssets = assets
    .filter((a) => newIndex.has(Number(a.input_inputIndex)))
    .map((a) => ({ ...a, input_txSeq: seq, input_inputIndex: newIndex.get(Number(a.input_inputIndex)) }));
  await tx.run(DELETE.from(TransactionInputAssets).where({ input_txSeq: seq }));
  await tx.run(DELETE.from(TransactionInputs).where({ txSeq: seq }));
  await tx.run(UPSERT.into(TransactionInputs).entries(rows));
  if (movedAssets.length) await tx.run(UPSERT.into(TransactionInputAssets).entries(movedAssets));
}

/**
 * Deletes stored outputs the ledger never produced: a provider lists the collateral return of a
 * valid transaction, and the declared outputs of a phase-2 failure. Only when every output of the
 * stream is stored, so a gap is never mistaken for an extra. Returns the transactions touched.
 */
async function dropUnappliedOutputs(tx: CapTransaction, txs: Transaction[]): Promise<number[]> {
  const wanted = new Map(txs.map((t) => [txSeqOf(t.slot, t.index), new Set((t.outputs ?? []).map((o) => o.outputIndex))]));
  const stored = new Map<number, number[]>();
  for (const seqChunk of chunk([...wanted.keys()], IN_CHUNK)) {
    const rows = (await tx.run(SELECT.from(TransactionOutputs).columns('txSeq', 'outputIndex').where({ txSeq: { in: seqChunk } }))) as Array<{ txSeq: number | string; outputIndex: number }>;
    for (const r of rows ?? []) stored.set(Number(r.txSeq), [...(stored.get(Number(r.txSeq)) ?? []), Number(r.outputIndex)]);
  }
  const touched: number[] = [];
  for (const [seq, indices] of stored) {
    const keep = wanted.get(seq)!;
    const extra = indices.filter((i) => !keep.has(i));
    if (!extra.length || [...keep].some((i) => !indices.includes(i))) continue;
    await tx.run(DELETE.from(TransactionOutputAssets).where({ output_txSeq: seq, output_outputIndex: { in: extra } }));
    await tx.run(DELETE.from(TransactionOutputs).where({ txSeq: seq, outputIndex: { in: extra } }));
    touched.push(seq);
  }
  return touched;
}

export async function backfillTransactions(opts: TransactionBackfillOptions): Promise<TransactionBackfillResult> {
  const { fromSlot, toSlot, indexer } = opts;
  const progress: TransactionBackfillProgress = { atSlot: 0, blocks: 0, transactions: 0, inputs: 0, redeemers: 0, rewritten: 0, skipped: 0 };
  let started = false;

  const intersection = await streamCrawledBlocks(
    { ...opts, errorType: TransactionBackfillError },
    (_block, txs) => txs,
    async (tx, blocks) => {
      const txs = blocks.flatMap((b) => b.payload);
      progress.blocks += blocks.length;
      progress.transactions += txs.length;
      if (!txs.length) return;

      // the UTxO set rows answer too: they keep spent outputs, also those from before the crawl
      await indexer.resolveInputs(tx, txs, { hashes: new Set(), rows: new Map(), assets: new Map() });

      const seqs = txs.map((t) => txSeqOf(t.slot, t.index));
      const stored = new Map<string, StoredInputRow>();
      const storedLovelace = new Map<string, string>();
      const storedCount = new Map<string, number>();
      const storedBySeq = new Map<string, StoredInputRow[]>();
      for (const seqChunk of chunk(seqs, IN_CHUNK)) {
        const [rows, lovelace] = await Promise.all([
          tx.run(SELECT.from(TransactionInputs).where({ txSeq: { in: seqChunk } })) as Promise<StoredInputRow[]>,
          tx.run(SELECT.from(TransactionInputAssets).columns('input_txSeq', 'input_inputIndex', 'asset_quantity')
            .where({ input_txSeq: { in: seqChunk }, unit: 'lovelace' })) as Promise<Array<{ input_txSeq: number | string; input_inputIndex: number; asset_quantity: unknown }>>,
        ]);
        for (const r of rows ?? []) {
          stored.set(key(r.txSeq, r.inputIndex), r);
          storedCount.set(String(Number(r.txSeq)), (storedCount.get(String(Number(r.txSeq))) ?? 0) + 1);
          storedBySeq.set(String(Number(r.txSeq)), [...(storedBySeq.get(String(Number(r.txSeq))) ?? []), r]);
        }
        for (const a of lovelace ?? []) storedLovelace.set(key(a.input_txSeq, a.input_inputIndex), String(a.asset_quantity));
      }

      const fills: InputFill[] = [];
      const assetRows: ReturnType<typeof mapTransactionInputAssets> = [];
      const reorders: Array<{ seq: number; rows: StoredInputRow[]; inputs: TxInputLine[] }> = [];
      const rewritten = new Set<number>();
      for (const t of txs) {
        const seq = txSeqOf(t.slot, t.index);
        const inputs = t.inputs ?? [];
        const rows = inputs.map((_, i) => stored.get(key(seq, i)));
        const lines = (storedCount.get(String(seq)) ?? 0) === inputs.length && rows.every((r, i) => r && sameInput(r, inputs[i], storedLovelace.get(key(seq, i)) ?? null));
        if (!lines) {
          // after a phase-2 failure the ledger applied no regular input: rows a provider stored for them go
          const all = [...(storedBySeq.get(String(seq)) ?? [])].sort((a, b) => Number(a.inputIndex) - Number(b.inputIndex));
          const kept = t.spendsCollaterals ? all.filter((r) => r.isCollateral || r.isReference) : all;
          const inPlace = kept.length === inputs.length &&
            kept.every((r, i) => sameInput(r, inputs[i], storedLovelace.get(key(seq, Number(r.inputIndex))) ?? null));
          const ordered = inPlace ? kept : reorderByOutpoint(kept, inputs);
          if (ordered) {
            reorders.push({ seq, rows: ordered, inputs });
            rewritten.add(seq);
            continue;
          }
          progress.skipped++;
          logger.debug(`Transaction ${t.hash}: stored inputs differ from the stream — left as it is`);
          continue;
        }
        for (let i = 0; i < inputs.length; i++) {
          const set = missingFields(rows[i]!, inputs[i]);
          if (!Object.keys(set).length) continue;
          fills.push({ txSeq: seq, inputIndex: i, set });
          if (set.address_address) assetRows.push(...mapTransactionInputAssets(seq, inputs).filter((a) => a.input_inputIndex === i));
        }
      }
      await writeInputFills(tx, fills);
      progress.inputs += fills.length;
      if (assetRows.length) await tx.run(UPSERT.into(TransactionInputAssets).entries(assetRows));
      for (const r of reorders) await rewriteInOrder(tx, r.seq, r.rows, r.inputs);
      for (const seq of await dropUnappliedOutputs(tx, txs)) rewritten.add(seq);
      progress.rewritten += rewritten.size;

      const redeemerRows = txs.flatMap((t) => mapTransactionRedeemers(t.hash, t.redeemers ?? []));
      progress.redeemers += redeemerRows.length;
      if (redeemerRows.length) await tx.run(UPSERT.into(TransactionRedeemers).entries(redeemerRows));
    },
    (atSlot) => {
      started = true;
      progress.atSlot = atSlot;
      opts.onProgress?.({ ...progress });
    },
  );
  if (!started) progress.atSlot = intersection === 'origin' ? 0 : intersection.slot;
  logger.info(
    `Transaction backfill ${fromSlot}..${toSlot}: ${progress.blocks} blocks, ${progress.inputs} inputs, ` +
    `${progress.redeemers} redeemers, ${progress.rewritten} transactions rewritten, ${progress.skipped} skipped`
  );
  return { ...progress, fromSlot, toSlot, intersection };
}
