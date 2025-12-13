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
      mockAxiosInstance.get.mockResolvedValue({ data: [mockKoiosAddress] });

      const result = await backend.getAddress(mockAddress);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/address_info?address=${mockAddress}`);
      expect(result).toEqual({
        address: mockAddress,
        stakeAddress: 'stake_test1uz123',
        type: 'payment',
        isScript: false,
        amount: '5000000',
      });
    });

    test('handles null stake_address', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: [{ ...mockKoiosAddress, stake_address: null }],
      });

      const result = await backend.getAddress(mockAddress);

      expect(result.stakeAddress).toBeNull();
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
});

