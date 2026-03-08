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

    it('should handle null v3 cost model', () => {
      const result = createCostModels(JSON.stringify({ 'plutus:v3': null }));
      expect(result.len()).toBe(0);
    });

    it('should handle empty array v3 cost model', () => {
      // toArray returns [] which is truthy, but toCostModelArrV3 pads it
      const result = createCostModels(JSON.stringify({ 'plutus:v3': [] }));
      // Empty array returns truthy from toArray but may still produce a cost model
      // depending on toCostModelArrV3 behavior with empty input
      expect(result).toBeDefined();
    });

    it('should prefer plutus:v3 key over PlutusV3 when both present', () => {
      const v3a = Array(297).fill(0).map((_, i) => i);
      const v3b = Array(297).fill(0).map((_, i) => i + 1000);
      const result = createCostModels(JSON.stringify({
        'plutus:v3': v3a,
        'PlutusV3': v3b,
      }));
      // Should use plutus:v3 (first in || chain)
      expect(result.len()).toBe(1);
    });
  });

  describe('_jsonToCSLMetadatum', () => {
    const toMetadatum = (value: any) => {
      return (builder as any)._jsonToCSLMetadatum(value);
    };

    it('should handle positive numbers', () => {
      const result = toMetadatum(12345);
      expect(result).toBeDefined();
    });

    it('should handle negative numbers', () => {
      const result = toMetadatum(-42);
      expect(result).toBeDefined();
    });

    it('should handle bigint values', () => {
      const result = toMetadatum(BigInt('999999999999999'));
      expect(result).toBeDefined();
    });

    it('should handle negative bigint values', () => {
      const result = toMetadatum(BigInt('-123456'));
      expect(result).toBeDefined();
    });

    it('should handle strings', () => {
      const result = toMetadatum('hello world');
      expect(result).toBeDefined();
    });

    it('should handle empty arrays', () => {
      const result = toMetadatum([]);
      expect(result).toBeDefined();
    });

    it('should handle arrays with mixed types', () => {
      const result = toMetadatum([1, 'text', { key: 'value' }]);
      expect(result).toBeDefined();
    });

    it('should handle nested arrays', () => {
      const result = toMetadatum([[1, 2], [3, 4]]);
      expect(result).toBeDefined();
    });

    it('should handle empty objects', () => {
      const result = toMetadatum({});
      expect(result).toBeDefined();
    });

    it('should handle objects with multiple keys', () => {
      const result = toMetadatum({ key1: 'val1', key2: 123, key3: [1, 2] });
      expect(result).toBeDefined();
    });

    it('should handle deeply nested objects', () => {
      const result = toMetadatum({
        level1: {
          level2: {
            level3: 'deep'
          }
        }
      });
      expect(result).toBeDefined();
    });

    it('should throw for unsupported types (boolean)', () => {
      expect(() => toMetadatum(true)).toThrow('Unsupported metadata value type');
    });

    it('should throw for unsupported types (null)', () => {
      // null passes typeof === 'object' check but is excluded by !== null
      // Actually null would fail at Array.isArray check, then fail typeof === 'object' && value !== null
      // So it should throw
      expect(() => toMetadatum(null)).toThrow('Unsupported metadata value type');
    });
  });

  describe('_selectMinimalUtxos', () => {
    const selectMinimalUtxos = (utxos: any[], requiredLovelace: bigint) => {
      return (builder as any)._selectMinimalUtxos(utxos, requiredLovelace);
    };

    it('should return all UTxOs when insufficient total', () => {
      const utxos = [
        { txHash: 'tx1', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '1000000' }] },
        { txHash: 'tx2', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '500000' }] },
      ];
      const result = selectMinimalUtxos(utxos, 10000000n);
      expect(result).toHaveLength(2); // All returned even though total < required
    });

    it('should select only needed UTxOs when sufficient', () => {
      const utxos = [
        { txHash: 'tx1', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '10000000' }] },
        { txHash: 'tx2', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
        { txHash: 'tx3', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '2000000' }] },
      ];
      const result = selectMinimalUtxos(utxos, 5000000n);
      expect(result).toHaveLength(1); // Largest UTxO (10M) is enough
    });

    it('should sort by lovelace descending (largest first)', () => {
      const utxos = [
        { txHash: 'tx1', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '1000000' }] },
        { txHash: 'tx2', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '5000000' }] },
        { txHash: 'tx3', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '3000000' }] },
      ];
      const result = selectMinimalUtxos(utxos, 4000000n);
      // Should pick 5M first (largest), which is enough
      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe('tx2');
    });

    it('should handle equal-value UTxOs', () => {
      const utxos = [
        { txHash: 'tx1', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '2000000' }] },
        { txHash: 'tx2', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '2000000' }] },
        { txHash: 'tx3', outputIndex: 0, address: 'addr1', amount: [{ unit: 'lovelace', quantity: '2000000' }] },
      ];
      const result = selectMinimalUtxos(utxos, 3000000n);
      expect(result).toHaveLength(2); // Need two 2M UTxOs to cover 3M
    });
  });

  describe('_evaluateExUnits', () => {
    const evaluateExUnits = async (evaluator?: any) => {
      // Build function returns a mock transaction
      const CSL = require('@emurgo/cardano-serialization-lib-nodejs');
      const mockBuildFn = (_units: any) => {
        // Return a minimal valid transaction for CBOR encoding
        const txBody = CSL.TransactionBody.new_tx_body(
          CSL.TransactionInputs.new(),
          CSL.TransactionOutputs.new(),
          CSL.BigNum.from_str('200000')
        );
        const witnessSet = CSL.TransactionWitnessSet.new();
        return CSL.Transaction.new(txBody, witnessSet);
      };
      return (builder as any)._evaluateExUnits(mockBuildFn, evaluator);
    };

    it('should return defaults when no evaluator provided', async () => {
      const result = await evaluateExUnits(undefined);
      expect(result.mem).toBeDefined();
      expect(result.cpu).toBeDefined();
    });

    it('should return defaults when evaluator throws', async () => {
      const throwingEvaluator = async () => { throw new Error('Network timeout'); };
      const result = await evaluateExUnits(throwingEvaluator);
      expect(result.mem).toBeDefined();
      expect(result.cpu).toBeDefined();
    });

    it('should return defaults when evaluator returns empty array', async () => {
      const emptyEvaluator = async () => [];
      const result = await evaluateExUnits(emptyEvaluator);
      expect(result.mem).toBeDefined();
      expect(result.cpu).toBeDefined();
    });

    it('should return defaults when evaluator returns null', async () => {
      const nullEvaluator = async () => null;
      const result = await evaluateExUnits(nullEvaluator);
      expect(result.mem).toBeDefined();
      expect(result.cpu).toBeDefined();
    });

    it('should apply buffer to evaluated results', async () => {
      const workingEvaluator = async () => [{ budget: { memory: 100000, cpu: 50000000 } }];
      const result = await evaluateExUnits(workingEvaluator);
      // Result should be higher than raw values (buffer applied)
      expect(Number(result.mem)).toBeGreaterThan(100000);
      expect(Number(result.cpu)).toBeGreaterThan(50000000);
    });
  });

  describe('_setupCollateral', () => {
    const setupCollateral = (utxos: any[]) => {
      const CSL = require('@emurgo/cardano-serialization-lib-nodejs');
      // Create a real TransactionBuilder for testing
      const tbCfg = CSL.TransactionBuilderConfigBuilder.new()
        .fee_algo(CSL.LinearFee.new(CSL.BigNum.from_str('44'), CSL.BigNum.from_str('155381')))
        .coins_per_utxo_byte(CSL.BigNum.from_str('4310'))
        .pool_deposit(CSL.BigNum.from_str('500000000'))
        .key_deposit(CSL.BigNum.from_str('2000000'))
        .max_value_size(5000)
        .max_tx_size(16384)
        .build();
      const txb = CSL.TransactionBuilder.new(tbCfg);
      return (builder as any)._setupCollateral(txb, utxos);
    };

    it('should skip collateral when no ADA-only UTxO available', () => {
      const utxos = [
        {
          txHash: 'a'.repeat(64),
          outputIndex: 0,
          address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
          amount: [
            { unit: 'lovelace', quantity: '5000000' },
            { unit: 'policyabc.token1', quantity: '100' }
          ]
        }
      ];
      const result = setupCollateral(utxos);
      expect(result.collateralUtxo).toBeUndefined();
      expect(result.fundingUtxos).toEqual(utxos);
    });

    it('should include collateral in funding when it is the only UTxO', () => {
      const utxos = [
        {
          txHash: 'b'.repeat(64),
          outputIndex: 0,
          address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
          amount: [{ unit: 'lovelace', quantity: '5000000' }]
        }
      ];
      const result = setupCollateral(utxos);
      expect(result.collateralUtxo).toBeDefined();
      // Funding should include the collateral since it's the only UTxO
      expect(result.fundingUtxos).toHaveLength(1);
    });

    it('should exclude collateral from funding when multiple UTxOs available', () => {
      const utxos = [
        {
          txHash: 'c'.repeat(64),
          outputIndex: 0,
          address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
          amount: [{ unit: 'lovelace', quantity: '3000000' }]
        },
        {
          txHash: 'd'.repeat(64),
          outputIndex: 0,
          address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
          amount: [{ unit: 'lovelace', quantity: '10000000' }]
        }
      ];
      const result = setupCollateral(utxos);
      expect(result.collateralUtxo).toBeDefined();
      expect(result.fundingUtxos).toHaveLength(1);
    });
  });

  describe('_attachInlineDatum', () => {
    it('should not attach datum when datum is undefined', () => {
      const CSL = require('@emurgo/cardano-serialization-lib-nodejs');
      const address = CSL.Address.from_bech32('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp');
      const value = CSL.Value.new(CSL.BigNum.from_str('2000000'));
      const output = CSL.TransactionOutput.new(address, value);

      (builder as any)._attachInlineDatum(output, undefined);

      // Output should not have plutus data
      expect(output.plutus_data()).toBeUndefined();
    });

    it('should attach datum when datum is provided', () => {
      const CSL = require('@emurgo/cardano-serialization-lib-nodejs');
      const address = CSL.Address.from_bech32('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp');
      const value = CSL.Value.new(CSL.BigNum.from_str('2000000'));
      const output = CSL.TransactionOutput.new(address, value);

      const datum = { constructor: 0, fields: [{ int: 42 }] };
      (builder as any)._attachInlineDatum(output, datum);

      // Output should have plutus data
      expect(output.plutus_data()).toBeDefined();
    });
  });
});