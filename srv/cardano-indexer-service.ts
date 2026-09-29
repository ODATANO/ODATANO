import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing, TransactionValidationError } from './utils/errors';
import { getCrawler, isCrawlerRunning, isCrawlerRunningInCluster, startCrawler, stopCrawler } from './blockchain/crawler';
import { isCrawlerLeaseActive, readCursor } from './blockchain/crawler/sync-state';
import { importUtxoSet, rebuildUtxoSetAggregates } from './blockchain/crawler/utxo-set-import';
import { backfillCertificates, type CertificateBackfillProgress } from './blockchain/crawler/certificate-backfill';
import { backfillTransactions, type TransactionBackfillProgress } from './blockchain/crawler/transaction-backfill';
import { isBlockHash } from './utils/validators';
import { getCardanoClient, getCardanoIndexer, loadCrawlerConfigFromEnv } from './server';
import { buildLiveness } from './utils/liveness';
import { EpochLedgerSnapshots } from '#cds-models/odatano/cardano';
import type { CrawlerConfig } from './blockchain/crawler/crawler';

const { SELECT } = cds.ql;

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

/** The transaction backfill of this process, same lifecycle as the certificate backfill. */
interface TransactionBackfillState extends TransactionBackfillProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  fromSlot: number;
  toSlot: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
let transactionBackfillStarting = false;
let transactionBackfill: TransactionBackfillState = {
  status: 'none', fromSlot: 0, toSlot: 0, atSlot: 0, blocks: 0, transactions: 0, inputs: 0, redeemers: 0, rewritten: 0, skipped: 0,
  startedAt: null, finishedAt: null, error: null,
};

type BackfillData = { fromSlot?: string | number | null; toSlot?: string | number | null };

/** Slot range of a backfill: defaults to crawl start .. cursor, never past the cursor. */
async function backfillRange(db: Parameters<typeof readCursor>[0], data: BackfillData): Promise<{ fromSlot: number; toSlot: number }> {
  const cursor = await readCursor(db);
  if (!cursor) throw new TransactionValidationError('No crawler cursor yet — the backfill covers crawled blocks only.');
  const fromSlot = data.fromSlot != null ? Number(data.fromSlot) : (cursor.startSlot ?? 0);
  const toSlot = data.toSlot != null ? Number(data.toSlot) : cursor.lastSlot;
  if (toSlot < fromSlot) throw new TransactionValidationError(`toSlot ${toSlot} lies before fromSlot ${fromSlot}.`);
  if (toSlot > cursor.lastSlot) throw new TransactionValidationError(`toSlot ${toSlot} is past the crawler cursor (slot ${cursor.lastSlot}) — only crawled blocks can be backfilled.`);
  return { fromSlot, toSlot };
}

function utxoSetConfigured(): boolean {
  try {
    return Boolean(loadCrawlerConfigFromEnv()?.utxoSet);
  } catch {
    return false;
  }
}

function epochSnapshotsConfigured(): boolean {
  try {
    return Boolean(loadCrawlerConfigFromEnv()?.epochSnapshots);
  } catch {
    return false;
  }
}

/** Source the next epoch snapshot would use: the node's ledger first, Koios second. */
function epochSnapshotSource(): 'ogmios' | 'koios' | null {
  try {
    const client = getCardanoClient();
    if (client.getEpochStateBackend()) return 'ogmios';
    return client.getEnumeratingBackend() ? 'koios' : null;
  } catch {
    return null;
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
      const lastSnapshot = await db.run(
        SELECT.one.from(EpochLedgerSnapshots).columns('epoch', 'source', 'snapshotSlot').orderBy('epoch desc')
      ) as { epoch?: number; source?: string | null; snapshotSlot?: number | string | null } | undefined;
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
        transactionBackfill: {
          status: transactionBackfill.status,
          fromSlot: String(transactionBackfill.fromSlot),
          toSlot: String(transactionBackfill.toSlot),
          atSlot: String(transactionBackfill.atSlot),
          blocks: transactionBackfill.blocks,
          transactions: transactionBackfill.transactions,
          inputs: transactionBackfill.inputs,
          redeemers: transactionBackfill.redeemers,
          rewritten: transactionBackfill.rewritten,
          skipped: transactionBackfill.skipped,
          startedAt: transactionBackfill.startedAt,
          finishedAt: transactionBackfill.finishedAt,
          error: transactionBackfill.error,
        },
        epochSnapshots: {
          enabled: epochSnapshotsConfigured(),
          source: epochSnapshotSource(),
          lastEpoch: lastSnapshot?.epoch ?? null,
          lastSource: lastSnapshot?.source ?? null,
          lastSlot: lastSnapshot?.snapshotSlot == null ? null : String(lastSnapshot.snapshotSlot),
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
        const { fromSlot, toSlot } = await backfillRange(db, data);
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

  // backfillTransactions — second chain-sync stream over already crawled blocks; fills empty
  // input fields (outpoint, datum, address) and the redeemers. Validates, then runs detached.
  srv.on('backfillTransactions', async (req: Request) => {
    const data = (req.data ?? {}) as BackfillData;
    if (data.fromSlot != null && !Number.isInteger(Number(data.fromSlot))) return rejectInvalid(req, 'backfillTransactions', 'fromSlot must be an integer', 'fromSlot');
    if (data.toSlot != null && !Number.isInteger(Number(data.toSlot))) return rejectInvalid(req, 'backfillTransactions', 'toSlot must be an integer', 'toSlot');
    if (transactionBackfill.status === 'running' || transactionBackfillStarting) return rejectInvalid(req, 'backfillTransactions', 'A transaction backfill is already running');
    if (!getCardanoClient().getChainSyncBackend()) return rejectInvalid(req, 'backfillTransactions', 'No chain-sync backend available (needs Ogmios)');
    transactionBackfillStarting = true;
    try {
      return await handleRequest(req, async (db) => {
        const { fromSlot, toSlot } = await backfillRange(db, data);
        transactionBackfill = {
          status: 'running', fromSlot, toSlot, atSlot: fromSlot, blocks: 0, transactions: 0, inputs: 0, redeemers: 0, rewritten: 0, skipped: 0,
          startedAt: new Date().toISOString(), finishedAt: null, error: null,
        };
        void backfillTransactions({
          client: getCardanoClient(), indexer: getCardanoIndexer(), fromSlot, toSlot,
          onProgress: (p) => {
            Object.assign(transactionBackfill, p);
            if (transactionBackfill.blocks % 20_000 < 200) logger.info(`Transaction backfill at slot ${p.atSlot}: ${p.blocks} blocks, ${p.inputs} inputs, ${p.redeemers} redeemers`);
          },
        })
          .then((r) => { Object.assign(transactionBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            Object.assign(transactionBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
            logger.error(`Transaction backfill failed: ${message}`);
          });
        return {
          accepted: true,
          fromSlot: String(fromSlot),
          toSlot: String(toSlot),
          message: `Transaction backfill started for slots ${fromSlot}..${toSlot}; poll getStatus().transactionBackfill.`,
        };
      });
    } finally {
      transactionBackfillStarting = false;
    }
  });

  // importUtxoSet — one-off snapshot import that anchors crawler.utxoSet. Validates, then
  // runs detached; progress via getStatus().utxoSet.
  srv.on('importUtxoSet', async (req: Request) => {
    const data = (req.data ?? {}) as { source?: string; filePath?: string; anchorSlot?: string | number | null; anchorHash?: string | null };
    if (data.source === 'aggregates') {
      if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process — pauseCrawler first');
      if (utxoSetImportInFlight) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
      return handleRequest(req, async (db) => {
        const cursor = await readCursor(db);
        const { anchorSlot, anchorHash } = cursor?.utxoSet ?? {};
        if (anchorSlot == null || !anchorHash) throw new TransactionValidationError('No imported UTxO set to rebuild the sums from — run importUtxoSet first.');
        utxoSetImportInFlight = rebuildUtxoSetAggregates({ indexer: getCardanoIndexer() })
          .then((r) => logger.info(`UTxO set sums rebuilt: ${r.utxos} rows at ${r.anchor.slot}/${r.anchor.hash}`))
          .catch((err: unknown) => logger.error(`UTxO set aggregate rebuild failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => { utxoSetImportInFlight = null; });
        return {
          accepted: true,
          anchorSlot: String(anchorSlot),
          anchorHash,
          message: 'UTxO set sums are rebuilt from the imported rows; poll getStatus().utxoSet, then resumeCrawler.',
        };
      });
    }
    const source = data.source === 'file' || data.source === 'ogmios' ? data.source : null;
    if (!source) return rejectInvalid(req, 'importUtxoSet', 'source must be "ogmios", "file" or "aggregates"', 'source');
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
