/**
 * Unit tests for TxBuilderRegistry
 */

import { TxBuilderRegistry } from '../../srv/blockchain/transaction-building/tx-builder-registry';
import { ConfigError } from '../../srv/utils/errors';
import { CONFIG } from '../../config/config';
import logger from '../../srv/utils/logger';

// Mock the logger
jest.mock('../../srv/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock the CONFIG
jest.mock('../../config/config', () => ({
  CONFIG: {
    transactionBuilders: ['csl', 'buildooor'],
  },
}));

describe('TxBuilderRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create()', () => {
    it('should create a buildooor transaction builder', () => {
      const builder = TxBuilderRegistry.create('buildooor');
      expect(builder).toBeDefined();
      expect(builder.name).toBe('buildooor');
    });

    it('should create a csl transaction builder', () => {
      const builder = TxBuilderRegistry.create('csl');
      expect(builder).toBeDefined();
      expect(builder.name).toBe('csl');
    });

    it('should throw ConfigError for unknown builder', () => {
      expect(() => TxBuilderRegistry.create('unknown')).toThrow(ConfigError);
      expect(() => TxBuilderRegistry.create('unknown')).toThrow('Unknown transaction builder: unknown');
    });

    it('should throw ConfigError for empty string', () => {
      expect(() => TxBuilderRegistry.create('')).toThrow(ConfigError);
      expect(() => TxBuilderRegistry.create('')).toThrow('Unknown transaction builder: ');
    });

    it('should create different instances on multiple calls', () => {
      const builder1 = TxBuilderRegistry.create('csl');
      const builder2 = TxBuilderRegistry.create('csl');
      expect(builder1).not.toBe(builder2);
    });
  });

  describe('createDefault()', () => {
    it('should create the first configured transaction builder', () => {
      const builder = TxBuilderRegistry.createDefault();
      expect(builder).toBeDefined();
      expect(builder.name).toBe('csl');
    });

    it('should log the default builder name', () => {
      TxBuilderRegistry.createDefault();
      expect(logger.info).toHaveBeenCalledWith(
        '[TxBuilderRegistry] Creating default transaction builder: csl'
      );
    });
  });

  describe('createDefault() with different configurations', () => {
    it('should use first configured builder from CONFIG', () => {
      const originalBuilders = CONFIG.transactionBuilders;
      (CONFIG as any).transactionBuilders = ['buildooor', 'csl'];

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('buildooor');
      // Restore original config
      (CONFIG as any).transactionBuilders = originalBuilders;
    });

    it('should handle single configured builder', () => {
      const originalBuilders = CONFIG.transactionBuilders;
      (CONFIG as any).transactionBuilders = ['csl'];

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('csl');

      // Restore original config
      (CONFIG as any).transactionBuilders = originalBuilders;
    });

    it('should throw error if configured builder is unavailable', () => {
      const originalBuilders = CONFIG.transactionBuilders;
      (CONFIG as any).transactionBuilders = ['invalid'];

      expect(() => TxBuilderRegistry.createDefault()).toThrow(ConfigError);
      expect(() => TxBuilderRegistry.createDefault()).toThrow('Unknown transaction builder: invalid');

      // Restore original config
      (CONFIG as any).transactionBuilders = originalBuilders;
    });
  });

  describe('getAvailableBuilders()', () => {
    it('should return all available builder names', () => {
      const builders = TxBuilderRegistry.getAvailableBuilders();
      expect(builders).toContain('buildooor');
      expect(builders).toContain('csl');
      expect(builders).toHaveLength(2);
    });

    it('should return a new array on each call', () => {
      const builders1 = TxBuilderRegistry.getAvailableBuilders();
      const builders2 = TxBuilderRegistry.getAvailableBuilders();
      expect(builders1).not.toBe(builders2);
      expect(builders1).toEqual(builders2);
    });
  });

  describe('isAvailable()', () => {
    it('should return true for buildooor', () => {
      expect(TxBuilderRegistry.isAvailable('buildooor')).toBe(true);
    });

    it('should return true for csl', () => {
      expect(TxBuilderRegistry.isAvailable('csl')).toBe(true);
    });

    it('should return false for unknown builder', () => {
      expect(TxBuilderRegistry.isAvailable('unknown')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(TxBuilderRegistry.isAvailable('')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(TxBuilderRegistry.isAvailable(null as any)).toBe(false);
      expect(TxBuilderRegistry.isAvailable(undefined as any)).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(TxBuilderRegistry.isAvailable('CSL')).toBe(false);
      expect(TxBuilderRegistry.isAvailable('BUILDOOOR')).toBe(false);
      expect(TxBuilderRegistry.isAvailable('Csl')).toBe(false);
    });
  });

  describe('Integration scenarios', () => {
    it('should create builder only if available', () => {
      const builderName = 'csl';
      if (TxBuilderRegistry.isAvailable(builderName)) {
        const builder = TxBuilderRegistry.create(builderName);
        expect(builder.name).toBe(builderName);
      }
    });

    it('should handle all available builders', () => {
      const availableBuilders = TxBuilderRegistry.getAvailableBuilders();
      const createdBuilders = availableBuilders.map(name => TxBuilderRegistry.create(name));
      
      expect(createdBuilders).toHaveLength(availableBuilders.length);
      createdBuilders.forEach((builder, index) => {
        expect(builder.name).toBe(availableBuilders[index]);
      });
    });
  });
});
