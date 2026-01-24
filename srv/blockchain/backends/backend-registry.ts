import cds from '@sap/cds';
import { CardanoBackend } from './cardano-backend';
import { OgmiosBackend } from './ogmios-backend';
import { BlockfrostBackend } from './blockfrost-backend';
import { KoiosBackend } from './koios-backend';
import { ConfigError } from '../../utils/errors';
import { CONFIG } from '../../../config/config';

const logger = cds.log('BackendRegistry');
/**
 * BackendName - Union type of supported backend names
 */
export type BackendName = 'ogmios' | 'blockfrost' | 'koios';

/**
 * BackendRegistry - Central registry for creating and managing backend instances
 * 
 * Provides factory methods for creating backend instances based on configuration
 */
export class BackendRegistry {
  private static readonly BACKEND_FACTORIES = new Map<string, () => CardanoBackend>([
    ['ogmios', () => new OgmiosBackend()],
    ['blockfrost', () => new BlockfrostBackend()],
    ['koios', () => new KoiosBackend()],
  ]);

  /**
   * Create a single backend instance by name
   * @param name backend name
   * @returns {CardanoBackend} backend instance
   */
  static create(name: string): CardanoBackend {
    const factory = this.BACKEND_FACTORIES.get(name);
    if (!factory) {
      throw new ConfigError(`Unknown backend: ${name}`);
    }
    return factory();
  }

  /**
   * Create live backend from configuration
   * @returns {CardanoBackend | undefined} live backend instance or undefined
   */
  static createLiveBackend(): CardanoBackend | undefined {
    const configuredBackends = CONFIG.backends;
    
    // Check if Ogmios is configured
    if (configuredBackends.includes('ogmios')) {
      logger.info('Creating Ogmios as live backend');
      return this.create('ogmios');
    }
    
    return undefined;
  }

  /**
   * Create historical backends from configuration
   * @returns {CardanoBackend[]} array of historical backend instances
   */
  static createHistoricalBackends(): CardanoBackend[] {
    const configuredBackends = CONFIG.backends;
    const backends: CardanoBackend[] = [];

    // Check for Blockfrost
    if (configuredBackends.includes('blockfrost') && CONFIG.blockfrostApiKey) {
      logger.info('Adding Blockfrost as historical backend');
      backends.push(this.create('blockfrost'));
    }

    // Check for Koios (API key is optional)
    if (configuredBackends.includes('koios')) {
      logger.info('Adding Koios as historical backend');
      backends.push(this.create('koios'));
    }

    return backends;
  }
}
