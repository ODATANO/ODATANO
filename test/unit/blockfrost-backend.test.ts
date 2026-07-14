import { BlockFrostAPI as BlockFrostAPIActual } from '@blockfrost/blockfrost-js';
import { BlockfrostBackend } from '../../srv/blockchain/backends/blockfrost-backend';
import { BackendInitError, NotFoundError, ProviderUnavailableError } from '../../srv/utils/errors';

// Mock the BlockFrostAPI
vi.mock('@blockfrost/blockfrost-js', () => {
  const mockBlockFrostAPI = vi.fn().mockImplementation(function () { return {
    txSubmit: vi.fn(),
    poolsById: vi.fn(),
    blocksLatest: vi.fn(),
    addressesUtxosAll: vi.fn(),
    assetsById: vi.fn(),
    assetsHistory: vi.fn(),
    txs: vi.fn(),
    epochsLatestParameters: vi.fn(),
    options: { requestTimeout: 0 },
  }; });
  return { BlockFrostAPI: mockBlockFrostAPI };
});

// Shared handle on the mocked constructor (replaces the per-test
// jest.requireMock('@blockfrost/blockfrost-js') lookups).
const BlockFrostAPI = vi.mocked(BlockFrostAPIActual);

const NETWORK = 'preview' as const;
const TIMEOUT_MS = 5000;

describe('BlockfrostBackend constructor', () => {
  beforeEach(() => {
    BlockFrostAPI.mockClear();
  });

  it('throws BackendInitError when both projectId AND customBackend are missing', () => {
    expect(() => new BlockfrostBackend(NETWORK, TIMEOUT_MS, '')).toThrow(BackendInitError);
    try {
      new BlockfrostBackend(NETWORK, TIMEOUT_MS, '');
    } catch (err: any) {
      expect(err.originalError?.message).toMatch(/Either projectId .* or customBackend .* is required/i);
    }
  });

  it('creates backend successfully with valid projectId', () => {
    expect(() => new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key')).not.toThrow();
  });

  it('creates backend successfully with customBackend only (no projectId)', () => {
    expect(() => new BlockfrostBackend(NETWORK, TIMEOUT_MS, '', 'http://localhost:3010/api/v0')).not.toThrow();
  });

  it('forwards customBackend into the BlockFrostAPI constructor', () => {
    new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key', 'http://demeter.example/v0');
    expect(BlockFrostAPI).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'test-key',
        network: NETWORK,
        customBackend: 'http://demeter.example/v0',
      }),
    );
  });

  it("substitutes 'self-hosted' projectId when customBackend is set without a key", () => {
    new BlockfrostBackend(NETWORK, TIMEOUT_MS, '', 'http://localhost:3010/api/v0');
    expect(BlockFrostAPI).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'self-hosted',
        customBackend: 'http://localhost:3010/api/v0',
      }),
    );
  });

  it('omits customBackend from SDK options when not provided', () => {
    new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    const callArgs = BlockFrostAPI.mock.calls[0][0]!;
    expect(callArgs).not.toHaveProperty('customBackend');
    expect(callArgs.projectId).toBe('test-key');
  });
});

describe('BlockfrostBackend submitTransaction mock test', () => {
  it('should submit a transaction and return the transaction hash', async () => {
    const mockTxHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    BlockFrostAPI.mockImplementation(function () { return {
      txSubmit: vi.fn().mockResolvedValue(mockTxHash),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const signedTxCbor = '84a300818258201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef00018182581d60abcdef1234567890abcdef1234567890abcdef1234567890abcdef12341a000f4240021a0002a389a0f6';

    const result = await backend.submitTransaction(signedTxCbor);
    expect(result).toBe(mockTxHash);
  });
});

describe('BlockfrostBackend getPool mock test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    BlockFrostAPI.mockImplementation(function () { return {
      poolsById: vi.fn().mockResolvedValue(mockPoolData),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

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

    BlockFrostAPI.mockImplementation(function () { return {
      poolsById: vi.fn().mockResolvedValue(mockPoolData),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getPool('pool1minimal');

    expect(result.liveStake).toBe('0');
    expect(result.activeStake).toBe('0');
    expect(result.pledge).toBe('0');
    expect(result.fixedCost).toBe('0');
  });

  it('should throw NotFoundError when pool does not exist', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      poolsById: vi.fn().mockRejectedValue({
        status: 404,
        message: 'Pool not found'
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getPool('pool1nonexistent')).rejects.toThrow();
  });
});

describe('BlockfrostBackend getAddressUtxos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    BlockFrostAPI.mockImplementation(function () { return {
      addressesUtxosAll: vi.fn().mockResolvedValue(mockUtxos),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAddressUtxos('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae');

    expect(result).toHaveLength(2);
    expect(result[0].txHash).toBe('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
    expect(result[0].outputIndex).toBe(0);
    expect(result[1].amount).toHaveLength(2);
  });

  it('should throw NotFoundError when address has no UTxOs', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      addressesUtxosAll: vi.fn().mockRejectedValue({
        status_code: 404,
        message: 'The requested component has not been found.'
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getAddressUtxos('addr_test1empty')).rejects.toThrow(NotFoundError);
  });

  it('should hydrate inlineDatum and reference_script_hash when present', async () => {
    const ADDR = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
    const mockUtxos = [
      {
        tx_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        output_index: 0,
        address: ADDR,
        amount: [{ unit: 'lovelace', quantity: '10000000' }],
        block: 'block123',
        data_hash: null,
        inline_datum: '19a6aa',
        reference_script_hash: '13a3efd825703a352a8f71f4e2758d08c28c564e8dfcce9f77776ad1',
      },
      {
        tx_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        output_index: 1,
        address: ADDR,
        amount: [{ unit: 'lovelace', quantity: '5000000' }],
        block: 'block456',
        data_hash: null,
        inline_datum: null,
        reference_script_hash: null,
      },
    ];

    BlockFrostAPI.mockImplementation(function () { return {
      addressesUtxosAll: vi.fn().mockResolvedValue(mockUtxos),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAddressUtxos(ADDR);

    expect(result).toHaveLength(2);
    expect(result[0].inlineDatum).toBe('19a6aa');
    expect(result[0].scriptRef).toBe('13a3efd825703a352a8f71f4e2758d08c28c564e8dfcce9f77776ad1');
    expect(result[1].inlineDatum).toBeNull();
    expect(result[1].scriptRef).toBeNull();
  });

  it('should return null inlineDatum for plain UTxOs (regression)', async () => {
    const ADDR = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
    const mockUtxos = [
      {
        tx_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        output_index: 0,
        address: ADDR,
        amount: [{ unit: 'lovelace', quantity: '10000000' }],
        block: 'block123',
        data_hash: null,
      },
    ];

    BlockFrostAPI.mockImplementation(function () { return {
      addressesUtxosAll: vi.fn().mockResolvedValue(mockUtxos),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAddressUtxos(ADDR);

    expect(result).toHaveLength(1);
    expect(result[0].inlineDatum).toBeNull();
  });
});

describe('BlockfrostBackend getAddressTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should preserve requested order and skip hashes missing from batch result', async () => {
    const txHashA = 'a'.repeat(64);
    const txHashB = 'b'.repeat(64);
    const txHashC = 'c'.repeat(64);

    BlockFrostAPI.mockImplementation(function () { return {
      addressesTransactions: vi.fn().mockResolvedValue([
        { tx_hash: txHashB },
        { tx_hash: txHashA },
        { tx_hash: txHashC },
      ]),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const txA = { hash: txHashA } as any;
    const txC = { hash: txHashC } as any;
    const batchSpy = vi.spyOn(backend, 'getTransactionsBatch').mockResolvedValue(
      new Map<string, any>([
        [txHashA, txA],
        [txHashC, txC],
      ])
    );

    const result = await backend.getAddressTransactions('addr_test1qexample', 3);

    expect(batchSpy).toHaveBeenCalledWith([txHashB, txHashA, txHashC]);
    expect(result).toEqual([txA, txC]);
  });
});

describe('BlockfrostBackend getProtocolParameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    BlockFrostAPI.mockImplementation(function () { return {
      epochsLatestParameters: vi.fn().mockResolvedValue(mockProtocolParams),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

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

    BlockFrostAPI.mockImplementation(function () { return {
      epochsLatestParameters: vi.fn().mockResolvedValue(mockProtocolParams),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

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
    BlockFrostAPI.mockImplementation(function () { return {
      epochsLatestParameters: vi.fn().mockRejectedValue({
        status_code: 500,
        message: 'Internal server error'
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'block123' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getProtocolParameters()).rejects.toThrow();
  });
});

describe('BlockfrostBackend getAssetInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const POLICY = 'a'.repeat(56);
  const ASSET_NAME_HEX = '484f534b59'; // "HOSKY"
  const UNIT = POLICY + ASSET_NAME_HEX;

  it('maps full Blockfrost response to canonical AssetInfo', async () => {
    const mockResponse = {
      asset: UNIT,
      policy_id: POLICY,
      asset_name: ASSET_NAME_HEX,
      fingerprint: 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w',
      quantity: '1000000000',
      initial_mint_tx_hash: 'b'.repeat(64),
      mint_or_burn_count: 7,
      onchain_metadata: { name: 'Hosky', image: 'ipfs://...' },
      onchain_metadata_standard: 'CIP25v2',
      metadata: {
        name: 'Hosky Token',
        ticker: 'HOSKY',
        decimals: 0,
        description: 'Wow such token',
        url: 'https://hosky.io',
        logo: 'iVBORw0KGgo...',
      },
    };

    BlockFrostAPI.mockImplementation(function () { return {
      assetsById: vi.fn().mockResolvedValue(mockResponse),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAssetInfo(UNIT);

    expect(result).toEqual({
      unit: UNIT,
      policyId: POLICY,
      assetNameHex: ASSET_NAME_HEX,
      assetName: 'HOSKY',
      fingerprint: 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w',
      totalSupply: '1000000000',
      mintOrBurnCount: 7,
      initialMintTxHash: 'b'.repeat(64),
      initialMintTime: null, // Blockfrost does not expose
      onchainMetadata: { name: 'Hosky', image: 'ipfs://...' },
      registryName: 'Hosky Token',
      registryTicker: 'HOSKY',
      registryDecimals: 0,
      registryDescription: 'Wow such token',
      registryUrl: 'https://hosky.io',
      registryLogo: 'iVBORw0KGgo...',
    });
  });

  it('handles asset without registry metadata (null fields)', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      assetsById: vi.fn().mockResolvedValue({
        asset: UNIT,
        policy_id: POLICY,
        asset_name: ASSET_NAME_HEX,
        fingerprint: 'asset1xyz',
        quantity: '1',
        initial_mint_tx_hash: 'c'.repeat(64),
        mint_or_burn_count: 1,
        onchain_metadata: null,
        metadata: null,
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();
    const result = await backend.getAssetInfo(UNIT);

    expect(result.registryName).toBeNull();
    expect(result.onchainMetadata).toBeNull();
    expect(result.totalSupply).toBe('1');
  });

  it('throws NotFoundError when asset does not exist', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      assetsById: vi.fn().mockRejectedValue({
        status_code: 404,
        message: 'The requested component has not been found.',
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getAssetInfo(UNIT)).rejects.toThrow(NotFoundError);
  });
});

describe('BlockfrostBackend getAssetHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const POLICY = 'a'.repeat(56);
  const UNIT = POLICY + '484f534b59';

  it('maps actions and backfills blockTime/blockHeight via api.txs', async () => {
    const TX1 = 'b'.repeat(64);
    const TX2 = 'c'.repeat(64);
    const mockHistory = [
      { tx_hash: TX1, action: 'minted', amount: '1000' },
      { tx_hash: TX2, action: 'burned', amount: '50' },
    ];

    let captured: any = null;
    const txsMock = vi.fn((hash: string) => {
      if (hash === TX1) return Promise.resolve({ block_time: 1700000200, block_height: 200 });
      if (hash === TX2) return Promise.resolve({ block_time: 1700000100, block_height: 199 });
      return Promise.reject(new Error('unknown tx'));
    });
    BlockFrostAPI.mockImplementation(function () { return {
      assetsHistory: vi.fn((asset: string, opts: any) => {
        captured = { asset, opts };
        return Promise.resolve(mockHistory);
      }),
      txs: txsMock,
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAssetHistory(UNIT);

    expect(captured.asset).toBe(UNIT);
    expect(captured.opts).toMatchObject({ order: 'desc', count: 100 });
    expect(txsMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { unit: UNIT, txHash: TX1, action: 'mint', quantity: '1000', blockTime: 1700000200, blockHeight: 200 },
      { unit: UNIT, txHash: TX2, action: 'burn', quantity: '50',   blockTime: 1700000100, blockHeight: 199 },
    ]);
  });

  it('leaves blockTime/blockHeight null when tx-fetch fails (best-effort)', async () => {
    const TX1 = 'b'.repeat(64);
    BlockFrostAPI.mockImplementation(function () { return {
      assetsHistory: vi.fn().mockResolvedValue([
        { tx_hash: TX1, action: 'minted', amount: '1' },
      ]),
      txs: vi.fn().mockRejectedValue({ status_code: 500, message: 'temporary' }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAssetHistory(UNIT);
    expect(result).toHaveLength(1);
    expect(result[0].blockTime).toBeNull();
    expect(result[0].blockHeight).toBeNull();
    // Action and quantity still mapped correctly
    expect(result[0].action).toBe('mint');
    expect(result[0].quantity).toBe('1');
  });

  it('clamps limit to [1, 100]', async () => {
    let captured: any = null;
    BlockFrostAPI.mockImplementation(function () { return {
      assetsHistory: vi.fn((asset: string, opts: any) => {
        captured = opts;
        return Promise.resolve([]);
      }),
      txs: vi.fn(),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await backend.getAssetHistory(UNIT, 500);
    expect(captured.count).toBe(100);

    await backend.getAssetHistory(UNIT, 0);
    expect(captured.count).toBe(1);
  });

  it('returns empty array when no history exists', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      assetsHistory: vi.fn().mockResolvedValue([]),
      txs: vi.fn(),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'b' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const result = await backend.getAssetHistory(UNIT);
    expect(result).toEqual([]);
  });
});

describe('BlockfrostBackend getCurrentSlot', () => {
  it('returns the slot from getLatestBlock', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h', slot: 80_000_000 }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    const slot = await backend.getCurrentSlot();
    expect(slot).toBe(80_000_000);
  });

  it('throws ProviderUnavailableError when latest block has no slot', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h', slot: null }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.getCurrentSlot()).rejects.toThrow(ProviderUnavailableError);
  });
});

describe('BlockfrostBackend isUtxoUnspent', () => {
  const TX = 'a'.repeat(64);

  it('returns true when consumed_by_tx is null', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos: vi.fn().mockResolvedValue({
        outputs: [{ output_index: 0, consumed_by_tx: null }],
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    expect(await backend.isUtxoUnspent(TX, 0)).toBe(true);
  });

  it('returns false when consumed_by_tx is a tx hash', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos: vi.fn().mockResolvedValue({
        outputs: [{ output_index: 0, consumed_by_tx: 'b'.repeat(64) }],
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    expect(await backend.isUtxoUnspent(TX, 0)).toBe(false);
  });

  it('matches by output_index regardless of array order', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos: vi.fn().mockResolvedValue({
        outputs: [
          { output_index: 1, consumed_by_tx: 'b'.repeat(64) },
          { output_index: 0, consumed_by_tx: null },
        ],
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    expect(await backend.isUtxoUnspent(TX, 0)).toBe(true);
    expect(await backend.isUtxoUnspent(TX, 1)).toBe(false);
  });

  it('returns false for out-of-range outputIndex', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos: vi.fn().mockResolvedValue({
        outputs: [{ output_index: 0, consumed_by_tx: null }],
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    expect(await backend.isUtxoUnspent(TX, 99)).toBe(false);
  });

  it('returns false for negative outputIndex without making a network call', async () => {
    const txsUtxos = vi.fn();
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos,
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    expect(await backend.isUtxoUnspent(TX, -1)).toBe(false);
    expect(txsUtxos).not.toHaveBeenCalled();
  });

  it('returns false when tx is 404 (never on chain)', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos: vi.fn().mockRejectedValue({ status_code: 404, message: 'not found' }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    expect(await backend.isUtxoUnspent(TX, 0)).toBe(false);
  });

  it('throws ProviderUnavailableError when consumed_by_tx field is absent (older server)', async () => {
    BlockFrostAPI.mockImplementation(function () { return {
      txsUtxos: vi.fn().mockResolvedValue({
        outputs: [{ output_index: 0 }], // no consumed_by_tx key
      }),
      blocksLatest: vi.fn().mockResolvedValue({ hash: 'h' }),
      options: { requestTimeout: 0 },
    }; });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'test-key');
    await backend.init();

    await expect(backend.isUtxoUnspent(TX, 0)).rejects.toThrow(ProviderUnavailableError);
  });
});
