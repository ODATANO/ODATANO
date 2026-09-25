import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing, TransactionValidationError } from './utils/errors';
import { getCrawler, isCrawlerRunning, isCrawlerRunningInCluster, startCrawler, stopCrawler } from './blockchain/crawler';
import { isCrawlerLeaseActive, readCursor } from './blockchain/crawler/sync-state';
import { importUtxoSet } from './blockchain/crawler/utxo-set-import';
import { backfillCertificates, type CertificateBackfillProgress } from './blockchain/crawler/certificate-backfill';
import { isBlockHash } from './utils/validators';
import { getCardanoClient, getCardanoIndexer, loadCrawlerConfigFromEnv } from './server';
import { buildLiveness } from './utils/liveness';
import type { CrawlerConfig } from './blockchain/crawler/crawler';

const logger = cds.log('CardanoIndexerService');

/** One import at a time per process; the promise is only used as the busy flag. */
let utxoSetImportInFlight: Promise<unknown> | null = null;

/** The certificate backfill of this process: one at a time, state kept until the next start. */
interface CertificateBackfillState extends CertificateBackfillProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  fromSlot: number;
  toSlot: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
/** Set while a start request is validated, so a second request cannot start a parallel run. */
let certificateBackfillStarting = false;
let certificateBackfill: CertificateBackfillState = {
  status: 'none', fromSlot: 0, toSlot: 0, atSlot: 0, blocks: 0, transactions: 0, certificates: 0, withdrawals: 0,
  startedAt: null, finishedAt: null, error: null,
};

function utxoSetConfigured(): boolean {
  try {
    return Boolean(loadCrawlerConfigFromEnv()?.utxoSet);
  } catch {
    return false;
  }
}

/**
 * CardanoIndexerService handlers: control/observability surface over the crawler
 * singleton (srv/blockchain/crawler). Reads the cursor and starts/stops the crawler.
 */
module.exports = (srv: cds.Service) => {

  // getLiveness — unauthenticated probe (@requires: 'any'); no handleRequest, no app context.
  srv.on('getLiveness', async () => buildLiveness());

  // getStatus — live run state + sync progress (numeric fields as strings, CAP 10 convention)
  srv.on('getStatus', async (req: Request) => {
    return handleRequest(req, async (db) => {
      const cursor = await readCursor(db);
      const lastHeight = cursor?.lastHeight ?? 0;
      const tipHeight = cursor?.tipHeight ?? 0;
      const progress = tipHeight > 0 ? Math.min(100, (lastHeight / tipHeight) * 100) : 0;

      return {
        running: isCrawlerLeaseActive(cursor),
        syncStatus: cursor?.syncStatus ?? 'stopped',
        // Process-local: a standby without the lease or a stopped crawler reports null.
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
        certificateBackfill: {
          status: certificateBackfill.status,
          fromSlot: String(certificateBackfill.fromSlot),
          toSlot: String(certificateBackfill.toSlot),
          atSlot: String(certificateBackfill.atSlot),
          blocks: certificateBackfill.blocks,
          certificates: certificateBackfill.certificates,
          withdrawals: certificateBackfill.withdrawals,
          startedAt: certificateBackfill.startedAt,
          finishedAt: certificateBackfill.finishedAt,
          error: certificateBackfill.error,
        },
      };
    });
  });

  // backfillCertificates — second chain-sync stream over already crawled blocks; writes the
  // certificate and withdrawal tables only. Validates, then runs detached.
  srv.on('backfillCertificates', async (req: Request) => {
    const data = (req.data ?? {}) as { fromSlot?: string | number | null; toSlot?: string | number | null };
    if (data.fromSlot != null && !Number.isInteger(Number(data.fromSlot))) return rejectInvalid(req, 'backfillCertificates', 'fromSlot must be an integer', 'fromSlot');
    if (data.toSlot != null && !Number.isInteger(Number(data.toSlot))) return rejectInvalid(req, 'backfillCertificates', 'toSlot must be an integer', 'toSlot');
    if (certificateBackfill.status === 'running' || certificateBackfillStarting) return rejectInvalid(req, 'backfillCertificates', 'A certificate backfill is already running');
    if (!getCardanoClient().getChainSyncBackend()) return rejectInvalid(req, 'backfillCertificates', 'No chain-sync backend available (needs Ogmios)');
    certificateBackfillStarting = true;
    try {
      return await handleRequest(req, async (db) => {
        const cursor = await readCursor(db);
        if (!cursor) throw new TransactionValidationError('No crawler cursor yet — the backfill covers crawled blocks only.');
        const fromSlot = data.fromSlot != null ? Number(data.fromSlot) : (cursor.startSlot ?? 0);
        const toSlot = data.toSlot != null ? Number(data.toSlot) : cursor.lastSlot;
        if (toSlot < fromSlot) throw new TransactionValidationError(`toSlot ${toSlot} lies before fromSlot ${fromSlot}.`);
        if (toSlot > cursor.lastSlot) throw new TransactionValidationError(`toSlot ${toSlot} is past the crawler cursor (slot ${cursor.lastSlot}) — only crawled blocks can be backfilled.`);
        certificateBackfill = {
          status: 'running', fromSlot, toSlot, atSlot: fromSlot, blocks: 0, transactions: 0, certificates: 0, withdrawals: 0,
          startedAt: new Date().toISOString(), finishedAt: null, error: null,
        };
        void backfillCertificates({
          client: getCardanoClient(), fromSlot, toSlot,
          onProgress: (p) => {
            Object.assign(certificateBackfill, p);
            if (certificateBackfill.blocks % 20_000 < 200) logger.info(`Certificate backfill at slot ${p.atSlot}: ${p.blocks} blocks, ${p.certificates} certificates, ${p.withdrawals} withdrawals`);
          },
        })
          .then((r) => { Object.assign(certificateBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            Object.assign(certificateBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
            logger.error(`Certificate backfill failed: ${message}`);
          });
        return {
          accepted: true,
          fromSlot: String(fromSlot),
          toSlot: String(toSlot),
          message: `Certificate backfill started for slots ${fromSlot}..${toSlot}; poll getStatus().certificateBackfill.`,
        };
      });
    } finally {
      certificateBackfillStarting = false;
    }
  });

  // importUtxoSet — one-off snapshot import that anchors crawler.utxoSet. Validates, then
  // runs detached; progress via getStatus().utxoSet.
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

  // resumeCrawler — (re)start from the persisted cursor. Gated on config.enabled so an
  // unconfigured crawler is never started (it would sync from genesis). Resume on a running
  // crawler is a no-op; pauseCrawler first to apply changed config.
  srv.on('resumeCrawler', async (req: Request) => {
    let config: CrawlerConfig;
    try {
      config = loadCrawlerConfigFromEnv();
    } catch (err) {
      // A config problem (e.g. enabled without a start block) is the caller's 400.
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
