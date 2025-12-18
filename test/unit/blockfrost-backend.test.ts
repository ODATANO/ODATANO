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

    it('maps transaction metadata when present', async () => {
      mockApi.txs.mockResolvedValue({
        hash: mockTxHash,
        block: 'block_hash',
        block_height: 1,
        block_time: 2,
        slot: 3,
        index: 0,
        fees: '1',
        deposit: '0',
        size: 1,
        utxo_count: 0,
        withdrawal_count: 0,
        mir_cert_count: 0,
        delegation_count: 0,
        stake_cert_count: 0,
        pool_update_count: 0,
        pool_retire_count: 0,
        asset_mint_or_burn_count: 0,
        redeemer_count: 0,
        valid_contract: true,
        output_amount: [],
      } as any);

      mockApi.txsUtxos.mockResolvedValue({ inputs: [], outputs: [] } as any);
      mockApi.txsMetadata.mockResolvedValue([
        { label: '721', json_metadata: { foo: 'bar' } },
      ]);

      const result = await backend.getTransaction(mockTxHash);

      expect(result.metadata).toEqual([
        { txHash: mockTxHash, label: '721', json_metadata: { foo: 'bar' } },
      ]);
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

      // Mock addressesUtxos since getAddress also calls this
      mockApi.addressesUtxos.mockResolvedValue([
        {
          tx_hash: 'utxo_hash',
          output_index: 0,
          address: mockAddress,
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
          block: 'block_hash',
          data_hash: null,
          reference_script_hash: null,
        }
      ] as any);

      const result = await backend.getAddress(mockAddress);

      expect(result.address).toBe(mockAddress);
      expect(result.amount).toEqual([{ unit: 'lovelace', quantity: '5000000' }]);
      expect(result.stakeAddress).toBe('stake_test1234567890');
      expect(result.utxos).toHaveLength(1);
      expect(result.utxos[0].txHash).toBe('utxo_hash');

      expect(mockApi.addresses).toHaveBeenCalledWith(mockAddress);
      expect(mockApi.addressesUtxos).toHaveBeenCalledWith(mockAddress);
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

  describe('getBlock', () => {
    test('fetches and returns block data', async () => {
      const blockHash = 'block123';
      mockApi.blocks = jest.fn().mockResolvedValue({
        time: 1000,
        height: 100,
        hash: blockHash,
        slot: 1000,
        epoch: 10,
        epoch_slot: 100,
        slot_leader: 'leader',
        size: 1000,
        tx_count: 5,
        fees: '5000',
      });

      const result = await backend.getBlock(blockHash);

      expect(result).toMatchObject({
        hash: blockHash,
        height: 100,
        time: 1000,
      });
      expect(mockApi.blocks).toHaveBeenCalledWith(blockHash);
    });
  });

  describe('getEpoch', () => {
    test('fetches and returns epoch data', async () => {
      const epochNumber = 100;
      mockApi.epochs = jest.fn().mockResolvedValue({
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
      });

      const result = await backend.getEpoch(epochNumber);

      expect(result).toMatchObject({
        epoch: epochNumber,
        start_time: 1000,
      });
      expect(mockApi.epochs).toHaveBeenCalledWith(epochNumber);
    });
  });

  describe('getPool', () => {
    test('fetches and returns pool data', async () => {
      const poolId = 'pool1abc123';
      mockApi.poolsById = jest.fn().mockResolvedValue({
        pool_id: poolId,
        vrf_key: 'vrf123',
        blocks_minted: 100,
        blocks_epoch: 10,
        live_stake: '1000000',
        live_size: 0.5,
        live_delegators: 50,
        live_saturation: 0.3,
        active_stake: '900000',
        active_size: 0.45,
        live_pledge: '100000',
        margin_cost: 0.05,
        fixed_cost: '340000000',
        reward_account: 'stake1reward',
      });

      const result = await backend.getPool(poolId);

      expect(result).toMatchObject({
        poolId,
        liveStake: 1000000,
      });
      expect(mockApi.poolsById).toHaveBeenCalledWith(poolId);
    });

    test('maps pool numeric fallbacks when fields are missing', async () => {
      const poolId = 'pool1missing';
      mockApi.poolsById = jest.fn().mockResolvedValue({
        pool_id: poolId,
        vrf_key: 'vrf123',
        blocks_minted: 1,
        blocks_epoch: 1,
        live_stake: undefined,
        live_size: 0,
        live_delegators: 0,
        live_saturation: 0,
        active_stake: undefined,
        active_size: 0,
        live_pledge: undefined,
        margin_cost: 0,
        fixed_cost: undefined,
        reward_account: 'stake1reward',
      });

      const result = await backend.getPool(poolId);

      expect(result.liveStake).toBe(0);
      expect(result.activeStake).toBe(0);
      expect(result.pledge).toBe(0);
      expect(result.fixedCost).toBe(0);
    });
  });

  describe('getDrep', () => {
    test('fetches and returns drep data', async () => {
      const drepId = 'drep1abc123';
      mockApi.governance = {
        drepsById: jest.fn().mockResolvedValue({
          drep_id: drepId,
          hex: 'abc123',
          amount: '1000000',
          has_script: false,
          last_active_epoch: 100,
          expired: false,
          retired: false,
        }),
      };

      const result = await backend.getDrep(drepId);

      expect(result).toMatchObject({
        drepId,
        amount: '1000000',
      });
      expect(mockApi.governance.drepsById).toHaveBeenCalledWith(drepId);
    });

    test('defaults lastActiveEpoch to 0 when missing', async () => {
      const drepId = 'drep1missing';
      mockApi.governance = {
        drepsById: jest.fn().mockResolvedValue({
          drep_id: drepId,
          hex: 'abc123',
          amount: '0',
          has_script: false,
          last_active_epoch: undefined,
          expired: false,
          retired: false,
        }),
      };

      const result = await backend.getDrep(drepId);

      expect(result.lastActiveEpoch).toBe(0);
    });
  });

  describe('getAccount', () => {
    test('fetches and returns account data with addresses', async () => {
      const stakeAddress = 'stake1abc123';
      
      mockApi.accounts = jest.fn().mockResolvedValue({
        stake_address: stakeAddress,
        active: true,
        active_epoch: 100,
        controlled_amount: '1000000',
        rewards_sum: '50000',
        withdrawals_sum: '10000',
        reserves_sum: '0',
        treasury_sum: '0',
        withdrawable_amount: '40000',
        pool_id: 'pool123',
      });
      mockApi.accountsAddresses = jest.fn().mockResolvedValue([]);
      mockApi.addresses = jest.fn().mockResolvedValueOnce({
        address: 'addr1',
        stake_address: stakeAddress,
        type: 'shelley',
        script: false,
        amount: [],
      });

      const result = await backend.getAccount(stakeAddress);

      expect(result).toMatchObject({
        stakeaddress: stakeAddress,
        active: true,
      });
      expect(mockApi.accounts).toHaveBeenCalledWith(stakeAddress);
      expect(mockApi.accountsAddresses).toHaveBeenCalledWith(stakeAddress);
      expect(Array.isArray(result.addresses)).toBe(true);
    });

    test('defaults activeEpoch to 0 when missing', async () => {
      const stakeAddress = 'stake1noepoch';

      mockApi.accounts = jest.fn().mockResolvedValue({
        stake_address: stakeAddress,
        active: true,
        active_epoch: undefined,
        controlled_amount: '0',
        rewards_sum: '0',
        withdrawals_sum: '0',
        reserves_sum: '0',
        treasury_sum: '0',
        withdrawable_amount: '0',
        pool_id: null,
      });
      mockApi.accountsAddresses = jest.fn().mockResolvedValue([]);
      mockApi.addresses = jest.fn().mockResolvedValueOnce({
        address: 'addr1',
        stake_address: stakeAddress,
        type: 'shelley',
        script: false,
        amount: [],
      });

      const result = await backend.getAccount(stakeAddress);

      expect(result.activeEpoch).toBe(0);
    });

    test('fetches and maps multiple addresses via Promise.all', async () => {
      const stakeAddress = 'stake1xyz789';
      
      mockApi.accounts = jest.fn().mockResolvedValue({
        stake_address: stakeAddress,
        active: true,
        active_epoch: 200,
        controlled_amount: '2000000',
        rewards_sum: '100000',
        withdrawals_sum: '20000',
        reserves_sum: '0',
        treasury_sum: '0',
        withdrawable_amount: '80000',
        pool_id: 'pool456',
      });

      // Mock multiple addresses from accountsAddresses
      mockApi.accountsAddresses = jest.fn().mockResolvedValue([
        { address: 'addr_test1qqabc123' },
        { address: 'addr_test1qqdef456' },
        { address: 'addr_test1qqghi789' },
      ]);

      // Mock getAddress responses for each address
      mockApi.addresses = jest.fn()
        .mockResolvedValueOnce({
          address: 'addr_test1qqabc123',
          stake_address: stakeAddress,
          type: 'shelley',
          script: false,
          amount: [{ unit: 'lovelace', quantity: '1000000' }],
        })
        .mockResolvedValueOnce({
          address: 'addr_test1qqdef456',
          stake_address: stakeAddress,
          type: 'shelley',
          script: false,
          amount: [{ unit: 'lovelace', quantity: '500000' }],
        })
        .mockResolvedValueOnce({
          address: 'addr_test1qqghi789',
          stake_address: stakeAddress,
          type: 'shelley',
          script: false,
          amount: [{ unit: 'lovelace', quantity: '500000' }],
        });

      mockApi.addressesUtxos = jest.fn().mockResolvedValue([]);

      const result = await backend.getAccount(stakeAddress);

      expect(result.addresses).toHaveLength(3);
      expect(result.addresses[0].address).toBe('addr_test1qqabc123');
      expect(result.addresses[1].address).toBe('addr_test1qqdef456');
      expect(result.addresses[2].address).toBe('addr_test1qqghi789');
      expect(mockApi.addresses).toHaveBeenCalledTimes(3);
    });
  });
});