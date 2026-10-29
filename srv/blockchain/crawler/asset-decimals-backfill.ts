import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { Assets } from '#cds-models/odatano/cardano';
import { cip68ReferenceUnit } from '../../cbor/cip68';
import { cip68Decimals, setAssetDecimals } from '../asset-decimals';

const { SELECT } = cds.ql;
const logger = cds.log('DecimalsBackfill');

export interface DecimalsBackfillProgress {
  /** Catalogue rows read. */
  scanned: number;
  /** Units with label 333 or 444. */
  candidates: number;
  /** Units that received a decimals value. */
  filled: number;
}

export interface DecimalsBackfillOptions {
  /** Rows per page. */
  chunkSize?: number;
  onProgress?: (p: DecimalsBackfillProgress) => void;
}

interface CatalogueRow {
  unit: string;
  initialMintTxHash?: string | null;
}

/**
 * Fills Assets.decimals from the CIP-68 reference datum for every catalogue unit with label 333
 * or 444. The catalogue is paged by unit alone, so the page query never depends on column
 * statistics; a repeat resolves every unit again and so refreshes the values.
 */
export async function backfillAssetDecimals(opts: DecimalsBackfillOptions = {}): Promise<DecimalsBackfillProgress> {
  const chunkSize = opts.chunkSize ?? 5000;
  const progress: DecimalsBackfillProgress = { scanned: 0, candidates: 0, filled: 0 };
  let cursor: string | null = null;
  for (;;) {
    const done: boolean = await cds.tx(async (tx: CapTransaction) => {
      const rows = (await tx.run(
        SELECT.from(Assets).columns('unit', 'initialMintTxHash').where(cursor ? { unit: { '>': cursor } } : {}).orderBy('unit').limit(chunkSize)
      )) as CatalogueRow[] ?? [];
      if (!rows.length) return true;
      const full = rows.length === chunkSize;
      const lastUnit = rows[rows.length - 1].unit;
      const allSame = rows.every((r) => r.unit === lastUnit);
      // The slices of a unit are adjacent. The last unit of a full page may continue on the next
      // one, so its rows wait there; a page holding one unit only is resolved as a whole.
      const complete = full && !allSame ? rows.filter((r) => r.unit !== lastUnit) : rows;
      const mints = new Map<string, string | null>();
      for (const r of complete) {
        if (!cip68ReferenceUnit(r.unit)) continue;
        if (!mints.has(r.unit) || r.initialMintTxHash) mints.set(r.unit, r.initialMintTxHash ?? null);
      }
      for (const [unit, mintTxHash] of mints) {
        const decimals = await cip68Decimals(tx, unit, mintTxHash);
        if (decimals == null) continue;
        await setAssetDecimals(tx, unit, decimals);
        progress.filled++;
      }
      progress.scanned += complete.length;
      progress.candidates += mints.size;
      cursor = complete[complete.length - 1].unit;
      return !full;
    });
    opts.onProgress?.({ ...progress });
    if (done) break;
  }
  logger.info(`asset decimals filled: ${progress.filled} of ${progress.candidates} CIP-68 units, ${progress.scanned} catalogue rows read`);
  return progress;
}
