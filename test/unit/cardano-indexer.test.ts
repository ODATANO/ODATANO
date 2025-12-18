import type { Transaction as CAPTransaction } from '@sap/cds';
import type { Transaction, Address, UTxO, Network, BlockData, EpochData } from '../../srv/utils/types';

// Mock CDS module before importing anything that uses it
const mockSELECT = {
  one: {
    from: jest.fn(() => ({
      entries: jest.fn().mockReturnThis(),
    })),
  },
  from: jest.fn(() => ({
    entries: jest.fn().mockReturnThis(),
  })),
};

const mockUPSERT = {
  into: jest.fn(() => ({
    entries: jest.fn().mockReturnThis(),
  })),
};

// Make SELECT available globally (CDS makes it global)
(global as any).SELECT = mockSELECT;

jest.mock('@sap/cds', () => ({
  ql: {
    UPSERT: mockUPSERT,
    SELECT: mockSELECT,
  },
  tx: jest.fn(),
}));

// Mock CDS entities
jest.mock('#cds-models/CardanoODataService', () => ({
  Transactions: {},
  TransactionInputs: {},
  TransactionInputAssets: {},
  TransactionOutputs: {},
  TransactionOutputAssets: {},
  Addresses: {},
  AddressAssets: {},
  AddressUTxOs: {},
  NetworkInformation: {},
  Block: {},
  Epoch: {},
  TransactionMetadata: {},
}));

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
    getAccount: jest.fn(),
    getDrep: jest.fn(),
    getPool: jest.fn(),
    getBlock: jest.fn(),
    getEpoch: jest.fn(),
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

// Now import after mocks are set up
import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import cardano from '../../srv/blockchain/cardano-client';

describe('CardanoIndexer', () => {
  let indexer: CardanoIndexer;
  let mockTx: jest.Mocked<CAPTransaction>;

  beforeEach(() => {
    jest.clearAllMocks();
    indexer = new CardanoIndexer();
    
    // Mock CAP transaction - return success for all UPSERT operations
    mockTx = {
      run: jest.fn().mockResolvedValue({ affectedRows: 1 }),
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
      // Should have multiple UPSERT calls for tx, inputs, outputs, and addresses
      expect(mockTx.run).toHaveBeenCalled();
      expect(mockTx.run.mock.calls.length).toBeGreaterThan(0);
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

    test('indexes transaction with metadata', async () => {
      const txWithMetadata: Transaction = {
        ...mockTransactionData,
        metadata: [
          {
            txHash: mockTransactionData.hash,
            label: '721',
            json: { name: 'NFT Name', image: 'ipfs://...' },
          },
        ],
      };
      (cardano.getTransaction as jest.Mock).mockResolvedValue(txWithMetadata);
      (cardano.getAddress as jest.Mock).mockResolvedValue({
        address: 'addr_test1qz...',
        stakeAddress: null,
        type: 'shelley',
        isScript: false,
        amount: [],
      });
      (cardano.getAddressUtxos as jest.Mock).mockResolvedValue([]);

      const result = await indexer.indexTransaction(mockTx, txWithMetadata.hash);

      expect(result.hash).toBe(txWithMetadata.hash);
      expect(mockTx.run).toHaveBeenCalled();
      // Verify metadata was processed (line 120-121)
      const runCalls = mockTx.run.mock.calls;
      expect(runCalls.length).toBeGreaterThan(0);
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
      utxos: [],
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
      // Should call run for Address, AddressAssets, and AddressUTxOs
      expect(mockTx.run).toHaveBeenCalled();
      expect(mockTx.run.mock.calls.length).toBeGreaterThanOrEqual(1);
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
      expect(mockTx.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('indexLatestBlock', () => {
    const mockBlockData: BlockData = {
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
      // First call returns existing epoch, second call is UPSERT
      mockTx.run
        .mockResolvedValueOnce(mockEpochData) // SELECT.one.from(Epoch)
        .mockResolvedValueOnce({ affectedRows: 1 }); // UPSERT block

      const result = await indexer.indexLatestBlock(mockTx);

      expect(cardano.getLatestBlock).toHaveBeenCalled();
      expect(result.hash).toBe('block123');
      expect(result.height).toBe(9876543);
    });

    test('indexes epoch if not found', async () => {
      const mockLatestEpoch: EpochData = {
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
      // First SELECT returns null (no epoch), subsequent calls are UPSERTs
      mockTx.run
        .mockResolvedValueOnce(null) // SELECT.one.from(Epoch) - not found
        .mockResolvedValueOnce({ affectedRows: 1 }) // UPSERT epoch
        .mockResolvedValueOnce({ affectedRows: 1 }); // UPSERT block

      await indexer.indexLatestBlock(mockTx);

      expect(cardano.getLatestEpoch).toHaveBeenCalled();
    });

    test('throws error if epoch indexing fails when not found', async () => {
      (cardano.getLatestBlock as jest.Mock).mockResolvedValue(mockBlockData);
      (cardano.getLatestEpoch as jest.Mock).mockRejectedValue(new Error('Epoch fetch failed'));
      // SELECT returns null, triggering epoch indexing which will fail
      mockTx.run.mockResolvedValueOnce(null);

      await expect(
        indexer.indexLatestBlock(mockTx)
      ).rejects.toThrow('LatestEpoch data not found for LatestBlock indexing');
    });
  });

  describe('indexLatestEpoch', () => {
    const mockEpochData: EpochData = {
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
      expect(mockTx.run).toHaveBeenCalledTimes(1);
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
      expect(mockTx.run).toHaveBeenCalledTimes(1);
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
      // Implementation has a bug that doubles the entries (mapper + manual loop)
      expect(result.length).toBe(2);
      expect(mockTx.run).toHaveBeenCalled();
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

      const result = await indexer.indexMetadataLabelTransactions(mockTx, 721);

      expect(cardano.getMetadataLabelTransactions).toHaveBeenCalledWith(721);
      
      expect(result.length).toBe(1);
      expect(mockTx.run).toHaveBeenCalled();
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
      // Each address triggers UPSERT for Address table (and possibly more for assets/utxos)
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexMetadataLabelTransactions', () => {
    test('returns empty array when no transactions found', async () => {
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue([]);

      const result = await indexer.indexMetadataLabelTransactions(mockTx, 721);

      expect(result).toEqual([]);
      expect(mockTx.run).not.toHaveBeenCalled();
    });

    test('returns empty array when labelTxs is not an array', async () => {
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue(null);

      const result = await indexer.indexMetadataLabelTransactions(mockTx, 721);

      expect(result).toEqual([]);
    });

    test('indexes transactions with valid metadata', async () => {
      const labelTxs = [
        { txHash: 'tx1', label: 721, json: { name: 'NFT1' } },
        { txHash: 'tx2', label: 721, json: { name: 'NFT2' } },
      ];
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue(labelTxs);

      const result = await indexer.indexMetadataLabelTransactions(mockTx, 721);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        tx_hash: 'tx1',
        label: '721',
        payload: JSON.stringify({ name: 'NFT1' }),
      });
      expect(mockTx.run).toHaveBeenCalled();
    });

    test('skips entries with invalid numeric labels', async () => {
      const labelTxs = [
        { txHash: 'tx1', label: 'invalid', json: { name: 'NFT1' } },
        { txHash: 'tx2', label: 721, json: { name: 'NFT2' } },
      ];
      (cardano.getMetadataLabelTransactions as jest.Mock).mockResolvedValue(labelTxs);

      const result = await indexer.indexMetadataLabelTransactions(mockTx, 721);

      expect(result).toHaveLength(1);
      expect(result[0].tx_hash).toBe('tx2');
    });
  });

  describe('indexBlock', () => {
    test('indexes block with existing epoch', async () => {
      const blockHash = 'block123';
      const blockData: BlockData = {
        time: 1000,
        height: 100,
        hash: blockHash,
        slot: 1000,
        epoch: 10,
        epochSlot: 100,
        slotLeader: 'leader',
        size: 1000,
        txCount: 5,
        fees: '5000',
      };
      const epochData = { epoch: 10, start_time: 1000 };
      
      (cardano.getBlock as jest.Mock).mockResolvedValue(blockData);
      mockTx.run.mockResolvedValueOnce(epochData);

      await indexer.indexBlock(mockTx, blockHash);

      expect(cardano.getBlock).toHaveBeenCalledWith(blockHash);
      expect(mockTx.run).toHaveBeenCalled();
    });

    test('fetches latest epoch when none exists', async () => {
      const blockHash = 'block123';
      const blockData: BlockData = {
        time: 1000,
        height: 100,
        hash: blockHash,
        slot: 1000,
        epoch: 10,
        epochSlot: 100,
        slotLeader: 'leader',
        size: 1000,
        txCount: 5,
        fees: '5000',
      };
      const epochData: EpochData = {
        epoch: 10,
        start_time: 1000,
        end_time: 2000,
        first_block_time: 1000,
        last_block_time: 2000,
        block_count: 100,
        tx_count: 500,
        output: '1000000',
        fees: '5000',
        active_stake: '50000000',
      };
      
      (cardano.getBlock as jest.Mock).mockResolvedValue(blockData);
      (cardano.getLatestEpoch as jest.Mock).mockResolvedValue(epochData);
      mockTx.run.mockResolvedValueOnce(null);

      await indexer.indexBlock(mockTx, blockHash);

      expect(cardano.getLatestEpoch).toHaveBeenCalled();
    });

    test('throws error when epoch fetch fails', async () => {
      const blockHash = 'block123';
      const blockData: BlockData = {
        time: 1000,
        height: 100,
        hash: blockHash,
        slot: 1000,
        epoch: 10,
        epochSlot: 100,
        slotLeader: 'leader',
        size: 1000,
        txCount: 5,
        fees: '5000',
      };
      
      (cardano.getBlock as jest.Mock).mockResolvedValue(blockData);
      (cardano.getLatestEpoch as jest.Mock).mockRejectedValue(new Error('Epoch fetch failed'));
      mockTx.run.mockResolvedValueOnce(null);

      await expect(indexer.indexBlock(mockTx, blockHash)).rejects.toThrow('LatestEpoch data not found');
    });
  });

  describe('indexEpoch', () => {
    test('indexes specific epoch number', async () => {
      const epochNumber = 100;
      const epochData: EpochData = {
        epoch: epochNumber,
        start_time: 1000,
        end_time: 2000,
        first_block_time: 1000,
        last_block_time: 2000,
        block_count: 100,
        tx_count: 500,
        output: '1000000',
        fees: '5000',
        active_stake: '50000000',
      };
      
      (cardano.getEpoch as jest.Mock).mockResolvedValue(epochData);

      await indexer.indexEpoch(mockTx, epochNumber);

      expect(cardano.getEpoch).toHaveBeenCalledWith(epochNumber);
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexAccount', () => {
    test('indexes account data', async () => {
      const accountId = 'stake1abc123';
      const accountData = {
        stakeaddress: accountId,
        active: true,
        activeEpoch: 100,
        controlledAmount: '1000000',
        rewardsSum: '50000',
        withdrawalsSum: '10000',
        reservesSum: '0',
        treasurySum: '0',
        withdrawableAmount: '40000',
      };
      
      (cardano.getAccount as jest.Mock).mockResolvedValue(accountData);

      await indexer.indexAccount(mockTx, accountId);

      expect(cardano.getAccount).toHaveBeenCalledWith(accountId);
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexDrep', () => {
    test('indexes drep data', async () => {
      const drepId = 'drep1abc123';
      const drepData = {
        drepId,
        hex: 'abc123',
        amount: '1000000',
        hasScript: false,
        lastActiveEpoch: 100,
        expired: false,
        retired: false,
      };
      
      (cardano.getDrep as jest.Mock).mockResolvedValue(drepData);

      await indexer.indexDrep(mockTx, drepId);

      expect(cardano.getDrep).toHaveBeenCalledWith(drepId);
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('indexPool', () => {
    test('indexes pool data', async () => {
      const poolId = 'pool1abc123';
      const poolData = {
        poolId,
        vrfKeyHash: 'vrf123',
        blocksMinted: 100,
        blocksEpoch: 10,
        liveStake: 1000000,
        liveSize: 0.5,
        liveDelegators: 50,
        liveSaturation: 0.3,
        activeStake: 900000,
        activeSize: 0.45,
        pledge: 100000,
        margin: 0.05,
        fixedCost: 340000000,
        rewardAccount: 'stake1reward',
      };
      
      (cardano.getPool as jest.Mock).mockResolvedValue(poolData);

      await indexer.indexPool(mockTx, poolId);

      expect(cardano.getPool).toHaveBeenCalledWith(poolId);
      expect(mockTx.run).toHaveBeenCalled();
    });
  });

  describe('_runWithRetry', () => {
    test('retries on SQLITE_BUSY error', async () => {
      let attempts = 0;
      const mockFn = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('database is locked');
          (err as any).code = 'SQLITE_BUSY';
          throw err;
        }
        return Promise.resolve('success');
      });

      const result = await (indexer as any)._runWithRetry(mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    test('throws error after max retries', async () => {
      const mockFn = jest.fn().mockImplementation(() => {
        const err = new Error('database is locked');
        (err as any).code = 'SQLITE_BUSY';
        throw err;
      });

      await expect((indexer as any)._runWithRetry(mockFn, 3)).rejects.toThrow('database is locked');
      expect(mockFn).toHaveBeenCalledTimes(4); // Initial attempt + 3 retries
    });

    test('throws non-retryable errors immediately', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('Other error'));

      await expect((indexer as any)._runWithRetry(mockFn)).rejects.toThrow('Other error');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });
});
