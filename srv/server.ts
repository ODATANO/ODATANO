import cds from '@sap/cds';
import { CardanoClient, CardanoClientConfig, BackendName } from './blockchain/cardano-client';
import { CardanoIndexer } from './blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from './blockchain/cardano-tx-builder';
import type { LedgerProtocolParameters, HsmConfig } from './utils/types';
import { HsmSigner, getHsmSigner, setHsmSigner } from './blockchain/signing/hsm-signer';
import { ProviderUnavailableError } from './utils/errors';
import { setActiveNetwork } from './utils/network-context';
import { installDbSanitizer } from './utils/db-sanitize';
import { ensureDbIndexes } from './utils/db-indexes';
import { installPostgresOrderNulls } from './utils/pg-order-nulls';
import { installPostgresInlineJson } from './utils/pg-inline-json';
import { startCrawler, stopCrawler } from './blockchain/crawler';
import type { CrawlerConfig } from './blockchain/crawler/crawler';
import { startWalletWorker, stopWalletWorker } from './blockchain/wallet-worker';
import type { WalletWorkerConfig } from './blockchain/wallet-worker';
import { activateAgentGrants } from './utils/agent-grants-config';
import {
  autoInitSkipped, isProduction, loadConfigFromEnv, loadCrawlerConfigFromEnv, loadHsmConfigFromEnv,
  loadPoolMetadataFetchFromEnv, loadWalletWorkerConfigFromEnv,
} from './config';

const logger = cds.log('ODATANO');

interface AppContext {
  cardanoClient: CardanoClient;
  cardanoIndexer: CardanoIndexer;
  cardanoTxBuilder: CardanoTransactionBuilder;
}

let appContext: AppContext | null = null;
let bootstrapError: Error | null = null;

/** Every start path, standalone hook and plugin, comes through here. */
async function initializeAppContext(
  config: CardanoClientConfig,
  protocolParams?: LedgerProtocolParameters,
  hsmConfig?: HsmConfig,
): Promise<AppContext> {
  logger.debug('Initializing blockchain components...');

  // Database first. Postgres ORDER BY without a NULLS clause on key / NOT NULL columns so
  // the indexes serve `$top` / `$orderby`, bulk rows inline instead of through a COPY buffer;
  // then the secondary indexes the model cannot declare.
  installPostgresOrderNulls();
  installPostgresInlineJson();
  // PostgreSQL builds its indexes CONCURRENTLY, so the service answers while a large one builds.
  const indexes = ensureDbIndexes().catch((err: unknown) => { logger.warn('secondary indexes not ensured (non-fatal):', err); });
  if ((cds.db as { kind?: string } | undefined)?.kind !== 'postgres') await indexes;

  const cardanoClient = new CardanoClient(config);

  // Lets leaf utilities (network-aware validators) read the network without importing this module.
  setActiveNetwork(config.network);

  const cardanoTxBuilder = new CardanoTransactionBuilder(cardanoClient);
  await cardanoTxBuilder.init(protocolParams);

  // PostgreSQL rejects U+0000 in text/JSON; one db-level `before` hook covers every write.
  if (installDbSanitizer()) logger.debug('DB NUL sanitizer installed');

  const cardanoIndexer = new CardanoIndexer(cardanoClient, cardanoTxBuilder);
  cardanoIndexer.setPoolMetadataFetch(loadPoolMetadataFetchFromEnv());

  // HSM signer failure is non-fatal
  if (hsmConfig?.enabled) {
    try {
      const hsmSigner = new HsmSigner(hsmConfig);
      await hsmSigner.init(config.network);
      setHsmSigner(hsmSigner);
      logger.debug('HSM signer initialized');
    } catch (err) {
      logger.error('Failed to initialize HSM signer:', err);
      setHsmSigner(null);
    }
  }

  logger.info('Blockchain components initialized successfully');

  return {
    cardanoClient,
    cardanoIndexer,
    cardanoTxBuilder,
  };
}

// Standalone mode never loads src/plugin.ts, so swap the auth impl here as well
// (bin/serve.js imports this file before the middlewares exist). Idempotent.
activateAgentGrants();

/** Throws 503 when uninitialized, with a bootstrap failure appended as cause. */
export function getAppContext(): AppContext {
  if (!appContext) {
    const base = 'Application not initialized. This should be called after cds.served event.';
    const msg = bootstrapError
      ? `${base} Bootstrap failed: ${bootstrapError.message}`
      : base;
    throw new ProviderUnavailableError(msg, 'odatano-bootstrap', undefined, bootstrapError ?? undefined);
  }
  return appContext;
}

export function getCardanoIndexer(): CardanoIndexer {
  return getAppContext().cardanoIndexer;
}

export function getCardanoClient(): CardanoClient {
  return getAppContext().cardanoClient;
}

export function getCardanoTxBuilder(): CardanoTransactionBuilder {
  return getAppContext().cardanoTxBuilder;
}

let hsmConfigInstance: HsmConfig | undefined;

/** HSM configuration when enabled; the sign service reads requiresRole from it. */
export function getHsmConfig(): HsmConfig | undefined {
  return hsmConfigInstance;
}

/** What getReadiness() reports about this process: the app context and, when configured, the HSM session. */
export function readinessParts(): { context: boolean; hsm: boolean | null } {
  return { context: appContext !== null, hsm: hsmConfigInstance ? getHsmSigner()?.isConnected() === true : null };
}

// Plugin path. Idempotent, so a second call never creates a duplicate CardanoClient.
// Tests reinitialize with resetAppContext() or createTestContext().
export async function initializeFromConfig(config: CardanoClientConfig, protocolParams?: LedgerProtocolParameters, hsmConfig?: HsmConfig): Promise<void> {
  if (appContext) {
    logger.debug('initializeFromConfig: appContext already initialized, skipping');
    return;
  }
  hsmConfigInstance = hsmConfig;
  try {
    appContext = await initializeAppContext(config, protocolParams, hsmConfig);
    bootstrapError = null;
  } catch (err) {
    // Keep the cause so getAppContext() can surface a structured 503 in plugin mode too.
    bootstrapError = err instanceof Error ? err : new Error(String(err));
    throw err;
  }
}

/** Reset the application context (tests only); lets tests inject their own instances. */
export function resetAppContext(context: AppContext | null): void {
  if (isProduction()) {
    throw new Error('resetAppContext() is not available in production');
  }
  appContext = context;
  bootstrapError = null;
  setActiveNetwork(context?.cardanoClient.network ?? null);
  logger.debug('Application context reset');
}

/** Isolated test context: the configuration of the environment with the given backends. */
export async function createTestContext(backends: BackendName[], protocolParams?: LedgerProtocolParameters): Promise<AppContext> {
  return await initializeAppContext({ ...loadConfigFromEnv(), backends }, protocolParams);
}

let shutdownInFlight: Promise<void> | null = null;

/** Stop worker and crawler, then close all backend connections. Concurrent callers share one run. */
export function shutdownAppContext(): Promise<void> {
  shutdownInFlight ??= runShutdown().finally(() => { shutdownInFlight = null; });
  return shutdownInFlight;
}

async function runShutdown(): Promise<void> {
  if (submissionReconcilerStarted) {
    submissionFinalizer().stopSubmissionReconciler();
    submissionReconcilerStarted = false;
  }

  // Worker and crawler first: their in-flight writes must not hit a torn-down client.
  try {
    await stopWalletWorker();
  } catch (err) {
    logger.warn('Wallet worker shutdown failed (continuing):', err);
  }

  try {
    await stopCrawler();
  } catch (err) {
    logger.warn('Crawler shutdown failed (continuing):', err);
  }

  if (appContext) {
    logger.info('Shutting down application context...');

    const hsm = getHsmSigner();
    if (hsm) {
      hsm.shutdown();
      setHsmSigner(null);
      logger.debug('HSM signer shutdown');
    }

    await appContext.cardanoClient.shutdown();
    appContext = null;
    setActiveNetwork(null);
  }
}


/** Start the crawler if enabled and the app context is ready. Never throws; idempotent. */
export async function startCrawlerIfConfigured(): Promise<void> {
  if (autoInitSkipped() || !appContext) return;
  let config: CrawlerConfig;
  try {
    config = loadCrawlerConfigFromEnv();
  } catch (err) {
    logger.error('Invalid crawler configuration, crawler not started:', err);
    return;
  }
  if (!config.enabled) return;

  try {
    await startCrawler({
      client: appContext.cardanoClient,
      indexer: appContext.cardanoIndexer,
      network: appContext.cardanoClient.network,
      config,
    });
    logger.info(`Chain crawler started (source=${config.source}, start=${config.startBlockHash})`);
  } catch (err) {
    logger.error('Failed to start chain crawler (non-fatal):', err);
  }
}

/** Start the wallet worker if enabled and the app context is ready. Never throws; idempotent. */
export async function startWalletWorkerIfConfigured(): Promise<void> {
  if (autoInitSkipped() || !appContext) return;
  let config: WalletWorkerConfig;
  try {
    config = loadWalletWorkerConfigFromEnv();
  } catch (err) {
    logger.error('Invalid wallet-worker configuration, worker not started:', err);
    return;
  }
  if (!config.enabled) return;

  try {
    await startWalletWorker({
      client: appContext.cardanoClient,
      indexer: appContext.cardanoIndexer,
      network: appContext.cardanoClient.network,
      config,
    });
    logger.info(`Wallet worker started (wallets=${config.wallets.map((w2) => w2.walletId).join(',')})`);
  } catch (err) {
    logger.error('Failed to start wallet worker (non-fatal):', err);
  }
}

let submissionReconcilerStarted = false;

function submissionFinalizer(): typeof import('./blockchain/signing/submission-finalizer') {
  return require('./blockchain/signing/submission-finalizer') as typeof import('./blockchain/signing/submission-finalizer');
}

// Resolves submits left open by a crash or by a submit without a verdict, now and then on a timer.
// Idempotent, because a transaction the node already holds finalizes as submitted. Never throws.
export async function redriveInterruptedSubmissionsIfConfigured(): Promise<void> {
  if (autoInitSkipped() || !appContext) return;
  // Without a database there are no signing requests to re-drive
  if (!cds.db) return;
  try {
    const attempted = await submissionFinalizer().redriveInterruptedSubmissions();
    if (attempted > 0) logger.info(`Resolved or retried ${attempted} open submission(s)`);
  } catch (err) {
    logger.error('Failed to re-drive interrupted submissions (non-fatal):', err);
  }
  submissionFinalizer().startSubmissionReconciler();
  submissionReconcilerStarted = true;
}

// Standalone bootstrap; skipped when the plugin already initialized the context.
cds.on('served', async () => {
  if (appContext) return;

  // SKIP_AUTO_INIT: tests with mocked backends
  if (autoInitSkipped()) {
    logger.info('Skipping auto-initialization (SKIP_AUTO_INIT=true)');
    return;
  }

  // Config loading stays inside the try: a ConfigError must never crash the host app.
  let config: ReturnType<typeof loadConfigFromEnv> | undefined;
  try {
    config = loadConfigFromEnv();
    const hsmConfig = loadHsmConfigFromEnv();
    hsmConfigInstance = hsmConfig;
    appContext = await initializeAppContext(config, undefined, hsmConfig);
    bootstrapError = null;
    logger.info('CAP server bootstrap complete');
  } catch (err) {
    // Never throw; keep the cause so getAppContext() surfaces a structured 503.
    bootstrapError = err instanceof Error ? err : new Error(String(err));
    // stderr directly: the cause stays visible when a test runner silences console.error.
    const where = config ? `backends={${config.backends.join(',')}} network=${config.network}` : 'config load';
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`[ODATANO] Failed to initialize blockchain components: ${where}\n${msg}\n`);
    logger.error('Failed to initialize blockchain components:', err);
  }

  // Optional subsystems; each is non-fatal.
  await startCrawlerIfConfigured();
  await startWalletWorkerIfConfigured();
  await redriveInterruptedSubmissionsIfConfigured();
});

cds.on('shutdown', async () => {
  await shutdownAppContext();
});
