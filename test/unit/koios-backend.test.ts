import axios from 'axios';
import { KoiosBackend } from '../../srv/blockchain/backends/koios-backend';
import { ProviderBadResponseError, NotFoundError } from '../../srv/utils/errors';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('KoiosBackend', () => {
  let backend: KoiosBackend;
  let mockAxiosInstance: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock axios instance
    mockAxiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
    };

    // Mock axios.create to return our mock instance
    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);

    backend = new KoiosBackend();
  });

  describe('constructor and init', () => {
    test('creates axios instance with correct config', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://preview.koios.rest/api/v1',
        timeout: 8000,
      });
    });

    test('name property is "koios"', () => {
      expect(backend.name).toBe('koios');
    });

    test('init() resolves successfully', async () => {
      await expect(backend.init()).resolves.toBeUndefined();
    });
  });

  describe('healthCheck', () => {
    test('returns true on successful health check', async () => {
      mockAxiosInstance.get.mockResolvedValue({ status: 200 });

      const result = await backend.healthCheck();

      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/health');
    });

    test('returns false on failed health check', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const result = await backend.healthCheck();

      expect(result).toBe(false);
    });

    test('returns false on non-200 status', async () => {
      mockAxiosInstance.get.mockResolvedValue({ status: 500 });

      const result = await backend.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe('getTransaction', () => {
    const mockTxHash = '1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2a';
    
    const mockKoiosTransaction = {
      tx_hash: mockTxHash,
      block_hash: 'abc123',
      block_height: 100000,
      slot_no: 50000000,
      tx_index: 5,
      tx_fee: '170000',
      deposit: '0',
      tx_size: 400,
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
      tx_validity_start: 1638360000,
      output_amount: '1000000',
      inputs: [
        { address: 'addr_test1qz123', tx_hash: 'input_tx_hash' }
      ],
      outputs: [
        { address: 'addr_test1qz456', amount: '1000000' }
      ],
      metadata: null,
    };

    test('fetches and parses transaction correctly', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: [mockKoiosTransaction],
      });

      const result = await backend.getTransaction(mockTxHash);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/tx_info?tx_hash=${mockTxHash}`);
      expect(result).toEqual({
        hash: mockTxHash,
        blockHash: 'abc123',
        blockHeight: 100000,
        slot: 50000000,
        index: 5,
        fee: 170000,
        deposit: 0,
        size: 400,
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
        blockTime: 1638360000000,
        outputAmount: '1000000',
        inputs: [{ address: 'addr_test1qz123', txHash: 'input_tx_hash' }],
        outputs: [{ address: 'addr_test1qz456', amount: '1000000' }],
        metadata: null,
      });
    });

    test('throws error when transaction not found', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [] });

      await expect(backend.getTransaction(mockTxHash)).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getTransaction(mockTxHash)).rejects.toThrow('Transaction not found');
    });

    test('handles missing optional fields', async () => {
      const minimalTx = {
        tx_hash: mockTxHash,
        block_hash: 'abc',
        block_height: 1,
        slot_no: 1,
        tx_index: 1,
        tx_size: 100,
        utxo_count: 0,
        withdrawal_count: 0,
        mir_cert_count: 0,
        delegation_count: 0,
        stake_cert_count: 0,
        pool_update_count: 0,
        pool_retire_count: 0,
        asset_mint_or_burn_count: 0,
        redeemer_count: 0,
        valid_contract: false,
        tx_validity_start: 1000000,
        output_amount: '0',
        inputs: [],
        outputs: [],
        metadata: null,
      };

      mockAxiosInstance.get.mockResolvedValue({ data: [minimalTx] });

      const result = await backend.getTransaction(mockTxHash);

      expect(result.fee).toBe(0);
      expect(result.deposit).toBe(0);
    });
  });

  describe('getLatestBlock', () => {
    const mockTipData = {
      hash: 'tip_hash_123',
      epoch_no: 400,
      block_height: 8000000,
    };

    const mockBlockData = {
      block_hash: 'tip_hash_123',
      block_height: 8000000,
      slot_no: 80000000,
      epoch_no: 400,
      epoch_slot_no: 12345,
      vrf_key: 'vrf_key_123',
      block_size: 65536,
      tx_count: 20,
      total_fees: '500000',
      time: 1700000000,
    };

    test('fetches and parses latest block correctly', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockResolvedValue({ data: [mockBlockData] });

      const result = await backend.getLatestBlock();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/tip');
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/block_info', {
        _block_hashes: ['tip_hash_123'],
      });

      expect(result).toEqual({
        time: 1700000000,
        height: 8000000,
        hash: 'tip_hash_123',
        slot: 80000000,
        epoch: 400,
        epochSlot: 12345,
        slotLeader: 'vrf_key_123',
        size: 65536,
        txCount: 20,
        fees: '500000',
      });
    });

    test('throws error when block data is empty', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getLatestBlock()).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getLatestBlock()).rejects.toThrow('Block data not available');
    });

    test('throws NOT_FOUND on 404 error', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockRejectedValue({ status: 404 });

      await expect(backend.getLatestBlock()).rejects.toThrow(NotFoundError);
    });

    test('throws NOT_FOUND on response.status 404', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockRejectedValue({ response: { status: 404 } });

      await expect(backend.getLatestBlock()).rejects.toThrow(NotFoundError);
    });

    test('re-throws other errors', async () => {
      const networkError = new Error('Network error');
      mockAxiosInstance.get.mockRejectedValue(networkError);

      await expect(backend.getLatestBlock()).rejects.toThrow('Network error');
    });
  });

  describe('getLatestEpoch', () => {
    const mockTipData = {
      epoch_no: 400,
    };

    const mockEpochData = {
      epoch_no: 400,
      start_time: 1700000000,
      end_time: 1700500000,
      first_block_time: 1700000100,
      last_block_time: 1700499900,
      block_count: 21600,
      tx_count: 500000,
      total_output: '1000000000000',
      total_fees: '100000000',
      active_stake: '50000000000000',
    };

    test('fetches and parses latest epoch correctly', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockResolvedValue({ data: [mockEpochData] });

      const result = await backend.getLatestEpoch();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/tip');
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/epoch_info', {
        _epoch_nos: [400],
      });

      expect(result).toEqual({
        epoch: 400,
        start_time: 1700000000,
        end_time: 1700500000,
        first_block_time: 1700000100,
        last_block_time: 1700499900,
        block_count: 21600,
        tx_count: 500000,
        output: '1000000000000',
        fees: '100000000',
        active_stake: '50000000000000',
      });
    });

    test('throws error when epoch data is empty', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getLatestEpoch()).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getLatestEpoch()).rejects.toThrow('Epoch data not available');
    });

    test('throws error when epoch data is null', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: mockTipData });
      mockAxiosInstance.post.mockResolvedValue({ data: null });

      await expect(backend.getLatestEpoch()).rejects.toThrow(ProviderBadResponseError);
    });
  });

  describe('getAddress', () => {
    const mockAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
    
    const mockKoiosAddress = {
      address: mockAddress,
      stake_address: 'stake_test1uz123',
      address_type: 'payment',
      is_script: false,
      total_balance: '5000000',
    };

    test('fetches and parses address correctly', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: [mockKoiosAddress] })
        .mockResolvedValueOnce({ 
          data: [{
            utxos: [
              {
                tx_hash: 'utxo_tx_hash',
                tx_index: 0,
                amount: [{ unit: 'lovelace', quantity: '5000000' }],
                block_hash: 'block_hash',
                datum_hash: null,
                script_ref: null,
              }
            ]
          }]
        });

      const result = await backend.getAddress(mockAddress);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/address_info?address=${mockAddress}`);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/address_utxos?address=${mockAddress}`);
      expect(result).toEqual({
        address: mockAddress,
        stakeAddress: 'stake_test1uz123',
        type: 'payment',
        isScript: false,
        amount: '5000000',
        utxos: [
          {
            txHash: 'utxo_tx_hash',
            outputIndex: 0,
            address: mockAddress,
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
            blockHash: 'block_hash',
            datumHash: null,
            scriptRef: null,
          }
        ],
      });
    });

    test('handles null stake_address', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: [{ ...mockKoiosAddress, stake_address: null }],
        })
        .mockResolvedValueOnce({ 
          data: [{
            utxos: []
          }]
        });

      const result = await backend.getAddress(mockAddress);

      expect(result.stakeAddress).toBeNull();
      expect(result.utxos).toEqual([]);
    });

    test('throws error when address not found', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [] });

      await expect(backend.getAddress(mockAddress)).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getAddress(mockAddress)).rejects.toThrow('Address not found');
    });
  });

  describe('getAddressUtxos', () => {
    const mockAddress = 'addr_test1qz123';

    const mockKoiosUtxos = {
      utxos: [
        {
          tx_hash: 'utxo_tx_hash_1',
          tx_index: 0,
          amount: '1000000',
          block_hash: 'block_hash_1',
          datum_hash: 'datum_hash_1',
          script_ref: null,
        },
        {
          tx_hash: 'utxo_tx_hash_2',
          tx_index: 1,
          amount: '2000000',
          block_hash: 'block_hash_2',
          datum_hash: null,
          script_ref: 'script_ref_2',
        },
      ],
    };

    test('fetches and parses UTxOs correctly', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [mockKoiosUtxos] });

      const result = await backend.getAddressUtxos(mockAddress);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/address_utxos?address=${mockAddress}`);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        txHash: 'utxo_tx_hash_1',
        outputIndex: 0,
        address: mockAddress,
        amount: '1000000',
        blockHash: 'block_hash_1',
        datumHash: 'datum_hash_1',
        scriptRef: null,
      });
      expect(result[1]).toEqual({
        txHash: 'utxo_tx_hash_2',
        outputIndex: 1,
        address: mockAddress,
        amount: '2000000',
        blockHash: 'block_hash_2',
        datumHash: null,
        scriptRef: 'script_ref_2',
      });
    });

    test('handles empty UTxO list', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [] });

      await expect(backend.getAddressUtxos(mockAddress)).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getAddressUtxos(mockAddress)).rejects.toThrow('Address UTxOs not found');
    });
  });

  describe('getNetworkInformation', () => {
    const mockNetworkInfo = {
      supply: {
        max: '45000000000000000',
        total: '35000000000000000',
        circulating: '34000000000000000',
        locked: '1000000000000000',
        treasury: '500000000000000',
        reserves: '10000000000000000',
      },
      stake: {
        live: '25000000000000000',
        active: '24000000000000000',
      },
    };

    test('fetches and parses network information correctly', async () => {
      const mockTotals = [{
        epoch_no: 258,
        circulation: '30013545931388687',
        treasury: '1663258441069032',
        supply: '31710284090017896',
        reserves: '13289715909982104',
      }];
      
      mockAxiosInstance.get.mockResolvedValue({ data: mockTotals });

      const result = await backend.getNetworkInformation();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/totals?order=epoch_no.desc&limit=1');
      expect(result).toEqual({
        supply: {
          max: '45000000000000000',
          total: '31710284090017896',
          circulating: '30013545931388687',
          locked: '0',
          treasury: '1663258441069032',
          reserves: '13289715909982104',
        },
        stake: {
          live: '0',
          active: '0',
        },
      });
    });

    test('throws error when network info not found', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: null });

      await expect(backend.getNetworkInformation()).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getNetworkInformation()).rejects.toThrow('Network information not available');
    });
  });

  describe('getMetadataLabelTransactions', () => {
    test('throws ProviderBadResponseError for string label', async () => {
      await expect(backend.getMetadataLabelTransactions('721')).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getMetadataLabelTransactions('721')).rejects.toThrow('not supported');
    });

    test('throws ProviderBadResponseError for numeric label', async () => {
      await expect(backend.getMetadataLabelTransactions(721)).rejects.toThrow(ProviderBadResponseError);
    });
  });

  describe('getTransactionMetadata', () => {
    const mockTxHash = '1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2a';

    test('fetches and parses transaction metadata correctly', async () => {
      const mockMetadataResponse = [
        {
          tx_hash: mockTxHash,
          metadata: {
            '721': {
              policy: 'test_policy',
              asset: 'test_asset',
            },
            '1967': {
              name: 'Test NFT',
            },
          },
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({ data: mockMetadataResponse });

      const result = await backend.getTransactionMetadata(mockTxHash);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/tx_metadata', {
        _tx_hashes: [mockTxHash],
      });

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        txHash: mockTxHash,
        label: 721,
        json: { policy: 'test_policy', asset: 'test_asset' },
      });
      expect(result).toContainEqual({
        txHash: mockTxHash,
        label: 1967,
        json: { name: 'Test NFT' },
      });
    });

    test('handles numeric and string labels correctly', async () => {
      const mockMetadataResponse = [
        {
          tx_hash: mockTxHash,
          metadata: {
            '721': { nft: 'data' },
            'custom_label': { custom: 'value' },
          },
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({ data: mockMetadataResponse });

      const result = await backend.getTransactionMetadata(mockTxHash);

      expect(result[0].label).toBe(721); // Parsed as number
      expect(result[1].label).toBe('custom_label'); // Kept as string
    });

    test('throws error when response is not an array', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: null });

      await expect(backend.getTransactionMetadata(mockTxHash)).rejects.toThrow(ProviderBadResponseError);
    });

    test('throws error when response array is empty', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getTransactionMetadata(mockTxHash)).rejects.toThrow(ProviderBadResponseError);
    });

    test('throws error when metadata object is empty', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: [{ tx_hash: mockTxHash, metadata: {} }],
      });

      await expect(backend.getTransactionMetadata(mockTxHash)).rejects.toThrow(ProviderBadResponseError);
    });

    test('uses fallback txHash when tx_hash is missing in response', async () => {
      const mockMetadataResponse = [
        {
          metadata: {
            '721': { test: 'data' },
          },
        },
      ];

      mockAxiosInstance.post.mockResolvedValue({ data: mockMetadataResponse });

      const result = await backend.getTransactionMetadata(mockTxHash);

      expect(result[0].txHash).toBe(mockTxHash);
    });

    test('handles null metadata object', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: [{ tx_hash: mockTxHash, metadata: null }],
      });

      await expect(backend.getTransactionMetadata(mockTxHash)).rejects.toThrow(ProviderBadResponseError);
    });
  });

  describe('getBlock', () => {
    test('fetches and returns block data', async () => {
      const blockHash = 'block123';
      mockAxiosInstance.post.mockResolvedValue({
        data: [{
          block_hash: blockHash,
          block_height: 100,
          time: 1000,
          slot_no: 1000,
          epoch_no: 10,
          epoch_slot: 100,
          slot_leader: 'leader',
          block_size: 1000,
          tx_count: 5,
          fees: '5000',
        }],
      });

      const result = await backend.getBlock(blockHash);

      expect(result).toMatchObject({
        hash: blockHash,
        height: 100,
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/block_info', { _block_hashes: [blockHash] });
    });

    test('throws error when block data is empty', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getBlock('block123')).rejects.toThrow(ProviderBadResponseError);
    });
  });

  describe('getEpoch', () => {
    test('fetches and returns epoch data', async () => {
      const epochNumber = 100;
      mockAxiosInstance.post.mockResolvedValue({
        data: [{
          epoch_no: epochNumber,
          start_time: 1000,
          end_time: 2000,
          first_block_time: 1000,
          last_block_time: 2000,
          block_count: 100,
          tx_count: 500,
          output: '1000000',
          fees: '5000',
          active_stake: '50000000',
        }],
      });

      const result = await backend.getEpoch(epochNumber);

      expect(result).toMatchObject({
        epoch: epochNumber,
        start_time: 1000,
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/epoch_info', { _epoch_nos: [epochNumber] });
    });

    test('throws error when epoch data is empty', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getEpoch(100)).rejects.toThrow(ProviderBadResponseError);
    });
  });

  describe('getPool', () => {
    test('fetches and returns pool data', async () => {
      const poolId = 'pool1abc123';
      mockAxiosInstance.post.mockResolvedValue({
        data: [{
          pool_bech32_id: poolId,
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
        }],
      });

      const result = await backend.getPool(poolId);

      expect(result).toMatchObject({
        poolId,
        liveStake: 1000000,
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/pool_info', { _pool_bech32_ids: [poolId] });
    });

    test('throws error when pool not found', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getPool('pool123')).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getPool('pool123')).rejects.toThrow('Pool not found');
    });
  });

  describe('getDrep', () => {
    test('fetches and returns drep data', async () => {
      const drepId = 'drep1abc123';
      mockAxiosInstance.post.mockResolvedValue({
        data: [{
          drep_id: drepId,
          hex: 'abc123',
          amount: '1000000',
          has_script: false,
          last_active_epoch: 100,
          expired: false,
          retired: false,
        }],
      });

      const result = await backend.getDrep(drepId);

      expect(result).toMatchObject({
        drepId,
        amount: '1000000',
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/drep_info', { _drep_ids: [drepId] });
    });

    test('throws error when drep not found', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getDrep('drep123')).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getDrep('drep123')).rejects.toThrow('Drep not found');
    });
  });

  describe('getAccount', () => {
    test('fetches and returns account data with addresses', async () => {
      const accountId = 'stake1abc123';
      
      mockAxiosInstance.post
        .mockResolvedValueOnce({
          data: [{
            stake_address: accountId,
            active: true,
            active_epoch: 100,
            controlled_amount: '1000000',
            rewards_sum: '50000',
            withdrawals_sum: '10000',
            reserves_sum: '0',
            treasury_sum: '0',
            withdrawable_amount: '40000',
            pool_id: 'pool123',
            drep_id: 'drep123',
          }],
        })
        .mockResolvedValueOnce({
          data: [],
        });
      
      const result = await backend.getAccount(accountId);

      expect(result).toMatchObject({
        stakeaddress: accountId,
        active: true,
        controlledAmount: '1000000',
        rewardsSum: '50000',
        withdrawalsSum: '10000',
        reservesSum: '0',
        treasurySum: '0',
        withdrawableAmount: '40000',
        poolId: 'pool123',
        drepId: 'drep123',
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/account_info', { _stake_addresses: [accountId] });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/account_addresses', { _stake_addresses: [accountId] });
      expect(Array.isArray(result.addresses)).toBe(true);
    });

    test('throws error when account not found', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: [] });

      await expect(backend.getAccount('stake123')).rejects.toThrow(ProviderBadResponseError);
      await expect(backend.getAccount('stake123')).rejects.toThrow('Account not found');
    });

    test('handles missing pool_id and drep_id', async () => {
      const accountId = 'stake1xyz789';
      
      mockAxiosInstance.post
        .mockResolvedValueOnce({
          data: [{
            stake_address: accountId,
            active: false,
            active_epoch: 50,
            controlled_amount: '500000',
            rewards_sum: '25000',
            withdrawals_sum: '5000',
            reserves_sum: '0',
            treasury_sum: '0',
            withdrawable_amount: '20000',
            pool_id: null,
            drep_id: null,
          }],
        })
        .mockResolvedValueOnce({
          data: [],
        });
      
      const result = await backend.getAccount(accountId);

      expect(result).toMatchObject({
        stakeaddress: accountId,
        active: false,
        poolId: null,
        drepId: null,
      });
      expect(Array.isArray(result.addresses)).toBe(true);
    });

    test('fetches and maps multiple addresses via Promise.all', async () => {
      const accountId = 'stake1multiaddr';
      
      // Mock the POST calls first
      mockAxiosInstance.post
        .mockResolvedValueOnce({
          data: [{
            stake_address: accountId,
            active: true,
            active_epoch: 150,
            controlled_amount: '3000000',
            rewards_sum: '150000',
            withdrawals_sum: '30000',
            reserves_sum: '0',
            treasury_sum: '0',
            withdrawable_amount: '120000',
            pool_id: 'pool789',
            drep_id: null,
          }],
        })
        .mockResolvedValueOnce({
          data: [
            { address: 'addr_test1qqaaa111' },
            { address: 'addr_test1qqbbb222' },
            { address: 'addr_test1qqccc333' },
          ],
        });

      // Mock GET requests using mockImplementation to handle Promise.all concurrency
      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (url.includes('address_info?address=addr_test1qqaaa111')) {
          return Promise.resolve({
            data: [{
              address: 'addr_test1qqaaa111',
              stake_address: accountId,
              address_type: 'shelley',
              is_script: false,
              total_balance: '1000000',
            }],
          });
        } else if (url.includes('address_utxos?address=addr_test1qqaaa111')) {
          return Promise.resolve({
            data: [{ utxos: [] }],
          });
        } else if (url.includes('address_info?address=addr_test1qqbbb222')) {
          return Promise.resolve({
            data: [{
              address: 'addr_test1qqbbb222',
              stake_address: accountId,
              address_type: 'shelley',
              is_script: false,
              total_balance: '500000',
            }],
          });
        } else if (url.includes('address_utxos?address=addr_test1qqbbb222')) {
          return Promise.resolve({
            data: [{ utxos: [] }],
          });
        } else if (url.includes('address_info?address=addr_test1qqccc333')) {
          return Promise.resolve({
            data: [{
              address: 'addr_test1qqccc333',
              stake_address: accountId,
              address_type: 'shelley',
              is_script: false,
              total_balance: '500000',
            }],
          });
        } else if (url.includes('address_utxos?address=addr_test1qqccc333')) {
          return Promise.resolve({
            data: [{ utxos: [] }],
          });
        }
        return Promise.reject(new Error(`Unexpected GET call: ${url}`));
      });

      const result = await backend.getAccount(accountId);

      expect(result.addresses).toHaveLength(3);
      expect(result.addresses[0].address).toBe('addr_test1qqaaa111');
      expect(result.addresses[1].address).toBe('addr_test1qqbbb222');
      expect(result.addresses[2].address).toBe('addr_test1qqccc333');
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/account_addresses', { _stake_addresses: [accountId] });
      expect(mockAxiosInstance.get).toHaveBeenCalled();
    });
  });
});

