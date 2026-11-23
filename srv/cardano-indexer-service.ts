import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, rejectMissing, TransactionValidationError } from './utils/errors';
import { getCrawler, isCrawlerRunning, isCrawlerRunningInCluster, startCrawler, stopCrawler } from './blockchain/crawler';
import { isCrawlerLeaseActive, readCursor, type SyncCursor } from './blockchain/crawler/sync-state';
import { importUtxoSet, rebuildUtxoSetAggregates, refreshUtxoSetReferenceScripts } from './blockchain/crawler/utxo-set-import';
import { backfillCertificates, type CertificateBackfillProgress } from './blockchain/crawler/certificate-backfill';
import { backfillTransactions, type TransactionBackfillProgress } from './blockchain/crawler/transaction-backfill';
import { backfillUtxoCredentials, type CredentialBackfillProgress } from './blockchain/crawler/credential-backfill';
import { backfillAssetDecimals, type DecimalsBackfillProgress } from './blockchain/crawler/asset-decimals-backfill';
import {
  backfillAssetRegistry, backfillAssetRegistryFromFiles, registryEntryFiles, type RegistryBackfillProgress,
} from './blockchain/crawler/asset-registry-backfill';
import { backfillOutputDatums, type OutputDatumBackfillProgress } from './blockchain/crawler/output-datum-backfill';
import { backfillMetadataPositions, type MetadataPositionProgress } from './blockchain/crawler/metadata-position-backfill';
import { backfillAssetSlices, type AssetSliceBackfillProgress } from './blockchain/crawler/asset-slice-backfill';
import {
  pruneInputAssetCopies, restoreInputAssetCopies, type InputCopyPruneProgress, type InputCopyRestoreProgress,
} from './blockchain/crawler/input-asset-copies';
import type { EpochBackfillProgress } from './blockchain/cardano-indexer';
import { isBlockHash } from './utils/validators';
import { getCardanoClient, getCardanoIndexer, readinessParts } from './server';
import { loadCrawlerConfigFromEnv } from './config';
import { buildLiveness } from './utils/liveness';
import { buildReadiness } from './utils/readiness';
import { answerNumbersAsText } from './utils/result-numbers';
import { DetachedRun } from './utils/detached-run';
import { recheckFailed, type FailedRecheckProgress } from './blockchain/signing/failed-recheck';
import { EpochLedgerSnapshots } from '#cds-models/odatano/cardano';
import type { CrawlerConfig } from './blockchain/crawler/crawler';

const { SELECT } = cds.ql;

const logger = cds.log('CardanoIndexerService');

// One run per kind and process. Each keeps the state of its last run until the next start.
const certificateRun = new DetachedRun<CertificateBackfillProgress & { fromSlot: number; toSlot: number }>(
  'Certificate backfill',
  { fromSlot: 0, toSlot: 0, atSlot: 0, blocks: 0, transactions: 0, certificates: 0, withdrawals: 0, removed: 0 },
  ['fromSlot', 'toSlot', 'atSlot'],
);
const transactionRun = new DetachedRun<TransactionBackfillProgress & { fromSlot: number; toSlot: number }>(
  'Transaction backfill',
  { fromSlot: 0, toSlot: 0, atSlot: 0, blocks: 0, transactions: 0, inputs: 0, outputs: 0, redeemers: 0, datums: 0, rewritten: 0, skipped: 0 },
  ['fromSlot', 'toSlot', 'atSlot'],
);
const credentialRun = new DetachedRun<CredentialBackfillProgress>('Payment-credential backfill', { table: null, outputs: 0, inputs: 0, ledgerUtxos: 0 });
const decimalsRun = new DetachedRun<DecimalsBackfillProgress>('Asset-decimals backfill', { scanned: 0, candidates: 0, filled: 0 });
const registryRun = new DetachedRun<RegistryBackfillProgress>('Asset-registry backfill', { units: 0, processed: 0, filled: 0, failed: 0, absent: 0, skipped: 0 });
const datumRun = new DetachedRun<OutputDatumBackfillProgress>(
  'Output-datum backfill', { scanned: 0, candidates: 0, transactions: 0, missing: 0, outputs: 0, inputs: 0, ledgerUtxos: 0 },
);
const metadataRun = new DetachedRun<MetadataPositionProgress>('Metadata-position backfill', { atSlot: 0, toSlot: 0, rows: 0 }, ['atSlot', 'toSlot']);
const sliceRun = new DetachedRun<AssetSliceBackfillProgress>('Asset-slice backfill', { table: null, outputs: 0, inputs: 0, ledgerUtxos: 0, ledgerAddresses: 0, utxoSlices: 0, addressSlices: 0 });
const epochRun = new DetachedRun<EpochBackfillProgress>('Epoch backfill', { atEpoch: 0, toEpoch: 0, updated: 0, created: 0 });
const recheckRun = new DetachedRun<FailedRecheckProgress>('Re-check of failed submits', { submissions: 0, requests: 0, jobs: 0, restored: 0 });
const pruneRun = new DetachedRun<InputCopyPruneProgress>('Prune of input asset copies', { atSlot: 0, toSlot: 0, referenced: 0, kept: 0, deleted: 0 }, ['atSlot', 'toSlot']);
const restoreRun = new DetachedRun<InputCopyRestoreProgress>('Restore of input asset copies', { atSlot: 0, toSlot: 0, restored: 0, rows: 0 }, ['atSlot', 'toSlot']);
/** The UTxO set import and its two repairs: one at a time, the status shows it as importing. */
const utxoSetRun = new DetachedRun<Record<string, never>>('UTxO set import', {});

/** The runs cancelMaintenance can stop, by the name getStatus shows them under. */
const CANCELLABLE = {
  certificateBackfill: certificateRun,
  transactionBackfill: transactionRun,
  credentialBackfill: credentialRun,
  decimalsBackfill: decimalsRun,
  registryBackfill: registryRun,
  datumBackfill: datumRun,
  metadataBackfill: metadataRun,
  epochBackfill: epochRun,
  failedRecheck: recheckRun,
  sliceBackfill: sliceRun,
  copyPrune: pruneRun,
  copyRestore: restoreRun,
} as const;

type BackfillData = { fromSlot?: string | number | null; toSlot?: string | number | null };

/** Slot range of a backfill: defaults to crawl start .. cursor, never past the cursor. */
async function backfillRange(db: Parameters<typeof readCursor>[0], data: BackfillData): Promise<{ fromSlot: number; toSlot: number }> {
  const cursor = await readCursor(db);
  if (!cursor) throw new TransactionValidationError('No crawler cursor yet. The backfill covers crawled blocks only.');
  const fromSlot = data.fromSlot != null ? Number(data.fromSlot) : (cursor.startSlot ?? 0);
  const toSlot = data.toSlot != null ? Number(data.toSlot) : cursor.lastSlot;
  if (toSlot < fromSlot) throw new TransactionValidationError(`toSlot ${toSlot} lies before fromSlot ${fromSlot}.`);
  if (toSlot > cursor.lastSlot) throw new TransactionValidationError(`toSlot ${toSlot} is past the crawler cursor (slot ${cursor.lastSlot}). Only crawled blocks can be backfilled.`);
  return { fromSlot, toSlot };
}

/** A crawler switch as configured; false when the configuration is invalid. */
function crawlerOption(name: 'utxoSet' | 'epochSnapshots' | 'accountSnapshots'): boolean {
  try {
    return Boolean(loadCrawlerConfigFromEnv()?.[name]);
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

/** No block committed for this long while the crawler holds its lease: it is stuck. */
export const CRAWLER_STALL_MS = 10 * 60 * 1000;

/** A crawler that holds the lease but has committed no block within CRAWLER_STALL_MS. */
export function isCrawlerStalled(cursor: SyncCursor | null, now = Date.now()): boolean {
  if (!cursor || !isCrawlerLeaseActive(cursor) || !cursor.lastIndexedAt) return false;
  return now - Date.parse(cursor.lastIndexedAt) > CRAWLER_STALL_MS;
}

/** CardanoIndexerService handlers. They read the crawler cursor and start or stop the crawler. */
module.exports = (srv: cds.Service) => {
  answerNumbersAsText(srv);

  // getLiveness: unauthenticated probe. No handleRequest and no app context.
  srv.on('getLiveness', async () => buildLiveness());

  // getReadiness: unauthenticated probe. A missing part answers 503 with the same body.
  srv.on('getReadiness', async (req: Request) => {
    const readiness = await buildReadiness(readinessParts());
    if (readiness.status !== 'ready') req.http?.res.status(503);
    return readiness;
  });

  // getStatus: run state and sync progress. Numeric fields are strings, as CAP 10 serializes them.
  srv.on('getStatus', async (req: Request) => {
    return handleRequest(req, async (db) => {
      const cursor = await readCursor(db);
      const lastSnapshot = await db.run(
        SELECT.one.from(EpochLedgerSnapshots).columns('epoch', 'source', 'snapshotSlot').orderBy('epoch desc')
      ) as { epoch?: number; source?: string | null; snapshotSlot?: number | string | null } | undefined;
      const lastAccounts = await db.run(
        SELECT.one.from(EpochLedgerSnapshots).columns('epoch', 'accountCount').where({ accountCount: { '!=': null } }).orderBy('epoch desc')
      ) as { epoch?: number; accountCount?: number | null } | undefined;
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
        lastIndexedAt: cursor?.lastIndexedAt ?? null,
        stalled: isCrawlerStalled(cursor),
        nodeBehindSince: cursor?.nodeBehindSince ?? null,
        utxoSet: {
          enabled: crawlerOption('utxoSet'),
          status: utxoSetRun.isBusy() ? 'importing' : (cursor?.utxoSet?.status ?? 'none'),
          anchorSlot: cursor?.utxoSet?.anchorSlot == null ? null : String(cursor.utxoSet.anchorSlot),
          anchorHash: cursor?.utxoSet?.anchorHash ?? null,
          importedAt: cursor?.utxoSet?.importedAt ?? null,
          error: cursor?.utxoSet?.error ?? null,
        },
        ...Object.fromEntries(Object.entries(CANCELLABLE).map(([name, run]) => [name, run.snapshot()])),
        epochBackfill: epochRun.snapshot(),
        epochSnapshots: {
          enabled: crawlerOption('epochSnapshots'),
          source: epochSnapshotSource(),
          lastEpoch: lastSnapshot?.epoch ?? null,
          lastSource: lastSnapshot?.source ?? null,
          lastSlot: lastSnapshot?.snapshotSlot == null ? null : String(lastSnapshot.snapshotSlot),
          accounts: crawlerOption('accountSnapshots'),
          lastAccountEpoch: lastAccounts?.epoch ?? null,
          lastAccountCount: lastAccounts?.accountCount ?? null,
        },
      };
    });
  });

  const busy = (req: Request, action: string, run: { label: string }) =>
    rejectInvalid(req, action, `${run.label} is already running`);
  /** A transaction backfill rewrites inputs a prune or restore moves, so they never overlap. */
  const copyWalkBusy = () => pruneRun.isBusy() || restoreRun.isBusy();

  // backfillCertificates: a second chain-sync stream over crawled blocks.
  // Writes only the certificate and withdrawal tables and runs detached.
  srv.on('backfillCertificates', async (req: Request) => {
    const data = (req.data ?? {}) as BackfillData;
    if (certificateRun.isBusy()) return busy(req, 'backfillCertificates', certificateRun);
    if (!getCardanoClient().getChainSyncBackend()) return rejectInvalid(req, 'backfillCertificates', 'No chain-sync backend available (needs Ogmios)');
    return handleRequest(req, (db) => certificateRun.start(async () => {
      const { fromSlot, toSlot } = await backfillRange(db, data);
      return {
        initial: { fromSlot, toSlot, atSlot: fromSlot },
        run: (ctl) => backfillCertificates({
          client: getCardanoClient(), fromSlot, toSlot, shouldStop: ctl.shouldStop,
          onProgress: (p) => {
            ctl.progress(p);
            if (p.blocks % 20_000 < 200) logger.info(`Certificate backfill at slot ${p.atSlot}: ${p.blocks} blocks, ${p.certificates} certificates, ${p.withdrawals} withdrawals`);
          },
        }),
        answer: {
          accepted: true,
          fromSlot: String(fromSlot),
          toSlot: String(toSlot),
          message: `Certificate backfill started for slots ${fromSlot}..${toSlot}; poll getStatus().certificateBackfill.`,
        },
      };
    }));
  });

  // backfillTransactions: a second chain-sync stream over crawled blocks.
  // Fills empty input fields and the redeemers and runs detached.
  srv.on('backfillTransactions', async (req: Request) => {
    const data = (req.data ?? {}) as BackfillData;
    if (transactionRun.isBusy()) return busy(req, 'backfillTransactions', transactionRun);
    if (copyWalkBusy()) return rejectInvalid(req, 'backfillTransactions', 'A prune or restore of input asset copies is running; it moves the inputs this backfill rewrites');
    if (!getCardanoClient().getChainSyncBackend()) return rejectInvalid(req, 'backfillTransactions', 'No chain-sync backend available (needs Ogmios)');
    return handleRequest(req, (db) => transactionRun.start(async () => {
      const { fromSlot, toSlot } = await backfillRange(db, data);
      return {
        initial: { fromSlot, toSlot, atSlot: fromSlot },
        run: (ctl) => backfillTransactions({
          client: getCardanoClient(), indexer: getCardanoIndexer(), fromSlot, toSlot, shouldStop: ctl.shouldStop,
          onProgress: (p) => {
            ctl.progress(p);
            if (p.blocks % 20_000 < 200) logger.info(`Transaction backfill at slot ${p.atSlot}: ${p.blocks} blocks, ${p.inputs} inputs, ${p.redeemers} redeemers`);
          },
        }),
        answer: {
          accepted: true,
          fromSlot: String(fromSlot),
          toSlot: String(toSlot),
          message: `Transaction backfill started for slots ${fromSlot}..${toSlot}; poll getStatus().transactionBackfill.`,
        },
      };
    }));
  });

  // backfillPaymentCredentials: fills the credential from the stored address in every UTxO table.
  // Needs no backend and runs detached. Progress is in getStatus().credentialBackfill.
  srv.on('backfillPaymentCredentials', async (req: Request) => {
    if (credentialRun.isBusy()) return busy(req, 'backfillPaymentCredentials', credentialRun);
    return credentialRun.start(() => ({
      run: (ctl) => backfillUtxoCredentials({ onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Payment-credential backfill started; poll getStatus().credentialBackfill.' },
    }));
  });

  // backfillAssetDecimals: reads the CIP-68 reference datum of every label 333 and 444 unit.
  // Needs no backend and runs detached. Progress is in getStatus().decimalsBackfill.
  srv.on('backfillAssetDecimals', async (req: Request) => {
    if (decimalsRun.isBusy()) return busy(req, 'backfillAssetDecimals', decimalsRun);
    return decimalsRun.start(() => ({
      run: (ctl) => backfillAssetDecimals({ onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Asset-decimals backfill started; poll getStatus().decimalsBackfill.' },
    }));
  });

  // backfillAssetRegistry: writes the CIP-26 registry fields of every registered unit. The registry is
  // off-chain: it comes from a backend that lists it, or from the entry files of its repository.
  srv.on('backfillAssetRegistry', async (req: Request) => {
    const data = (req.data ?? {}) as { source?: string | null; path?: string | null };
    const source = data.source ?? 'koios';
    if (registryRun.isBusy()) return busy(req, 'backfillAssetRegistry', registryRun);
    if (source === 'file' && !data.path) return rejectMissing(req, 'backfillAssetRegistry', 'path');
    if (source !== 'file' && !getCardanoClient().getTokenRegistryBackend()) {
      return rejectInvalid(req, 'backfillAssetRegistry', 'No backend lists the token registry (needs Koios, or source file)');
    }
    const directory = source === 'file' ? String(data.path) : null;
    try {
      return await registryRun.start(async () => {
        if (directory) await registryEntryFiles(directory);
        return {
          run: (ctl) => directory
            ? backfillAssetRegistryFromFiles({ directory, onProgress: ctl.progress, shouldStop: ctl.shouldStop })
            : backfillAssetRegistry({ client: getCardanoClient(), indexer: getCardanoIndexer(), onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
          answer: { accepted: true, message: 'Asset-registry backfill started; poll getStatus().registryBackfill.' },
        };
      });
    } catch (err) {
      return rejectInvalid(req, 'backfillAssetRegistry', err instanceof Error ? err.message : String(err), 'path');
    }
  });

  // backfillOutputDatums: reads transactions again whose outputs hold a datum hash and no inline
  // datum. Needs a backend that serves transactions. Progress is in getStatus().datumBackfill.
  srv.on('backfillOutputDatums', async (req: Request) => {
    if (datumRun.isBusy()) return busy(req, 'backfillOutputDatums', datumRun);
    if (!getCardanoClient().supports('getTransaction')) {
      return rejectInvalid(req, 'backfillOutputDatums', 'No configured backend serves transactions. With Ogmios only, run backfillTransactions over the crawled range');
    }
    return datumRun.start(() => ({
      run: (ctl) => backfillOutputDatums({ client: getCardanoClient(), onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Output-datum backfill started; poll getStatus().datumBackfill.' },
    }));
  });

  // backfillMetadataPositions: writes the chain position to metadata rows that lack it.
  // Needs no backend and runs detached. Progress is in getStatus().metadataBackfill.
  srv.on('backfillMetadataPositions', async (req: Request) => {
    const data = (req.data ?? {}) as BackfillData;
    const range = { fromSlot: data.fromSlot == null ? null : Number(data.fromSlot), toSlot: data.toSlot == null ? null : Number(data.toSlot) };
    if (range.fromSlot != null && range.toSlot != null && range.fromSlot > range.toSlot) {
      return rejectInvalid(req, 'backfillMetadataPositions', 'fromSlot must not be after toSlot', 'fromSlot');
    }
    if (metadataRun.isBusy()) return busy(req, 'backfillMetadataPositions', metadataRun);
    return metadataRun.start(() => ({
      run: (ctl) => backfillMetadataPositions({ ...range, onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Metadata-position backfill started; poll getStatus().metadataBackfill.' },
    }));
  });

  // backfillAssetSlices: writes policy id, name and fingerprint of every stored asset row as derived
  // from its unit. Needs no backend and runs detached. Progress is in getStatus().sliceBackfill.
  srv.on('backfillAssetSlices', async (req: Request) => {
    if (sliceRun.isBusy()) return busy(req, 'backfillAssetSlices', sliceRun);
    return sliceRun.start(() => ({
      run: (ctl) => backfillAssetSlices({ onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Asset-slice backfill started; poll getStatus().sliceBackfill.' },
    }));
  });

  // backfillEpochs: rebuilds the epoch rows of the crawled range from the stored blocks.
  // Needs no backend and runs detached.
  srv.on('backfillEpochs', async (req: Request) => {
    if (epochRun.isBusy()) return busy(req, 'backfillEpochs', epochRun);
    return epochRun.start(() => ({
      run: (ctl) => getCardanoIndexer().backfillEpochs(ctl.progress, () => ctl.shouldStop()),
      answer: { accepted: true, message: 'Epoch backfill started; poll getStatus().epochBackfill.' },
    }));
  });

  // recheckFailedSubmits: a submission or signing request marked failed whose transaction is on chain
  // with passing scripts goes back to submitted. Rows an earlier version failed on a refusal or time.
  srv.on('recheckFailedSubmits', async (req: Request) => {
    if (recheckRun.isBusy()) return busy(req, 'recheckFailedSubmits', recheckRun);
    return recheckRun.start(() => ({
      run: (ctl) => recheckFailed({ indexer: getCardanoIndexer(), client: getCardanoClient() },
        { shouldStop: () => ctl.shouldStop(), onProgress: ctl.progress }),
      answer: { accepted: true, message: 'Re-check of failed submits started; poll getStatus().failedRecheck.' },
    }));
  });

  // Slot range of a walk over input asset copies. Both bounds are required: the caller names what
  // moves. Null after the request was rejected.
  const copyRange = (req: Request, action: string): { fromSlot: number; toSlot: number; slotWindow?: number } | null => {
    const data = (req.data ?? {}) as { fromSlot?: unknown; toSlot?: unknown; slotWindow?: unknown };
    if (data.fromSlot == null) { rejectMissing(req, action, 'fromSlot'); return null; }
    if (data.toSlot == null) { rejectMissing(req, action, 'toSlot'); return null; }
    const range = { fromSlot: Number(data.fromSlot), toSlot: Number(data.toSlot) };
    if (range.fromSlot > range.toSlot) { rejectInvalid(req, action, 'fromSlot must not be after toSlot', 'fromSlot'); return null; }
    return data.slotWindow == null ? range : { ...range, slotWindow: Number(data.slotWindow) };
  };
  /** Why a copy walk cannot start now; null when it can. */
  const copyWalkConflict = (): string | null => {
    if (copyWalkBusy()) return 'A prune or restore of input asset copies is already running';
    if (transactionRun.isBusy()) return 'A transaction backfill is running; it rewrites the inputs this walk moves';
    return null;
  };

  // pruneInputAssetCopies: moves the inputs of a slot range from asset copies to the output they
  // spent and deletes those copies. Needs no backend and runs detached.
  srv.on('pruneInputAssetCopies', async (req: Request) => {
    const range = copyRange(req, 'pruneInputAssetCopies');
    if (!range) return;
    const conflict = copyWalkConflict();
    if (conflict) return rejectInvalid(req, 'pruneInputAssetCopies', conflict);
    return pruneRun.start(() => ({
      run: (ctl) => pruneInputAssetCopies({ ...range, onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Prune of input asset copies started; poll getStatus().copyPrune.' },
    }));
  });

  // restoreInputAssetCopies: the way back, copies written from the outputs.
  srv.on('restoreInputAssetCopies', async (req: Request) => {
    const range = copyRange(req, 'restoreInputAssetCopies');
    if (!range) return;
    const conflict = copyWalkConflict();
    if (conflict) return rejectInvalid(req, 'restoreInputAssetCopies', conflict);
    return restoreRun.start(() => ({
      run: (ctl) => restoreInputAssetCopies({ ...range, onProgress: ctl.progress, shouldStop: ctl.shouldStop }),
      answer: { accepted: true, message: 'Restore of input asset copies started; poll getStatus().copyRestore.' },
    }));
  });

  // cancelMaintenance: asks a running backfill or walk of this process to stop at its next window,
  // page or batch. What it wrote so far stays; a new start begins again at its first slot or key.
  srv.on('cancelMaintenance', async (req: Request) => {
    const name = String((req.data as { run?: unknown } | undefined)?.run ?? '');
    const run = Object.hasOwn(CANCELLABLE, name) ? CANCELLABLE[name as keyof typeof CANCELLABLE] : null;
    if (!run) return rejectInvalid(req, 'cancelMaintenance', `run must be one of ${Object.keys(CANCELLABLE).join(', ')}`, 'run');
    if (!run.cancel()) return { accepted: false, message: `${run.label} is not running in this process.` };
    return { accepted: true, message: `${run.label} stops at its next step; poll getStatus().${name}.` };
  });

  // importUtxoSet: one-off snapshot import that anchors crawler.utxoSet.
  // Runs detached. Progress is in getStatus().utxoSet.
  srv.on('importUtxoSet', async (req: Request) => {
    const data = (req.data ?? {}) as { source?: string; filePath?: string; anchorSlot?: string | number | null; anchorHash?: string | null };
    if (data.source === 'aggregates') {
      if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process. Run pauseCrawler first');
      if (utxoSetRun.isBusy()) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
      return handleRequest(req, (db) => utxoSetRun.start(async () => {
        const cursor = await readCursor(db);
        const { anchorSlot, anchorHash } = cursor?.utxoSet ?? {};
        if (anchorSlot == null || !anchorHash) throw new TransactionValidationError('No imported UTxO set to rebuild the sums from. Run importUtxoSet first.');
        return {
          label: 'UTxO set aggregate rebuild',
          run: async () => {
            const r = await rebuildUtxoSetAggregates({ indexer: getCardanoIndexer() });
            logger.info(`UTxO set sums rebuilt: ${r.utxos} rows at ${r.anchor.slot}/${r.anchor.hash}`);
          },
          answer: {
            accepted: true,
            anchorSlot: String(anchorSlot),
            anchorHash,
            message: 'UTxO set sums are rebuilt from the imported rows; poll getStatus().utxoSet, then resumeCrawler.',
          },
        };
      }));
    }
    if (data.source === 'scripts') {
      if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process. Run pauseCrawler first');
      if (utxoSetRun.isBusy()) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
      return handleRequest(req, (db) => utxoSetRun.start(async () => {
        const cursor = await readCursor(db);
        const { anchorSlot, anchorHash } = cursor?.utxoSet ?? {};
        if (anchorSlot == null || !anchorHash) throw new TransactionValidationError('No imported UTxO set to fill. Run importUtxoSet first.');
        return {
          label: 'UTxO set reference-script fill',
          run: async () => {
            const r = await refreshUtxoSetReferenceScripts({ filePath: data.filePath, client: getCardanoClient() });
            logger.info(`UTxO set reference scripts filled: ${r.updated} of ${r.candidates} rows`);
          },
          answer: {
            accepted: true,
            anchorSlot: String(anchorSlot),
            anchorHash,
            message: `Reference-script columns of the UTxO set are being filled (${data.filePath ? 'from the dump' : 'from the node'}); watch the log, then resumeCrawler.`,
          },
        };
      }));
    }
    // the model rejects an unknown source and a negative anchorSlot
    const source = data.source;
    if (source !== 'file' && source !== 'ogmios') return rejectMissing(req, 'importUtxoSet', 'source');
    if (source === 'file' && !data.filePath) return rejectMissing(req, 'importUtxoSet', 'filePath');
    const anchorGiven = data.anchorSlot != null || !!data.anchorHash;
    if (source === 'file' && !anchorGiven) {
      return rejectInvalid(req, 'importUtxoSet', 'source "file" needs anchorSlot + anchorHash: the tip at dump time', 'anchorSlot');
    }
    if (anchorGiven && (data.anchorSlot == null || !Number.isInteger(Number(data.anchorSlot)) || !isBlockHash(data.anchorHash))) {
      return rejectInvalid(req, 'importUtxoSet', 'anchorSlot must be an integer and anchorHash a 64-hex block hash', 'anchorHash');
    }
    if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process. Run pauseCrawler first');
    if (utxoSetRun.isBusy()) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
    return handleRequest(req, (db) => utxoSetRun.start(async () => {
      const cursor = await readCursor(db);
      if (!cursor) throw new TransactionValidationError('No crawler cursor yet. Start the crawler once before importing.');
      if (isCrawlerLeaseActive(cursor)) throw new TransactionValidationError('Crawler is running (active lease). Run pauseCrawler first.');
      const anchor = anchorGiven
        ? { slot: Number(data.anchorSlot), hash: String(data.anchorHash).toLowerCase() }
        : { slot: cursor.lastSlot, hash: cursor.lastBlockHash ?? '' };
      if (!anchor.hash) throw new TransactionValidationError('Cursor has no block hash yet. Pass anchorSlot + anchorHash.');
      if (cursor.lastSlot > anchor.slot) {
        throw new TransactionValidationError(
          `Crawler cursor (slot ${cursor.lastSlot}) is past the anchor (slot ${anchor.slot}). Dump the set at or after the cursor.`
        );
      }
      return {
        run: async () => {
          const r = await importUtxoSet({
            source, filePath: data.filePath, anchor,
            client: getCardanoClient(), indexer: getCardanoIndexer(),
            onProgress: (n) => { if (n % 100_000 === 0) logger.info(`UTxO set import: ${n} entries`); },
          });
          logger.info(`UTxO set import done: ${r.utxos} entries at ${r.anchor.slot}/${r.anchor.hash}`);
        },
        answer: {
          accepted: true,
          anchorSlot: String(anchor.slot),
          anchorHash: anchor.hash,
          message: `UTxO set import started (source=${source}); poll getStatus().utxoSet, then resumeCrawler.`,
        },
      };
    }));
  });

  // pauseCrawler: stops the stream. The cursor is kept, so resume continues from it.
  srv.on('pauseCrawler', async (req: Request) => {
    return handleRequest(req, async () => {
      await stopCrawler(true);
      logger.info('Crawler paused via control action');
      return true;
    });
  });

  // resumeCrawler: starts from the stored cursor, only when enabled, since otherwise it would sync from genesis.
  // A no-op on a running crawler. Pause first to apply changed config.
  srv.on('resumeCrawler', async (req: Request) => {
    let config: CrawlerConfig;
    try {
      config = loadCrawlerConfigFromEnv();
    } catch (err) {
      // A config problem (e.g. enabled without a start block) is the caller's 400.
      return rejectInvalid(req, 'resumeCrawler', err instanceof Error ? err.message : String(err));
    }
    if (!config.enabled) {
      return rejectInvalid(req, 'resumeCrawler', 'Crawler is not enabled. Set cds.requires.odatano-core.crawler.enabled (or CRAWLER_ENABLED=true) with a start block before resuming.');
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
