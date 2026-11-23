import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { assetSlice } from '../../utils/mappers';
import { chunk } from '../../utils/collections';
import { bulkSqlKind, connectedDbKind, jsonFillUpdate, type BulkSqlKind } from '../../utils/db-kind';
import { slotRangeOf, walkSlotWindows } from './window-plan';
import { TransactionInputs, TransactionOutputs } from '#cds-models/odatano/cardano';

const logger = cds.log('AssetSliceBackfill');

// Sets policy id, name in hex and decoded, and fingerprint of every stored asset row to what
// assetSlice derives from its unit. Rows that already agree are left alone. Idempotent.

export interface AssetSliceBackfillProgress {
  /** Table being walked; null when finished. */
  table: AssetSliceTable['name'] | null;
  outputs: number;
  inputs: number;
  ledgerUtxos: number;
  ledgerAddresses: number;
  utxoSlices: number;
  addressSlices: number;
}

export interface AssetSliceBackfillOptions {
  /** Slots per window on the transaction tables. */
  slotWindow?: number;
  /** Units, or addresses on the cached tables, per statement. */
  chunkSize?: number;
  shouldStop?: () => boolean;
  onProgress?: (p: AssetSliceBackfillProgress) => void;
}

interface AssetSliceTable {
  name: 'TransactionOutputAssets' | 'TransactionInputAssetCopies' | 'LedgerUTxOAssets' | 'LedgerAddressAssets' | 'UTxOAssets' | 'AddressAssets';
  table: string;
  counter: 'outputs' | 'inputs' | 'ledgerUtxos' | 'ledgerAddresses' | 'utxoSlices' | 'addressSlices';
  /** txSeq column of a table walked by slot window. */
  seqColumn?: string;
  /** Entity whose txSeq bounds the window walk. */
  rangeOf?: unknown;
  /** Address column of a cached table, walked along its address index; every slice of a row is set. */
  addressColumn?: string;
}

export const ASSET_SLICE_TABLES: readonly AssetSliceTable[] = [
  { name: 'TransactionOutputAssets', table: 'odatano_cardano_TransactionOutputAssets', counter: 'outputs', seqColumn: 'output_txSeq', rangeOf: TransactionOutputs },
  { name: 'TransactionInputAssetCopies', table: 'odatano_cardano_TransactionInputAssetCopies', counter: 'inputs', seqColumn: 'input_txSeq', rangeOf: TransactionInputs },
  { name: 'LedgerUTxOAssets', table: 'odatano_cardano_LedgerUTxOAssets', counter: 'ledgerUtxos' },
  { name: 'LedgerAddressAssets', table: 'odatano_cardano_LedgerAddressAssets', counter: 'ledgerAddresses' },
  { name: 'UTxOAssets', table: 'odatano_cardano_UTxOAssets', counter: 'utxoSlices', addressColumn: 'utxo_address_address' },
  { name: 'AddressAssets', table: 'odatano_cardano_AddressAssets', counter: 'addressSlices', addressColumn: 'address_address' },
];

const SLICE_COLUMNS = ['asset_policyId', 'asset_assetNameHex', 'asset_assetName', 'asset_fingerprint'] as const;

// One UPDATE that sets the slice columns of every row whose unit, and address on a cached table, is in
// the bound JSON array and whose columns differ. `bounds` limits it to one txSeq window; they are
// integers, so they are written inline.
export function sliceFillStatement(kind: BulkSqlKind, spec: AssetSliceTable, bounds?: [number, number]): string {
  const differs = SLICE_COLUMNS.map((c) => `t.${c} IS DISTINCT FROM v.${c}`).join(' OR ');
  const window = bounds && spec.seqColumn
    ? `t.${spec.seqColumn} >= ${Math.trunc(bounds[0])} AND t.${spec.seqColumn} < ${Math.trunc(bounds[1])} AND `
    : '';
  return jsonFillUpdate(kind, {
    table: spec.table,
    keys: spec.addressColumn ? [[spec.addressColumn, 'text'], ['unit', 'text']] : [['unit', 'text']],
    values: SLICE_COLUMNS.map((c) => [c, 'text']),
    set: SLICE_COLUMNS.map((c) => `${c} = v.${c}`).join(', '),
    where: `${window}(${differs})`,
  });
}

/** Fill records of `units`, the record fields named after the columns in lower case. */
function records(units: string[], extra: Array<Record<string, string>> = []): Array<Record<string, string | null>> {
  return units.map((unit, i) => {
    const s = assetSlice(unit, 0);
    return {
      ...extra[i],
      unit,
      asset_policyid: s.asset_policyId,
      asset_assetnamehex: s.asset_assetNameHex,
      asset_assetname: s.asset_assetName,
      asset_fingerprint: s.asset_fingerprint,
    };
  });
}

/** Rows a plain statement changed; the drivers answer with their own result object. */
function changed(result: unknown): number {
  const r = result as { changes?: number; rowCount?: number } | number | undefined;
  return typeof r === 'number' ? r : Number(r?.changes ?? r?.rowCount) || 0;
}

async function fillUnits(tx: CapTransaction, sql: string, units: string[], chunkSize: number): Promise<number> {
  let n = 0;
  for (const part of chunk(units, chunkSize)) n += changed(await tx.run(sql, [JSON.stringify(records(part))]));
  return n;
}

// Walks a cached table along its address index: a page of addresses, then every (address, unit) pair
// in that address range. One pair stands for all slices of the row, so each slice gets the columns.
async function fillByAddress(kind: BulkSqlKind, spec: AssetSliceTable, opts: AssetSliceBackfillOptions, add: (n: number) => void): Promise<boolean> {
  const column = spec.addressColumn!;
  const chunkSize = opts.chunkSize ?? 1000;
  const sql = sliceFillStatement(kind, spec);
  const [p1, p2] = kind === 'postgres' ? ['$1', '$2'] : ['?', '?'];
  const page = `SELECT DISTINCT ${column} AS address FROM ${spec.table} WHERE ${column} > ${p1} ORDER BY ${column} LIMIT ${chunkSize}`;
  const pairs = `SELECT DISTINCT ${column} AS address, unit FROM ${spec.table} WHERE ${column} >= ${p1} AND ${column} <= ${p2}`;
  for (let after = ''; ;) {
    if (opts.shouldStop?.()) return false;
    const addresses = ((await cds.tx((tx: CapTransaction) => tx.run(page, [after]))) as Array<{ address: string }>).map((r) => r.address);
    if (!addresses.length) return true;
    add(await cds.tx(async (tx: CapTransaction) => {
      const rows = await tx.run(pairs, [addresses[0], addresses[addresses.length - 1]]) as Array<{ address: string; unit: string }>;
      let n = 0;
      for (const part of chunk(rows, chunkSize)) {
        const fill = records(part.map((r) => r.unit), part.map((r) => ({ [column.toLowerCase()]: r.address })));
        n += changed(await tx.run(sql, [JSON.stringify(fill)]));
      }
      return n;
    }));
    after = addresses[addresses.length - 1];
    if (addresses.length < chunkSize) return true;
  }
}

/** Walks a transaction asset table window by window. False when stopped. */
async function fillByWindow(kind: BulkSqlKind, spec: AssetSliceTable, opts: AssetSliceBackfillOptions, add: (n: number) => void): Promise<boolean> {
  const range = await slotRangeOf(spec.rangeOf);
  if (!range) return true;
  const chunkSize = opts.chunkSize ?? 1000;
  // the fill matches the window's rows against a unit list: a hash join, key lookups take 100 times longer
  return walkSlotWindows(range, { slotWindow: opts.slotWindow, shouldStop: opts.shouldStop, plan: 'join' }, async (tx, window) => {
    const rows = await tx.run(
      `SELECT DISTINCT unit FROM ${spec.table} WHERE ${spec.seqColumn} >= ${Math.trunc(window[0])} AND ${spec.seqColumn} < ${Math.trunc(window[1])}`,
    ) as Array<{ unit: string }>;
    if (rows.length) add(await fillUnits(tx, sliceFillStatement(kind, spec, window), rows.map((r) => r.unit), chunkSize));
  });
}

/** Walks a ledger asset table unit by unit along its unit index. False when stopped. */
async function fillByUnit(kind: BulkSqlKind, spec: AssetSliceTable, opts: AssetSliceBackfillOptions, add: (n: number) => void): Promise<boolean> {
  const chunkSize = opts.chunkSize ?? 1000;
  const sql = sliceFillStatement(kind, spec);
  const page = kind === 'postgres'
    ? `SELECT DISTINCT unit FROM ${spec.table} WHERE unit > $1 ORDER BY unit LIMIT ${chunkSize}`
    : `SELECT DISTINCT unit FROM ${spec.table} WHERE unit > ? ORDER BY unit LIMIT ${chunkSize}`;
  for (let after = ''; ;) {
    if (opts.shouldStop?.()) return false;
    const units = ((await cds.tx((tx: CapTransaction) => tx.run(page, [after]))) as Array<{ unit: string }>).map((r) => r.unit);
    if (!units.length) return true;
    add(await cds.tx((tx: CapTransaction) => fillUnits(tx, sql, units, chunkSize)));
    after = units[units.length - 1];
    if (units.length < chunkSize) return true;
  }
}

export async function backfillAssetSlices(opts: AssetSliceBackfillOptions = {}): Promise<AssetSliceBackfillProgress> {
  const kind = bulkSqlKind(connectedDbKind());
  if (!kind) throw new Error(`Asset rows are rewritten on PostgreSQL and SQLite only (database kind: ${connectedDbKind() || 'none'})`);
  const progress: AssetSliceBackfillProgress = { table: null, outputs: 0, inputs: 0, ledgerUtxos: 0, ledgerAddresses: 0, utxoSlices: 0, addressSlices: 0 };
  for (const spec of ASSET_SLICE_TABLES) {
    progress.table = spec.name;
    opts.onProgress?.({ ...progress });
    const add = (n: number) => {
      progress[spec.counter] += n;
      opts.onProgress?.({ ...progress });
    };
    const finished = spec.seqColumn ? await fillByWindow(kind, spec, opts, add)
      : spec.addressColumn ? await fillByAddress(kind, spec, opts, add)
      : await fillByUnit(kind, spec, opts, add);
    if (!finished) return progress;
  }
  progress.table = null;
  logger.info(`asset rows rewritten: ${progress.outputs} output, ${progress.inputs} input, ${progress.ledgerUtxos} ledger UTxO, ${progress.ledgerAddresses} ledger address, ${progress.utxoSlices} cached UTxO, ${progress.addressSlices} cached address rows`);
  return progress;
}
