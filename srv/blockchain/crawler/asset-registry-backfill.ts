import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { promises as fs } from 'fs';
import path from 'path';
import { Assets } from '#cds-models/odatano/cardano';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import { NotFoundError, ProviderUnavailableError, TransactionValidationError } from '../../utils/errors';
import { chunk } from '../../utils/collections';
import { isAssetUnit } from '../../utils/validators';

const { UPDATE } = cds.ql;
const logger = cds.log('RegistryBackfill');

export interface RegistryBackfillProgress {
  /** Units with a CIP-26 registry entry. */
  units: number;
  /** Units handled so far, filled or failed. */
  processed: number;
  /** Units whose Assets rows received the registry values. */
  filled: number;
  /** Units the backend did not resolve, or entry files that could not be read. */
  failed: number;
  /** Source file: registry units the database has no Assets row for. */
  absent: number;
  /** Source file: entries that describe no native asset. */
  skipped: number;
}

export interface RegistryBackfillOptions {
  client: CardanoClient;
  indexer: CardanoIndexer;
  /** Backend calls per second; one unit is one call. */
  unitsPerSecond?: number;
  onProgress?: (p: RegistryBackfillProgress) => void;
}

/** The run stops when this many units in a row fail: the backend is down, not the units. */
const MAX_CONSECUTIVE_FAILURES = 25;

// Fill the CIP-26 registry fields of every Assets slice for the units the registry lists. The
// registry is off-chain, so each unit is read from the backend; a repeat run refreshes the values.
export async function backfillAssetRegistry(opts: RegistryBackfillOptions): Promise<RegistryBackfillProgress> {
  const backend = opts.client.getTokenRegistryBackend();
  if (!backend) throw new ProviderUnavailableError('No backend lists the token registry (needs Koios)');
  const units = await backend.getTokenRegistryUnits();
  const intervalMs = 1000 / Math.max(1, opts.unitsPerSecond ?? 4);
  const progress: RegistryBackfillProgress = { units: units.length, processed: 0, filled: 0, failed: 0, absent: 0, skipped: 0 };
  const failuresByError = new Map<string, number>();
  let consecutiveFailures = 0;

  for (const unit of units) {
    const started = Date.now();
    try {
      await cds.tx(async (tx: CapTransaction) => {
        const row = await opts.indexer.indexAssetFromBackend(tx, unit);
        // Every slice of the unit carries the registry values, the bare catalogue row included.
        await tx.run(UPDATE.entity(Assets).set({
          registryName: row.registryName ?? null,
          registryTicker: row.registryTicker ?? null,
          registryDecimals: row.registryDecimals ?? null,
          registryDescription: row.registryDescription ?? null,
          registryUrl: row.registryUrl ?? null,
          registryLogo: row.registryLogo ?? null,
        }).where({ unit }));
        if (row.decimals != null) {
          await tx.run(UPDATE.entity(Assets).set({ decimals: row.decimals }).where({ unit, decimals: null }));
        }
      });
      progress.filled++;
      consecutiveFailures = 0;
    } catch (err) {
      progress.failed++;
      consecutiveFailures++;
      const errorName = err instanceof Error ? err.name : typeof err;
      failuresByError.set(errorName, (failuresByError.get(errorName) ?? 0) + 1);
      logger.debug(`registry fill for ${unit} failed:`, err);
      if (!(err instanceof NotFoundError) && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const last = err instanceof Error ? err.message : String(err);
        throw new ProviderUnavailableError(`${consecutiveFailures} units in a row failed, last: ${last}`);
      }
    }
    progress.processed++;
    opts.onProgress?.({ ...progress });
    const wait = intervalMs - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  logger.info(`asset registry filled: ${progress.filled} of ${progress.units} registered units, ${progress.failed} failed`);
  if (failuresByError.size > 0) {
    const counts = [...failuresByError].map(([name, count]) => `${name} ${count}`).join(', ');
    logger.warn(`asset registry: units not filled, by error: ${counts}`);
  }
  return progress;
}

/** The registry values of one unit, as the Assets columns hold them. */
export interface RegistryEntry {
  unit: string;
  registryName: string | null;
  registryTicker: string | null;
  registryDecimals: number | null;
  registryDescription: string | null;
  registryUrl: string | null;
  registryLogo: string | null;
}

// One entry file of the registry repository. Null for an entry whose subject is no asset unit, or
// that carries a preimage: the registry also describes scripts. A value too long for its column is left out.
export function parseRegistryEntry(json: string): RegistryEntry | null {
  const entry = JSON.parse(json) as Record<string, { value?: unknown } | string | undefined>;
  const unit = typeof entry.subject === 'string' ? entry.subject.toLowerCase() : '';
  if (!isAssetUnit(unit) || entry.preImage !== undefined) return null;
  const text = (name: string, max: number): string | null => {
    const value = (entry[name] as { value?: unknown } | undefined)?.value;
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  };
  const decimals = (entry.decimals as { value?: unknown } | undefined)?.value;
  return {
    unit,
    registryName: text('name', 128),
    registryTicker: text('ticker', 16),
    registryDecimals: typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null,
    registryDescription: text('description', 5000),
    registryUrl: text('url', 256),
    registryLogo: text('logo', 500_000),
  };
}

export interface RegistryFileOptions {
  directory: string; // folder with one <subject>.json per registry entry
  onProgress?: (p: RegistryBackfillProgress) => void;
}

/** The entry files of `directory`; refuses a path that holds none. */
export async function registryEntryFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (err) {
    throw new TransactionValidationError(`path is not a readable folder: ${err instanceof Error ? err.message : String(err)}`);
  }
  const files = names.filter(n => n.endsWith('.json')).sort();
  if (!files.length) {
    throw new TransactionValidationError('path holds no entry files (*.json). Name the folder mappings of cardano-token-registry, or registry of metadata-registry-testnet.');
  }
  return files;
}

// Fill the registry fields from the entry files of a checkout of the registry repository. Only
// units that have an Assets row are written; no backend is asked and no row is created.
export async function backfillAssetRegistryFromFiles(opts: RegistryFileOptions): Promise<RegistryBackfillProgress> {
  const files = await registryEntryFiles(opts.directory);
  const progress: RegistryBackfillProgress = { units: files.length, processed: 0, filled: 0, failed: 0, absent: 0, skipped: 0 };
  for (const batch of chunk(files, 200)) {
    const entries: RegistryEntry[] = [];
    for (const name of batch) {
      try {
        const entry = parseRegistryEntry(await fs.readFile(path.join(opts.directory, name), 'utf8'));
        if (entry) entries.push(entry);
        else progress.skipped++;
      } catch (err) {
        progress.failed++;
        logger.debug(`registry entry ${name} not read:`, err);
      }
    }
    await cds.tx(async (tx: CapTransaction) => {
      for (const { unit, ...values } of entries) {
        const rows = Number(await tx.run(UPDATE.entity(Assets).set(values).where({ unit })));
        if (!rows) { progress.absent++; continue; }
        progress.filled++;
        if (values.registryDecimals != null) {
          await tx.run(UPDATE.entity(Assets).set({ decimals: values.registryDecimals }).where({ unit, decimals: null }));
        }
      }
    });
    progress.processed += batch.length;
    opts.onProgress?.({ ...progress });
  }
  logger.info(`asset registry filled from ${opts.directory}: ${progress.filled} of ${progress.units} entries, ${progress.absent} without an asset row, ${progress.skipped} not an asset, ${progress.failed} failed`);
  return progress;
}
