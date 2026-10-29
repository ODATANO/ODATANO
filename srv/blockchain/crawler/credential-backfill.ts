import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { paymentCredentialOf } from '../../utils/mappers';
import { chunk } from '../../utils/collections';
import { TransactionOutputs, TransactionInputs, LedgerUTxOs } from '#cds-models/odatano/cardano';

const { SELECT, UPDATE } = cds.ql;
const logger = cds.log('CredentialBackfill');

/**
 * Fills the payment credential of UTxO-shaped rows written before the column existed:
 * TransactionOutputs, TransactionInputs and LedgerUTxOs. Each table is paged by its primary key
 * alone, so the page query never depends on column statistics; rows that already carry a
 * credential are skipped in process, and a second run changes nothing.
 */

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

/**
 * One UPDATE per chunk: the fills travel as a JSON array and are joined on the key. Only rows
 * still without a credential are touched. Postgres and SQLite; other databases get one UPDATE per row.
 */
export function credentialFillStatement(kind: string, spec: CredentialTableSpec): string | null {
  const [k1, k2] = spec.keys;
  if (kind === 'postgres') {
    return `UPDATE ${spec.table} AS t SET ${spec.column} = v.credential ` +
      `FROM json_to_recordset($1::json) AS v(${k1.toLowerCase()} ${spec.firstKeyType}, ${k2.toLowerCase()} integer, credential text) ` +
      `WHERE t.${k1} = v.${k1.toLowerCase()} AND t.${k2} = v.${k2.toLowerCase()} AND t.${spec.column} IS NULL`;
  }
  if (kind === 'sqlite' || kind === 'better-sqlite') {
    const cols = [k1, k2, 'credential'].map((c) => `json_extract(value, '$.${c.toLowerCase()}') AS ${c}`).join(', ');
    return `UPDATE ${spec.table} AS t SET ${spec.column} = v.credential FROM (SELECT ${cols} FROM json_each(?)) AS v ` +
      `WHERE t.${k1} = v.${k1} AND t.${k2} = v.${k2} AND t.${spec.column} IS NULL`;
  }
  return null;
}

async function writeFills(tx: CapTransaction, spec: CredentialTableSpec, fills: Fill[], chunkSize: number): Promise<void> {
  if (!fills.length) return;
  const sql = credentialFillStatement((cds.db as { kind?: string } | undefined)?.kind ?? '', spec);
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

/** Where the walk continues: after `first` (greater first key), or within it after `second`. */
interface Cursor {
  first: number | string;
  second: number;
  within: boolean;
}

/** Walks one table from its lowest key; returns the rows that received a credential. */
async function fillTable(spec: CredentialTableSpec, chunkSize: number, onChunk: (filled: number) => void): Promise<number> {
  const [k1, k2] = spec.keys;
  let filled = 0;
  let cursor: Cursor | null = null;
  const decoded = new Map<string, string | null>();
  for (;;) {
    const done: boolean = await cds.tx(async (tx: CapTransaction) => {
      const where: Record<string, unknown> = {};
      if (cursor?.within) {
        where[k1] = cursor.first;
        where[k2] = { '>': cursor.second };
      } else if (cursor) {
        where[k1] = { '>': cursor.first };
      }
      const rows = (await tx.run(
        SELECT.from(spec.entity as never).columns(k1, k2, spec.address, spec.column).where(where).orderBy(k1, k2).limit(chunkSize)
      )) as Array<Record<string, unknown>> ?? [];
      const wasWithin = cursor?.within ?? false;
      if (!rows.length) {
        if (!wasWithin) return true;
        cursor = { ...cursor!, within: false };
        return false;
      }
      const full = rows.length === chunkSize;
      const lastFirst = rows[rows.length - 1][k1];
      const allSame = rows.every((r) => r[k1] === lastFirst);
      // The last key of a full batch may continue in the next one: its rows wait for it. When the
      // whole batch is that one key, the walk continues inside it by the second key.
      const complete = full && !allSame ? rows.filter((r) => r[k1] !== lastFirst) : rows;
      const fills: Fill[] = [];
      for (const r of complete) {
        if (r[spec.column] != null) continue;
        const address = r[spec.address] as string | null;
        if (!address) continue;
        if (!decoded.has(address)) decoded.set(address, paymentCredentialOf(address));
        const credential = decoded.get(address);
        if (credential) fills.push({ first: keyValue(r[k1], spec.firstKeyType), second: Number(r[k2]), credential });
      }
      await writeFills(tx, spec, fills, chunkSize);
      filled += fills.length;
      const last = complete[complete.length - 1];
      cursor = { first: keyValue(last[k1], spec.firstKeyType), second: Number(last[k2]), within: full && allSame };
      return !full && !wasWithin;
    });
    onChunk(filled);
    if (decoded.size > 50_000) decoded.clear();
    if (done) return filled;
  }
}

export async function backfillUtxoCredentials(opts: CredentialBackfillOptions = {}): Promise<CredentialBackfillProgress> {
  const chunkSize = opts.chunkSize ?? 5000;
  const progress: CredentialBackfillProgress = { table: null, outputs: 0, inputs: 0, ledgerUtxos: 0 };
  for (const spec of CREDENTIAL_TABLES) {
    progress.table = spec.name;
    opts.onProgress?.({ ...progress });
    progress[spec.counter] = await fillTable(spec, chunkSize, (filled) => {
      progress[spec.counter] = filled;
      opts.onProgress?.({ ...progress });
    });
  }
  progress.table = null;
  logger.info(`payment credentials filled: ${progress.outputs} outputs, ${progress.inputs} inputs, ${progress.ledgerUtxos} ledger UTxOs`);
  return progress;
}
