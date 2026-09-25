import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing, TransactionValidationError } from './utils/errors';
import { getCrawler, isCrawlerRunning, isCrawlerRunningInCluster, startCrawler, stopCrawler } from './blockchain/crawler';
import { isCrawlerLeaseActive, readCursor } from './blockchain/crawler/sync-state';
import { importUtxoSet } from './blockchain/crawler/utxo-set-import';
import { isBlockHash } from './utils/validators';
import { getCardanoClient, getCardanoIndexer, loadCrawlerConfigFromEnv } from './server';
import { buildLiveness } from './utils/liveness';
import type { CrawlerConfig } from './blockchain/crawler/crawler';

const logger = cds.log('CardanoIndexerService');

/** One import at a time per process; the promise is only used as the busy flag. */
let utxoSetImportInFlight: Promise<unknown> | null = null;

function utxoSetConfigured(): boolean {
  try {
    return Boolean(loadCrawlerConfigFromEnv()?.utxoSet);
  } catch {
    return false;
  }
}

/**
 * CardanoIndexerService handlers — thin control/observability surface over the crawler
 * singleton (srv/blockchain/crawler). Engine logic lives there; this only reads the
 * cursor and starts/stops the crawler.
 */
module.exports = (srv: cds.Service) => {

  // getLiveness — unauthenticated probe (@requires: 'any'); no handleRequest, no app context.
  srv.on('getLiveness', async () => buildLiveness());

  // getStatus — live run state + sync progress (numeric fields as strings, CAP-10 aligned)
  srv.on('getStatus', async (req: Request) => {
    return handleRequest(req, async (db) => {
      const cursor = await readCursor(db);
      const lastHeight = cursor?.lastHeight ?? 0;
      const tipHeight = cursor?.tipHeight ?? 0;
      const progress = tipHeight > 0 ? Math.min(100, (lastHeight / tipHeight) * 100) : 0;

      return {
        running: isCrawlerLeaseActive(cursor),
        syncStatus: cursor?.syncStatus ?? 'stopped',
        // Process-local by nature: the source is what THIS instance ingests from. A
        // standby that does not hold the lease reports null, as does a stopped crawler.
        source: getCrawler()?.getActiveSource() ?? null,
        lastSlot: String(cursor?.lastSlot ?? 0),
        lastHeight: String(lastHeight),
        tipHeight: String(tipHeight),
        syncProgress: progress.toFixed(2),
        consecutiveErrors: cursor?.consecutiveErrors ?? 0,
        utxoSet: {
          enabled: utxoSetConfigured(),
          status: utxoSetImportInFlight ? 'importing' : (cursor?.utxoSet?.status ?? 'none'),
          anchorSlot: cursor?.utxoSet?.anchorSlot == null ? null : String(cursor.utxoSet.anchorSlot),
          anchorHash: cursor?.utxoSet?.anchorHash ?? null,
          importedAt: cursor?.utxoSet?.importedAt ?? null,
          error: cursor?.utxoSet?.error ?? null,
        },
      };
    });
  });

  // importUtxoSet — one-off snapshot import that anchors crawler.utxoSet. Validation first,
  // then the import runs detached (mainnet takes a while); progress via getStatus().utxoSet.
  srv.on('importUtxoSet', async (req: Request) => {
    const data = (req.data ?? {}) as { source?: string; filePath?: string; anchorSlot?: string | number | null; anchorHash?: string | null };
    const source = data.source === 'file' || data.source === 'ogmios' ? data.source : null;
    if (!source) return rejectInvalid(req, 'importUtxoSet', 'source must be "ogmios" or "file"', 'source');
    if (source === 'file' && !data.filePath) return rejectMissing(req, 'importUtxoSet', 'filePath');
    const anchorGiven = data.anchorSlot != null || !!data.anchorHash;
    if (source === 'file' && !anchorGiven) {
      return rejectInvalid(req, 'importUtxoSet', 'source "file" needs anchorSlot + anchorHash: the tip at dump time', 'anchorSlot');
    }
    if (anchorGiven && (data.anchorSlot == null || !Number.isInteger(Number(data.anchorSlot)) || !isBlockHash(data.anchorHash))) {
      return rejectInvalid(req, 'importUtxoSet', 'anchorSlot must be an integer and anchorHash a 64-hex block hash', 'anchorHash');
    }
    if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process — pauseCrawler first');
    if (utxoSetImportInFlight) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
    return handleRequest(req, async (db) => {
      const cursor = await readCursor(db);
      if (!cursor) throw new TransactionValidationError('No crawler cursor yet — start the crawler once before importing.');
      if (isCrawlerLeaseActive(cursor)) throw new TransactionValidationError('Crawler is running (active lease) — pauseCrawler first.');
      const anchor = anchorGiven
        ? { slot: Number(data.anchorSlot), hash: String(data.anchorHash).toLowerCase() }
        : { slot: cursor.lastSlot, hash: cursor.lastBlockHash ?? '' };
      if (!anchor.hash) throw new TransactionValidationError('Cursor has no block hash yet — pass anchorSlot + anchorHash.');
      if (cursor.lastSlot > anchor.slot) {
        throw new TransactionValidationError(
          `Crawler cursor (slot ${cursor.lastSlot}) is past the anchor (slot ${anchor.slot}) — dump the set at or after the cursor.`
        );
      }
      utxoSetImportInFlight = importUtxoSet({
        source, filePath: data.filePath, anchor,
        client: getCardanoClient(), indexer: getCardanoIndexer(),
        onProgress: (n) => { if (n % 100_000 === 0) logger.info(`UTxO set import: ${n} entries`); },
      })
        .then((r) => logger.info(`UTxO set import done: ${r.utxos} entries at ${r.anchor.slot}/${r.anchor.hash}`))
        .catch((err: unknown) => logger.error(`UTxO set import failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { utxoSetImportInFlight = null; });
      return {
        accepted: true,
        anchorSlot: String(anchor.slot),
        anchorHash: anchor.hash,
        message: `UTxO set import started (source=${source}); poll getStatus().utxoSet, then resumeCrawler.`,
      };
    });
  });

  // pauseCrawler — stop the stream; the cursor is preserved so resume continues.
  srv.on('pauseCrawler', async (req: Request) => {
    return handleRequest(req, async () => {
      await stopCrawler(true);
      logger.info('Crawler paused via control action');
      return true;
    });
  });

  // resumeCrawler — (re)start from the persisted cursor using the configured source.
  // Gated on config.enabled: the control action must not start a crawler the operator
  // never configured (an unconfigured start would otherwise sync from genesis).
  // NOTE: to apply CHANGED config to a running crawler, call pauseCrawler first —
  // resume on a running crawler is a no-op by design.
  srv.on('resumeCrawler', async (req: Request) => {
    let config: CrawlerConfig;
    try {
      config = loadCrawlerConfigFromEnv();
    } catch (err) {
      // e.g. ConfigError: enabled but no start block — a config problem is the
      // caller's 400, not a raw 500 from an escaping throw
      return rejectInvalid(req, 'resumeCrawler', err instanceof Error ? err.message : String(err));
    }
    if (!config.enabled) {
      return rejectInvalid(req, 'resumeCrawler', 'Crawler is not enabled — set cds.requires.odatano-core.crawler.enabled (or CRAWLER_ENABLED=true) with a start block before resuming.');
    }
    return handleRequest(req, async () => {
      const client = getCardanoClient();
      await startCrawler({
        client,
        indexer: getCardanoIndexer(),
        network: client.network,
        config,
      }, true);
      logger.info('Crawler resumed via control action');
      return isCrawlerRunningInCluster();
    });
  });
};
