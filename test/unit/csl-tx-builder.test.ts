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
import type { TxBuildRequest, TxBuildContext } from '../../srv/utils/types';

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

  describe('buildUnsignedMultiAssetTransaction validation', () => {
    const validCtx: TxBuildContext = {
      utxos: [],
      protocolParameters: {
        minFeeA: 44,
        minFeeB: 155381,
        maxTxSize: 16384,
        keyDeposit: '2000000',
        poolDeposit: '500000000',
        coinsPerUtxoByte: '4310',
        maxValSize: '5000',
        collateralPercentage: 150,
        maxCollateralInputs: 3,
        priceMem: 0.0577,
        priceStep: 0.0000721,
      } as any,
    };

    it('should throw error when assets is undefined', async () => {
      const req: TxBuildRequest = {
        network: 'preview',
        senderAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        recipientAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        lovelaceAmount: 1000000,
        // assets is undefined
      };

      await expect(builder.buildUnsignedMultiAssetTransaction(req, validCtx))
        .rejects.toThrow('[CSLTxBuilder] buildUnsignedMultiAssetTransaction requires assets to be specified');
    });

    it('should throw error when assets is empty array', async () => {
      const req: TxBuildRequest = {
        network: 'preview',
        senderAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        recipientAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        lovelaceAmount: 1000000,
        assets: [],
      };

      await expect(builder.buildUnsignedMultiAssetTransaction(req, validCtx))
        .rejects.toThrow('[CSLTxBuilder] buildUnsignedMultiAssetTransaction requires assets to be specified');
    });
  });

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
      const costs = Array(251).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({ 'plutus:v3': costs }));
      expect(result.len()).toBe(1);
    });

    it('should parse valid PlutusV3 cost model with PlutusV3 key', () => {
      const costs = Array(251).fill(0).map((_, i) => i);
      const result = createCostModels(JSON.stringify({ 'PlutusV3': costs }));
      expect(result.len()).toBe(1);
    });
  });
});