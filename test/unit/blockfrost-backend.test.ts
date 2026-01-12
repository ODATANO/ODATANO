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
