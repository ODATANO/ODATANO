
// Mock axios
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
  })),
}));

// Mock config
jest.mock('../../config/config', () => ({
  CONFIG: {
    koiosApiUrl: 'https://preview.koios.rest/api/v1',
    koiosApiKey: 'test-key',
    blockfrostApiKey: '',
    blockfrostApiUrl: '',
    network: 'preview',
    hrp: { addr: /^addr_test/, stake: /^stake_test/ },
    primaryTimeoutMs: 5000,
    fallbackTimeoutMs: 3000,
    indexTtlMs: 60000,
    logLevel: 'info',
    backends: ['koios'],
  },
}));

// Mock logger
jest.mock('../../srv/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

describe('KoiosBackend', () => {
  let KoiosBackend: any;
  let koiosBackend: any;
  let mockAxios: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    const axios = require('axios');
    mockAxios = {
      get: jest.fn(),
      post: jest.fn(),
    };
    axios.create.mockReturnValue(mockAxios);

    KoiosBackend = require('../../srv/blockchain/backends/koios-backend').KoiosBackend;
    koiosBackend = new KoiosBackend();
  });

  describe('getLatestBlock', () => {
    it('should throw NotFoundError when tip data is null', async () => {
      // Mock null tip response to trigger line 526
      mockAxios.get.mockResolvedValueOnce({ data: null });

      await expect(koiosBackend.getLatestBlock()).rejects.toThrow('Latest Block');
    });
  });
});
