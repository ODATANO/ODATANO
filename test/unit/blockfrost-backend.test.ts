import { BlockfrostBackend } from '../../srv/blockchain/backends/blockfrost-backend';
import { BackendInitError, NotFoundError } from '../../srv/utils/errors';

// Mock the BlockFrostAPI
jest.mock('@blockfrost/blockfrost-js', () => {
  const mockBlockFrostAPI = jest.fn().mockImplementation(() => ({
    txSubmit: jest.fn(),
    poolsById: jest.fn(),
    blocksLatest: jest.fn(),
    addressesUtxos: jest.fn(),
    epochsLatestParameters: jest.fn(),
    options: { requestTimeout: 0 },
  }));
  return { BlockFrostAPI: mockBlockFrostAPI };
});

const NETWORK = 'preview' as const;
const TIMEOUT_MS = 5000;

describe('BlockfrostBackend constructor Error Test', () => {
  it('throws BackendInitError when projectId is missing', () => {
    expect(() => new BlockfrostBackend(NETWORK, TIMEOUT_MS, '')).toThrow(BackendInitError);
    try {
      new BlockfrostBackend(NETWORK, TIMEOUT_MS, '');
    } catch (err: any) {
      expect(err.originalError?.message).toMatch(/Blockfrost Api Key is not set/i);
    }
  });

  it('creates backend successfully with valid projectId', () => {
    expect(() => new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key')).not.toThrow();
  });
});

describe('BlockfrostBackend submitTransaction mock test', () => {
  it('should submit a transaction and return the transaction hash', async () => {
    const mockTxHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      txSubmit: jest.fn().mockResolvedValue(mockTxHash),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const signedTxCbor = '84a300818258201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef00018182581d60abcdef1234567890abcdef1234567890abcdef1234567890abcdef12341a000f4240021a0002a389a0f6';

    const result = await backend.submitTransaction(signedTxCbor);
    expect(result).toBe(mockTxHash);
  });
});

describe('BlockfrostBackend getPool mock test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return pool data for a valid pool ID', async () => {
    const mockPoolData = {
      pool_id: 'pool1abc123def456',
      vrf_key: 'vrf_vk1abc123',
      blocks_minted: 1000,
      blocks_epoch: 10,
      live_stake: '50000000000000',
      live_size: 0.05,
      live_delegators: 500,
      live_saturation: 0.75,
      active_stake: '45000000000000',
      active_size: 0.045,
      live_pledge: '1000000000000',
      margin_cost: 0.02,
      fixed_cost: '340000000',
      reward_account: 'stake1uxyz789'
    };

    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      poolsById: jest.fn().mockResolvedValue(mockPoolData),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getPool('pool1abc123def456');

    expect(result).toEqual({
      poolId: 'pool1abc123def456',
      vrfKeyHash: 'vrf_vk1abc123',
      blocksMinted: 1000,
      blocksEpoch: 10,
      liveStake: '50000000000000',
      liveSize: 0.05,
      liveDelegators: 500,
      liveSaturation: 0.75,
      activeStake: '45000000000000',
      activeSize: 0.045,
      pledge: '1000000000000',
      margin: 0.02,
      fixedCost: '340000000',
      rewardAccount: 'stake1uxyz789'
    });
  });

  it('should handle pool data with null/undefined optional fields', async () => {
    const mockPoolData = {
      pool_id: 'pool1minimal',
      vrf_key: 'vrf_vk1min',
      blocks_minted: 0,
      blocks_epoch: 0,
      live_stake: null,
      live_size: 0,
      live_delegators: 0,
      live_saturation: 0,
      active_stake: null,
      active_size: 0,
      live_pledge: null,
      margin_cost: 0,
      fixed_cost: null,
      reward_account: 'stake1min'
    };

    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      poolsById: jest.fn().mockResolvedValue(mockPoolData),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getPool('pool1minimal');

    expect(result.liveStake).toBe('0');
    expect(result.activeStake).toBe('0');
    expect(result.pledge).toBe('0');
    expect(result.fixedCost).toBe('0');
  });

  it('should throw NotFoundError when pool does not exist', async () => {
    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      poolsById: jest.fn().mockRejectedValue({
        status: 404,
        message: 'Pool not found'
      }),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getPool('pool1nonexistent')).rejects.toThrow();
  });
});

describe('BlockfrostBackend getAddressUtxos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return UTxOs for valid address', async () => {
    const mockUtxos = [
      {
        tx_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        output_index: 0,
        address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
        amount: [
          { unit: 'lovelace', quantity: '10000000' }
        ],
        block: 'block123',
        data_hash: null
      },
      {
        tx_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        output_index: 1,
        address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
          { unit: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea546f6b656e4d', quantity: '100' }
        ],
        block: 'block456',
        data_hash: null
      }
    ];

    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      addressesUtxos: jest.fn().mockResolvedValue(mockUtxos),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAddressUtxos('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae');

    expect(result).toHaveLength(2);
    expect(result[0].txHash).toBe('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
    expect(result[0].outputIndex).toBe(0);
    expect(result[1].amount).toHaveLength(2);
  });

  it('should throw NotFoundError when address has no UTxOs', async () => {
    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      addressesUtxos: jest.fn().mockRejectedValue({
        status_code: 404,
        message: 'The requested component has not been found.'
      }),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getAddressUtxos('addr_test1empty')).rejects.toThrow(NotFoundError);
  });
});

describe('BlockfrostBackend getProtocolParameters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return protocol parameters', async () => {
    const mockProtocolParams = {
      epoch: 500,
      min_utxo: '1000000',
      nonce: 'nonce123',
      min_fee_a: 44,
      min_fee_b: 155381,
      max_tx_size: 16384,
      max_block_header_size: 1100,
      max_block_size: 65536,
      key_deposit: '2000000',
      pool_deposit: '500000000',
      e_max: 18,
      n_opt: 500,
      a0: 0.3,
      rho: 0.003,
      tau: 0.2,
      protocol_major_ver: 8,
      protocol_minor_ver: 0,
      min_pool_cost: '340000000',
      price_mem: 0.0577,
      price_step: 0.0000721,
      max_tx_ex_mem: '14000000',
      max_tx_ex_steps: '10000000000',
      max_block_ex_mem: '62000000',
      max_block_ex_steps: '20000000000',
      max_val_size: '5000',
      collateral_percent: 150,
      max_collateral_inputs: 3,
      coins_per_utxo_size: '4310',
      cost_models: {
        PlutusV3: Array(297).fill(1000)
      }
    };

    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      epochsLatestParameters: jest.fn().mockResolvedValue(mockProtocolParams),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getProtocolParameters();

    expect(result).toHaveProperty('epoch', 500);
    expect(result).toHaveProperty('minFeeA', 44);
    expect(result).toHaveProperty('minFeeB', 155381);
    expect(result).toHaveProperty('maxTxSize', 16384);
  });

  it('should normalize cost_models_raw arrays and pad V3 to 297 params', async () => {
    const mockProtocolParams = {
      epoch: 500,
      min_utxo: '1000000',
      nonce: 'nonce123',
      min_fee_a: 44,
      min_fee_b: 155381,
      max_tx_size: 16384,
      max_block_header_size: 1100,
      max_block_size: 65536,
      key_deposit: '2000000',
      pool_deposit: '500000000',
      e_max: 18,
      n_opt: 500,
      a0: 0.3,
      rho: 0.003,
      tau: 0.2,
      protocol_major_ver: 8,
      protocol_minor_ver: 0,
      min_pool_cost: '340000000',
      price_mem: 0.0577,
      price_step: 0.0000721,
      max_tx_ex_mem: '14000000',
      max_tx_ex_steps: '10000000000',
      max_block_ex_mem: '62000000',
      max_block_ex_steps: '20000000000',
      max_val_size: '5000',
      collateral_percent: 150,
      max_collateral_inputs: 3,
      coins_per_utxo_size: '4310',
      // Blockfrost now uses cost_models_raw (canonical arrays direct from node)
      cost_models_raw: {
        PlutusV3: [100, 200]
      }
    };

    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      epochsLatestParameters: jest.fn().mockResolvedValue(mockProtocolParams),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getProtocolParameters();
    const costModels = JSON.parse(result.costModels);

    expect(Array.isArray(costModels.PlutusV3)).toBe(true);
    // toCostModelArrV3 pads short arrays to 297 (Chang 2) with defaults
    expect(costModels.PlutusV3.length).toBe(297);
    expect(costModels.PlutusV3[0]).toBe(100);
    expect(costModels.PlutusV3[1]).toBe(200);
  });

  it('should throw on API error', async () => {
    const { BlockFrostAPI } = jest.requireMock('@blockfrost/blockfrost-js');
    BlockFrostAPI.mockImplementation(() => ({
      epochsLatestParameters: jest.fn().mockRejectedValue({
        status_code: 500,
        message: 'Internal server error'
      }),
      blocksLatest: jest.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }));

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getProtocolParameters()).rejects.toThrow();
  });
});
