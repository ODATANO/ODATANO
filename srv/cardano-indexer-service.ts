import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { isCrawlerRunning, startCrawler, stopCrawler } from './blockchain/crawler';
import { readCursor } from './blockchain/crawler/sync-state';
import { getCardanoClient, getCardanoIndexer, loadCrawlerConfigFromEnv } from './server';

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
        running: isCrawlerRunning(),
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
      await stopCrawler();
      logger.info('Crawler paused via control action');
      return true;
    });
  });

  // resumeCrawler — (re)start from the persisted cursor using the configured source.
  // Gated on config.enabled: the control action must not start a crawler the operator
  // never configured (an unconfigured start would otherwise sync from genesis).
  srv.on('resumeCrawler', async (req: Request) => {
    const config = loadCrawlerConfigFromEnv();
    if (!config.enabled) {
      return req.reject(400, 'Crawler is not enabled — set cds.requires.odatano-core.crawler.enabled (or CRAWLER_ENABLED=true) with a start block before resuming.');
    }
    return handleRequest(req, async () => {
      const client = getCardanoClient();
      await startCrawler({
        client,
        indexer: getCardanoIndexer(),
        network: client.network,
        config,
      });
      logger.info('Crawler resumed via control action');
      return isCrawlerRunning();
    });
  });
};
