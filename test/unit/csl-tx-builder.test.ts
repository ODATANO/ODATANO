/**
 * Unit tests for CSLTxBuilder
 *
 * These tests validate the input validation logic of the CSL transaction builder.
 * The validation errors are thrown before any protocol parameter lookups or
 * transaction building, so we don't need to mock the cardano client.
 */

import { CSLTxBuilder } from '../../srv/blockchain/transaction-building/csl-tx';
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

  describe('buildUnsignedMintTransaction validation', () => {
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

    it('should throw error when mintActions is undefined', async () => {
      const req: TxBuildRequest = {
        network: 'preview',
        senderAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        recipientAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        lovelaceAmount: 1000000,
        mintingPolicyScript: '8200581c1234567890abcdef1234567890abcdef1234567890abcdef12345678',
        // mintActions is undefined
      };

      await expect(builder.buildUnsignedMintTransaction(req, validCtx))
        .rejects.toThrow('[CSLTxBuilder] buildUnsignedMintTransaction requires mintActions to be specified');
    });

    it('should throw error when mintActions is empty array', async () => {
      const req: TxBuildRequest = {
        network: 'preview',
        senderAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        recipientAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        lovelaceAmount: 1000000,
        mintingPolicyScript: '8200581c1234567890abcdef1234567890abcdef1234567890abcdef12345678',
        mintActions: [],
      };

      await expect(builder.buildUnsignedMintTransaction(req, validCtx))
        .rejects.toThrow('[CSLTxBuilder] buildUnsignedMintTransaction requires mintActions to be specified');
    });

    it('should throw error when mintingPolicyScript is undefined', async () => {
      const req: TxBuildRequest = {
        network: 'preview',
        senderAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        recipientAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        lovelaceAmount: 1000000,
        mintActions: [{ assetUnit: 'test', quantity: BigInt(100) }],
        // mintingPolicyScript is undefined
      };

      await expect(builder.buildUnsignedMintTransaction(req, validCtx))
        .rejects.toThrow('[CSLTxBuilder] buildUnsignedMintTransaction requires mintingPolicyScript to be specified');
    });
  });

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
});