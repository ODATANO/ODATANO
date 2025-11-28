import { CardanoBackend } from './cardano-backend';
import { BlockfrostBackend } from './blockfrost-backend';
import { KoiosBackend } from './koios-backend';
import logger from '../utils/logger';

const PRIMARY_TIMEOUT_MS  = Number(process.env.PRIMARY_TIMEOUT_MS  ?? 8000);
const FALLBACK_TIMEOUT_MS = Number(process.env.FALLBACK_TIMEOUT_MS ?? 8000);

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
    // ADD NEW BACKENDS HERE
    return PRIMARY_TIMEOUT_MS;
  }

  private async withFallback<T>(
    fn: (backend: CardanoBackend) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    let lastError: any;

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
        lastError = err;
        logger.warn({ backend: backend.name, err }, 'Backend failed');
      }
    }

    throw new Error(
      `All Cardano backends failed: ${lastError?.message ?? 'unknown error'}`
    );
  }

  getTransaction(txHash: string): Promise<any> {
    return this.withFallback(b => b.getTransaction(txHash));
  }

  getAddress(address: string): Promise<any> {
    return this.withFallback(b => b.getAddress(address));
  }

  getAddressUtxos(address: string): Promise<any[]> {
    return this.withFallback(b => b.getAddressUtxos(address));
  }

  getNetworkInformation(): Promise<any> {
    return this.withFallback(b => b.getNetworkInformation());
  }

  getMetadataLabels(): Promise<any[]> {
    return this.withFallback(b => b.getMetadataLabels());
  }

  getMetadataTrasactions(label: string | number): Promise<any[]> {
    return this.withFallback(b => b.getMetadataLabelTransactions(label));
  }
}

export const cardanoClient = new CardanoClient([
  new BlockfrostBackend(), // primary
  new KoiosBackend(),      // fallback
  //new NodeBackend(),     // add Note later
]);

export default cardanoClient;
