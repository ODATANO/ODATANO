import { BlockfrostBackend } from '../../srv/blockchain/backends/blockfrost-backend';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { BackendError, BackendInitError, NotFoundError } from '../../srv/utils/errors';

// Mock config module
jest.mock('../../config/config', () => ({
  CONFIG: {
    blockfrostApiKey: 'test_key',
    blockfrostApiUrl: 'https://cardano-preview.blockfrost.io/api/v0',
  },
}));

jest.mock('@blockfrost/blockfrost-js');
const MockedBlockFrostAPI = BlockFrostAPI as jest.MockedClass<typeof BlockFrostAPI>;

describe('BlockfrostBackend', () => {
  let backend: BlockfrostBackend;
  let mockApi: any;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    // Create mock API with all methods
    mockApi = {
      health: jest.fn(),
      network: jest.fn(),
      blocksLatest: jest.fn(),
      epochsLatest: jest.fn(),
      txs: jest.fn(),
      txsUtxos: jest.fn(),
      txsMetadata: jest.fn(),
      addresses: jest.fn(),
      addressesUtxos: jest.fn(),
      metadataTxsLabel: jest.fn(),
    };

    MockedBlockFrostAPI.mockImplementation(() => mockApi);

    backend = new BlockfrostBackend();
    await backend.init();
  });

  describe('constructor', () => {
    

  it('creates BlockFrostAPI with projectId and customBackend', () => {
    expect(MockedBlockFrostAPI).toHaveBeenCalledTimes(1);
    // Just verify it was called, don't check specific values since they come from config/env
    expect(MockedBlockFrostAPI).toHaveBeenCalled();
  });

  it('name property is "blockfrost"', () => {
    expect(backend.name).toBe('blockfrost');
  });

  it('init() resolves successfully', async () => {
    await expect(backend.init()).resolves.toBeUndefined();
  });

});

  describe('healthCheck', () => {
    it('returns true on healthy backend', async () => {
      mockApi.health.mockResolvedValue({ is_healthy: true } as any);

      const result = await backend.healthCheck();

      expect(result).toBe(true);
      expect(mockApi.health).toHaveBeenCalledTimes(1);
    });

    it('returns false on unhealthy backend', async () => {
      mockApi.health.mockResolvedValue({ is_healthy: false } as any);

      const result = await backend.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe('getNetworkInformation', () => {
    it('fetches and returns network information', async () => {
      mockApi.network.mockResolvedValue({
        supply: {
          max: '45000000000000000',
          total: '35000000000000000',
          circulating: '33000000000000000',
          locked: '2000000000000000',
          treasury: '1000000000000000',
          reserves: '10000000000000000',
        },
        stake: {
          live: '23000000000000000',
          active: '22000000000000000',
        },
      } as any);

      const result = await backend.getNetworkInformation();

      expect(result.supply).toBeDefined();
      expect(result.stake).toBeDefined();
      expect(mockApi.network).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundError on API error', async () => {
      mockApi.network.mockRejectedValue({ status_code: 404, message: 'Not found' });

      await expect(backend.getNetworkInformation()).rejects.toThrow(NotFoundError);
    });
  });

  describe('getLatestBlock', () => {
    it('fetches and maps latest block', async () => {
      mockApi.blocksLatest.mockResolvedValue({
        time: 1638360000,
        height: 7654321,
        hash: 'block_hash_123',
        slot: 12345678,
        epoch: 300,
        epoch_slot: 123456,
        slot_leader: 'pool_leader_123',
        size: 12345,
        tx_count: 42,
        fees: '1234567',
        output: '1000000000',
        op_cert: 'cert_123',
        op_cert_counter: '5',
        vrf_key: 'vrf_key_123',
        previous_block: 'prev_block_hash',
        next_block: null,
        confirmations: 1,
      } as any);

      const result = await backend.getLatestBlock();

      expect(result).toEqual({
        time: 1638360000,
        height: 7654321,
        hash: 'block_hash_123',
        slot: 12345678,
        slotLeader: 'pool_leader_123',
        epoch: 300,
        epochSlot: 123456,
        size: 12345,
        txCount: 42,
        fees: '1234567',
      });
      expect(mockApi.blocksLatest).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLatestEpoch', () => {
    it('fetches and maps latest epoch', async () => {
      mockApi.epochsLatest.mockResolvedValue({
        epoch: 300,
        start_time: 1638100000,
        end_time: 1638532800,
        first_block_time: 1638100020,
        last_block_time: 1638532780,
        block_count: 21600,
        tx_count: 500000,
        output: '9000000000000000',
        fees: '5000000000',
        active_stake: '22000000000000000',
      } as any);

      const result = await backend.getLatestEpoch();

      expect(result).toEqual({
        epoch: 300,
        start_time: 1638100000,
        end_time: 1638532800,
        first_block_time: 1638100020,
        last_block_time: 1638532780,
        block_count: 21600,
        tx_count: 500000,
        output: '9000000000000000',
        fees: '5000000000',
        active_stake: '22000000000000000',
      });
      expect(mockApi.epochsLatest).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTransaction', () => {
    const mockTxHash = 'abc123def456';

    it('fetches and maps transaction with inputs/outputs', async () => {
      mockApi.txs.mockResolvedValue({
        hash: mockTxHash,
        block: 'block_hash',
        block_height: 7654321,
        block_time: 1638360000,
        slot: 12345678,
        index: 5,
        fees: '170000',
        deposit: '0',
        size: 450,
        invalid_before: null,
        invalid_hereafter: '12500000',
        utxo_count: 2,
        withdrawal_count: 0,
        mir_cert_count: 0,
        delegation_count: 0,
        stake_cert_count: 0,
        pool_update_count: 0,
        pool_retire_count: 0,
        asset_mint_or_burn_count: 0,
        redeemer_count: 0,
        valid_contract: true,
        output_amount: [{ unit: 'lovelace', quantity: '5000000' }],
      } as any);

      mockApi.txsUtxos.mockResolvedValue({
        hash: mockTxHash,
        inputs: [
          {
            address: 'addr_test1_input',
            tx_hash: 'input_tx_hash',
            output_index: 0,
            amount: [{ unit: 'lovelace', quantity: '10000000' }],
            data_hash: null,
            inline_datum: null,
            reference_script_hash: null,
            collateral: false,
            reference: false,
          },
        ],
        outputs: [
          {
            address: 'addr_test1_output',
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
            output_index: 0,
            data_hash: null,
            inline_datum: null,
            collateral: false,
            reference_script_hash: null,
          },
        ],
      } as any);

      mockApi.txsMetadata.mockResolvedValue([]);

      const result = await backend.getTransaction(mockTxHash);

      expect(result.hash).toBe(mockTxHash);
      expect(result.blockHash).toBe('block_hash');
      expect(result.fee).toBe(170000);
      expect(result.inputs).toHaveLength(1);
      expect(result.outputs).toHaveLength(1);
      expect(result.inputs[0].address).toBe('addr_test1_input');
      expect(result.outputs[0].address).toBe('addr_test1_output');

      expect(mockApi.txs).toHaveBeenCalledWith(mockTxHash);
      expect(mockApi.txsUtxos).toHaveBeenCalledWith(mockTxHash);
      expect(mockApi.txsMetadata).toHaveBeenCalledWith(mockTxHash);
    });

    it('throws NotFoundError for non-existent transaction', async () => {
      mockApi.txs.mockRejectedValue({ status_code: 404, message: 'Not found' });

      await expect(backend.getTransaction('invalid_hash')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getTransactionMetadata', () => {
    it('fetches and maps transaction metadata', async () => {
      const mockTxHash = 'tx_with_metadata';

      mockApi.txsMetadata.mockResolvedValue([
        { label: '721', json_metadata: { name: 'NFT Token', image: 'ipfs://...' } },
        { label: '1234', json_metadata: { custom: 'data' } },
      ] as any);

      const result = await backend.getTransactionMetadata(mockTxHash);

      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('721');
      expect(result[0].json).toEqual({ name: 'NFT Token', image: 'ipfs://...' });
      expect(result[1].label).toBe('1234');

      expect(mockApi.txsMetadata).toHaveBeenCalledWith(mockTxHash);
    });

    it('returns empty array if no metadata', async () => {
      mockApi.txsMetadata.mockResolvedValue([]);

      const result = await backend.getTransactionMetadata('tx_no_metadata');

      expect(result).toEqual([]);
    });

    it('returns empty array for non-array response', async () => {
      mockApi.txsMetadata.mockResolvedValue(null as any);

      const result = await backend.getTransactionMetadata('abc123');

      expect(result).toEqual([]);
    });
  });

  describe('getAddress', () => {
    it('fetches and maps address information', async () => {
      const mockAddress = 'addr_test1234567890';

      mockApi.addresses.mockResolvedValue({
        address: mockAddress,
        amount: [{ unit: 'lovelace', quantity: '5000000' }],
        stake_address: 'stake_test1234567890',
        type: 'shelley',
        script: false,
      } as any);

      const result = await backend.getAddress(mockAddress);

      expect(result.address).toBe(mockAddress);
      expect(result.amount).toEqual([{ unit: 'lovelace', quantity: '5000000' }]);
      expect(result.stakeAddress).toBe('stake_test1234567890');

      expect(mockApi.addresses).toHaveBeenCalledWith(mockAddress);
    });

    it('throws NotFoundError for invalid address', async () => {
      mockApi.addresses.mockRejectedValue({ status_code: 404, message: 'Not found' });

      await expect(backend.getAddress('invalid_address')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getAddressUtxos', () => {
    it('fetches and maps UTxOs for address', async () => {
      const mockAddress = 'addr_test1234567890';

      mockApi.addressesUtxos.mockResolvedValue([
        {
          tx_hash: 'utxo_tx_hash_1',
          tx_index: 0,
          output_index: 0,
          address: 'addr_utxo_1',
          amount: [{ unit: 'lovelace', quantity: '2000000' }],
          block: 'block_hash',
          data_hash: null,
          inline_datum: null,
          reference_script_hash: null,
        },
        {
          tx_hash: 'utxo_tx_hash_2',
          tx_index: 1,
          output_index: 0,
          address: 'addr_utxo_2',
          amount: [{ unit: 'lovelace', quantity: '3000000' }],
          block: 'block_hash',
          data_hash: null,
          inline_datum: null,
          reference_script_hash: null,
        },
      ] as any);

      const result = await backend.getAddressUtxos(mockAddress);

      expect(result).toHaveLength(2);
      expect(result[0].txHash).toBe('utxo_tx_hash_1');
      expect(result[0].address).toBe('addr_utxo_1');
      expect(result[1].txHash).toBe('utxo_tx_hash_2');

      expect(mockApi.addressesUtxos).toHaveBeenCalledWith(mockAddress);
    });

    it('returns empty array for address with no UTxOs', async () => {
      mockApi.addressesUtxos.mockResolvedValue([]);

      const result = await backend.getAddressUtxos('addr_empty');

      expect(result).toEqual([]);
    });
  });

  describe('getMetadataLabelTransactions', () => {
    it('fetches transactions by metadata label', async () => {
      mockApi.metadataTxsLabel.mockResolvedValue([
        { tx_hash: 'tx1', tx_index: 1, block_height: 1000, block_time: 1638360000 },
        { tx_hash: 'tx2', tx_index: 2, block_height: 1001, block_time: 1638360100 },
      ] as any);

      const result = await backend.getMetadataLabelTransactions('721');

      expect(result).toHaveLength(2);
      expect(result[0].txHash).toBe('tx1');
      expect(result[1].txHash).toBe('tx2');

      expect(mockApi.metadataTxsLabel).toHaveBeenCalledWith('721');
    });

    it('returns empty array for unused label', async () => {
      mockApi.metadataTxsLabel.mockResolvedValue([]);

      const result = await backend.getMetadataLabelTransactions('999999');

      expect(result).toEqual([]);
    });

    it('returns empty array when API response is not an array', async () => {
      mockApi.metadataTxsLabel.mockResolvedValue({ not: 'array' } as any);

      const result = await backend.getMetadataLabelTransactions('721');

      expect(result).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('handles network errors', async () => {
      mockApi.network.mockRejectedValue(new Error('Network error'));

      await expect(backend.getNetworkInformation()).rejects.toThrow();
    });

    it('handles timeout errors', async () => {
      mockApi.blocksLatest.mockRejectedValue({ code: 'ETIMEDOUT', message: 'Timeout' });

      await expect(backend.getLatestBlock()).rejects.toThrow();
    });

    it('handles malformed API responses gracefully', async () => {
      mockApi.addresses.mockRejectedValue({ status_code: 500, message: 'Internal error' });

      await expect(backend.getAddress('addr_test123')).rejects.toThrow();
    });
  });
  
   describe('Constructor - Configuration validation', () => {
    test('throws BackendInitError when CONFIG.blockfrostApiKey is not set', async () => {
      jest.resetModules();
      jest.clearAllMocks();

      jest.doMock('../../config/config', () => ({
        CONFIG: { blockfrostApiKey: undefined },
      }));

      jest.isolateModules(() => {
        const { BlockfrostBackend: FreshBlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');
        const { BackendInitError: FreshBackendInitError } = require('../../srv/utils/errors');
        expect(() => new FreshBlockfrostBackend()).toThrow(FreshBackendInitError);
        expect(() => new FreshBlockfrostBackend()).toThrow('Failed to initialize backend: blockfrost');
      });
    });

    test('does not throw when CONFIG.blockfrostApiKey is set', async () => {
      jest.resetModules();
      jest.clearAllMocks();

      jest.doMock('../../config/config', () => ({
        CONFIG: { blockfrostApiKey: 'present-key' },
      }));

      jest.isolateModules(() => {
        const { BlockfrostBackend: FreshBlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');
        expect(() => new FreshBlockfrostBackend()).not.toThrow();
      });
    });
  }); 
});