import { CardanoBackend } from './backends/cardano-backend';
import { BlockfrostBackend } from './backends/blockfrost-backend';
import { KoiosBackend } from './backends/koios-backend';
import { BackendError, ConfigError, AllBackendsFailedError, ProviderUnavailableError, AllBackendsInitFailedError, BackendInitError, normalizeBackendError } from '../utils/errors';
import logger from '../utils/logger';
import { CONFIG } from '../../config/config';

import {
  Transaction,
  Address,
  UTxO,
  Network,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData, 
  DrepData, 
  AccountData
} from '../utils/types';

const PRIMARY_TIMEOUT_MS = Number(CONFIG.primaryTimeoutMs) || 8000;
const FALLBACK_TIMEOUT_MS = Number(CONFIG.fallbackTimeoutMs) || 8000;

export class CardanoClient {
  private backends: CardanoBackend[];
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(backends: CardanoBackend[]) {
    if (!backends || backends.length === 0) {
      throw new ConfigError(
        'CardanoClient misconfigured: no backend available. Check CONFIG and API keys.'
      );
    }
    this.backends = backends;
  }

  // ---------------------------------------------------------------------------
  // Init-Lifecycle
  // ---------------------------------------------------------------------------
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initBackends();
    }
    await this.initPromise;
  }

  private async initBackends(): Promise<void> {
    const initialized: CardanoBackend[] = [];
    const initErrors: BackendInitError[] = [];

    for (const backend of this.backends) {
      try {
        logger.info({ backend: backend.name }, 'Initializing backend');
        await backend.init();
        initialized.push(backend);
        logger.info({ backend: backend.name }, 'Backend initialized successfully');
      } catch (err: any) {
        initErrors.push(new BackendInitError(backend.name, err));
        logger.error({ backend: backend.name, err }, 'Failed to initialize backend');
      }
    }
    if (initialized.length === 0) {
      throw new AllBackendsInitFailedError(initErrors);
    }
    this.backends = initialized;
    this.initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Intern: Timeout & Fallback
  // ---------------------------------------------------------------------------
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    backendName: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new ProviderUnavailableError('Backend timeout', backendName, ms)),
          ms
        )
      ),
    ]);
  }

  private getTimeoutForBackend(backend: CardanoBackend): number {
    if (backend.name === 'blockfrost') return PRIMARY_TIMEOUT_MS;
    if (backend.name === 'koios') return FALLBACK_TIMEOUT_MS;
    // add more backends with custom timeouts here
    return PRIMARY_TIMEOUT_MS;
  }

  private async withFallback<T>(
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    const errors: BackendError[] = [];

    for (const backend of this.backends) {
      const timeoutMs = this.getTimeoutForBackend(backend);
      try {
        logger.debug({ backend: backend.name }, 'Calling backend');
        const result = await this.withTimeout(
          fn(backend),
          timeoutMs,
          backend.name
        );
        return result;
      } catch (err: any) {

        const backendError = normalizeBackendError(err, backend.name);
        errors.push(backendError);
        
        // 404 errors are expected - log as debug, not warn
        if (backendError.statusCode === 404) {
          logger.debug(
            { 
              backend: backend.name, 
              error: backendError.message,
              code: backendError.code 
            }, 
            'Backend: resource not found'
          );
        } else {
          logger.warn(
            { 
              backend: backend.name, 
              error: backendError.message,
              statusCode: backendError.statusCode,
              code: backendError.code 
            }, 
            'Backend failed'
          );
        }
      }
    }

    throw new AllBackendsFailedError(errors);
  }

  getTransaction(txHash: string): Promise<Transaction> {
    return this.withFallback(b => b.getTransaction(txHash));
  }
  getAddress(address: string): Promise<Address> {
    return this.withFallback(b => b.getAddress(address));
  }
  getAddressUtxos(address: string): Promise<UTxO[]> {
    return this.withFallback(b => b.getAddressUtxos(address));
  }
  getNetworkInformation(): Promise<Network> {
    return this.withFallback(b => b.getNetworkInformation());
  }
  getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return this.withFallback(b => b.getTransactionMetadata(tx_hash));
  }
  getBlock(block_hash: string): Promise<BlockData> {
    return this.withFallback(b => b.getBlock(block_hash));
  }
  getEpoch(epochNumber: Number): Promise<EpochData> {
    return this.withFallback(b => b.getEpoch(epochNumber));
  }
  getPool(poolId: string): Promise<PoolData> {
    return this.withFallback(b => b.getPool(poolId));
  }
  getDrep(drepId: string): Promise<DrepData> {
    return this.withFallback(b => b.getDrep(drepId));
  }
  getAccount(stakeAddress: string): Promise<AccountData> {
    return this.withFallback(b => b.getAccount(stakeAddress));
  } 
}

const backends: CardanoBackend[] = [];

// build backends from configuration
for (const backendName of CONFIG.backends) {
  if (backendName === 'blockfrost' && CONFIG.blockfrostApiKey) {
    backends.push(new BlockfrostBackend());
  } else if (backendName === 'koios') {
    backends.push(new KoiosBackend());
  }
}

// Fallback if no backends configured
if (backends.length === 0) {
  if (CONFIG.blockfrostApiKey) {
    backends.push(new BlockfrostBackend());
  }
  backends.push(new KoiosBackend());
}

export const cardanoClient = new CardanoClient(backends);

export default cardanoClient;

// ---------------------------------------------------------------------------
// Factory for creating client with specific backends (useful for tests to init single backends)
// ---------------------------------------------------------------------------
export function createCardanoClientForBackends(backendNames: string[]): CardanoClient {
  const testBackends: CardanoBackend[] = [];

  for (const backendName of backendNames) {
    if (backendName === 'blockfrost' && CONFIG.blockfrostApiKey) {
      testBackends.push(new BlockfrostBackend());
    } else if (backendName === 'koios') {
      testBackends.push(new KoiosBackend());
    }
  }

  if (testBackends.length === 0) {
    throw new ConfigError(`No valid backends configured: ${backendNames.join(',')}`);
  }

  return new CardanoClient(testBackends);
}
