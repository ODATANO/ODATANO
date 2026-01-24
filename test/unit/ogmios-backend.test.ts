jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('../../config/config', () => ({
  CONFIG: {
    ogmiosUrl: 'ws://localhost:1337',
    network: 'preview'
  }
}));

jest.mock('@cardano-ogmios/client', () => ({
  createInteractionContext: jest.fn(),
  createLedgerStateQueryClient: jest.fn(),
  createTransactionSubmissionClient: jest.fn()
}));

import { OgmiosBackend } from '../../srv/blockchain/backends/ogmios-backend';
import { BackendInitError } from '../../srv/utils/errors';
import { CONFIG } from '../../config/config';

describe('OgmiosBackend', () => {
  let originalOgmiosUrl: string | undefined;

  beforeEach(() => {
    originalOgmiosUrl = CONFIG.ogmiosUrl;
    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    (CONFIG as any).ogmiosUrl = originalOgmiosUrl;
  });

  describe('Constructor', () => {
    it('should create instance successfully when CONFIG.ogmiosUrl is set', () => {
      (CONFIG as any).ogmiosUrl = 'ws://localhost:1337';
      
      expect(() => new OgmiosBackend()).not.toThrow();
      
      const backend = new OgmiosBackend();
      expect(backend.name).toBe('ogmios');
    });

    it('should throw BackendInitError when CONFIG.ogmiosUrl is not set', () => {
      (CONFIG as any).ogmiosUrl = undefined;
      
      expect(() => new OgmiosBackend()).toThrow(BackendInitError);
      
      // Verify the error is about ogmios backend initialization
      try {
        new OgmiosBackend();
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(BackendInitError);
        expect((error as BackendInitError).backendName).toBe('ogmios');
      }
    });

    it('should throw BackendInitError when CONFIG.ogmiosUrl is empty string', () => {
      (CONFIG as any).ogmiosUrl = '';
      
      expect(() => new OgmiosBackend()).toThrow(BackendInitError);
    });

    it('should throw BackendInitError when CONFIG.ogmiosUrl is null', () => {
      (CONFIG as any).ogmiosUrl = null;
      
      expect(() => new OgmiosBackend()).toThrow(BackendInitError);
    });
  });

  describe('convertOgmiosValue', () => {
    let backend: OgmiosBackend;

    beforeEach(() => {
      (CONFIG as any).ogmiosUrl = 'ws://localhost:1337';
      backend = new OgmiosBackend();
    });

    it('should convert lovelace-only value correctly', () => {
      const ogmiosValue = {
        ada: { lovelace: 1000000 }
      };

      // Access private method via type assertion
      const result = (backend as any).convertOgmiosValue(ogmiosValue);

      expect(result).toEqual([
        { unit: 'lovelace', quantity: '1000000' }
      ]);
    });

    it('should convert value with native assets correctly', () => {
      const ogmiosValue = {
        ada: { lovelace: 2000000 },
        'policy123': {
          'asset1': 100,
          'asset2': 200
        }
      };

      const result = (backend as any).convertOgmiosValue(ogmiosValue);

      expect(result).toHaveLength(3);
      expect(result).toContainEqual({ unit: 'lovelace', quantity: '2000000' });
      expect(result).toContainEqual({ unit: 'policy123asset1', quantity: '100' });
      expect(result).toContainEqual({ unit: 'policy123asset2', quantity: '200' });
    });

    it('should convert multiple policies with multiple assets', () => {
      const ogmiosValue = {
        ada: { lovelace: 5000000 },
        'policyABC': {
          'tokenX': 500
        },
        'policyDEF': {
          'tokenY': 1000,
          'tokenZ': 2000
        }
      };

      const result = (backend as any).convertOgmiosValue(ogmiosValue);

      expect(result).toHaveLength(4);
      expect(result).toContainEqual({ unit: 'lovelace', quantity: '5000000' });
      expect(result).toContainEqual({ unit: 'policyABCtokenX', quantity: '500' });
      expect(result).toContainEqual({ unit: 'policyDEFtokenY', quantity: '1000' });
      expect(result).toContainEqual({ unit: 'policyDEFtokenZ', quantity: '2000' });
    });

    it('should handle value without lovelace (assets only)', () => {
      const ogmiosValue = {
        'policy456': {
          'nft1': 1
        }
      };

      const result = (backend as any).convertOgmiosValue(ogmiosValue);

      expect(result).toEqual([
        { unit: 'policy456nft1', quantity: '1' }
      ]);
    });

    it('should return only lovelace when no native assets present', () => {
      const ogmiosValue = {
        ada: { lovelace: 10000000 }
      };

      const result = (backend as any).convertOgmiosValue(ogmiosValue);

      expect(result).toEqual([
        { unit: 'lovelace', quantity: '10000000' }
      ]);
    });

    it('should handle BigInt lovelace values', () => {
      const ogmiosValue = {
        ada: { lovelace: BigInt('999999999999999') }
      };

      const result = (backend as any).convertOgmiosValue(ogmiosValue);

      expect(result).toEqual([
        { unit: 'lovelace', quantity: '999999999999999' }
      ]);
    });
  });

  describe('getAccount', () => {
    it('should return account data for valid stake address', async () => {
      const mockStateQueryClient = {
        rewardAccountSummaries: jest.fn().mockResolvedValue([{
          controlledAmount: 50000000000,
          rewards: 1500000,
          withdrawals: 500000,
          delegation: { poolId: 'pool1abc123' },
          drep: { id: 'drep1xyz456' }
        }])
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;

      const result = await backend.getAccount('stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr');

      // Ogmios queries from tip by default - no acquire/release needed
      expect(mockStateQueryClient.rewardAccountSummaries).toHaveBeenCalledWith({
        keys: ['stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr']
      });
      
      expect(result).toEqual({
        stakeaddress: 'stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr',
        active: true,
        activeEpoch: 0,
        controlledAmount: '50000000000',
        rewardsSum: '1500000',
        withdrawalsSum: '500000',
        reservesSum: '0',
        treasurySum: '0',
        withdrawableAmount: '1500000',
        poolId: 'pool1abc123',
        drepId: 'drep1xyz456',
        addresses: []
      });
    });

    it('should throw NotFoundError when account does not exist', async () => {
      const mockStateQueryClient = {
        rewardAccountSummaries: jest.fn().mockResolvedValue([])
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;

      await expect(
        backend.getAccount('stake1u8notfound')
      ).rejects.toThrow('Account');
    });

    it('should throw error when stateQueryClient is not initialized', async () => {
      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = null;

      await expect(
        backend.getAccount('stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr')
      ).rejects.toThrow('Failed to initialize backend: ogmios');
    });

    it('should handle account with no delegation or drep', async () => {
      const mockStateQueryClient = {
        rewardAccountSummaries: jest.fn().mockResolvedValue([{
          controlledAmount: 2000000,
          rewards: 0,
          withdrawals: 0
        }])
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;

      const result = await backend.getAccount('stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr');

      expect(result.poolId).toBe(null);
      expect(result.drepId).toBe(null);
      expect(result.controlledAmount).toBe('2000000');
      expect(result.rewardsSum).toBe('0');
    });
  });

  describe('shutdown', () => {
    it('should shutdown all clients and set isShutdown flag', async () => {
      const mockStateQueryClient = {
        shutdown: jest.fn().mockResolvedValue(undefined)
      };
      const mockTxSubmissionClient = {
        shutdown: jest.fn().mockResolvedValue(undefined)
      };
      const mockSocket = {
        close: jest.fn()
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      await backend.shutdown();

      expect(mockStateQueryClient.shutdown).toHaveBeenCalled();
      expect(mockTxSubmissionClient.shutdown).toHaveBeenCalled();
      expect(mockSocket.close).toHaveBeenCalled();
      expect((backend as any).isShutdown).toBe(true);
      expect((backend as any).stateQueryClient).toBe(null);
      expect((backend as any).txSubmissionClient).toBe(null);
      expect((backend as any).context).toBe(null);
    });

    it('should handle null clients during shutdown', async () => {
      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = null;
      (backend as any).txSubmissionClient = null;
      (backend as any).context = null;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
    });

    it('should be idempotent - calling shutdown twice should not throw', async () => {
      const mockStateQueryClient = {
        shutdown: jest.fn().mockResolvedValue(undefined)
      };
      const mockTxSubmissionClient = {
        shutdown: jest.fn().mockResolvedValue(undefined)
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).isShutdown = false;

      await backend.shutdown();
      await backend.shutdown(); // second call should early-return

      // shutdown methods should only be called once
      expect(mockStateQueryClient.shutdown).toHaveBeenCalledTimes(1);
      expect(mockTxSubmissionClient.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('isConnected', () => {
    it('should return true when socket is open and not shutdown', () => {
      const mockSocket = {
        readyState: 1, // OPEN
        OPEN: 1
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend();
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      expect(backend.isConnected()).toBe(true);
    });

    it('should return false when shutdown', () => {
      const mockSocket = {
        readyState: 1, // OPEN
        OPEN: 1
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend();
      (backend as any).context = mockContext;
      (backend as any).isShutdown = true;

      expect(backend.isConnected()).toBe(false);
    });

    it('should return false when socket is not open', () => {
      const mockSocket = {
        readyState: 3, // CLOSED
        OPEN: 1
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend();
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      expect(backend.isConnected()).toBe(false);
    });

    it('should return false when context is null', () => {
      const backend = new OgmiosBackend();
      (backend as any).context = null;
      (backend as any).isShutdown = false;

      // When context is null, context?.socket?.readyState is undefined
      // and context?.socket?.OPEN is also undefined
      // undefined === undefined is true, BUT we want false
      // So the implementation needs to check for null/undefined context first
      expect(backend.isConnected()).toBe(false);
    });
  });

  describe('ensureNotShutdown', () => {
    it('should not throw when client is not shutdown', () => {
      const mockStateQueryClient = {
        epoch: jest.fn().mockResolvedValue(500)
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      // Should not throw - ensureNotShutdown is synchronous
      expect(() => (backend as any).ensureNotShutdown()).not.toThrow();
    });

    it('should throw when client is shutdown', async () => {
      const backend = new OgmiosBackend();
      (backend as any).isShutdown = true;

      expect(() => (backend as any).ensureNotShutdown()).toThrow('Ogmios client has been shutdown');
    });

    it('should prevent operations after shutdown', async () => {
      const mockStateQueryClient = {
        epoch: jest.fn().mockResolvedValue(500),
        protocolParameters: jest.fn().mockResolvedValue({})
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = true;

      // getProtocolParameters should fail because ensureNotShutdown is called
      await expect(backend.getProtocolParameters()).rejects.toThrow('Ogmios client has been shutdown');
    });
  });
});
