import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { AssetHistory, AssetSupply, AssetSupply_, CardanoSyncState } from '#cds-models/odatano/cardano';
import { chunk, IN_CHUNK } from '../utils/collections';
import { SINGLETON_ID } from './crawler/sync-state';

const { SELECT, UPSERT, UPDATE, DELETE } = cds.ql;

// Supply and event count per unit, kept by the crawler. AssetSupply counts the AssetHistory rows
// up to the block height in CardanoSyncState.assetSupplyHeight, so a row the lazy path wrote
// ahead of the crawler is counted once, when the crawler reaches its block.

type HistoryRow = Pick<AssetHistory, 'unit' | 'action' | 'quantity' | 'blockHeight'>;

const big = (v: unknown): bigint => (v == null || v === '' ? 0n : BigInt(String(v).split('.')[0]));
const signed = (r: HistoryRow): bigint => (r.action === 'burn' ? -1n : 1n) * big(r.quantity);

/** The stored sums of one unit; undefined for a unit without counted rows. */
export async function readAssetSupply(tx: CapTransaction, unit: string): Promise<AssetSupply | undefined> {
  return await tx.run(SELECT.one.from(AssetSupply_).where({ unit })) as AssetSupply | undefined;
}

/** Height up to which AssetSupply is counted; null until computed. */
export async function assetSupplyHeight(tx: CapTransaction): Promise<number | null> {
  const row = await tx.run(SELECT.one.from(CardanoSyncState).columns('assetSupplyHeight').where({ ID: SINGLETON_ID })) as
    { assetSupplyHeight?: number | string | null } | undefined;
  return row?.assetSupplyHeight == null ? null : Number(row.assetSupplyHeight);
}

async function addToSupply(tx: CapTransaction, rows: HistoryRow[], sign: 1n | -1n): Promise<void> {
  const deltas = new Map<string, { supply: bigint; count: number }>();
  for (const r of rows) {
    const d = deltas.get(String(r.unit)) ?? { supply: 0n, count: 0 };
    d.supply += sign * signed(r);
    d.count += Number(sign);
    deltas.set(String(r.unit), d);
  }
  for (const units of chunk([...deltas.keys()], IN_CHUNK)) {
    const existing = await tx.run(SELECT.from(AssetSupply_).where({ unit: { in: units } })) as AssetSupply[] | undefined;
    const byUnit = new Map((existing ?? []).map(e => [String(e.unit), e]));
    const upserts: AssetSupply[] = [];
    const deletes: string[] = [];
    for (const unit of units) {
      const d = deltas.get(unit)!;
      const prev = byUnit.get(unit);
      const count = Number(prev?.mintOrBurnCount ?? 0) + d.count;
      if (count <= 0) deletes.push(unit);
      else upserts.push({ unit, totalSupply: (big(prev?.totalSupply) + d.supply).toString(), mintOrBurnCount: count });
    }
    if (upserts.length) await tx.run(UPSERT.into(AssetSupply_).entries(upserts));
    if (deletes.length) await tx.run(DELETE.from(AssetSupply_).where({ unit: { in: deletes } }));
  }
}

// Counts the mint and burn rows of one crawled block. A block at or below the height is
// already counted (a crawl repeated after a cursor reset) and changes nothing.
export async function applyBlockAssetSupply(tx: CapTransaction, rows: HistoryRow[], height: number): Promise<void> {
  if (!rows.length) return;
  const counted = await assetSupplyHeight(tx);
  if (counted == null || height <= counted) return;
  await addToSupply(tx, rows, 1n);
  await tx.run(UPDATE.entity(CardanoSyncState).set({ assetSupplyHeight: height }).where({ ID: SINGLETON_ID }));
}

// Takes the rows of rolled-back transactions off the sums. Runs before they are deleted and
// before lowerAssetSupplyHeight, which ends the rollback.
export async function undoAssetSupply(tx: CapTransaction, txHashes: string[]): Promise<void> {
  const counted = await assetSupplyHeight(tx);
  if (counted == null || !txHashes.length) return;
  const rows: HistoryRow[] = [];
  for (const hashes of chunk(txHashes, IN_CHUNK)) {
    const found = await tx.run(
      SELECT.from(AssetHistory).columns('unit', 'action', 'quantity', 'blockHeight').where({ txHash: { in: hashes } })
    ) as HistoryRow[] | undefined;
    rows.push(...(found ?? []).filter(r => r.blockHeight != null && Number(r.blockHeight) <= counted));
  }
  await addToSupply(tx, rows, -1n);
}

// Lowers the counted height to the fork, so the blocks of the new chain are counted.
// An unknown fork height clears it, and the next crawler start computes the sums again.
export async function lowerAssetSupplyHeight(tx: CapTransaction, forkHeight: number | null): Promise<void> {
  await tx.run(UPDATE.entity(CardanoSyncState).set({ assetSupplyHeight: forkHeight })
    .where(forkHeight == null ? { ID: SINGLETON_ID } : { ID: SINGLETON_ID, assetSupplyHeight: { '>': forkHeight } }));
}

const T = { supply: 'odatano_cardano_AssetSupply', history: 'odatano_cardano_AssetHistory' };

/** Statements that rebuild AssetSupply from the AssetHistory rows up to `height`. Portable SQL. */
export function assetSupplyStatements(height: number): string[] {
  const h = Math.trunc(height);
  return [
    `DELETE FROM ${T.supply}`,
    `INSERT INTO ${T.supply} (unit, totalSupply, mintOrBurnCount) ` +
    `SELECT unit, SUM(CASE WHEN action = 'burn' THEN -CAST(quantity AS DECIMAL(38, 0)) ELSE CAST(quantity AS DECIMAL(38, 0)) END), COUNT(*) ` +
    `FROM ${T.history} WHERE blockHeight <= ${h} GROUP BY unit`,
  ];
}

// Builds AssetSupply once from the stored rows up to `height`, the crawler's cursor. Runs
// before the crawler writes blocks, so no block lands between the sum and the height.
export async function computeAssetSupply(tx: CapTransaction, height: number): Promise<void> {
  const raw = tx as unknown as { run: (sql: string) => Promise<unknown> };
  // the GROUP BY reads every row once; a bigger hash budget keeps it in memory on PostgreSQL
  if ((cds.db as { kind?: string } | undefined)?.kind === 'postgres') await raw.run(`SET LOCAL work_mem = '256MB'`);
  for (const sql of assetSupplyStatements(height)) await raw.run(sql);
  await tx.run(UPDATE.entity(CardanoSyncState).set({ assetSupplyHeight: Math.trunc(height) }).where({ ID: SINGLETON_ID }));
}
