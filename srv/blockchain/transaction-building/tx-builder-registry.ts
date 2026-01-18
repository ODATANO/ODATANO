import { CardanoTxBuilder } from './cardano-tx';
import { BuildooorTxBuilder } from './buildooor-tx';
import { CSLTxBuilder } from './csl-tx';
import { ConfigError } from '../../utils/errors';
import { CONFIG } from '../../../config/config';
import cds from '@sap/cds';

const logger = cds.log(`TxBuilderRegistry`);
export type TxBuilderName = 'buildooor' | 'csl';

/**
 * TxBuilderRegistry - Central registry for creating and managing transaction builder instances
 * 
 * Provides factory methods for creating transaction builder instances based on configuration
 */
export class TxBuilderRegistry {
  private static readonly TX_BUILDER_FACTORIES = new Map<string, () => CardanoTxBuilder>([
    ['buildooor', () => new BuildooorTxBuilder()],
    ['csl', () => new CSLTxBuilder()],
  ]);

  /**
   * Create a single transaction builder instance by name
   * @param name transaction builder name
   * @returns {CardanoTxBuilder} transaction builder instance
   */
  static create(name: string): CardanoTxBuilder {
    const factory = this.TX_BUILDER_FACTORIES.get(name);
    if (!factory) {
      throw new ConfigError(`Unknown transaction builder: ${name}`);
    }
    return factory();
  }

  /**
   * Create default transaction builder from configuration
   * @returns {CardanoTxBuilder} default transaction builder instance
   */
  static createDefault(): CardanoTxBuilder {
    // Use first configured builder as default
    const configuredBuilders = CONFIG.transactionBuilders;
    const defaultBuilder = configuredBuilders[0];
    logger.info(`Creating default transaction builder: ${defaultBuilder}`);
    return this.create(defaultBuilder);
  }

  /**
   * Get all available transaction builder names
   * @returns {string[]} array of available transaction builder names
   */
  static getAvailableBuilders(): string[] {
    return Array.from(this.TX_BUILDER_FACTORIES.keys());
  }

  /**
   * Check if a transaction builder is available
   * @param name transaction builder name
   * @returns {boolean} true if the builder is available
   */
  static isAvailable(name: string): boolean {
    return this.TX_BUILDER_FACTORIES.has(name);
  }
}
