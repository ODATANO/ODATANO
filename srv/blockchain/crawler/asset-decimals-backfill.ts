import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { Assets, type Asset } from '#cds-models/odatano/cardano';
import { cip68ReferenceUnit } from '../../cbor/cip68';
import { cip68Decimals, setAssetDecimals } from '../asset-decimals';
import { pageByKey } from './key-pages';

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
  /** Stops the walk before the next page. */
  shouldStop?: () => boolean;
}

type CatalogueRow = Pick<Asset, 'initialMintTxHash'> & { unit: string; validFrom: string };

// Fill Assets.decimals from the CIP-68 reference datum for label 333 and 444 units. Pages by key
// only, so the query plan never depends on column statistics. A repeat run refreshes the values.
// A unit with more slices than a page holds is resolved per page; each part writes the same value.
export async function backfillAssetDecimals(opts: DecimalsBackfillOptions = {}): Promise<DecimalsBackfillProgress> {
  const chunkSize = opts.chunkSize ?? 5000;
  const progress: DecimalsBackfillProgress = { scanned: 0, candidates: 0, filled: 0 };
  // units are adjacent in key order, so only the last unit of the previous page can go on
  let carried: { unit: string; filled: boolean } | null = null;
  await pageByKey<CatalogueRow>({
    entity: Assets, keys: ['unit', 'validFrom'], columns: ['initialMintTxHash'], chunkSize, shouldStop: opts.shouldStop,
  }, async (rows) => {
    const mints = new Map<string, string | null>();
    for (const r of rows) {
      if (!cip68ReferenceUnit(r.unit)) continue;
      if (!mints.has(r.unit) || r.initialMintTxHash) mints.set(r.unit, r.initialMintTxHash ?? null);
    }
    const filled = new Set<string>();
    await cds.tx(async (tx: CapTransaction) => {
      for (const [unit, mintTxHash] of mints) {
        const decimals = await cip68Decimals(tx, unit, mintTxHash);
        if (decimals == null) continue;
        await setAssetDecimals(tx, unit, decimals);
        filled.add(unit);
      }
    });
    progress.scanned += rows.length;
    for (const unit of mints.keys()) {
      const continued = carried?.unit === unit;
      if (!continued) progress.candidates++;
      if (filled.has(unit) && !(continued && carried!.filled)) progress.filled++;
    }
    const last = rows[rows.length - 1].unit;
    carried = { unit: last, filled: filled.has(last) || (carried?.unit === last && carried.filled) };
    opts.onProgress?.({ ...progress });
  });
  logger.info(`asset decimals filled: ${progress.filled} of ${progress.candidates} CIP-68 units, ${progress.scanned} catalogue rows read`);
  return progress;
}
