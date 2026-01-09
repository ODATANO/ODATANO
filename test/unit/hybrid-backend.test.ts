import { HybridBackend } from '../../srv/blockchain/backends/hybrid-backend';
import {
  LedgerProtocolParameters,
  EpochData,
  BlockData,
  Address,
  UTxO,
  Transaction,
  MetadataLabelTx
} from '../../srv/utils/types';

// Mock logger to avoid console output during tests
jest.mock('../../srv/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

describe('HybridBackend Unit Tests', () => {
  let hybridBackend: HybridBackend;
  let mockOgmiosBackend: any;
  let mockHistoricalBackend: any;

  beforeEach(() => {
    // Create simple mock objects instead of actual backend instances
    mockOgmiosBackend = {
      name: 'ogmios',
      init: jest.fn().mockResolvedValue(undefined),
      getProtocolParameters: jest.fn(),
      getLatestEpoch: jest.fn(),
      getLatestBlock: jest.fn(),
      getAddress: jest.fn(),
      getAddressUtxos: jest.fn(),
      submitTransaction: jest.fn(),
      getNetworkInformation: jest.fn(),
      getPool: jest.fn(),
      getAccount: jest.fn(),
      getTransaction: jest.fn(),
      getEpoch: jest.fn(),
      getBlock: jest.fn(),
      getTransactionMetadata: jest.fn(),
      getDrep: jest.fn()
    };

    mockHistoricalBackend = {
      name: 'blockfrost',
      init: jest.fn().mockResolvedValue(undefined),
      getProtocolParameters: jest.fn(),
      getLatestEpoch: jest.fn(),
      getLatestBlock: jest.fn(),
      getAddress: jest.fn(),
      getAddressUtxos: jest.fn(),
      submitTransaction: jest.fn(),
      getNetworkInformation: jest.fn(),
      getPool: jest.fn(),
      getAccount: jest.fn(),
      getTransaction: jest.fn(),
      getEpoch: jest.fn(),
      getBlock: jest.fn(),
      getTransactionMetadata: jest.fn(),
      getDrep: jest.fn()
    };

    // Create hybrid backend with mocked backends
    hybridBackend = new HybridBackend(mockOgmiosBackend, mockHistoricalBackend);
  });

  describe('Initialization', () => {
    it('should initialize both backends', async () => {
      await hybridBackend.init();

      expect(mockOgmiosBackend.init).toHaveBeenCalled();
      expect(mockHistoricalBackend.init).toHaveBeenCalled();
    });
  });

  describe('Live Data Queries (Ogmios Primary with Fallback)', () => {
    describe('getProtocolParameters', () => {
      const mockParams: Partial<LedgerProtocolParameters> = {
        network: 'preview',
        epoch: 100,
        minFeeA: 44,
        minFeeB: 155381,
        source: 'ogmios'
      };

      it('should use Ogmios backend when successful', async () => {
        mockOgmiosBackend.getProtocolParameters.mockResolvedValue(mockParams);

        const result = await hybridBackend.getProtocolParameters();

        expect(mockOgmiosBackend.getProtocolParameters).toHaveBeenCalled();
        expect(mockHistoricalBackend.getProtocolParameters).not.toHaveBeenCalled();
        expect(result).toEqual(mockParams);
      });

      it('should fallback to historical backend when Ogmios fails', async () => {
        const historicalParams = { ...mockParams, source: 'blockfrost' };
        mockOgmiosBackend.getProtocolParameters.mockRejectedValue(new Error('Ogmios error'));
        mockHistoricalBackend.getProtocolParameters.mockResolvedValue(historicalParams);

        const result = await hybridBackend.getProtocolParameters();

        expect(mockOgmiosBackend.getProtocolParameters).toHaveBeenCalled();
        expect(mockHistoricalBackend.getProtocolParameters).toHaveBeenCalled();
        expect(result).toEqual(historicalParams);
      });
    });

    describe('getLatestEpoch', () => {
      const mockEpoch: Partial<EpochData> = {
        epoch: 100,
        start_time: 1700000000,
        end_time: 1700432000,
        block_count: 21600,
        tx_count: 5000
      };

      it('should use Ogmios backend when successful', async () => {
        mockOgmiosBackend.getLatestEpoch = jest.fn().mockResolvedValue(mockEpoch);

        const result = await hybridBackend.getLatestEpoch();

        expect(mockOgmiosBackend.getLatestEpoch).toHaveBeenCalled();
        expect(mockHistoricalBackend.getLatestEpoch).not.toHaveBeenCalled();
        expect(result).toEqual(mockEpoch);
      });

      it('should fallback to historical backend when Ogmios fails', async () => {
        mockOgmiosBackend.getLatestEpoch.mockRejectedValue(new Error('Ogmios error'));
        mockHistoricalBackend.getLatestEpoch.mockResolvedValue(mockEpoch);

        const result = await hybridBackend.getLatestEpoch();

        expect(mockOgmiosBackend.getLatestEpoch).toHaveBeenCalled();
        expect(mockHistoricalBackend.getLatestEpoch).toHaveBeenCalled();
        expect(result).toEqual(mockEpoch);
      });
    });

    describe('getLatestBlock', () => {
      const mockBlock: Partial<BlockData> = {
        height: 1000000,
        hash: 'block_hash_123',
        slot: 50000000,
        epoch: 100,
        time: 1700000000
      };

      it('should use Ogmios backend when successful', async () => {
        mockOgmiosBackend.getLatestBlock.mockResolvedValue(mockBlock);

        const result = await hybridBackend.getLatestBlock();

        expect(mockOgmiosBackend.getLatestBlock).toHaveBeenCalled();
        expect(mockHistoricalBackend.getLatestBlock).not.toHaveBeenCalled();
        expect(result).toEqual(mockBlock);
      });

      it('should fallback to historical backend when Ogmios fails', async () => {
        mockOgmiosBackend.getLatestBlock.mockRejectedValue(new Error('Ogmios error'));
        mockHistoricalBackend.getLatestBlock.mockResolvedValue(mockBlock);

        const result = await hybridBackend.getLatestBlock();

        expect(mockOgmiosBackend.getLatestBlock).toHaveBeenCalled();
        expect(mockHistoricalBackend.getLatestBlock).toHaveBeenCalled();
        expect(result).toEqual(mockBlock);
      });
    });

    describe('getAddress', () => {
      const testAddress = 'addr_test1qq...';
      const mockAddressData: Partial<Address> = {
        address: testAddress
      };

      it('should use Ogmios backend when successful', async () => {
        mockOgmiosBackend.getAddress.mockResolvedValue(mockAddressData);

        const result = await hybridBackend.getAddress(testAddress);

        expect(mockOgmiosBackend.getAddress).toHaveBeenCalledWith(testAddress);
        expect(mockHistoricalBackend.getAddress).not.toHaveBeenCalled();
        expect(result).toEqual(mockAddressData);
      });

      it('should fallback to historical backend when Ogmios fails', async () => {
        mockOgmiosBackend.getAddress.mockRejectedValue(new Error('Ogmios error'));
        mockHistoricalBackend.getAddress.mockResolvedValue(mockAddressData);

        const result = await hybridBackend.getAddress(testAddress);

        expect(mockOgmiosBackend.getAddress).toHaveBeenCalledWith(testAddress);
        expect(mockHistoricalBackend.getAddress).toHaveBeenCalledWith(testAddress);
        expect(result).toEqual(mockAddressData);
      });
    });

    describe('getAddressUtxos', () => {
      const testAddress = 'addr_test1qq...';
      const mockUtxos: Partial<UTxO>[] = [
        {
          txHash: 'tx_hash_1',
          outputIndex: 0,
          address: testAddress,
          amount: [{ unit: 'lovelace', quantity: '1000000' }]
        },
        {
          txHash: 'tx_hash_2',
          outputIndex: 1,
          address: testAddress,
          amount: [{ unit: 'lovelace', quantity: '2000000' }]
        }
      ];

      it('should use Ogmios backend when successful', async () => {
        mockOgmiosBackend.getAddressUtxos.mockResolvedValue(mockUtxos);

        const result = await hybridBackend.getAddressUtxos(testAddress);

        expect(mockOgmiosBackend.getAddressUtxos).toHaveBeenCalledWith(testAddress);
        expect(mockHistoricalBackend.getAddressUtxos).not.toHaveBeenCalled();
        expect(result).toEqual(mockUtxos);
      });

      it('should fallback to historical backend when Ogmios fails', async () => {
        mockOgmiosBackend.getAddressUtxos.mockRejectedValue(new Error('Ogmios error'));
        mockHistoricalBackend.getAddressUtxos.mockResolvedValue(mockUtxos);

        const result = await hybridBackend.getAddressUtxos(testAddress);

        expect(mockOgmiosBackend.getAddressUtxos).toHaveBeenCalledWith(testAddress);
        expect(mockHistoricalBackend.getAddressUtxos).toHaveBeenCalledWith(testAddress);
        expect(result).toEqual(mockUtxos);
      });
    });

    describe('submitTransaction', () => {
      const signedTxCbor = '84a300818258200123456789abcdef...';
      const expectedTxHash = 'tx_hash_abc123';

      it('should use Ogmios backend when successful', async () => {
        mockOgmiosBackend.submitTransaction.mockResolvedValue(expectedTxHash);

        const result = await hybridBackend.submitTransaction(signedTxCbor);

        expect(mockOgmiosBackend.submitTransaction).toHaveBeenCalledWith(signedTxCbor);
        expect(mockHistoricalBackend.submitTransaction).not.toHaveBeenCalled();
        expect(result).toEqual(expectedTxHash);
      });

      it('should fallback to historical backend when Ogmios fails', async () => {
        mockOgmiosBackend.submitTransaction.mockRejectedValue(new Error('Ogmios error'));
        mockHistoricalBackend.submitTransaction.mockResolvedValue(expectedTxHash);

        const result = await hybridBackend.submitTransaction(signedTxCbor);

        expect(mockOgmiosBackend.submitTransaction).toHaveBeenCalledWith(signedTxCbor);
        expect(mockHistoricalBackend.submitTransaction).toHaveBeenCalledWith(signedTxCbor);
        expect(result).toEqual(expectedTxHash);
      });
    });
  });

  describe('Historical Data Queries (Historical Backend Primary)', () => {
    describe('getTransaction', () => {
      const txHash = 'tx_hash_123';
      const mockTx: Partial<Transaction> = {
        hash: txHash,
        slot: 50000000
      };

      it('should use historical backend directly', async () => {
        mockHistoricalBackend.getTransaction.mockResolvedValue(mockTx);

        const result = await hybridBackend.getTransaction(txHash);

        expect(mockHistoricalBackend.getTransaction).toHaveBeenCalledWith(txHash);
        expect(result).toEqual(mockTx);
      });

      it('should propagate errors from historical backend', async () => {
        mockHistoricalBackend.getTransaction.mockRejectedValue(new Error('Transaction not found'));

        await expect(hybridBackend.getTransaction(txHash)).rejects.toThrow('Transaction not found');
        expect(mockHistoricalBackend.getTransaction).toHaveBeenCalledWith(txHash);
      });
    });

    describe('getEpoch', () => {
      const epochNumber = 100;
      const mockEpoch: Partial<EpochData> = {
        epoch: epochNumber,
        start_time: 1700000000,
        end_time: 1700432000,
        block_count: 21600,
        tx_count: 5000
      };

      it('should use historical backend directly', async () => {
        mockHistoricalBackend.getEpoch.mockResolvedValue(mockEpoch);

        const result = await hybridBackend.getEpoch(epochNumber);

        expect(mockHistoricalBackend.getEpoch).toHaveBeenCalledWith(epochNumber);
        expect(result).toEqual(mockEpoch);
      });

      it('should propagate errors from historical backend', async () => {
        mockHistoricalBackend.getEpoch.mockRejectedValue(new Error('Epoch not found'));

        await expect(hybridBackend.getEpoch(epochNumber)).rejects.toThrow('Epoch not found');
        expect(mockHistoricalBackend.getEpoch).toHaveBeenCalledWith(epochNumber);
      });
    });

    describe('getBlock', () => {
      const blockHash = 'block_hash_123';
      const mockBlock: Partial<BlockData> = {
        hash: blockHash,
        height: 1000000,
        slot: 50000000,
        epoch: 100
      };

      it('should use historical backend directly', async () => {
        mockHistoricalBackend.getBlock.mockResolvedValue(mockBlock);

        const result = await hybridBackend.getBlock(blockHash);

        expect(mockHistoricalBackend.getBlock).toHaveBeenCalledWith(blockHash);
        expect(result).toEqual(mockBlock);
      });

      it('should propagate errors from historical backend', async () => {
        mockHistoricalBackend.getBlock.mockRejectedValue(new Error('Block not found'));

        await expect(hybridBackend.getBlock(blockHash)).rejects.toThrow('Block not found');
        expect(mockHistoricalBackend.getBlock).toHaveBeenCalledWith(blockHash);
      });
    });

    describe('getTransactionMetadata', () => {
      const txHash = 'tx_hash_123';
      const mockMetadata: Partial<MetadataLabelTx>[] = [
        {
          txHash,
          label: '721',
          json: { name: 'NFT' }
        }
      ];

      it('should use historical backend directly', async () => {
        mockHistoricalBackend.getTransactionMetadata.mockResolvedValue(mockMetadata);

        const result = await hybridBackend.getTransactionMetadata(txHash);

        expect(mockHistoricalBackend.getTransactionMetadata).toHaveBeenCalledWith(txHash);
        expect(result).toEqual(mockMetadata);
      });
    });
  });

  describe('Backend Name', () => {
    it('should have name "hybrid"', () => {
      expect(hybridBackend.name).toBe('hybrid');
    });
  });
});
