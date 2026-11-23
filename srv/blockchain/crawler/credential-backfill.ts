import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { paymentCredentialOf } from '../../utils/mappers';
import { chunk } from '../../utils/collections';
import { bulkSqlKind, connectedDbKind, jsonFillUpdate } from '../../utils/db-kind';
import { pageByKey } from './key-pages';
import { TransactionOutputs, TransactionInputs, LedgerUTxOs } from '#cds-models/odatano/cardano';

const { UPDATE } = cds.ql;
const logger = cds.log('CredentialBackfill');

// Fill the payment credential of TransactionOutputs, TransactionInputs and LedgerUTxOs rows.
// Pages by primary key only, so the query plan never depends on column statistics. Idempotent.

export interface CredentialBackfillProgress {
  /** Table being walked; null when finished. */
  table: 'TransactionOutputs' | 'TransactionInputs' | 'LedgerUTxOs' | null;
  outputs: number;
  inputs: number;
  ledgerUtxos: number;
}

export interface CredentialBackfillOptions {
  /** Rows per statement. */
  chunkSize?: number;
  onProgress?: (p: CredentialBackfillProgress) => void;
  /** Stops the walk before the next page. */
  shouldStop?: () => boolean;
}

export interface CredentialTableSpec {
  name: NonNullable<CredentialBackfillProgress['table']>;
  entity: unknown;
  table: string;
  /** Primary key in walk order. */
  keys: [first: string, second: string];
  /** Postgres type of the first key column. */
  firstKeyType: 'bigint' | 'text';
  column: string;
  address: string;
  counter: 'outputs' | 'inputs' | 'ledgerUtxos';
}

export const CREDENTIAL_TABLES: readonly CredentialTableSpec[] = [
  { name: 'TransactionOutputs', entity: TransactionOutputs, table: 'odatano_cardano_TransactionOutputs', keys: ['txSeq', 'outputIndex'], firstKeyType: 'bigint', column: 'utxo_paymentCredential', address: 'address_address', counter: 'outputs' },
  { name: 'TransactionInputs', entity: TransactionInputs, table: 'odatano_cardano_TransactionInputs', keys: ['txSeq', 'inputIndex'], firstKeyType: 'bigint', column: 'utxoData_paymentCredential', address: 'address_address', counter: 'inputs' },
  { name: 'LedgerUTxOs', entity: LedgerUTxOs, table: 'odatano_cardano_LedgerUTxOs', keys: ['txHash', 'outputIndex'], firstKeyType: 'text', column: 'utxo_paymentCredential', address: 'address', counter: 'ledgerUtxos' },
];

interface Fill {
  first: number | string;
  second: number;
  credential: string;
}

// One UPDATE per chunk that joins a JSON array of fills on the key. Touches only rows without a
// credential. Null for databases other than Postgres and SQLite, which update row by row.
export function credentialFillStatement(kind: string, spec: CredentialTableSpec): string | null {
  const bulk = bulkSqlKind(kind);
  if (!bulk) return null;
  const [k1, k2] = spec.keys;
  return jsonFillUpdate(bulk, {
    table: spec.table,
    keys: [[k1, spec.firstKeyType], [k2, 'integer']],
    values: [['credential', 'text']],
    set: `${spec.column} = v.credential`,
    where: `t.${spec.column} IS NULL`,
  });
}

async function writeFills(tx: CapTransaction, spec: CredentialTableSpec, fills: Fill[], chunkSize: number): Promise<void> {
  if (!fills.length) return;
  const sql = credentialFillStatement(connectedDbKind(), spec);
  const [k1, k2] = spec.keys;
  if (!sql) {
    for (const f of fills) {
      await tx.run(UPDATE.entity(spec.entity as never).set({ [spec.column]: f.credential }).where({ [k1]: f.first, [k2]: f.second, [spec.column]: null }));
    }
    return;
  }
  for (const part of chunk(fills, chunkSize)) {
    const records = part.map((f) => ({ [k1.toLowerCase()]: f.first, [k2.toLowerCase()]: f.second, credential: f.credential }));
    await tx.run(sql, [JSON.stringify(records)]);
  }
}

const keyValue = (v: unknown, type: CredentialTableSpec['firstKeyType']): number | string =>
  type === 'bigint' ? Number(v) : String(v);

/** Walks one table from its lowest key; returns the rows that received a credential, or null when stopped. */
async function fillTable(spec: CredentialTableSpec, chunkSize: number, onChunk: (filled: number) => void, shouldStop?: () => boolean): Promise<number | null> {
  let filled = 0;
  const decoded = new Map<string, string | null>();
  const [k1, k2] = spec.keys;
  const finished = await pageByKey<Record<string, unknown>>({
    entity: spec.entity, keys: spec.keys, columns: [spec.address, spec.column], chunkSize, shouldStop,
  }, async (rows) => {
    const fills: Fill[] = [];
    for (const r of rows) {
      if (r[spec.column] != null) continue;
      const address = r[spec.address] as string | null;
      if (!address) continue;
      if (!decoded.has(address)) decoded.set(address, paymentCredentialOf(address));
      const credential = decoded.get(address);
      if (credential) fills.push({ first: keyValue(r[k1], spec.firstKeyType), second: Number(r[k2]), credential });
    }
    await cds.tx((tx: CapTransaction) => writeFills(tx, spec, fills, chunkSize));
    filled += fills.length;
    onChunk(filled);
    if (decoded.size > 50_000) decoded.clear();
  });
  return finished ? filled : null;
}

export async function backfillUtxoCredentials(opts: CredentialBackfillOptions = {}): Promise<CredentialBackfillProgress> {
  const chunkSize = opts.chunkSize ?? 5000;
  const progress: CredentialBackfillProgress = { table: null, outputs: 0, inputs: 0, ledgerUtxos: 0 };
  for (const spec of CREDENTIAL_TABLES) {
    progress.table = spec.name;
    opts.onProgress?.({ ...progress });
    const filled = await fillTable(spec, chunkSize, (n) => {
      progress[spec.counter] = n;
      opts.onProgress?.({ ...progress });
    }, opts.shouldStop);
    if (filled === null) return progress;
    progress[spec.counter] = filled;
  }
  progress.table = null;
  logger.info(`payment credentials filled: ${progress.outputs} outputs, ${progress.inputs} inputs, ${progress.ledgerUtxos} ledger UTxOs`);
  return progress;
}
