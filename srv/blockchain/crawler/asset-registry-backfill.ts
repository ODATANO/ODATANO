import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import { Assets } from '#cds-models/odatano/cardano';
import type { CardanoClient } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import { NotFoundError, ProviderUnavailableError } from '../../utils/errors';

const { UPDATE } = cds.ql;
const logger = cds.log('RegistryBackfill');

export interface RegistryBackfillProgress {
  /** Units with a CIP-26 registry entry. */
  units: number;
  /** Units handled so far, filled or failed. */
  processed: number;
  /** Units whose Assets rows received the registry values. */
  filled: number;
  /** Units the backend did not resolve. */
  failed: number;
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
  const progress: RegistryBackfillProgress = { units: units.length, processed: 0, filled: 0, failed: 0 };
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
  return progress;
}
