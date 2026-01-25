jest.mock('@blockfrost/blockfrost-js', () => {
  const BlockFrostAPI = jest.fn().mockImplementation(() => ({}));
  return { BlockFrostAPI };
});

describe('BlockfrostBackend constructor Error Test', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('throws BackendInitError when BLOCKFROST_KEY is missing', () => {
    // Mock config to force empty key irrespective of env/.env
    jest.isolateModules(() => {
      jest.doMock('../../config/config', () => ({
        CONFIG: {
          blockfrostApiKey: '',
          blockfrostApiUrl: '',
          koiosApiUrl: '',
          koiosApiKey: '',
          network: 'preview',
          hrp: { addr: /^$/, stake: /^$/ },
          primaryTimeoutMs: 0,
          fallbackTimeoutMs: 0,
          indexTtlMs: 0,
          logLevel: 'info',
          backends: ['blockfrost'],
        },
      }));

      const { BlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');

      try {
        new BlockfrostBackend();
        throw new Error('Expected constructor to throw');
      } catch (err) {
        expect((err as any).name).toBe('BackendInitError');
        expect((err as Error).message).toMatch(/Failed to initialize backend: blockfrost/);
        expect((err as any).originalError?.message).toMatch(/blockfrostApiKey is not set/i);
      }
    });
  });
});

describe('BlockfrostBackend submitTransaction mock test', () => {
  it('should submit a transaction and return the transaction hash', async () => {
    const mockTxHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const mockTxSubmit = jest.fn().mockResolvedValue(mockTxHash);

    jest.isolateModules(() => {
      jest.doMock('@blockfrost/blockfrost-js', () => ({
        BlockFrostAPI: jest.fn().mockImplementation(() => ({
          txSubmit: mockTxSubmit,
        })),
      }));

      jest.doMock('../../config/config', () => ({
        CONFIG: {
          blockfrostApiKey: 'test-key',
          blockfrostApiUrl: 'https://cardano-preview.blockfrost.io/api/v0',
          koiosApiUrl: '',
          koiosApiKey: '',
          network: 'preview',
          hrp: { addr: /^addr_test/, stake: /^stake_test/ },
          primaryTimeoutMs: 5000,
          fallbackTimeoutMs: 3000,
          indexTtlMs: 60000,
          logLevel: 'info',
          backends: ['blockfrost'],
        },
      }));
    });

    const { BlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');
    const backend = new BlockfrostBackend();

    const signedTxCbor = '84a300818258201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef00018182581d60abcdef1234567890abcdef1234567890abcdef1234567890abcdef12341a000f4240021a0002a389a0f6';

    const result = await backend.submitTransaction(signedTxCbor);

    expect(result).toBe(mockTxHash);
    expect(mockTxSubmit).toHaveBeenCalledWith(Buffer.from(signedTxCbor, 'hex'));
  });
});

describe('BlockfrostBackend getPool mock test', () => {
  beforeEach(() => {
    jest.resetModules();
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

    const mockPoolsById = jest.fn().mockResolvedValue(mockPoolData);

    jest.doMock('@blockfrost/blockfrost-js', () => ({
      BlockFrostAPI: jest.fn().mockImplementation(() => ({
        poolsById: mockPoolsById,
      })),
    }));

    jest.doMock('../../config/config', () => ({
      CONFIG: {
        blockfrostApiKey: 'test-key',
        blockfrostApiUrl: 'https://cardano-preview.blockfrost.io/api/v0',
        network: 'preview',
        hrp: { addr: /^addr_test/, stake: /^stake_test/ },
        primaryTimeoutMs: 5000,
        fallbackTimeoutMs: 3000,
        indexTtlMs: 60000,
        logLevel: 'info',
        backends: ['blockfrost'],
      },
    }));

    const { BlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');
    const backend = new BlockfrostBackend();

    const result = await backend.getPool('pool1abc123def456');

    expect(mockPoolsById).toHaveBeenCalledWith('pool1abc123def456');
    expect(result).toEqual({
      poolId: 'pool1abc123def456',
      vrfKeyHash: 'vrf_vk1abc123',
      blocksMinted: 1000,
      blocksEpoch: 10,
      liveStake: 50000000000000,
      liveSize: 0.05,
      liveDelegators: 500,
      liveSaturation: 0.75,
      activeStake: 45000000000000,
      activeSize: 0.045,
      pledge: 1000000000000,
      margin: 0.02,
      fixedCost: 340000000,
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

    const mockPoolsById = jest.fn().mockResolvedValue(mockPoolData);

    jest.doMock('@blockfrost/blockfrost-js', () => ({
      BlockFrostAPI: jest.fn().mockImplementation(() => ({
        poolsById: mockPoolsById,
      })),
    }));

    jest.doMock('../../config/config', () => ({
      CONFIG: {
        blockfrostApiKey: 'test-key',
        blockfrostApiUrl: 'https://cardano-preview.blockfrost.io/api/v0',
        network: 'preview',
        hrp: { addr: /^addr_test/, stake: /^stake_test/ },
        primaryTimeoutMs: 5000,
        fallbackTimeoutMs: 3000,
        indexTtlMs: 60000,
        logLevel: 'info',
        backends: ['blockfrost'],
      },
    }));

    const { BlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');
    const backend = new BlockfrostBackend();

    const result = await backend.getPool('pool1minimal');

    expect(result.liveStake).toBe(0);
    expect(result.activeStake).toBe(0);
    expect(result.pledge).toBe(0);
    expect(result.fixedCost).toBe(0);
  });

  it('should throw NotFoundError when pool does not exist', async () => {
    const mockPoolsById = jest.fn().mockRejectedValue({
      status: 404,
      message: 'Pool not found'
    });

    jest.doMock('@blockfrost/blockfrost-js', () => ({
      BlockFrostAPI: jest.fn().mockImplementation(() => ({
        poolsById: mockPoolsById,
      })),
    }));

    jest.doMock('../../config/config', () => ({
      CONFIG: {
        blockfrostApiKey: 'test-key',
        blockfrostApiUrl: 'https://cardano-preview.blockfrost.io/api/v0',
        network: 'preview',
        hrp: { addr: /^addr_test/, stake: /^stake_test/ },
        primaryTimeoutMs: 5000,
        fallbackTimeoutMs: 3000,
        indexTtlMs: 60000,
        logLevel: 'info',
        backends: ['blockfrost'],
      },
    }));

    const { BlockfrostBackend } = require('../../srv/blockchain/backends/blockfrost-backend');
    const backend = new BlockfrostBackend();

    await expect(backend.getPool('pool1nonexistent')).rejects.toThrow();
  });
});
