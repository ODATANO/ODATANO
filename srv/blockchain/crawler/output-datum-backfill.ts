import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import type { CardanoClient } from '../cardano-client';
import type { TxOutputLine } from '../../utils/types';
import { chunk, IN_CHUNK } from '../../utils/collections';
import { pageByKey } from './key-pages';
import { Transactions, TransactionInputs, TransactionOutputs, LedgerUTxOs, type TransactionOutput } from '#cds-models/odatano/cardano';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('OutputDatumBackfill');

// Datum and reference-script fields of stored outputs that an earlier read left empty. The same
// values go to the input rows that spent the output and to its row in the crawler-fed UTxO set.

const FIELDS = ['dataHash', 'inlineDatum', 'referenceScriptHash', 'referenceScriptSize', 'referenceScriptType'] as const;
type Field = typeof FIELDS[number];

const OUTPUT_COLUMNS = ['txSeq', 'outputIndex', ...FIELDS.map((f) => `utxo_${f}`)];

type StoredOutput = Pick<TransactionOutput,
  'txSeq' | 'outputIndex' | 'utxo_dataHash' | 'utxo_inlineDatum' | 'utxo_referenceScriptHash' | 'utxo_referenceScriptSize' | 'utxo_referenceScriptType'>;

/** A transaction as the source of its outputs' fields. */
export interface OutputSource {
  hash: string;
  txSeq: number;
  outputs: TxOutputLine[];
}

/** Rows that received at least one field, per table. */
export interface OutputFillCounts {
  outputs: number;
  inputs: number;
  ledgerUtxos: number;
}

/** Fields the stored output lacks and the fresh one carries. */
function missingFields(row: StoredOutput, fresh: TxOutputLine): Array<[Field, string | number]> {
  return FIELDS.flatMap((f): Array<[Field, string | number]> => {
    const value = fresh[f];
    return row[`utxo_${f}`] == null && value != null && value !== '' ? [[f, value]] : [];
  });
}

// Fills the empty datum and reference-script fields of the stored outputs of these transactions,
// of the inputs that spent them and of their UTxO set rows. Only empty fields change.
export async function fillOutputFields(tx: CapTransaction, sources: OutputSource[]): Promise<OutputFillCounts> {
  const counts: OutputFillCounts = { outputs: 0, inputs: 0, ledgerUtxos: 0 };
  const bySeq = new Map(sources.map((s) => [s.txSeq, s]));
  for (const seqs of chunk([...bySeq.keys()], IN_CHUNK)) {
    const rows = (await tx.run(SELECT.from(TransactionOutputs).columns(...OUTPUT_COLUMNS).where({ txSeq: { in: seqs } }))) as StoredOutput[] ?? [];
    for (const row of rows) {
      const source = bySeq.get(Number(row.txSeq));
      const outputIndex = Number(row.outputIndex);
      const fresh = source?.outputs.find((o) => o.outputIndex === outputIndex);
      const missing = fresh ? missingFields(row, fresh) : [];
      if (!source || !missing.length) continue;

      const set: Record<string, unknown> = Object.fromEntries(missing.map(([f, v]) => [`utxo_${f}`, v]));
      await tx.run(UPDATE.entity(TransactionOutputs).set(set).where({ txSeq: row.txSeq, outputIndex }));
      counts.outputs++;

      let inputs = 0;
      let ledgerUtxos = 0;
      for (const [f, v] of missing) {
        const spent: Record<string, unknown> = { spentTxHash: source.hash, spentOutputIndex: outputIndex, [`utxoData_${f}`]: null };
        inputs = Math.max(inputs, Number(await tx.run(UPDATE.entity(TransactionInputs).set({ [`utxoData_${f}`]: v }).where(spent))) || 0);
        const unspent: Record<string, unknown> = { txHash: source.hash, outputIndex, [`utxo_${f}`]: null };
        ledgerUtxos = Math.max(ledgerUtxos, Number(await tx.run(UPDATE.entity(LedgerUTxOs).set({ [`utxo_${f}`]: v }).where(unspent))) || 0);
      }
      counts.inputs += inputs;
      counts.ledgerUtxos += ledgerUtxos;
    }
  }
  return counts;
}

export class OutputDatumBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputDatumBackfillError';
  }
}

export interface OutputDatumBackfillProgress extends OutputFillCounts {
  /** Stored outputs read. */
  scanned: number;
  /** Outputs with a datum hash and no inline datum. */
  candidates: number;
  /** Transactions read again from the backend. */
  transactions: number;
  /** Candidate transactions the backend did not return. */
  missing: number;
}

export interface OutputDatumBackfillOptions {
  client: Pick<CardanoClient, 'getTransactionsBatch' | 'supports'>;
  /** Stored outputs per page. */
  chunkSize?: number;
  /** Transactions per backend read. */
  batchSize?: number;
  onProgress?: (p: OutputDatumBackfillProgress) => void;
  /** Stops the walk before the next page. */
  shouldStop?: () => boolean;
}

type PageRow = Pick<TransactionOutput, 'txSeq' | 'outputIndex' | 'utxo_dataHash' | 'utxo_inlineDatum'>;

// Reads every transaction again that holds an output with a datum hash and no inline datum, and
// fills what the backend returns. Pages by primary key only. Backend reads run outside any DB tx.
export async function backfillOutputDatums(opts: OutputDatumBackfillOptions): Promise<OutputDatumBackfillProgress> {
  if (!opts.client.supports('getTransaction')) {
    throw new OutputDatumBackfillError('No configured backend serves transactions. With Ogmios only, run backfillTransactions over the crawled range.');
  }
  const chunkSize = opts.chunkSize ?? 5000;
  const batchSize = Math.min(opts.batchSize ?? 100, IN_CHUNK);
  const progress: OutputDatumBackfillProgress = { scanned: 0, candidates: 0, transactions: 0, missing: 0, outputs: 0, inputs: 0, ledgerUtxos: 0 };
  await pageByKey<PageRow>({
    entity: TransactionOutputs, keys: ['txSeq', 'outputIndex'], columns: ['utxo_dataHash', 'utxo_inlineDatum'], chunkSize,
    shouldStop: opts.shouldStop,
  }, async (rows) => {
    const candidates = rows.filter((r) => r.utxo_dataHash != null && r.utxo_inlineDatum == null);
    progress.scanned += rows.length;
    progress.candidates += candidates.length;

    for (const seqs of chunk([...new Set(candidates.map((r) => Number(r.txSeq)))], batchSize)) {
      const stored = (await cds.tx((tx: CapTransaction) => tx.run(
        SELECT.from(Transactions).columns('hash', 'txSeq').where({ txSeq: { in: seqs } })
      ))) as Array<{ hash: string; txSeq: number | string }> ?? [];
      const fresh = stored.length ? await opts.client.getTransactionsBatch(stored.map((t) => t.hash)) : new Map();
      const sources: OutputSource[] = stored.flatMap((t) => {
        const read = fresh.get(t.hash);
        return read ? [{ hash: t.hash, txSeq: Number(t.txSeq), outputs: read.outputs ?? [] }] : [];
      });
      progress.transactions += sources.length;
      progress.missing += seqs.length - sources.length;
      const counts = await cds.tx((tx: CapTransaction) => fillOutputFields(tx, sources));
      progress.outputs += counts.outputs;
      progress.inputs += counts.inputs;
      progress.ledgerUtxos += counts.ledgerUtxos;
    }
    opts.onProgress?.({ ...progress });
  });
  logger.info(
    `output datums: ${progress.outputs} outputs, ${progress.inputs} inputs and ${progress.ledgerUtxos} UTxO set rows filled; ` +
    `${progress.candidates} candidates in ${progress.scanned} outputs, ${progress.transactions} transactions read, ${progress.missing} not returned`
  );
  return progress;
}
