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
  status: 'none', fromSlot: 0, toSlot: 0, atSlot: 0, blocks: 0, transactions: 0, certificates: 0, withdrawals: 0, removed: 0,
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
  status: 'none', fromSlot: 0, toSlot: 0, atSlot: 0, blocks: 0, transactions: 0, inputs: 0, outputs: 0, redeemers: 0, datums: 0, rewritten: 0, skipped: 0,
  startedAt: null, finishedAt: null, error: null,
};

/** The output datum repair of this process, same lifecycle as the backfills. */
interface DatumBackfillState extends OutputDatumBackfillProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
const NO_DATUM_PROGRESS: OutputDatumBackfillProgress = { scanned: 0, candidates: 0, transactions: 0, missing: 0, outputs: 0, inputs: 0, ledgerUtxos: 0 };
let datumBackfill: DatumBackfillState = { status: 'none', ...NO_DATUM_PROGRESS, startedAt: null, finishedAt: null, error: null };

/** The metadata position fill of this process, same lifecycle as the backfills. */
interface MetadataBackfillState extends MetadataPositionProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
let metadataBackfill: MetadataBackfillState = { status: 'none', atSlot: 0, toSlot: 0, rows: 0, startedAt: null, finishedAt: null, error: null };

/** Lifecycle fields every detached walk of this process carries. */
interface WalkState {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
const IDLE: WalkState = { status: 'none', startedAt: null, finishedAt: null, error: null };
let epochBackfill: EpochBackfillProgress & WalkState = { ...IDLE, atEpoch: 0, toEpoch: 0, updated: 0, created: 0 };
let copyPrune: InputCopyPruneProgress & WalkState = { ...IDLE, atSlot: 0, toSlot: 0, referenced: 0, kept: 0, deleted: 0 };
let copyRestore: InputCopyRestoreProgress & WalkState = { ...IDLE, atSlot: 0, toSlot: 0, restored: 0, rows: 0 };

/** The payment-credential fill of this process, same lifecycle as the backfills. */
interface CredentialBackfillState extends CredentialBackfillProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
let credentialBackfill: CredentialBackfillState = {
  status: 'none', table: null, outputs: 0, inputs: 0, ledgerUtxos: 0, startedAt: null, finishedAt: null, error: null,
};

/** The CIP-68 decimals fill of this process, same lifecycle as the backfills. */
interface DecimalsBackfillState extends DecimalsBackfillProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
let decimalsBackfill: DecimalsBackfillState = {
  status: 'none', scanned: 0, candidates: 0, filled: 0, startedAt: null, finishedAt: null, error: null,
};

/** The CIP-26 registry fill of this process, same lifecycle as the backfills. */
interface RegistryBackfillState extends RegistryBackfillProgress {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
const REGISTRY_IDLE: RegistryBackfillProgress = { units: 0, processed: 0, filled: 0, failed: 0, absent: 0, skipped: 0 };
let registryBackfill: RegistryBackfillState = { ...REGISTRY_IDLE, status: 'none', startedAt: null, finishedAt: null, error: null };

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
        utxoSet: {
          enabled: crawlerOption('utxoSet'),
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
          removed: certificateBackfill.removed,
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
          outputs: transactionBackfill.outputs,
          redeemers: transactionBackfill.redeemers,
          datums: transactionBackfill.datums,
          rewritten: transactionBackfill.rewritten,
          skipped: transactionBackfill.skipped,
          startedAt: transactionBackfill.startedAt,
          finishedAt: transactionBackfill.finishedAt,
          error: transactionBackfill.error,
        },
        credentialBackfill: { ...credentialBackfill },
        decimalsBackfill: { ...decimalsBackfill },
        registryBackfill: { ...registryBackfill },
        datumBackfill: { ...datumBackfill },
        metadataBackfill: { ...metadataBackfill, atSlot: String(metadataBackfill.atSlot), toSlot: String(metadataBackfill.toSlot) },
        epochBackfill: { ...epochBackfill },
        copyPrune: { ...copyPrune, atSlot: String(copyPrune.atSlot), toSlot: String(copyPrune.toSlot) },
        copyRestore: { ...copyRestore, atSlot: String(copyRestore.atSlot), toSlot: String(copyRestore.toSlot) },
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

  // backfillCertificates: a second chain-sync stream over crawled blocks.
  // Writes only the certificate and withdrawal tables and runs detached.
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
          status: 'running', fromSlot, toSlot, atSlot: fromSlot, blocks: 0, transactions: 0, certificates: 0, withdrawals: 0, removed: 0,
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

  // backfillTransactions: a second chain-sync stream over crawled blocks.
  // Fills empty input fields and the redeemers and runs detached.
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
          status: 'running', fromSlot, toSlot, atSlot: fromSlot, blocks: 0, transactions: 0, inputs: 0, outputs: 0, redeemers: 0, datums: 0, rewritten: 0, skipped: 0,
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

  // backfillPaymentCredentials: fills the credential from the stored address in every UTxO table.
  // Needs no backend and runs detached. Progress is in getStatus().credentialBackfill.
  srv.on('backfillPaymentCredentials', async (req: Request) => {
    if (credentialBackfill.status === 'running') return rejectInvalid(req, 'backfillPaymentCredentials', 'A payment-credential backfill is already running');
    credentialBackfill = { status: 'running', table: null, outputs: 0, inputs: 0, ledgerUtxos: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    void backfillUtxoCredentials({
      onProgress: (p) => { Object.assign(credentialBackfill, p); },
    })
      .then((r) => { Object.assign(credentialBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(credentialBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Payment-credential backfill failed: ${message}`);
      });
    return { accepted: true, message: 'Payment-credential backfill started; poll getStatus().credentialBackfill.' };
  });

  // backfillAssetDecimals: reads the CIP-68 reference datum of every label 333 and 444 unit.
  // Needs no backend and runs detached. Progress is in getStatus().decimalsBackfill.
  srv.on('backfillAssetDecimals', async (req: Request) => {
    if (decimalsBackfill.status === 'running') return rejectInvalid(req, 'backfillAssetDecimals', 'An asset-decimals backfill is already running');
    decimalsBackfill = { status: 'running', scanned: 0, candidates: 0, filled: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    void backfillAssetDecimals({
      onProgress: (p) => { Object.assign(decimalsBackfill, p); },
    })
      .then((r) => { Object.assign(decimalsBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(decimalsBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Asset-decimals backfill failed: ${message}`);
      });
    return { accepted: true, message: 'Asset-decimals backfill started; poll getStatus().decimalsBackfill.' };
  });

  // backfillAssetRegistry: writes the CIP-26 registry fields of every registered unit. The registry is
  // off-chain: it comes from a backend that lists it, or from the entry files of its repository.
  srv.on('backfillAssetRegistry', async (req: Request) => {
    const data = (req.data ?? {}) as { source?: string | null; path?: string | null };
    const source = data.source ?? 'koios';
    if (registryBackfill.status === 'running') return rejectInvalid(req, 'backfillAssetRegistry', 'An asset-registry backfill is already running');
    if (source === 'file') {
      if (!data.path) return rejectMissing(req, 'backfillAssetRegistry', 'path');
      try {
        await registryEntryFiles(data.path);
      } catch (err) {
        return rejectInvalid(req, 'backfillAssetRegistry', err instanceof Error ? err.message : String(err), 'path');
      }
    } else if (!getCardanoClient().getTokenRegistryBackend()) {
      return rejectInvalid(req, 'backfillAssetRegistry', 'No backend lists the token registry (needs Koios, or source file)');
    }
    registryBackfill = { ...REGISTRY_IDLE, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null };
    const onProgress = (p: RegistryBackfillProgress) => { Object.assign(registryBackfill, p); };
    const run = source === 'file' && data.path
      ? backfillAssetRegistryFromFiles({ directory: data.path, onProgress })
      : backfillAssetRegistry({ client: getCardanoClient(), indexer: getCardanoIndexer(), onProgress });
    void run
      .then((r) => { Object.assign(registryBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(registryBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Asset-registry backfill failed: ${message}`);
      });
    return { accepted: true, message: 'Asset-registry backfill started; poll getStatus().registryBackfill.' };
  });

  // backfillOutputDatums: reads transactions again whose outputs hold a datum hash and no inline
  // datum. Needs a backend that serves transactions. Progress is in getStatus().datumBackfill.
  srv.on('backfillOutputDatums', async (req: Request) => {
    if (datumBackfill.status === 'running') return rejectInvalid(req, 'backfillOutputDatums', 'An output-datum backfill is already running');
    if (!getCardanoClient().supports('getTransaction')) {
      return rejectInvalid(req, 'backfillOutputDatums', 'No configured backend serves transactions. With Ogmios only, run backfillTransactions over the crawled range');
    }
    datumBackfill = { status: 'running', ...NO_DATUM_PROGRESS, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    void backfillOutputDatums({
      client: getCardanoClient(),
      onProgress: (p) => { Object.assign(datumBackfill, p); },
    })
      .then((r) => { Object.assign(datumBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(datumBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Output-datum backfill failed: ${message}`);
      });
    return { accepted: true, message: 'Output-datum backfill started; poll getStatus().datumBackfill.' };
  });

  // backfillMetadataPositions: writes the chain position to metadata rows that lack it.
  // Needs no backend and runs detached. Progress is in getStatus().metadataBackfill.
  srv.on('backfillMetadataPositions', async (req: Request) => {
    if (metadataBackfill.status === 'running') return rejectInvalid(req, 'backfillMetadataPositions', 'A metadata-position backfill is already running');
    metadataBackfill = { status: 'running', atSlot: 0, toSlot: 0, rows: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    void backfillMetadataPositions({
      onProgress: (p) => { Object.assign(metadataBackfill, p); },
    })
      .then((r) => { Object.assign(metadataBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(metadataBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Metadata-position backfill failed: ${message}`);
      });
    return { accepted: true, message: 'Metadata-position backfill started; poll getStatus().metadataBackfill.' };
  });

  // backfillEpochs: rebuilds the epoch rows of the crawled range from the stored blocks.
  // Needs no backend and runs detached.
  srv.on('backfillEpochs', async (req: Request) => {
    if (epochBackfill.status === 'running') return rejectInvalid(req, 'backfillEpochs', 'An epoch backfill is already running');
    epochBackfill = { ...IDLE, status: 'running', startedAt: new Date().toISOString(), atEpoch: 0, toEpoch: 0, updated: 0, created: 0 };
    void getCardanoIndexer().backfillEpochs((p) => { Object.assign(epochBackfill, p); })
      .then((r) => { Object.assign(epochBackfill, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(epochBackfill, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Epoch backfill failed: ${message}`);
      });
    return { accepted: true, message: 'Epoch backfill started; poll getStatus().epochBackfill.' };
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
  const copyWalkRunning = () => copyPrune.status === 'running' || copyRestore.status === 'running';

  // pruneInputAssetCopies: moves the inputs of a slot range from asset copies to the output they
  // spent and deletes those copies. Needs no backend and runs detached.
  srv.on('pruneInputAssetCopies', async (req: Request) => {
    const range = copyRange(req, 'pruneInputAssetCopies');
    if (!range) return;
    if (copyWalkRunning()) return rejectInvalid(req, 'pruneInputAssetCopies', 'A prune or restore of input asset copies is already running');
    copyPrune = { ...IDLE, status: 'running', startedAt: new Date().toISOString(), atSlot: 0, toSlot: 0, referenced: 0, kept: 0, deleted: 0 };
    void pruneInputAssetCopies({ ...range, onProgress: (p) => { Object.assign(copyPrune, p); } })
      .then((r) => { Object.assign(copyPrune, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(copyPrune, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Prune of input asset copies failed: ${message}`);
      });
    return { accepted: true, message: 'Prune of input asset copies started; poll getStatus().copyPrune.' };
  });

  // restoreInputAssetCopies: the way back, copies written from the outputs.
  srv.on('restoreInputAssetCopies', async (req: Request) => {
    const range = copyRange(req, 'restoreInputAssetCopies');
    if (!range) return;
    if (copyWalkRunning()) return rejectInvalid(req, 'restoreInputAssetCopies', 'A prune or restore of input asset copies is already running');
    copyRestore = { ...IDLE, status: 'running', startedAt: new Date().toISOString(), atSlot: 0, toSlot: 0, restored: 0, rows: 0 };
    void restoreInputAssetCopies({ ...range, onProgress: (p) => { Object.assign(copyRestore, p); } })
      .then((r) => { Object.assign(copyRestore, r, { status: 'done', finishedAt: new Date().toISOString() }); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(copyRestore, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, 500) });
        logger.error(`Restore of input asset copies failed: ${message}`);
      });
    return { accepted: true, message: 'Restore of input asset copies started; poll getStatus().copyRestore.' };
  });

  // importUtxoSet: one-off snapshot import that anchors crawler.utxoSet.
  // Runs detached. Progress is in getStatus().utxoSet.
  srv.on('importUtxoSet', async (req: Request) => {
    const data = (req.data ?? {}) as { source?: string; filePath?: string; anchorSlot?: string | number | null; anchorHash?: string | null };
    if (data.source === 'aggregates') {
      if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process. Run pauseCrawler first');
      if (utxoSetImportInFlight) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
      return handleRequest(req, async (db) => {
        const cursor = await readCursor(db);
        const { anchorSlot, anchorHash } = cursor?.utxoSet ?? {};
        if (anchorSlot == null || !anchorHash) throw new TransactionValidationError('No imported UTxO set to rebuild the sums from. Run importUtxoSet first.');
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
    if (data.source === 'scripts') {
      if (isCrawlerRunning()) return rejectInvalid(req, 'importUtxoSet', 'Crawler is running in this process. Run pauseCrawler first');
      if (utxoSetImportInFlight) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
      return handleRequest(req, async (db) => {
        const cursor = await readCursor(db);
        const { anchorSlot, anchorHash } = cursor?.utxoSet ?? {};
        if (anchorSlot == null || !anchorHash) throw new TransactionValidationError('No imported UTxO set to fill. Run importUtxoSet first.');
        utxoSetImportInFlight = refreshUtxoSetReferenceScripts({ filePath: data.filePath, client: getCardanoClient() })
          .then((r) => logger.info(`UTxO set reference scripts filled: ${r.updated} of ${r.candidates} rows`))
          .catch((err: unknown) => logger.error(`UTxO set reference-script fill failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => { utxoSetImportInFlight = null; });
        return {
          accepted: true,
          anchorSlot: String(anchorSlot),
          anchorHash,
          message: `Reference-script columns of the UTxO set are being filled (${data.filePath ? 'from the dump' : 'from the node'}); watch the log, then resumeCrawler.`,
        };
      });
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
    if (utxoSetImportInFlight) return rejectInvalid(req, 'importUtxoSet', 'A UTxO set import is already running');
    return handleRequest(req, async (db) => {
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
