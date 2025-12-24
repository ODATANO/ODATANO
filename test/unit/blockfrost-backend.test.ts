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
