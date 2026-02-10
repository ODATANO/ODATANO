import { CardanoTransactionBuilder } from '../../srv/blockchain/cardano-tx-builder';
import { TxBuilderRegistry } from '../../srv/blockchain/transaction-building/tx-builder-registry';
import { CardanoTxBuilder } from '../../srv/blockchain/transaction-building/cardano-tx';
import type { CardanoClient } from '../../srv/blockchain/cardano-client';
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO } from '../../srv/utils/types';

// Mock the TxBuilderRegistry
jest.mock('../../srv/blockchain/transaction-building/tx-builder-registry');

// Mock CardanoTxBuilder for testing
class MockTxBuilder implements CardanoTxBuilder {
  name = 'mock-builder';
  initCalled = false;
  shouldFailInit = false;

  async init(): Promise<void> {
    this.initCalled = true;
    if (this.shouldFailInit) {
      throw new Error('Builder init failed');
    }
  }

  async buildUnsignedTransfer(_req: TxBuildRequest, _ctx: TxBuildContext): Promise<TxBuildResult> {
    return {
      unsignedTxCbor: 'mock-transfer-tx-cbor',
      txBodyHash: 'mock-transfer-tx-hash',
      feeLovelace: '200000',
      inputs: [],
      outputs: [],
      warnings: [],
    };
  }

  async buildUnsignedTransactionWithMetadata(_req: TxBuildRequest, _ctx: TxBuildContext): Promise<TxBuildResult> {
    return {
      unsignedTxCbor: 'mock-metadata-tx-cbor',
      txBodyHash: 'mock-metadata-tx-hash',
      feeLovelace: '250000',
      inputs: [],
      outputs: [],
      warnings: [],
    };
  }

  async buildUnsignedMintTransaction(_req: TxBuildRequest, _ctx: TxBuildContext): Promise<TxBuildResult> {
    return {
      unsignedTxCbor: 'mock-mint-tx-cbor',
      txBodyHash: 'mock-mint-tx-hash',
      feeLovelace: '350000',
      inputs: [],
      outputs: [],
      warnings: [],
    };
  }

  async buildUnsignedPlutusSpendTransaction(_req: TxBuildRequest, _ctx: TxBuildContext): Promise<TxBuildResult> {
    return {
      unsignedTxCbor: 'mock-plutus-spend-tx-cbor',
      txBodyHash: 'mock-plutus-spend-tx-hash',
      feeLovelace: '400000',
      inputs: [],
      outputs: [],
      warnings: [],
    };
  }
}

// Test fixtures
const mockUtxos: UTxO[] = [
  {
    txHash: 'abc123',
    outputIndex: 0,
    amount: [{ unit: 'lovelace', quantity: '10000000' }],
    address: 'addr_test1xyz',
  },
];

const mockProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155381,
  maxTxSize: 16384,
  coinsPerUtxoByte: '4310',
} as any;

const mockTxRequest: TxBuildRequest = {
  network: 'preview',
  senderAddress: 'addr_test1sender',
  recipientAddress: 'addr_test1recipient',
  lovelaceAmount: 5000000,
};

const mockMintTxRequest: TxBuildRequest = {
  ...mockTxRequest,
  mintActions: [{ assetUnit: '1234567890abcdef1234567890abcdef1234567890abcdef12345678TestToken', quantity: BigInt(100) }],
  mintingPolicyScript: '8200581c1234567890abcdef1234567890abcdef1234567890abcdef12345678',
};

describe('CardanoTransactionBuilder', () => {
  let builder: CardanoTransactionBuilder;
  let mockTxBuilder: MockTxBuilder;
  let mockCardanoClient: jest.Mocked<CardanoClient>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock CardanoClient
    mockCardanoClient = {
      getAddressUtxos: jest.fn().mockResolvedValue(mockUtxos),
      hasOgmiosBackend: jest.fn().mockReturnValue(false),
      evaluateTransaction: jest.fn(),
      getTransaction: jest.fn().mockResolvedValue({
        hash: 'a'.repeat(64),
        outputs: [
          {
            address: 'addr_test1script',
            amount: [{ unit: 'lovelace', quantity: '2000000' }],
            outputIndex: 0,
            txHash: 'a'.repeat(64),
            dataHash: null,
            inlineDatum: null,
            isCollateral: false,
          },
        ],
        inputs: [],
        blockHash: 'b'.repeat(64),
        blockHeight: 1,
        slot: 1,
        index: 0,
        fee: '200000',
        deposit: '0',
        size: 300,
        blockTime: 1700000000,
      }),
    } as unknown as jest.Mocked<CardanoClient>;

    // Create fresh instances - pass mock client to constructor
    builder = new CardanoTransactionBuilder(mockCardanoClient);
    mockTxBuilder = new MockTxBuilder();

    // Setup TxBuilderRegistry mock
    (TxBuilderRegistry.createDefault as jest.Mock).mockReturnValue(mockTxBuilder);
    (TxBuilderRegistry.create as jest.Mock).mockReturnValue(mockTxBuilder);
  });

  // ============================================================================
  // init() Tests
  // ============================================================================
  describe('init()', () => {
    it('should initialize the builder from registry', async () => {
      await builder.init();

      expect(TxBuilderRegistry.createDefault).toHaveBeenCalledTimes(1);
      expect(mockTxBuilder.initCalled).toBe(true);
    });

    it('should only initialize once when called multiple times', async () => {
      await builder.init();
      await builder.init();
      await builder.init();

      expect(TxBuilderRegistry.createDefault).toHaveBeenCalledTimes(1);
    });

    it('should propagate errors from builder init', async () => {
      mockTxBuilder.shouldFailInit = true;

      await expect(builder.init()).rejects.toThrow('Builder init failed');
    });
  });

  // ============================================================================
  // ensureInitialized() Tests (via public methods)
  // ============================================================================
  describe('ensureInitialized() - lazy initialization', () => {
    it('should auto-initialize when building transaction without explicit init', async () => {
      // Don't call init() explicitly
      const result = await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(TxBuilderRegistry.createDefault).toHaveBeenCalledTimes(1);
      expect(result.unsignedTxCbor).toBe('mock-transfer-tx-cbor');
    });

    it('should not re-initialize if already initialized', async () => {
      await builder.init();
      await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(TxBuilderRegistry.createDefault).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // reset() and setBuilder() Tests
  // ============================================================================
  describe('reset() and setBuilder()', () => {
    it('should reset the builder state', async () => {
      await builder.init();
      builder.reset();

      // After reset, next operation should re-initialize
      await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(TxBuilderRegistry.createDefault).toHaveBeenCalledTimes(2);
    });

    it('should allow setting a custom builder', async () => {
      const customBuilder = new MockTxBuilder();
      customBuilder.name = 'custom-builder';

      builder.setBuilder(customBuilder);

      // Should use the custom builder without calling registry
      const result = await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(TxBuilderRegistry.createDefault).not.toHaveBeenCalled();
      expect(result.unsignedTxCbor).toBe('mock-transfer-tx-cbor');
    });
  });

  // ============================================================================
  // buildSimpleAdaTransaction() Tests
  // ============================================================================
  describe('buildSimpleAdaTransaction()', () => {
    it('should build a simple ADA transaction', async () => {
      const result = await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(result.unsignedTxCbor).toBe('mock-transfer-tx-cbor');
      expect(result.txBodyHash).toBe('mock-transfer-tx-hash');
      expect(result.feeLovelace).toBe('200000');
      expect(mockCardanoClient.getAddressUtxos).toHaveBeenCalledWith(mockTxRequest.senderAddress);
    });

    it('should fetch UTxOs for sender address', async () => {
      await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(mockCardanoClient.getAddressUtxos).toHaveBeenCalledWith('addr_test1sender');
    });
  });

  // ============================================================================
  // buildTransactionWithMetadata() Tests
  // ============================================================================
  describe('buildTransactionWithMetadata()', () => {
    it('should build a transaction with metadata', async () => {
      const result = await builder.buildTransactionWithMetadata(mockTxRequest, mockProtocolParameters);

      expect(result.unsignedTxCbor).toBe('mock-metadata-tx-cbor');
      expect(result.txBodyHash).toBe('mock-metadata-tx-hash');
      expect(result.feeLovelace).toBe('250000');
    });
  });

  // ============================================================================
  // buildMultiAssetTransaction() Tests
  // ============================================================================
  describe('buildMultiAssetTransaction()', () => {
    it('should build a multi-asset transaction', async () => {
      const reqWithAssets: TxBuildRequest = {
        ...mockTxRequest,
        assets: [{ unit: '1234567890abcdef1234567890abcdef1234567890abcdef12345678TestToken', quantity: '100' }],
      };
      const result = await builder.buildMultiAssetTransaction(reqWithAssets, mockProtocolParameters);

      expect(result.unsignedTxCbor).toBe('mock-transfer-tx-cbor');
      expect(result.txBodyHash).toBe('mock-transfer-tx-hash');
      expect(result.feeLovelace).toBe('200000');
    });

    it('should throw error when assets is missing', async () => {
      await expect(builder.buildMultiAssetTransaction(mockTxRequest, mockProtocolParameters))
        .rejects.toThrow('[CardanoTransactionBuilder] buildMultiAssetTransaction requires assets to be specified');
    });

    it('should throw error when assets is empty array', async () => {
      const reqEmptyAssets: TxBuildRequest = { ...mockTxRequest, assets: [] };
      await expect(builder.buildMultiAssetTransaction(reqEmptyAssets, mockProtocolParameters))
        .rejects.toThrow('[CardanoTransactionBuilder] buildMultiAssetTransaction requires assets to be specified');
    });
  });

  // ============================================================================
  // buildMintTransaction() Tests
  // ============================================================================
  describe('buildMintTransaction()', () => {
    it('should build a mint transaction without Ogmios', async () => {
      mockCardanoClient.hasOgmiosBackend.mockReturnValue(false);

      const result = await builder.buildMintTransaction(mockMintTxRequest, mockProtocolParameters);

      expect(result.unsignedTxCbor).toBe('mock-mint-tx-cbor');
      expect(result.txBodyHash).toBe('mock-mint-tx-hash');
      expect(result.feeLovelace).toBe('350000');
    });

    it('should pass evaluator when Ogmios is available', async () => {
      mockCardanoClient.hasOgmiosBackend.mockReturnValue(true);
      mockCardanoClient.evaluateTransaction.mockResolvedValue([
        { validator: { index: 0 }, budget: { memory: 1000, cpu: 500 } }
      ]);

      // Create a spy to capture the context passed to buildUnsignedMintTransaction
      let capturedContext: TxBuildContext | undefined;
      mockTxBuilder.buildUnsignedMintTransaction = jest.fn().mockImplementation(
        async (_req: TxBuildRequest, ctx: TxBuildContext) => {
          capturedContext = ctx;
          return {
            unsignedTxCbor: 'mock-mint-tx-cbor',
            txBodyHash: 'mock-mint-tx-hash',
            feeLovelace: '350000',
            inputs: [],
            outputs: [],
            warnings: [],
          };
        }
      );

      await builder.buildMintTransaction(mockMintTxRequest, mockProtocolParameters);

      expect(capturedContext).toBeDefined();
      expect(capturedContext!.evaluateTransaction).toBeDefined();
      expect(typeof capturedContext!.evaluateTransaction).toBe('function');
    });

    it('should not pass evaluator when Ogmios is not available', async () => {
      mockCardanoClient.hasOgmiosBackend.mockReturnValue(false);

      let capturedContext: TxBuildContext | undefined;
      mockTxBuilder.buildUnsignedMintTransaction = jest.fn().mockImplementation(
        async (_req: TxBuildRequest, ctx: TxBuildContext) => {
          capturedContext = ctx;
          return {
            unsignedTxCbor: 'mock-mint-tx-cbor',
            txBodyHash: 'mock-mint-tx-hash',
            feeLovelace: '350000',
            inputs: [],
            outputs: [],
            warnings: [],
          };
        }
      );

      await builder.buildMintTransaction(mockMintTxRequest, mockProtocolParameters);

      expect(capturedContext).toBeDefined();
      expect(capturedContext!.evaluateTransaction).toBeUndefined();
    });

    it('should throw error when mintActions is missing', async () => {
      await expect(builder.buildMintTransaction(mockTxRequest, mockProtocolParameters))
        .rejects.toThrow('[CardanoTransactionBuilder] buildMintTransaction requires mintActions to be specified');
    });

    it('should throw error when mintingPolicyScript is missing', async () => {
      const reqWithoutScript: TxBuildRequest = {
        ...mockTxRequest,
        mintActions: [{ assetUnit: 'test', quantity: BigInt(100) }],
      };
      await expect(builder.buildMintTransaction(reqWithoutScript, mockProtocolParameters))
        .rejects.toThrow('[CardanoTransactionBuilder] buildMintTransaction requires mintingPolicyScript to be specified');
    });
  });

  // ============================================================================
  // buildPlutusSpendTransaction() Tests
  // ============================================================================
  describe('buildPlutusSpendTransaction()', () => {
    it('should throw error when plutusScriptExecution is missing', async () => {
      await expect(builder.buildPlutusSpendTransaction(mockTxRequest, mockProtocolParameters))
        .rejects.toThrow('[CardanoTransactionBuilder] buildPlutusSpendTransaction requires plutusScriptExecution to be specified');
    });

    it('should build plutus spend transaction when plutusScriptExecution is provided', async () => {
      const plutusRequest: TxBuildRequest = {
        ...mockTxRequest,
        plutusScriptExecution: {
          validatorScript: 'abcdef',
          redeemer: { int: 0 },
          scriptUtxo: {
            txHash: 'a'.repeat(64),
            outputIndex: 0,
          },
        },
      };
      const result = await builder.buildPlutusSpendTransaction(plutusRequest, mockProtocolParameters);
      expect(result.unsignedTxCbor).toBe('mock-plutus-spend-tx-cbor');
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================
  describe('Error Handling', () => {
    it('should propagate UTxO fetch errors', async () => {
      mockCardanoClient.getAddressUtxos.mockRejectedValue(new Error('Network error'));

      await expect(builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters))
        .rejects.toThrow('Network error');
    });

    it('should propagate builder errors', async () => {
      mockTxBuilder.buildUnsignedTransfer = jest.fn().mockRejectedValue(
        new Error('Insufficient funds')
      );

      await expect(builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters))
        .rejects.toThrow('Insufficient funds');
    });
  });
});
