/**
 * Unit tests for mapper utilities
 */

import {
  mapTransactionInputAssets,
  mapTransactionOutputAssets,
  normalizeCostModels,
  scriptHashToEnterpriseAddress,
} from '../../srv/utils/mappers';

// Mock cds logger
jest.mock('@sap/cds', () => ({
  log: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('mappers', () => {

  // ==========================================================================
  // mapTransactionInputAssets — amount guard
  // ==========================================================================
  describe('mapTransactionInputAssets', () => {
    it('should return empty array when input.amount is undefined', () => {
      const result = mapTransactionInputAssets('abc123', [
        { txHash: 'def456', outputIndex: 0, address: 'addr_test1...', amount: undefined as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should return empty array when input.amount is null', () => {
      const result = mapTransactionInputAssets('abc123', [
        { txHash: 'def456', outputIndex: 0, address: 'addr_test1...', amount: null as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should map assets correctly when amount is valid array', () => {
      const result = mapTransactionInputAssets('abc123', [
        {
          txHash: 'def456',
          outputIndex: 0,
          address: 'addr_test1...',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        },
      ]);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].input_tx_hash).toBe('abc123');
    });
  });

  // ==========================================================================
  // mapTransactionOutputAssets — amount guard
  // ==========================================================================
  describe('mapTransactionOutputAssets', () => {
    it('should return empty array when output.amount is undefined', () => {
      const result = mapTransactionOutputAssets('abc123', [
        { address: 'addr_test1...', outputIndex: 0, txHash: 'def456', dataHash: null, inlineDatum: null, isCollateral: false, amount: undefined as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should return empty array when output.amount is null', () => {
      const result = mapTransactionOutputAssets('abc123', [
        { address: 'addr_test1...', outputIndex: 0, txHash: 'def456', dataHash: null, inlineDatum: null, isCollateral: false, amount: null as any },
      ]);
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // normalizeCostModels — object-format V3 handling
  // ==========================================================================
  describe('normalizeCostModels', () => {
    it('should pass through V1/V2 arrays unchanged', () => {
      const raw = { PlutusV1: [1, 2, 3, 4, 5] };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV1).toEqual([1, 2, 3, 4, 5]);
    });

    it('should convert V1/V2 object format to sorted array', () => {
      const raw = { PlutusV1: { 'b-param': 2, 'a-param': 1 } };
      const result = normalizeCostModels(raw);
      // Alphabetical sort: a-param=1, b-param=2
      expect(result.PlutusV1).toEqual([1, 2]);
    });

    it('should handle V3 array format with padding to 297', () => {
      // V3 arrays are padded to 297 by toCostModelArrV3
      const raw = { PlutusV3: new Array(251).fill(100) };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV3.length).toBe(297);
    });

    it('should handle V3 object format and convert to array', () => {
      // Create a minimal V3 object-format with a few known params
      const raw = { PlutusV3: { 'addInteger-cpu-arguments-intercept': 100, 'addInteger-cpu-arguments-slope': 200 } };
      const result = normalizeCostModels(raw);
      expect(Array.isArray(result.PlutusV3)).toBe(true);
      expect(result.PlutusV3.length).toBe(297);
    });

    it('should skip non-array non-object values', () => {
      const raw = { PlutusV1: 'invalid' as any };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV1).toBeUndefined();
    });
  });

  // ==========================================================================
  // scriptHashToEnterpriseAddress
  // ==========================================================================
  describe('scriptHashToEnterpriseAddress', () => {
    // Known script hash (28 bytes = 56 hex chars)
    const scriptHash = 'a'.repeat(56);

    it('should generate testnet address with addr_test prefix for preview', () => {
      const addr = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      expect(addr).toMatch(/^addr_test1/);
    });

    it('should generate testnet address with addr_test prefix for preprod', () => {
      const addr = scriptHashToEnterpriseAddress(scriptHash, 'preprod');
      expect(addr).toMatch(/^addr_test1/);
    });

    it('should generate mainnet address with addr prefix', () => {
      const addr = scriptHashToEnterpriseAddress(scriptHash, 'mainnet');
      expect(addr).toMatch(/^addr1/);
      expect(addr).not.toMatch(/^addr_test/);
    });

    it('should produce different addresses for different networks', () => {
      const testAddr = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      const mainAddr = scriptHashToEnterpriseAddress(scriptHash, 'mainnet');
      expect(testAddr).not.toBe(mainAddr);
    });

    it('should produce consistent results for same input', () => {
      const addr1 = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      const addr2 = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      expect(addr1).toBe(addr2);
    });
  });
});
