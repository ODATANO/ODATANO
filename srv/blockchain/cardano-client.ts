import { CardanoBackend } from './cardano-backend';
import { BlockfrostBackend } from './blockfrost-backend';
import { KoiosBackend } from './koios-backend';
import { BackendError, AllBackendsFailedError } from '../utils/errors';
import logger from '../utils/logger';

import {
  Transaction,
  Address,
  UTxO,
  Network,
  LatestBlock,
  LatestEpoch,
  MetadataLabelTx
} from '../utils/types';

const PRIMARY_TIMEOUT_MS = Number(process.env.PRIMARY_TIMEOUT_MS) || 8000;
const FALLBACK_TIMEOUT_MS = Number(process.env.FALLBACK_TIMEOUT_MS) || 8000;

// ---------------------------------------------------------------------------
// Cardano Client with multiple backends, timeouts and fallbacks
// ---------------------------------------------------------------------------
export class CardanoClient {
  private backends: CardanoBackend[];
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(backends: CardanoBackend[]) {
    if (!backends || backends.length === 0) {
      throw new Error('[CardanoClient] At least one backend must be provided');
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

    for (const backend of this.backends) {
      try {
        logger.info({ backend: backend.name }, 'Initializing backend');
        await backend.init();
        initialized.push(backend);
        logger.info({ backend: backend.name }, 'Backend initialized successfully');
      } catch (err: any) {
        logger.error({ backend: backend.name, err }, 'Failed to initialize backend');
      }
    }

    if (initialized.length === 0) {
      throw new Error('[CardanoClient] Initialization failed for all backends');
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
    label: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        )
      ),
    ]);
  }

  private getTimeoutForBackend(backend: CardanoBackend): number {
    if (backend.name === 'blockfrost') return PRIMARY_TIMEOUT_MS;
    if (backend.name === 'koios') return FALLBACK_TIMEOUT_MS;
    // add more backends here with custom timeouts here
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
        // Convert to BackendError if not already
        const backendError = err instanceof BackendError 
          ? err 
          : new BackendError(
              err?.message ?? 'Unknown error',
              500,
              backend.name,
              err
            );
        
        errors.push(backendError);
        logger.warn(
          { 
            backend: backend.name, 
            error: backendError.message,
            statusCode: backendError.statusCode 
          }, 
          'Backend failed'
        );
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

  getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]> {
    return this.withFallback(b => b.getTransactionMetadata(txHash));
  }

  getMetadataLabelTransactions(label: string | number): Promise<MetadataLabelTx[]> {
    return this.withFallback(b => b.getMetadataLabelTransactions(label));
  }

  getLatestBlock(): Promise<LatestBlock> {
    return this.withFallback(b => b.getLatestBlock());
  }
  
  getLatestEpoch(): Promise<LatestEpoch> {
    return this.withFallback(b => b.getLatestEpoch());
  }
}

const backends: CardanoBackend[] = [];

if (process.env.BLOCKFROST_KEY) {
  backends.push(new BlockfrostBackend());
}

backends.push(new KoiosBackend());

export const cardanoClient = new CardanoClient(backends);

export default cardanoClient;
