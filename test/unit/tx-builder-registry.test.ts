/**
 * Unit tests for TxBuilderRegistry
 */

import { TxBuilderRegistry } from '../../srv/blockchain/transaction-building/tx-builder-registry';
import { ConfigError } from '../../srv/utils/errors';

// Mock cds.log
jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Mock the CONFIG
jest.mock('../../config/config', () => ({
  CONFIG: {
    transactionBuilders: ['csl', 'buildooor'],
    backends: ['koios'], // Required for BackendRegistry
    network: 'preview',
    hrp: 'addr_test',
    VALIDITY_VARIANTS: { CURRENT: 300, LONG: 900 },
    blockfrostApiKey: '',
    blockfrostApiUrl: 'https://cardano-preview.blockfrost.io/api/v0',
    koiosApiUrl: 'https://preview.koios.rest/api/v1',
    koiosApiKey: '',
    ogmiosUrl: 'ws://localhost:1337',
    primaryTimeoutMs: 118000,
    fallbackTimeoutMs: 10000,
    indexTtlMs: 600000,
    logLevel: 'info',
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
      expect(builder.name).toBe('BuildooorTxBuilder');
    });

    it('should create a csl transaction builder', () => {
      const builder = TxBuilderRegistry.create('csl');
      expect(builder).toBeDefined();
      expect(builder.name).toBe('CslTxBuilder');
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
    const originalTxBuilders = process.env.TX_BUILDERS;

    afterEach(() => {
      // Restore original env
      if (originalTxBuilders !== undefined) {
        process.env.TX_BUILDERS = originalTxBuilders;
      } else {
        delete process.env.TX_BUILDERS;
      }
    });

    it('should create the first configured transaction builder', () => {
      process.env.TX_BUILDERS = 'csl';
      const builder = TxBuilderRegistry.createDefault();
      expect(builder).toBeDefined();
      expect(builder.name).toBe('CslTxBuilder');
    });

    it('should use first configured builder from TX_BUILDERS env', () => {
      process.env.TX_BUILDERS = 'buildooor,csl';

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('BuildooorTxBuilder');
    });

    it('should handle single configured builder', () => {
      process.env.TX_BUILDERS = 'csl';

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('CslTxBuilder');
    });

    it('should default to csl when TX_BUILDERS is not set', () => {
      delete process.env.TX_BUILDERS;

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('CslTxBuilder');
    });

    it('should filter out invalid builder names and use first valid one', () => {
      process.env.TX_BUILDERS = 'invalid,buildooor';

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('BuildooorTxBuilder');
    });

    it('should default to csl when all configured builders are invalid', () => {
      process.env.TX_BUILDERS = 'invalid,unknown';

      const builder = TxBuilderRegistry.createDefault();
      expect(builder.name).toBe('CslTxBuilder');
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
        expect(builder.name).toBe('CslTxBuilder');
      }
    });

    it('should handle all available builders', () => {
      const availableBuilders = TxBuilderRegistry.getAvailableBuilders();
      const createdBuilders = availableBuilders.map(name => TxBuilderRegistry.create(name));
      
      expect(createdBuilders).toHaveLength(availableBuilders.length);
      createdBuilders.forEach((builder) => {
        expect(builder.name).toMatch(/^(CslTxBuilder|BuildooorTxBuilder)$/);
      });
    });
  });
});
