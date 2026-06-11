import { CardanoTransactionBuilder } from '../../srv/blockchain/cardano-tx-builder';
import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import { CardanoTxBuilder } from '../../srv/blockchain/transaction-building/cardano-tx';
import type { CardanoClient } from '../../srv/blockchain/cardano-client';
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO } from '../../srv/utils/types';

// Mock the Buildooor builder (the coordinator constructs it directly via `new BuildooorTxBuilder()`)
jest.mock('../../srv/blockchain/transaction-building/buildooor-tx');

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
      // sender → mockUtxos; script address → the default getTransaction output is live
      // (the spent-check verifies fetched outputs against the live UTxO set)
      getAddressUtxos: jest.fn().mockImplementation(async (addr: string) =>
        addr === 'addr_test1script'
          ? [{ txHash: 'a'.repeat(64), outputIndex: 0, address: 'addr_test1script', amount: [{ unit: 'lovelace', quantity: '2000000' }] }]
          : mockUtxos
      ),
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

    // The coordinator does `new BuildooorTxBuilder()`; return our mock instance.
    (BuildooorTxBuilder as unknown as jest.Mock).mockClear();
    (BuildooorTxBuilder as unknown as jest.Mock).mockImplementation(() => mockTxBuilder);
  });

  // ============================================================================
  // init() Tests
  // ============================================================================
  describe('init()', () => {
    it('should initialize the builder from registry', async () => {
      await builder.init();

      expect((BuildooorTxBuilder as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
      expect(mockTxBuilder.initCalled).toBe(true);
    });

    it('should only initialize once when called multiple times', async () => {
      await builder.init();
      await builder.init();
      await builder.init();

      expect((BuildooorTxBuilder as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
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

      expect((BuildooorTxBuilder as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
      expect(result.unsignedTxCbor).toBe('mock-transfer-tx-cbor');
    });

    it('should not re-initialize if already initialized', async () => {
      await builder.init();
      await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect((BuildooorTxBuilder as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
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

      expect((BuildooorTxBuilder as unknown as jest.Mock)).toHaveBeenCalledTimes(2);
    });

    it('should allow setting a custom builder', async () => {
      const customBuilder = new MockTxBuilder();
      customBuilder.name = 'custom-builder';

      builder.setBuilder(customBuilder);

      // Should use the custom builder without calling registry
      const result = await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect((BuildooorTxBuilder as unknown as jest.Mock)).not.toHaveBeenCalled();
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
        { validator: { purpose: 'mint', index: 0 }, budget: { memory: 1000, cpu: 500 } }
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

    it('should carry dataHash and referenceScriptHash into the fabricated script UTxO (M5)', async () => {
      const scriptTxHash = 'f'.repeat(64);
      const datumHash = '923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec';
      const refScriptHash = 'c'.repeat(56);
      mockCardanoClient.getTransaction = jest.fn().mockResolvedValue({
        hash: scriptTxHash,
        outputs: [{
          address: 'addr_test1script',
          amount: [{ unit: 'lovelace', quantity: '2000000' }],
          outputIndex: 0,
          txHash: scriptTxHash,
          dataHash: datumHash,
          inlineDatum: null,
          referenceScriptHash: refScriptHash,
        }],
      });

      mockCardanoClient.getAddressUtxos = jest.fn().mockImplementation(async (addr: string) =>
        addr === 'addr_test1script'
          ? [{ txHash: scriptTxHash, outputIndex: 0, address: 'addr_test1script', amount: [{ unit: 'lovelace', quantity: '2000000' }] }]
          : mockUtxos
      );

      let captured: TxBuildContext | undefined;
      (mockTxBuilder.buildUnsignedPlutusSpendTransaction as any) = jest.fn().mockImplementation(
        async (_req: TxBuildRequest, ctx: TxBuildContext) => {
          captured = ctx;
          return {
            unsignedTxCbor: 'mock', txBodyHash: 'mock', feeLovelace: '0',
            inputs: [], outputs: [], warnings: [],
          };
        }
      );

      const plutusRequest: TxBuildRequest = {
        ...mockTxRequest,
        plutusScriptExecution: {
          validatorScript: 'abcdef',
          redeemer: { int: 0 },
          scriptUtxo: { txHash: scriptTxHash, outputIndex: 0 },
        },
      };
      await builder.buildPlutusSpendTransaction(plutusRequest, mockProtocolParameters);

      const fabricated = captured!.utxos.find(u => u.txHash === scriptTxHash);
      expect(fabricated).toBeDefined();
      // Both fields previously dropped — spending a datum-hash-locked UTxO then
      // failed with MissingRequiredDatums because the hash never reached the builder.
      expect(fabricated!.datumHash).toBe(datumHash);
      expect(fabricated!.scriptRef).toBe(refScriptHash);
    });

    it('should reject an already-spent script UTxO with a clear 400 (replay protection)', async () => {
      // default getTransaction returns a..a#0 at addr_test1script, but the live UTxO
      // set of that address is empty → the output has been consumed
      mockCardanoClient.getAddressUtxos = jest.fn().mockImplementation(async (addr: string) =>
        addr === 'addr_test1script' ? [] : mockUtxos
      );
      const plutusRequest: TxBuildRequest = {
        ...mockTxRequest,
        plutusScriptExecution: {
          validatorScript: 'abcdef',
          redeemer: { int: 0 },
          scriptUtxo: { txHash: 'a'.repeat(64), outputIndex: 0 },
        },
      };

      await expect(builder.buildPlutusSpendTransaction(plutusRequest, mockProtocolParameters))
        .rejects.toThrow(`scriptUtxo ${'a'.repeat(64)}#0 is already spent`);
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

  // ============================================================================
  // forceInputs — resolver + context merge
  // ============================================================================
  describe('forceInputs — resolver and context merge', () => {
    // Helper: capture the ctx that the mock builder receives
    function captureCtx<K extends 'buildUnsignedTransfer' | 'buildUnsignedTransactionWithMetadata' | 'buildUnsignedMintTransaction' | 'buildUnsignedPlutusSpendTransaction'>(method: K): () => TxBuildContext | undefined {
      let captured: TxBuildContext | undefined;
      (mockTxBuilder[method] as any) = jest.fn().mockImplementation(
        async (_req: TxBuildRequest, ctx: TxBuildContext) => {
          captured = ctx;
          return {
            unsignedTxCbor: 'mock', txBodyHash: 'mock', feeLovelace: '0',
            inputs: [], outputs: [], warnings: [],
          };
        }
      );
      return () => captured;
    }

    it('should use sender UTxO directly when forceInput ref matches (no getTransaction call)', async () => {
      const getCtx = captureCtx('buildUnsignedTransfer');
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [{ txHash: 'abc123', outputIndex: 0 }], // matches mockUtxos[0]
      };

      await builder.buildSimpleAdaTransaction(req, mockProtocolParameters);

      expect(mockCardanoClient.getTransaction).not.toHaveBeenCalled();
      const ctx = getCtx();
      expect(ctx).toBeDefined();
      expect(ctx!.utxos).toHaveLength(1); // single sender UTxO, no merge needed
      expect(ctx!.utxos[0].txHash).toBe('abc123');
    });

    it('should fetch via getTransaction when forceInput ref is not in sender UTxOs', async () => {
      const foreignTxHash = 'f'.repeat(64);
      mockCardanoClient.getTransaction = jest.fn().mockResolvedValue({
        hash: foreignTxHash,
        outputs: [
          { address: 'addr_test1foreign', amount: [{ unit: 'lovelace', quantity: '5000000' }], outputIndex: 0, txHash: foreignTxHash, dataHash: null, inlineDatum: null, isCollateral: false },
        ],
        inputs: [], blockHash: 'b'.repeat(64), blockHeight: 1, slot: 1, index: 0,
        fee: '0', deposit: '0', size: 0, blockTime: 0,
      });
      mockCardanoClient.getAddressUtxos = jest.fn().mockImplementation(async (addr: string) =>
        addr === 'addr_test1foreign'
          ? [{ txHash: foreignTxHash, outputIndex: 0, address: 'addr_test1foreign', amount: [{ unit: 'lovelace', quantity: '5000000' }] }]
          : mockUtxos
      );
      const getCtx = captureCtx('buildUnsignedTransfer');
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [{ txHash: foreignTxHash, outputIndex: 0 }],
      };

      await builder.buildSimpleAdaTransaction(req, mockProtocolParameters);

      expect(mockCardanoClient.getTransaction).toHaveBeenCalledWith(foreignTxHash);
      const ctx = getCtx();
      expect(ctx!.utxos).toHaveLength(2); // sender UTxO + forced foreign UTxO
      expect(ctx!.utxos.find(u => u.txHash === foreignTxHash)).toBeDefined();
    });

    it('should deduplicate identical forceInput refs (call getTransaction only once)', async () => {
      const foreignTxHash = 'd'.repeat(64);
      mockCardanoClient.getTransaction = jest.fn().mockResolvedValue({
        hash: foreignTxHash,
        outputs: [
          { address: 'addr_test1foreign', amount: [{ unit: 'lovelace', quantity: '5000000' }], outputIndex: 0, txHash: foreignTxHash, dataHash: null, inlineDatum: null, isCollateral: false },
        ],
        inputs: [], blockHash: 'b'.repeat(64), blockHeight: 1, slot: 1, index: 0,
        fee: '0', deposit: '0', size: 0, blockTime: 0,
      });
      mockCardanoClient.getAddressUtxos = jest.fn().mockImplementation(async (addr: string) =>
        addr === 'addr_test1foreign'
          ? [{ txHash: foreignTxHash, outputIndex: 0, address: 'addr_test1foreign', amount: [{ unit: 'lovelace', quantity: '5000000' }] }]
          : mockUtxos
      );
      const getCtx = captureCtx('buildUnsignedTransfer');
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [
          { txHash: foreignTxHash, outputIndex: 0 },
          { txHash: foreignTxHash, outputIndex: 0 }, // duplicate
        ],
      };

      await builder.buildSimpleAdaTransaction(req, mockProtocolParameters);

      expect(mockCardanoClient.getTransaction).toHaveBeenCalledTimes(1);
      const ctx = getCtx();
      const matches = ctx!.utxos.filter(u => u.txHash === foreignTxHash && u.outputIndex === 0);
      expect(matches).toHaveLength(1);
    });

    it('should reject a forceInput whose output exists but is already spent', async () => {
      const foreignTxHash = 'e'.repeat(64);
      mockCardanoClient.getTransaction = jest.fn().mockResolvedValue({
        hash: foreignTxHash,
        outputs: [
          { address: 'addr_test1foreign', amount: [{ unit: 'lovelace', quantity: '5000000' }], outputIndex: 0, txHash: foreignTxHash, dataHash: null, inlineDatum: null, isCollateral: false },
        ],
        inputs: [], blockHash: 'b'.repeat(64), blockHeight: 1, slot: 1, index: 0,
        fee: '0', deposit: '0', size: 0, blockTime: 0,
      });
      // live UTxO set of the foreign address does NOT contain the ref → spent
      mockCardanoClient.getAddressUtxos = jest.fn().mockImplementation(async (addr: string) =>
        addr === 'addr_test1foreign' ? [] : mockUtxos
      );
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [{ txHash: foreignTxHash, outputIndex: 0 }],
      };

      await expect(builder.buildSimpleAdaTransaction(req, mockProtocolParameters))
        .rejects.toThrow(`forceInput ${foreignTxHash}#0 is already spent`);
    });

    it('should tolerate a failing live-UTxO lookup during the spent-check (best-effort)', async () => {
      const foreignTxHash = 'e'.repeat(64);
      mockCardanoClient.getTransaction = jest.fn().mockResolvedValue({
        hash: foreignTxHash,
        outputs: [
          { address: 'addr_test1foreign', amount: [{ unit: 'lovelace', quantity: '5000000' }], outputIndex: 0, txHash: foreignTxHash, dataHash: null, inlineDatum: null, isCollateral: false },
        ],
        inputs: [], blockHash: 'b'.repeat(64), blockHeight: 1, slot: 1, index: 0,
        fee: '0', deposit: '0', size: 0, blockTime: 0,
      });
      mockCardanoClient.getAddressUtxos = jest.fn().mockImplementation(async (addr: string) => {
        if (addr === 'addr_test1foreign') throw new Error('backend hiccup');
        return mockUtxos;
      });
      const getCtx = captureCtx('buildUnsignedTransfer');
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [{ txHash: foreignTxHash, outputIndex: 0 }],
      };

      await builder.buildSimpleAdaTransaction(req, mockProtocolParameters);
      expect(getCtx()!.utxos.find(u => u.txHash === foreignTxHash)).toBeDefined();
    });

    it('should throw TransactionValidationError when forceInput UTxO is not found on-chain', async () => {
      const missingTxHash = '9'.repeat(64);
      mockCardanoClient.getTransaction = jest.fn().mockRejectedValue(new Error('Transaction not found'));
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [{ txHash: missingTxHash, outputIndex: 0 }],
      };

      await expect(builder.buildSimpleAdaTransaction(req, mockProtocolParameters))
        .rejects.toThrow(`forceInput ${missingTxHash}#0 not found on-chain`);
    });

    it('should throw TransactionValidationError when forceInput outputIndex does not exist in tx', async () => {
      const txHash = '7'.repeat(64);
      mockCardanoClient.getTransaction = jest.fn().mockResolvedValue({
        hash: txHash,
        outputs: [
          { address: 'addr', amount: [{ unit: 'lovelace', quantity: '1000000' }], outputIndex: 0, txHash, dataHash: null, inlineDatum: null, isCollateral: false },
        ],
        inputs: [], blockHash: 'b'.repeat(64), blockHeight: 1, slot: 1, index: 0,
        fee: '0', deposit: '0', size: 0, blockTime: 0,
      });
      const req: TxBuildRequest = {
        ...mockTxRequest,
        forceInputs: [{ txHash, outputIndex: 99 }], // index 99 doesn't exist
      };

      await expect(builder.buildSimpleAdaTransaction(req, mockProtocolParameters))
        .rejects.toThrow(`forceInput ${txHash}#99 not found on-chain`);
    });

    it('should be a no-op when forceInputs is undefined (ctx == sender UTxOs)', async () => {
      const getCtx = captureCtx('buildUnsignedTransfer');

      await builder.buildSimpleAdaTransaction(mockTxRequest, mockProtocolParameters);

      expect(mockCardanoClient.getTransaction).not.toHaveBeenCalled();
      const ctx = getCtx();
      expect(ctx!.utxos).toHaveLength(1);
      expect(ctx!.utxos[0].txHash).toBe('abc123');
    });

    it('should merge forced UTxO into ctx for metadata build', async () => {
      const getCtx = captureCtx('buildUnsignedTransactionWithMetadata');
      const req: TxBuildRequest = {
        ...mockTxRequest,
        metadataJson: { 674: { msg: ['test'] } },
        forceInputs: [{ txHash: 'abc123', outputIndex: 0 }],
      };

      await builder.buildTransactionWithMetadata(req, mockProtocolParameters);

      const ctx = getCtx();
      expect(ctx!.utxos.find(u => u.txHash === 'abc123')).toBeDefined();
    });

    it('should merge forced UTxO into ctx for mint build', async () => {
      const getCtx = captureCtx('buildUnsignedMintTransaction');
      const req: TxBuildRequest = {
        ...mockMintTxRequest,
        forceInputs: [{ txHash: 'abc123', outputIndex: 0 }],
      };

      await builder.buildMintTransaction(req, mockProtocolParameters);

      const ctx = getCtx();
      expect(ctx!.utxos.find(u => u.txHash === 'abc123')).toBeDefined();
    });

    it('should merge forced UTxO into ctx for plutus spend build (alongside script UTxO)', async () => {
      const scriptTxHash = 'a'.repeat(64);
      const getCtx = captureCtx('buildUnsignedPlutusSpendTransaction');
      const req: TxBuildRequest = {
        ...mockTxRequest,
        plutusScriptExecution: {
          validatorScript: 'abcdef',
          redeemer: { int: 0 },
          scriptUtxo: { txHash: scriptTxHash, outputIndex: 0 },
        },
        forceInputs: [{ txHash: 'abc123', outputIndex: 0 }],
      };

      await builder.buildPlutusSpendTransaction(req, mockProtocolParameters);

      const ctx = getCtx();
      // ctx contains sender UTxO (abc123) + script UTxO (via getTransaction)
      expect(ctx!.utxos.find(u => u.txHash === 'abc123')).toBeDefined();
      expect(ctx!.utxos.find(u => u.txHash === scriptTxHash)).toBeDefined();
    });
  });
});
