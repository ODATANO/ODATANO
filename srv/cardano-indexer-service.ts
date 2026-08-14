import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid } from './utils/errors';
import { isCrawlerRunningInCluster, startCrawler, stopCrawler } from './blockchain/crawler';
import { isCrawlerLeaseActive, readCursor } from './blockchain/crawler/sync-state';
import { getCardanoClient, getCardanoIndexer, loadCrawlerConfigFromEnv } from './server';
import type { CrawlerConfig } from './blockchain/crawler/crawler';

const logger = cds.log('CardanoIndexerService');

/**
 * CardanoIndexerService handlers — thin control/observability surface over the crawler
 * singleton (srv/blockchain/crawler). Engine logic lives there; this only reads the
 * cursor and starts/stops the crawler.
 */
module.exports = (srv: cds.Service) => {

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
        lastSlot: String(cursor?.lastSlot ?? 0),
        lastHeight: String(lastHeight),
        tipHeight: String(tipHeight),
        syncProgress: progress.toFixed(2),
        consecutiveErrors: cursor?.consecutiveErrors ?? 0,
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
