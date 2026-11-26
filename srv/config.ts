// Every setting is read here. cds.requires["odatano-core"] wins over process.env, which wins
// over the default. Only types are imported from the service code, so this module loads alone.
import cds from '@sap/cds';
import { env } from 'process';
import type { CardanoClientConfig, Network, BackendName } from './blockchain/cardano-client';
import type { CrawlerConfig } from './blockchain/crawler/crawler';
import type { WalletWorkerConfig } from './blockchain/wallet-worker';
import type { WorkerWalletConfig } from './blockchain/wallet-worker/signers';
import type { HsmConfig } from './utils/types';
import { DEFAULT_INDEX_TTL_MS } from './utils/const';
import { ConfigError } from './utils/errors';

const logger = cds.log('ODATANO');

const VALID_NETWORKS: Network[] = ['mainnet', 'preview', 'preprod'];

/** `cds.requires.odatano-core` as the host app wrote it; nested sections stay raw and are coerced on read. */
export interface OdatanoCoreCdsConfig {
  network?: string;
  backends?: string[] | string;
  blockfrostApiKey?: string;
  blockfrostCustomBackend?: string;
  koiosApiKey?: string;
  ogmiosUrl?: string;
  odatanoUrl?: string;
  odatanoApiKey?: string;
  primaryTimeoutMs?: number;
  fallbackTimeoutMs?: number;
  indexTtlMs?: number;
  poolMetadataFetch?: CdsBoolean;
  readTimeoutMs?: CdsNumber;
  hsm?: HsmCdsSection;
  crawler?: CrawlerCdsSection;
  walletWorker?: WalletWorkerCdsSection;
  agentGrants?: AgentGrantsCdsSection;
}

/** Numbers and booleans may arrive as strings; the loaders coerce and validate them. */
export type CdsNumber = number | string;
export type CdsBoolean = boolean | string;

export interface CrawlerCdsSection {
  enabled?: CdsBoolean;
  startSlot?: CdsNumber;
  startHeight?: CdsNumber;
  startBlockHash?: string;
  source?: string;
  batchSize?: CdsNumber;
  confirmationDepth?: CdsNumber;
  pollIntervalMs?: CdsNumber;
  assetHistory?: CdsBoolean;
  assetCatalogue?: string;
  assetEnrichRate?: CdsNumber;
  epochSnapshots?: CdsBoolean;
  accountSnapshots?: CdsBoolean;
  certificates?: CdsBoolean;
  utxoSet?: CdsBoolean;
  authoritative?: CdsBoolean;
  inputAssetCopies?: CdsBoolean;
}

export interface WalletWorkerCdsSection {
  enabled?: CdsBoolean;
  wallets?: unknown;
  maxConcurrentWallets?: CdsNumber;
  confirmationDepth?: CdsNumber;
  confirmationTimeoutMs?: CdsNumber;
  pollIntervalMs?: CdsNumber;
  defaultMaxAttempts?: CdsNumber;
  resubmitOnRollback?: CdsBoolean;
}

export interface HsmCdsSection {
  enabled?: boolean;
  pkcs11Module?: string;
  slot?: number;
  pin?: string;
  keyId?: string;
  keyLabel?: string;
  requiresRole?: string;
}

export interface AgentGrantsCdsSection {
  enabled?: CdsBoolean;
  delegate?: string;
  adminRateLimit?: CdsNumber;
  tokenCacheMs?: CdsNumber;
  usageRetentionDays?: CdsNumber;
}

/** The section as configured. Every read of it goes through here. */
export function coreCdsConfig(): OdatanoCoreCdsConfig {
  const requires = cds.env?.requires as Record<string, OdatanoCoreCdsConfig | undefined> | undefined;
  return requires?.['odatano-core'] ?? {};
}

/** The network as written, unchecked: for probes that answer even when the configuration is invalid. */
export function configuredNetworkName(): string {
  return String(coreCdsConfig().network || env.NETWORK || 'preview');
}

/** NODE_ENV=production, read per call like every other setting here. */
export function isProduction(): boolean {
  return env.NODE_ENV === 'production';
}

/** ENCRYPTION_KEY: the secret that encrypts worker signing keys given as `iv:authTag:ciphertext`. */
export function encryptionSecret(): string | undefined {
  return env.ENCRYPTION_KEY || undefined;
}

/** SKIP_AUTO_INIT=true: tests mount the services without starting backends, crawler or worker. */
export function autoInitSkipped(): boolean {
  return env.SKIP_AUTO_INIT === 'true';
}

/** ODATANO_DETACHED_TX_TIMEOUT_MS when it is a positive number; read per call. */
export function detachedTxTimeoutMs(): number | undefined {
  const fromEnv = Number(env.ODATANO_DETACHED_TX_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
}

export const READ_TIMEOUT_MS_DEFAULT = 15_000;

// Statement timeout for API reads on PostgreSQL. 0 turns it off; an invalid value logs a warning
// and falls back to the default.
export function loadReadTimeoutMs(vars: Record<string, string | undefined> = env): number {
  const configured = coreCdsConfig().readTimeoutMs;
  const raw = configured !== undefined ? configured : vars.READ_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return READ_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    logger.warn(`READ_TIMEOUT_MS "${String(raw)}" is not an integer >= 0; using ${READ_TIMEOUT_MS_DEFAULT}`);
    return READ_TIMEOUT_MS_DEFAULT;
  }
  return n;
}

const VALID_BACKENDS: BackendName[] = ['blockfrost', 'koios', 'ogmios', 'odatano'];

const CRAWLER_LIMITS = {
  batchSize: { min: 1, max: 100 },
  confirmationDepth: { min: 0, max: 2160 },
  pollIntervalMs: { min: 1000, max: 3_600_000 },
  assetEnrichRate: { min: 1, max: 20 },
} as const;

const VALID_ASSET_CATALOGUE_MODES = ['off', 'bare', 'enrich'] as const;

/** Parse a boolean crawler flag that defaults to `fallback` when unset. */
function crawlerBoolean(raw: unknown, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new ConfigError(`Invalid ${name} "${String(raw)}". Must be true or false.`);
}

/** Parse an integer without allowing JavaScript's lossy/implicit coercions. */
function crawlerInteger(
  raw: unknown,
  name: string,
  min: number,
  max: number,
  defaultValue?: number,
): number | undefined {
  if (raw == null) return defaultValue;
  if (
    (typeof raw !== 'number' && typeof raw !== 'string')
    || (typeof raw === 'string' && raw.trim() === '')
  ) {
    throw new ConfigError(`Invalid ${name} "${String(raw)}". Must be an integer between ${min} and ${max}.`);
  }

  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`Invalid ${name} "${String(raw)}". Must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/** Blockchain components created once at bootstrap and shared across services. */

/** Backends and their credentials. Throws ConfigError for an invalid value. */
export function loadConfigFromEnv(): CardanoClientConfig {
  const cdsConfig = coreCdsConfig();

  const network = configuredNetworkName() as Network;
  if (!VALID_NETWORKS.includes(network)) {
    throw new ConfigError(`Invalid NETWORK "${cdsConfig.network || env.NETWORK}". Must be one of: ${VALID_NETWORKS.join(', ')}`);
  }

  const backendsRaw = cdsConfig.backends ?? env.BACKENDS;
  const backendStrings: string[] = Array.isArray(backendsRaw) ? backendsRaw
    : backendsRaw ? String(backendsRaw).split(',').map(b => b.trim()) : ['koios'];
  const invalidBackends = backendStrings.filter(b => !(VALID_BACKENDS as readonly string[]).includes(b));
  if (invalidBackends.length > 0) {
    throw new ConfigError(`Invalid BACKENDS: "${invalidBackends.join(', ')}". Must be one of: ${VALID_BACKENDS.join(', ')}`);
  }
  const backends = backendStrings as BackendName[];

  const primaryTimeout = cdsConfig.primaryTimeoutMs ?? env.PRIMARY_TIMEOUT_MS;
  const fallbackTimeout = cdsConfig.fallbackTimeoutMs ?? env.FALLBACK_TIMEOUT_MS;

  // `!= null`, not truthiness: a CDS-config 0 must reach the <= 0 check.
  if (primaryTimeout != null && isNaN(Number(primaryTimeout))) {
    throw new ConfigError(`Invalid PRIMARY_TIMEOUT_MS "${primaryTimeout}". Must be a number.`);
  }
  if (primaryTimeout != null && Number(primaryTimeout) <= 0) {
    throw new ConfigError(`Invalid PRIMARY_TIMEOUT_MS "${primaryTimeout}". Must be a positive number.`);
  }
  if (fallbackTimeout != null && isNaN(Number(fallbackTimeout))) {
    throw new ConfigError(`Invalid FALLBACK_TIMEOUT_MS "${fallbackTimeout}". Must be a number.`);
  }
  if (fallbackTimeout != null && Number(fallbackTimeout) <= 0) {
    throw new ConfigError(`Invalid FALLBACK_TIMEOUT_MS "${fallbackTimeout}". Must be a positive number.`);
  }

  const blockfrostApiKey = cdsConfig.blockfrostApiKey || env.BLOCKFROST_API_KEY || '';
  const blockfrostCustomBackend = cdsConfig.blockfrostCustomBackend || env.BLOCKFROST_CUSTOM_BACKEND || '';
  if (blockfrostCustomBackend && !/^https?:\/\//i.test(blockfrostCustomBackend)) {
    throw new ConfigError(
      `Invalid BLOCKFROST_CUSTOM_BACKEND "${blockfrostCustomBackend}". Must be an http(s) URL ` +
      `(e.g. http://localhost:3010/api/v0).`
    );
  }
  const koiosApiKey = cdsConfig.koiosApiKey || env.KOIOS_API_KEY || '';
  const ogmiosUrl = cdsConfig.ogmiosUrl || env.OGMIOS_URL || '';
  const odatanoUrl = cdsConfig.odatanoUrl || env.ODATANO_URL || '';
  const odatanoApiKey = cdsConfig.odatanoApiKey || env.ODATANO_API_KEY || '';
  if (odatanoUrl && !/^https?:\/\//i.test(odatanoUrl)) {
    throw new ConfigError(`Invalid ODATANO_URL "${odatanoUrl}". Must be an http(s) URL (e.g. https://api.preprod.odatano.dev).`);
  }
  if (backends.includes('odatano') && !odatanoUrl && network === 'mainnet') {
    throw new ConfigError('ODATANO_URL is required for the odatano backend on mainnet.');
  }
  if (backends.includes('odatano') && !odatanoApiKey) {
    logger.warn('ODATANO_API_KEY is not set but odatano is listed in BACKENDS; the public API refuses calls without a key');
  }

  if (backends.includes('blockfrost') && !blockfrostApiKey && !blockfrostCustomBackend) {
    logger.warn('Neither BLOCKFROST_API_KEY nor BLOCKFROST_CUSTOM_BACKEND is set but blockfrost is listed in BACKENDS');
  } else if (backends.includes('blockfrost') && blockfrostCustomBackend) {
    logger.info(`Blockfrost will use customBackend: ${blockfrostCustomBackend}`);
  }
  if (backends.includes('ogmios') && !ogmiosUrl) {
    logger.warn('OGMIOS_URL is not set but ogmios is listed in BACKENDS');
  }

  return {
    network,
    backends,
    blockfrostApiKey,
    blockfrostCustomBackend: blockfrostCustomBackend || undefined,
    koiosApiKey,
    ogmiosUrl,
    odatanoUrl: odatanoUrl || undefined,
    odatanoApiKey: odatanoApiKey || undefined,
    primaryTimeoutMs: Number(primaryTimeout) || 30000,   // || intentional: NaN (missing config) falls back to default
    fallbackTimeoutMs: Number(fallbackTimeout) || 60000,
    indexTtlMs: Number(cdsConfig.indexTtlMs ?? env.INDEX_TTL_MS) || DEFAULT_INDEX_TTL_MS,
  };
}

/** `poolMetadataFetch` / POOL_METADATA_FETCH: load pool metadata files from their registered URL. Off by default. */
export function loadPoolMetadataFetchFromEnv(): boolean {
  return crawlerBoolean(coreCdsConfig().poolMetadataFetch ?? env.POOL_METADATA_FETCH, 'POOL_METADATA_FETCH', false);
}

/** From cds.requires.odatano-core.hsm or HSM_* env vars. Undefined when HSM is off. */
export function loadHsmConfigFromEnv(): HsmConfig | undefined {
  const cdsConfig = coreCdsConfig();
  const hsmCds: HsmCdsSection = cdsConfig.hsm ?? {};

  const hsmEnabled = hsmCds.enabled === true || env.HSM_ENABLED === 'true';
  if (!hsmEnabled) return undefined;

  const pkcs11Module = hsmCds.pkcs11Module || env.HSM_PKCS11_MODULE || '';
  if (!pkcs11Module) {
    throw new ConfigError('HSM_PKCS11_MODULE is required when HSM is enabled');
  }

  const pin = hsmCds.pin || env.HSM_PIN || '';
  if (!pin) {
    throw new ConfigError('HSM_PIN is required when HSM is enabled');
  }

  const slot = Number(hsmCds.slot ?? env.HSM_SLOT ?? 0);
  if (!Number.isInteger(slot) || slot < 0) {
    throw new ConfigError(`Invalid HSM slot: "${hsmCds.slot ?? env.HSM_SLOT}": must be a non-negative integer`);
  }

  // Fail closed: the HSM holds a real signing key, so an explicit role gate is mandatory.
  const requiresRole = hsmCds.requiresRole || env.HSM_REQUIRES_ROLE || '';
  if (!requiresRole) {
    throw new ConfigError('HSM_REQUIRES_ROLE (or cds.requires.odatano-core.hsm.requiresRole) is required when HSM is enabled. Set it to the XSUAA scope name allowed to invoke HSM signing actions');
  }

  return {
    enabled: true,
    pkcs11Module,
    slot,
    pin,
    keyId: hsmCds.keyId || env.HSM_KEY_ID,
    keyLabel: hsmCds.keyLabel || env.HSM_KEY_LABEL,
    requiresRole,
  };
}

/** From cds.requires.odatano-core.crawler or CRAWLER_* env vars. Off by default. */
export function loadCrawlerConfigFromEnv(): CrawlerConfig {
  const cdsConfig = coreCdsConfig();
  const c: CrawlerCdsSection = cdsConfig.crawler ?? {};

  // A CDS value, including an explicit `false`, wins over the environment.
  const enabledRaw = c.enabled !== undefined ? c.enabled : env.CRAWLER_ENABLED;
  let enabled = false;
  if (enabledRaw === true || enabledRaw === 'true') {
    enabled = true;
  } else if (enabledRaw !== undefined && enabledRaw !== false && enabledRaw !== 'false') {
    throw new ConfigError(`Invalid CRAWLER_ENABLED "${String(enabledRaw)}". Must be true or false.`);
  }

  const startSlot = crawlerInteger(
    c.startSlot ?? env.CRAWLER_START_SLOT,
    'CRAWLER_START_SLOT',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const startHeight = crawlerInteger(
    c.startHeight ?? env.CRAWLER_START_HEIGHT,
    'CRAWLER_START_HEIGHT',
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const startBlockHashRaw = c.startBlockHash ?? env.CRAWLER_START_HASH;
  if (startBlockHashRaw != null && (typeof startBlockHashRaw !== 'string' || !/^[0-9a-f]{64}$/i.test(startBlockHashRaw.trim()))) {
    throw new ConfigError('Invalid CRAWLER_START_HASH. Must be exactly 64 hexadecimal characters.');
  }
  const startBlockHash = startBlockHashRaw?.trim() || undefined;
  const source = (c.source ?? env.CRAWLER_SOURCE ?? 'auto') as CrawlerConfig['source'];
  const batchSize = crawlerInteger(
    c.batchSize ?? env.CRAWLER_BATCH_SIZE,
    'CRAWLER_BATCH_SIZE',
    CRAWLER_LIMITS.batchSize.min,
    CRAWLER_LIMITS.batchSize.max,
    20,
  )!;
  const confirmationDepth = crawlerInteger(
    c.confirmationDepth ?? env.CRAWLER_CONFIRMATION_DEPTH,
    'CRAWLER_CONFIRMATION_DEPTH',
    CRAWLER_LIMITS.confirmationDepth.min,
    CRAWLER_LIMITS.confirmationDepth.max,
    3,
  )!;
  const pollIntervalMs = crawlerInteger(
    c.pollIntervalMs ?? env.CRAWLER_POLL_INTERVAL_MS,
    'CRAWLER_POLL_INTERVAL_MS',
    CRAWLER_LIMITS.pollIntervalMs.min,
    CRAWLER_LIMITS.pollIntervalMs.max,
    20_000,
  )!;

  if (enabled && (startSlot == null || Number.isNaN(startSlot) || !startBlockHash)) {
    throw new ConfigError(
      'Crawler is enabled but no start block is configured. Set crawler.startSlot + crawler.startBlockHash ' +
      '(or CRAWLER_START_SLOT + CRAWLER_START_HASH).'
    );
  }
  if (!['ogmios', 'pagination', 'auto'].includes(source)) {
    throw new ConfigError(`Invalid CRAWLER_SOURCE "${source}". Must be one of: ogmios, pagination, auto.`);
  }

  // Analytics coverage: mint/burn and the bare catalogue are free by-products of a crawled
  // block and on by default; enrichment and epoch snapshots cost provider calls and are opt-in.
  const assetHistory = crawlerBoolean(
    c.assetHistory ?? env.CRAWLER_ASSET_HISTORY, 'CRAWLER_ASSET_HISTORY', true,
  );
  const assetCatalogue = (c.assetCatalogue ?? env.CRAWLER_ASSET_CATALOGUE ?? 'bare') as CrawlerConfig['assetCatalogue'];
  if (!VALID_ASSET_CATALOGUE_MODES.includes(assetCatalogue)) {
    throw new ConfigError(
      `Invalid CRAWLER_ASSET_CATALOGUE "${assetCatalogue}". Must be one of: ${VALID_ASSET_CATALOGUE_MODES.join(', ')}.`
    );
  }
  const assetEnrichRate = crawlerInteger(
    c.assetEnrichRate ?? env.CRAWLER_ASSET_ENRICH_RATE,
    'CRAWLER_ASSET_ENRICH_RATE',
    CRAWLER_LIMITS.assetEnrichRate.min,
    CRAWLER_LIMITS.assetEnrichRate.max,
    2,
  )!;
  const epochSnapshots = crawlerBoolean(
    c.epochSnapshots ?? env.CRAWLER_EPOCH_SNAPSHOTS, 'CRAWLER_EPOCH_SNAPSHOTS', false,
  );
  // One row per pool-delegated account and epoch, read from the node with the epoch snapshot.
  const accountSnapshots = crawlerBoolean(
    c.accountSnapshots ?? env.CRAWLER_ACCOUNT_SNAPSHOTS, 'CRAWLER_ACCOUNT_SNAPSHOTS', false,
  );
  if (accountSnapshots && !epochSnapshots) {
    throw new ConfigError('CRAWLER_ACCOUNT_SNAPSHOTS needs CRAWLER_EPOCH_SNAPSHOTS: the account snapshot is taken with the epoch snapshot.');
  }
  // Certificates + withdrawals are block content (no extra request) but opt-in to keep write volume stable.
  const certificates = crawlerBoolean(
    c.certificates ?? env.CRAWLER_CERTIFICATES, 'CRAWLER_CERTIFICATES', false,
  );
  // UTxO set: opt-in, inert until a snapshot has been imported (importUtxoSet).
  const utxoSet = crawlerBoolean(
    c.utxoSet ?? env.CRAWLER_UTXO_SET, 'CRAWLER_UTXO_SET', false,
  );
  // Crawled chain answers misses with 404 instead of a provider call.
  const authoritative = crawlerBoolean(
    c.authoritative ?? env.CRAWLER_AUTHORITATIVE, 'CRAWLER_AUTHORITATIVE', false,
  );

  // A copy of every input's assets makes long ranges of inputs fast to read and stores the assets twice.
  const inputAssetCopies = crawlerBoolean(
    c.inputAssetCopies ?? env.CRAWLER_INPUT_ASSET_COPIES, 'CRAWLER_INPUT_ASSET_COPIES', false,
  );

  return {
    enabled, startSlot, startBlockHash, startHeight, source, batchSize, confirmationDepth, pollIntervalMs,
    assetHistory, assetCatalogue, assetEnrichRate, epochSnapshots, accountSnapshots, certificates, utxoSet, authoritative, inputAssetCopies,
  };
}

const WALLET_WORKER_LIMITS = {
  maxConcurrentWallets: { min: 1, max: 64 },
  confirmationDepth: { min: 1, max: 2160 },
  confirmationTimeoutMs: { min: 30_000, max: 86_400_000 },
  pollIntervalMs: { min: 500, max: 3_600_000 },
  maxAttempts: { min: 1, max: 10 },
} as const;

/** From cds.requires.odatano-core.walletWorker or WALLET_WORKER_* env vars. Off by default. */
export function loadWalletWorkerConfigFromEnv(): WalletWorkerConfig {
  const cdsConfig = coreCdsConfig();
  const w: WalletWorkerCdsSection = cdsConfig.walletWorker ?? {};

  const enabledRaw = w.enabled !== undefined ? w.enabled : env.WALLET_WORKER_ENABLED;
  let enabled = false;
  if (enabledRaw === true || enabledRaw === 'true') {
    enabled = true;
  } else if (enabledRaw !== undefined && enabledRaw !== false && enabledRaw !== 'false') {
    throw new ConfigError(`Invalid WALLET_WORKER_ENABLED "${String(enabledRaw)}". Must be true or false.`);
  }

  let walletsRaw: unknown = w.wallets ?? undefined;
  if (walletsRaw === undefined && env.WALLET_WORKER_WALLETS) {
    try {
      walletsRaw = JSON.parse(env.WALLET_WORKER_WALLETS);
    } catch {
      throw new ConfigError('Invalid WALLET_WORKER_WALLETS: must be a JSON array of { walletId, signerType, keyEnv?, requiresRole? }.');
    }
  }
  const wallets: WorkerWalletConfig[] = [];
  if (walletsRaw !== undefined) {
    if (!Array.isArray(walletsRaw)) {
      throw new ConfigError('Invalid walletWorker.wallets: must be an array of { walletId, signerType, keyEnv?, requiresRole? }.');
    }
    for (const entry of walletsRaw) {
      const walletId = typeof entry?.walletId === 'string' ? entry.walletId.trim() : '';
      const signerType = entry?.signerType;
      if (!walletId || (signerType !== 'hsm' && signerType !== 'software')) {
        throw new ConfigError(`Invalid wallet entry ${JSON.stringify(entry)}: walletId and signerType (hsm|software) are required.`);
      }
      if (signerType === 'software' && (typeof entry.keyEnv !== 'string' || !entry.keyEnv.trim())) {
        throw new ConfigError(`Wallet "${walletId}" is signerType=software but has no keyEnv (name of the env var holding the signing key).`);
      }
      if (wallets.some((existing) => existing.walletId === walletId)) {
        throw new ConfigError(`Duplicate walletId "${walletId}" in walletWorker.wallets.`);
      }
      const requiresRole: unknown = entry.requiresRole ?? undefined;
      if (requiresRole !== undefined && (typeof requiresRole !== 'string' || !requiresRole.trim() || requiresRole.trim().length > 100)) {
        throw new ConfigError(`Wallet "${walletId}": requiresRole must be a role name of 1 to 100 characters.`);
      }
      wallets.push({ walletId, signerType, keyEnv: entry.keyEnv, ...(requiresRole ? { requiresRole: requiresRole.trim() } : {}) });
    }
  }

  const maxConcurrentWallets = crawlerInteger(
    w.maxConcurrentWallets ?? env.WALLET_WORKER_MAX_CONCURRENT,
    'WALLET_WORKER_MAX_CONCURRENT',
    WALLET_WORKER_LIMITS.maxConcurrentWallets.min,
    WALLET_WORKER_LIMITS.maxConcurrentWallets.max,
    4,
  )!;
  const confirmationDepth = crawlerInteger(
    w.confirmationDepth ?? env.WALLET_WORKER_CONFIRMATION_DEPTH,
    'WALLET_WORKER_CONFIRMATION_DEPTH',
    WALLET_WORKER_LIMITS.confirmationDepth.min,
    WALLET_WORKER_LIMITS.confirmationDepth.max,
    3,
  )!;
  const confirmationTimeoutMs = crawlerInteger(
    w.confirmationTimeoutMs ?? env.WALLET_WORKER_CONFIRMATION_TIMEOUT_MS,
    'WALLET_WORKER_CONFIRMATION_TIMEOUT_MS',
    WALLET_WORKER_LIMITS.confirmationTimeoutMs.min,
    WALLET_WORKER_LIMITS.confirmationTimeoutMs.max,
    600_000,
  )!;
  const pollIntervalMs = crawlerInteger(
    w.pollIntervalMs ?? env.WALLET_WORKER_POLL_INTERVAL_MS,
    'WALLET_WORKER_POLL_INTERVAL_MS',
    WALLET_WORKER_LIMITS.pollIntervalMs.min,
    WALLET_WORKER_LIMITS.pollIntervalMs.max,
    2_000,
  )!;
  const defaultMaxAttempts = crawlerInteger(
    w.defaultMaxAttempts ?? env.WALLET_WORKER_MAX_ATTEMPTS,
    'WALLET_WORKER_MAX_ATTEMPTS',
    WALLET_WORKER_LIMITS.maxAttempts.min,
    WALLET_WORKER_LIMITS.maxAttempts.max,
    3,
  )!;

  const resubmitRaw = w.resubmitOnRollback !== undefined ? w.resubmitOnRollback : env.WALLET_WORKER_RESUBMIT_ON_ROLLBACK;
  let resubmitOnRollback = true;
  if (resubmitRaw === false || resubmitRaw === 'false') {
    resubmitOnRollback = false;
  } else if (resubmitRaw !== undefined && resubmitRaw !== true && resubmitRaw !== 'true') {
    throw new ConfigError(`Invalid WALLET_WORKER_RESUBMIT_ON_ROLLBACK "${String(resubmitRaw)}". Must be true or false.`);
  }

  if (enabled && wallets.length === 0) {
    throw new ConfigError(
      'Wallet worker is enabled but no wallets are configured. Set walletWorker.wallets (or WALLET_WORKER_WALLETS).',
    );
  }

  return {
    enabled,
    wallets,
    maxConcurrentWallets,
    confirmationDepth,
    confirmationTimeoutMs,
    pollIntervalMs,
    defaultMaxAttempts,
    resubmitOnRollback,
  };
}

/** Agent grants: `agentGrants` in the section, else AGENT_GRANT* variables. */
export interface AgentGrantsConfig {
  enabled: boolean;
  /** CAP auth kind the transport middleware delegates to for non-token requests. */
  delegate: string;
  /** Grant administration calls per principal per hour (integer >= 1). */
  adminRateLimit: number;
}

export const AGENT_GRANTS_DELEGATES: readonly string[] = ['mocked', 'basic', 'jwt', 'xsuaa', 'ias', 'dummy'];

export const AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT = 10;

// Grant administration calls per principal per hour. An invalid value logs a warning
// and falls back to the default. It never disables the feature.
export function loadGrantAdminRateLimit(vars: Record<string, string | undefined> = env): number {
  const cfg = coreCdsConfig().agentGrants ?? {};
  const raw = cfg.adminRateLimit !== undefined ? cfg.adminRateLimit : vars.AGENT_GRANT_ADMIN_RATE_LIMIT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    logger.warn(
      `AGENT_GRANT_ADMIN_RATE_LIMIT "${String(raw)}" is not an integer >= 1; using ${AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT}`
    );
    return AGENT_GRANT_ADMIN_RATE_LIMIT_DEFAULT;
  }
  return n;
}

export const AGENT_TOKEN_CACHE_MS_DEFAULT = 10_000;

// How long a resolved grant row is reused before the DB is read again. 0 disables the cache.
// This bounds how late a revoke on another replica takes effect.
export function loadTokenCacheMs(vars: Record<string, string | undefined> = env): number {
  const cfg = coreCdsConfig().agentGrants ?? {};
  const raw = cfg.tokenCacheMs !== undefined ? cfg.tokenCacheMs : vars.AGENT_TOKEN_CACHE_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return AGENT_TOKEN_CACHE_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    logger.warn(`AGENT_TOKEN_CACHE_MS "${String(raw)}" is not an integer >= 0; using ${AGENT_TOKEN_CACHE_MS_DEFAULT}`);
    return AGENT_TOKEN_CACHE_MS_DEFAULT;
  }
  return n;
}

export const AGENT_GRANT_USAGE_RETENTION_DAYS_DEFAULT = 400;

// Days a usage counter row is kept; 0 keeps every row. GetGrantUsage reads at most 366 days at once.
// An invalid value logs a warning and falls back to the default.
export function loadGrantUsageRetentionDays(vars: Record<string, string | undefined> = env): number {
  const cfg = coreCdsConfig().agentGrants ?? {};
  const raw = cfg.usageRetentionDays !== undefined ? cfg.usageRetentionDays : vars.AGENT_GRANT_USAGE_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return AGENT_GRANT_USAGE_RETENTION_DAYS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    logger.warn(
      `AGENT_GRANT_USAGE_RETENTION_DAYS "${String(raw)}" is not an integer >= 0; using ${AGENT_GRANT_USAGE_RETENTION_DAYS_DEFAULT}`
    );
    return AGENT_GRANT_USAGE_RETENTION_DAYS_DEFAULT;
  }
  return n;
}

/** The configured `cds.requires.auth` as an object (the shorthand `"auth": "xsuaa"` is a string). */
export function configuredAuth(): Record<string, unknown> {
  const auth = (cds.env?.requires as Record<string, unknown> | undefined)?.auth;
  if (typeof auth === 'string') return { kind: auth };
  return (auth ?? {}) as Record<string, unknown>;
}

/** The transport middleware, recognisable in `auth.impl` so activation stays idempotent. */
export const AGENT_AUTH_IMPL = 'cap-auth';

/** A host-configured custom `cds.requires.auth.impl` (not this package's middleware); the lane wraps it. */
export function customAuthImpl(auth: Record<string, unknown> = configuredAuth()): string | null {
  const impl = typeof auth.impl === 'string' ? auth.impl.trim() : '';
  if (!impl || impl.includes(AGENT_AUTH_IMPL)) return null;
  return impl;
}

export function loadAgentGrantsConfig(vars: Record<string, string | undefined> = env): AgentGrantsConfig {
  const cfg = coreCdsConfig().agentGrants ?? {};
  const enabledRaw = cfg.enabled !== undefined ? cfg.enabled : vars.AGENT_GRANTS_ENABLED;
  const enabled = enabledRaw === true || String(enabledRaw ?? '').toLowerCase() === 'true';

  const auth = configuredAuth();
  const authKind = String(auth.kind ?? 'mocked');
  // A host's own auth.impl becomes the delegate ("custom") unless configured otherwise.
  const fallback = customAuthImpl(auth) ? 'custom' : authKind;
  const delegateRaw = String(cfg.delegate ?? vars.AGENT_GRANTS_DELEGATE ?? fallback);
  // `xsuaa-auth` / `basic-auth` spellings are what CAP itself accepts as kinds.
  const delegate = delegateRaw.replace(/-auth$/, '');
  if (enabled && delegate !== 'custom' && !AGENT_GRANTS_DELEGATES.includes(delegate)) {
    throw new Error(
      `Invalid agentGrants.delegate "${delegateRaw}". Must be one of: ${AGENT_GRANTS_DELEGATES.join(', ')}, custom`
    );
  }
  if (enabled && delegate === 'custom' && !customAuthImpl(auth)) {
    throw new Error('agentGrants.delegate "custom" needs a custom cds.requires.auth.impl to delegate to');
  }
  return { enabled, delegate, adminRateLimit: loadGrantAdminRateLimit(vars) };
}
