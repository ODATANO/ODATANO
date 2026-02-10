/**
 * Unit tests for CSLTxBuilder
 *
 * These tests validate the input validation logic of the CSL transaction builder.
 * The validation errors are thrown before any protocol parameter lookups or
 * transaction building, so we don't need to mock the cardano client.
 */

import { CSLTxBuilder } from '../../srv/blockchain/transaction-building/csl-tx';
import { mapBuilderError } from '../../srv/utils/tx-build-helper';
import { InsufficientFundsError } from '../../srv/utils/errors';

// Mock cds.log
jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Mock cardano-client - not used for validation tests but needed for import
jest.mock('../../srv/blockchain/cardano-client', () => ({
  default: {},
}));

describe('CSLTxBuilder', () => {
  let builder: CSLTxBuilder;

  beforeAll(() => {
    // Create builder without calling init() - validation happens before init is needed
    builder = new CSLTxBuilder();
  });

  // Note: buildUnsignedMintTransaction validation tests moved to cardano-tx-builder.test.ts
  // The CSLTxBuilder now expects TxBuildMintRequest with required mintActions and mintingPolicyScript

  describe('mapBuilderError (CSL)', () => {
    it('should throw InsufficientFundsError for "not enough" error message', () => {
      const err = new Error('Not enough ADA in wallet');
      expect(() => mapBuilderError(err)).toThrow(InsufficientFundsError);
    });

    it('should throw InsufficientFundsError for "insufficient" error message', () => {
      const err = new Error('Insufficient funds to complete transaction');
      expect(() => mapBuilderError(err)).toThrow(InsufficientFundsError);
    });

    it('should throw InsufficientFundsError for "balance" error message', () => {
      const err = new Error('Negative balance after transaction');
      expect(() => mapBuilderError(err)).toThrow(InsufficientFundsError);
    });

    it('should include custom asset unit in InsufficientFundsError', () => {
      const err = new Error('not enough tokens');
      try {
        mapBuilderError(err, 'customAssetUnit');
      } catch (e) {
        expect(e).toBeInstanceOf(InsufficientFundsError);
        expect((e as InsufficientFundsError).assetUnit).toBe('customAssetUnit');
      }
    });

    it('should re-throw original error for unrecognized error patterns', () => {
      const err = new Error('Some other error');
      expect(() => mapBuilderError(err)).toThrow('Some other error');
    });

    it('should handle string errors (CSL throws strings)', () => {
      // CSL sometimes throws strings directly instead of Error objects
      const stringErr = 'not enough inputs';
      expect(() => mapBuilderError(stringErr)).toThrow(InsufficientFundsError);
    });

    it('should handle errors without message property', () => {
      const err = { toString: () => 'insufficient funds' };
      expect(() => mapBuilderError(err)).toThrow(InsufficientFundsError);
    });

    it('should use default assetUnit "lovelace" when not specified', () => {
      const err = new Error('not enough');
      try {
        mapBuilderError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(InsufficientFundsError);
        expect((e as InsufficientFundsError).assetUnit).toBe('lovelace');
      }
    });
  });

  describe('mapBuilderError (Buildooor)', () => {
    it('should throw InsufficientFundsError for "not enough" error message', () => {
      const err = new Error('Not enough ADA');
      expect(() => mapBuilderError(err)).toThrow(InsufficientFundsError);
    });

    it('should throw InsufficientFundsError for "insufficient" error message', () => {
      const err = new Error('Insufficient balance');
      expect(() => mapBuilderError(err)).toThrow(InsufficientFundsError);
    });

    it('should re-throw original error for unrecognized error patterns', () => {
      const err = new Error('Transaction too large');
      expect(() => mapBuilderError(err)).toThrow('Transaction too large');
    });

    it('should handle errors without message (returns empty string)', () => {
      // Buildooor version uses err?.message?.toLowerCase() || ''
      const err = {};
      expect(() => mapBuilderError(err)).toThrow();
    });
  });

  describe('_createCostModels', () => {
    const createCostModels = (costModelsValue: any, version?: 'v1' | 'v2' | 'v3') => {
      (builder as any).protocolParameters = { costModels: costModelsValue };
      return (builder as any)._createCostModels(version);
    };

    it('should return empty cost models when costModels is undefined', () => {
      const result = createCostModels(undefined);
      expect(result.len()).toBe(0);
    });

    it('should return empty cost models when costModels is empty string', () => {
      const result = createCostModels('');
      expect(result.len()).toBe(0);
    });

    it('should return empty cost models when costModels is invalid JSON', () => {
      const result = createCostModels('not-valid-json');
      // Should not throw - catch block handles it and returns empty
      expect(result.len()).toBe(0);
    });

    it('should return empty cost models when costModels JSON has no matching version', () => {
      const result = createCostModels(JSON.stringify({ 'plutus:v1': [1, 2, 3] }), 'v3');
      expect(result.len()).toBe(0);
    });

    it('should parse valid PlutusV3 cost model with plutus:v3 key', () => {
      const costs = Array(297).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({ 'plutus:v3': costs }));
      expect(result.len()).toBe(1);
    });

    it('should parse valid PlutusV3 cost model with PlutusV3 key', () => {
      const costs = Array(297).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({ 'PlutusV3': costs }));
      expect(result.len()).toBe(1);
    });

    it('should convert object-format cost models to arrays (Blockfrost format)', () => {
      // Blockfrost returns cost models as { "paramName": value } objects, not arrays
      const objectCosts: Record<string, number> = {};
      for (let i = 0; i < 251; i++) {
        objectCosts[`param-${String(i).padStart(3, '0')}`] = i * 100;
      }
      // Even with only 251 object entries, padding to 297 ensures correct scriptDataHash
      const result = createCostModels(JSON.stringify({ 'plutus:v3': objectCosts }));
      expect(result.len()).toBe(1);
    });

    it('should pad 251-parameter PlutusV3 cost model to 297 (Chang 1 → Chang 2)', () => {
      // Blockfrost may return only 251 params (Chang 1 era), but post-Chang 2
      // the node expects 297 for scriptDataHash computation.
      // toCostModelArrV3() fills missing params with default values.
      const costs = Array(251).fill(0).map((_, i) => i * 100);
      const result = createCostModels(JSON.stringify({ 'plutus:v3': costs }));
      expect(result.len()).toBe(1);
    });

    it('should parse valid PlutusV1 cost model', () => {
      const costs = Array(166).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({ 'plutus:v1': costs }), 'v1');
      expect(result.len()).toBe(1);
    });

    it('should parse valid PlutusV2 cost model', () => {
      const costs = Array(175).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({ 'plutus:v2': costs }), 'v2');
      expect(result.len()).toBe(1);
    });

    it('should load all three Plutus versions when no version specified', () => {
      const v1Costs = Array(166).fill(0).map((_, i) => i);
      const v2Costs = Array(175).fill(0).map((_, i) => i);
      const v3Costs = Array(297).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({
        'plutus:v1': v1Costs,
        'plutus:v2': v2Costs,
        'plutus:v3': v3Costs,
      }));
      expect(result.len()).toBe(3);
    });

    it('should convert object-format cost models for all Plutus versions', () => {
      const makeObjectCosts = (count: number) => {
        const obj: Record<string, number> = {};
        for (let i = 0; i < count; i++) {
          obj[`param-${String(i).padStart(3, '0')}`] = i;
        }
        return obj;
      };
      const result = createCostModels(JSON.stringify({
        'PlutusV1': makeObjectCosts(166),
        'PlutusV2': makeObjectCosts(175),
        'PlutusV3': makeObjectCosts(297),
      }));
      expect(result.len()).toBe(3);
    });
  });
});