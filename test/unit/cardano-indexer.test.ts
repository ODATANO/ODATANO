import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import cardano from '../../srv/blockchain/cardano-client';
import type { Transaction as CAPTransaction } from '@sap/cds';
import type { Transaction, Address, UTxO, Network, LatestBlock, LatestEpoch } from '../../srv/utils/types';

// Mock CDS entities
jest.mock('#cds-models/CardanoODataService', () => {
  const createMockEntity = () => {
    const entity: any = {};
    entity.name = 'MockEntity';
    return entity;
  };

  return {
    Transactions: createMockEntity(),
    TransactionInputs: createMockEntity(),
    TransactionInputAssets: createMockEntity(),
    TransactionOutputs: createMockEntity(),
    TransactionOutputAssets: createMockEntity(),
    Addresses: createMockEntity(),
    AddressAssets: createMockEntity(),
    AddressUTxOs: createMockEntity(),
    NetworkInformation: createMockEntity(),
    LatestBlock: createMockEntity(),
    LatestEpoch: createMockEntity(),
    TransactionMetadata: createMockEntity(),
  };
});

// Mock cardano-client
jest.mock('../../srv/blockchain/cardano-client', () => ({
  __esModule: true,
  default: {
    getTransaction: jest.fn(),
    getAddress: jest.fn(),
    getAddressUtxos: jest.fn(),
    getNetworkInformation: jest.fn(),
    getLatestBlock: jest.fn(),
    getLatestEpoch: jest.fn(),
    getTransactionMetadata: jest.fn(),
    getMetadataLabelTransactions: jest.fn(),
  },
}));

// Mock logger
jest.mock('../../srv/utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CardanoIndexer', () => {
  let indexer: CardanoIndexer;
  let mockTx: jest.Mocked<CAPTransaction>;

  beforeEach(() => {
    jest.clearAllMocks();
    indexer = new CardanoIndexer();
    
    // Mock CAP transaction
    mockTx = {
      run: jest.fn().mockResolvedValue([]),
    } as any;
  });

  describe('indexTransaction', () => {
    const mockTransactionData: Transaction = {
      hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      blockHash: 'block123',
      blockHeight: 9876543,
      slot: 123456789,
      index: 0,
      fee: 170000,
      deposit: 0,
      size: 300,
      utxoCount: 2,
      withdrawalCount: 0,
      mirCertCount: 0,
      delegationCount: 0,
      stakeCertCount: 0,
      poolUpdateCount: 0,
      poolRetireCount: 0,
      assetMintOrBurnCount: 0,
      redeemerCount: 0,
      validContract: true,
      blockTime: 1701619200,
      inputs: [
        {
          address: 'addr_test1qz...',
          amount: [{ unit: 'lovelace', quantity: '1000000' }],
          txHash: 'input_tx_hash',
          outputIndex: 0,
        },
      ],
      outputs: [
        {
          address: 'addr_test1qx...',
          amount: [{ unit: 'lovelace', quantity: '800000' }],
          txHash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
          outputIndex: 0,
          dataHash: null,
          inlineDatum: null,
          isCollateral: false,
        },
      ],
    };

    test('indexes transaction with inputs and outputs', async () => {
      (cardano.getTransaction as jest.Mock).mockResolvedValue(mockTransactionData);
      (cardano.getAddress as jest.Mock).mockResolvedValue({
        address: 'addr_test1qz...',
        stakeAddress: null,
        type: 'shelley',
        isScript: false,
        amount: [{ unit: 'lovelace', quantity: '1000000' }],
      });
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue([]);

      const result = await indexer.indexTransaction(mockTx, mockTransactionData.hash);

      expect(cardano.getTransaction).toHaveBeenCalledWith(mockTransactionData.hash);
      expect(result.hash).toBe(mockTransactionData.hash);
      expect(result.fee).toBe(170000);
      expect(mockTx.run).toHaveBeenCalled();
    });

    test('throws error if transaction not found', async () => {
      (cardano.getTransaction as jest.Mock).mockResolvedValue(null);

      await expect(
        indexer.indexTransaction(mockTx, 'nonexistent_hash')
      ).rejects.toThrow('Transaction nonexistent_hash not found at provider');
    });

    test('indexes addresses from inputs and outputs', async () => {
      (cardano.getTransaction as jest.Mock).mockResolvedValue(mockTransactionData);
      (cardano.getAddress as jest.Mock).mockResolvedValue({
        address: 'addr_test1qz...',
        stakeAddress: null,
        type: 'shelley',
        isScript: false,
        amount: [],
      });
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue([]);

      await indexer.indexTransaction(mockTx, mockTransactionData.hash);

      // Should index both input and output addresses
      expect(cardano.getAddress).toHaveBeenCalledTimes(2);
    });

    test('handles transaction with no inputs or outputs', async () => {
      const emptyTx: Transaction = {
        ...mockTransactionData,
        inputs: [],
        outputs: [],
      };
      (cardano.getTransaction as jest.Mock).mockResolvedValue(emptyTx);

      const result = await indexer.indexTransaction(mockTx, emptyTx.hash);

      expect(result.hash).toBe(emptyTx.hash);
      expect(cardano.getAddress).not.toHaveBeenCalled();
    });
  });

  describe('indexAddress', () => {
    const mockAddressData: Address = {
      address: 'addr_test1qz...',
      stakeAddress: 'stake_test1...',
      type: 'shelley',
      isScript: false,
      amount: [
        { unit: 'lovelace', quantity: '5000000' },
        { unit: 'policyid.assetname', quantity: '100' },
      ],
    };

    const mockUtxos: UTxO[] = [
      {
        txHash: 'utxo_tx_hash',
        outputIndex: 0,
        address: 'addr_test1qz...',
        amount: [{ unit: 'lovelace', quantity: '5000000' }],
        blockHash: 'block_hash',
      },
    ];

    test('indexes address with assets and UTxOs', async () => {
      (cardano.getAddress as jest.Mock).mockResolvedValue(mockAddressData);
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue(mockUtxos);

      const result = await indexer.indexAddress(mockTx, 'addr_test1qz...');

      expect(cardano.getAddress).toHaveBeenCalledWith('addr_test1qz...');
      expect(cardano.getAddressUtxos).toHaveBeenCalledWith('addr_test1qz...');
      expect(result.address).toBe('addr_test1qz...');
      expect(mockTx.run).toHaveBeenCalled();
    });

    test('handles address with no assets', async () => {
      const noAssets: Address = { ...mockAddressData, amount: [] };
      (cardano.getAddress as jest.Mock).mockResolvedValue(noAssets);
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue([]);

      await indexer.indexAddress(mockTx, 'addr_test1qz...');

      expect(mockTx.run).toHaveBeenCalled();
    });

    test('handles address with no UTxOs', async () => {
      (cardano.getAddress as jest.Mock).mockResolvedValue(mockAddressData);
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue([]);

      await indexer.indexAddress(mockTx, 'addr_test1qz...');

      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexNetworkInformation', () => {
    const mockNetworkData: Network = {
      supply: {
        max: '45000000000000000',
        total: '35000000000000000',
        circulating: '34000000000000000',
        locked: '500000000000000',
        treasury: '300000000000000',
        reserves: '10000000000000000',
      },
      stake: {
        live: '23000000000000000',
        active: '22000000000000000',
      },
    };

    test('indexes network information', async () => {
      (cardano.getNetworkInformation as jest.Mock).mockResolvedValue(mockNetworkData);

      const result = await indexer.indexNetworkInformation(mockTx);

      expect(cardano.getNetworkInformation).toHaveBeenCalled();
      expect(result.maxSupply).toBe(45000000000000000);
      expect(result.totalSupply).toBe(35000000000000000);
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexLatestBlock', () => {
    const mockBlockData: LatestBlock = {
      hash: 'block123',
      time: 1701619200,
      height: 9876543,
      slot: 123456789,
      slotLeader: 'pool1abc',
      epoch: 450,
      epochSlot: 12345,
      size: 65432,
      txCount: 42,
      fees: '5000000',
    };

    const mockEpochData = {
      epoch: 450,
      validFrom: '2024-01-01T00:00:00.000Z',
      validTo: '2024-01-02T00:00:00.000Z',
    };

    test('indexes latest block with existing epoch', async () => {
      (cardano.getLatestBlock as jest.Mock).mockResolvedValue(mockBlockData);
      mockTx.run.mockResolvedValueOnce(mockEpochData); // SELECT.one.from(LatestEpoch)

      const result = await indexer.indexLatestBlock(mockTx);

      expect(cardano.getLatestBlock).toHaveBeenCalled();
      expect(result.hash).toBe('block123');
      expect(result.height).toBe(9876543);
    });

    test('indexes epoch if not found', async () => {
      const mockLatestEpoch: LatestEpoch = {
        epoch: 450,
        start_time: 1701561600,
        end_time: 1701993600,
        first_block_time: 1701561620,
        last_block_time: 1701993580,
        block_count: 21600,
        tx_count: 150000,
        output: '1000000000000',
        fees: '500000000',
        active_stake: '22000000000000000',
      };

      (cardano.getLatestBlock as jest.Mock).mockResolvedValue(mockBlockData);
      (cardano.getLatestEpoch as jest.Mock).mockResolvedValue(mockLatestEpoch);
      mockTx.run.mockResolvedValueOnce(null); // No existing epoch

      await indexer.indexLatestBlock(mockTx);

      expect(cardano.getLatestEpoch).toHaveBeenCalled();
    });

    test('throws error if epoch indexing fails when not found', async () => {
      (cardano.getLatestBlock as jest.Mock).mockResolvedValue(mockBlockData);
      (cardano.getLatestEpoch as jest.Mock).mockRejectedValue(new Error('Epoch fetch failed'));
      mockTx.run.mockResolvedValueOnce(null); // No existing epoch

      await expect(
        indexer.indexLatestBlock(mockTx)
      ).rejects.toThrow('LatestEpoch data not found for LatestBlock indexing');
    });
  });

  describe('indexLatestEpoch', () => {
    const mockEpochData: LatestEpoch = {
      epoch: 450,
      start_time: 1701561600,
      end_time: 1701993600,
      first_block_time: 1701561620,
      last_block_time: 1701993580,
      block_count: 21600,
      tx_count: 150000,
      output: '1000000000000',
      fees: '500000000',
      active_stake: '22000000000000000',
    };

    test('indexes latest epoch', async () => {
      (cardano.getLatestEpoch as jest.Mock).mockResolvedValue(mockEpochData);

      const result = await indexer.indexLatestEpoch(mockTx);

      expect(cardano.getLatestEpoch).toHaveBeenCalled();
      expect(result.epoch).toBe(450);
      expect(result.blockCount).toBe(21600);
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexTransactionMetadata', () => {
    test('indexes transaction metadata', async () => {
      const mockMetadata = [
        {
          txHash: 'abc123',
          label: '721',
          json: { name: 'NFT', image: 'ipfs://...' },
        },
      ];
      (cardano.getTransactionMetadata as jest.Mock).mockResolvedValue(mockMetadata);

      const result = await indexer.indexTransactionMetadata(mockTx, 'abc123');

      expect(cardano.getTransactionMetadata).toHaveBeenCalledWith('abc123');
      expect(result).toHaveLength(1);
      expect(mockTx.run).toHaveBeenCalled();
    });

    test('handles empty metadata', async () => {
      (cardano.getTransactionMetadata as jest.Mock).mockResolvedValue([]);

      const result = await indexer.indexTransactionMetadata(mockTx, 'abc123');

      expect(result).toHaveLength(0);
    });
  });

  describe('indexMetadataLabelTransactions', () => {
    test('indexes metadata by label (string)', async () => {
      const mockLabelTxs = [
        {
          txHash: 'abc123',
          label: '721',
          json: { name: 'NFT1' },
        },
        {
          txHash: 'def456',
          label: '721',
          json: { name: 'NFT2' },
        },
      ];
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue(mockLabelTxs);

      const result = await indexer.indexMetadataLabelTransactions(mockTx, '721');

      expect(cardano.getMetadataLabelTransactions).toHaveBeenCalledWith('721');
      expect(result.length).toBeGreaterThan(0);
    });

    test('indexes metadata by label (number)', async () => {
      const mockLabelTxs = [
        {
          txHash: 'abc123',
          label: '721',
          json: { name: 'NFT' },
        },
      ];
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue(mockLabelTxs);

      await indexer.indexMetadataLabelTransactions(mockTx, 721);

      expect(cardano.getMetadataLabelTransactions).toHaveBeenCalledWith(721);
    });

    test('returns empty array for no results', async () => {
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue([]);

      const result = await indexer.indexMetadataLabelTransactions(mockTx, '999');

      expect(result).toHaveLength(0);
    });
  });

  describe('Private helper methods', () => {
    test('_collectAddressesFromUtxos extracts unique addresses', () => {
      const txData: Transaction = {
        hash: 'abc',
        blockHash: 'block',
        blockHeight: 1,
        slot: 1,
        index: 0,
        fee: 1000,
        deposit: 0,
        size: 100,
        utxoCount: 3,
        withdrawalCount: 0,
        mirCertCount: 0,
        delegationCount: 0,
        stakeCertCount: 0,
        poolUpdateCount: 0,
        poolRetireCount: 0,
        assetMintOrBurnCount: 0,
        redeemerCount: 0,
        validContract: true,
        blockTime: 1000,
        inputs: [
          { address: 'addr1', amount: [], txHash: 'in1', outputIndex: 0 },
          { address: 'addr2', amount: [], txHash: 'in2', outputIndex: 0 },
        ],
        outputs: [
          { address: 'addr2', amount: [], txHash: 'abc', outputIndex: 0, dataHash: null, inlineDatum: null, isCollateral: false },
          { address: 'addr3', amount: [], txHash: 'abc', outputIndex: 1, dataHash: null, inlineDatum: null, isCollateral: false },
        ],
      };

      const addresses = (indexer as any)._collectAddressesFromUtxos(txData);

      expect(addresses).toHaveLength(3);
      expect(addresses).toContain('addr1');
      expect(addresses).toContain('addr2');
      expect(addresses).toContain('addr3');
    });

    test('_ensureAddresses indexes multiple addresses', async () => {
      (cardano.getAddress as jest.Mock).mockResolvedValue({
        address: 'test',
        stakeAddress: null,
        type: 'shelley',
        isScript: false,
        amount: [],
      });
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue([]);

      await (indexer as any)._ensureAddresses(mockTx, ['addr1', 'addr2', 'addr3']);

      expect(cardano.getAddress).toHaveBeenCalledTimes(3);
    });
  });
});
