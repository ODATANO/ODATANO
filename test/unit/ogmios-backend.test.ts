jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('@cardano-ogmios/client', () => ({
  createInteractionContext: jest.fn(),
  createLedgerStateQueryClient: jest.fn(),
  createTransactionSubmissionClient: jest.fn()
}));

import { OgmiosBackend } from '../../srv/blockchain/backends/ogmios-backend';
import { BackendInitError } from '../../srv/utils/errors';

describe('OgmiosBackend', () => {
  const NETWORK = 'preview' as const;
  const TIMEOUT_MS = 5000;
  const OGMIOS_URL = 'ws://localhost:1337';

  describe('Constructor', () => {
    it('should create instance successfully when ogmiosUrl is provided', () => {
      expect(() => new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL)).not.toThrow();

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      expect(backend.name).toBe('ogmios');
    });

    it('should throw BackendInitError when ogmiosUrl is not provided', () => {
      expect(() => new OgmiosBackend(NETWORK, TIMEOUT_MS, '')).toThrow(BackendInitError);

      // Verify the error is about ogmios backend initialization
      try {
        new OgmiosBackend(NETWORK, TIMEOUT_MS, '');
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(BackendInitError);
        expect((error as BackendInitError).backendName).toBe('ogmios');
      }
    });

    it('should throw BackendInitError when ogmiosUrl is empty string', () => {
      expect(() => new OgmiosBackend(NETWORK, TIMEOUT_MS, '')).toThrow(BackendInitError);
    });
  });

  describe('convertOgmiosValue', () => {
    let backend: OgmiosBackend;

    beforeEach(() => {
      backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;

      await expect(
        backend.getAccount('stake1u8notfound')
      ).rejects.toThrow('Account');
    });

    it('should throw error when stateQueryClient is not initialized', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
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

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      expect(backend.isConnected()).toBe(false);
    });

    it('should return false when context is null', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).context = null;
      (backend as any).isShutdown = false;

      expect(backend.isConnected()).toBe(false);
    });
  });

  describe('ensureNotShutdown', () => {
    it('should not throw when client is not shutdown', () => {
      const mockStateQueryClient = {
        epoch: jest.fn().mockResolvedValue(500)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      expect(() => (backend as any).ensureNotShutdown()).not.toThrow();
    });

    it('should throw when client is shutdown', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).isShutdown = true;

      expect(() => (backend as any).ensureNotShutdown()).toThrow('Ogmios client has been shutdown');
    });

    it('should prevent operations after shutdown', async () => {
      const mockStateQueryClient = {
        epoch: jest.fn().mockResolvedValue(500),
        protocolParameters: jest.fn().mockResolvedValue({})
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = true;

      await expect(backend.getProtocolParameters()).rejects.toThrow('Ogmios client has been shutdown');
    });
  });

  describe('submitTransaction', () => {
    it('should submit a transaction and return the transaction hash', async () => {
      const mockTxHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const mockTxSubmissionClient = {
        submitTransaction: jest.fn().mockResolvedValue(mockTxHash)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).isShutdown = false;

      const signedTxCbor = '84a300818258201234567890abcdef';
      const result = await backend.submitTransaction(signedTxCbor);

      expect(result).toBe(mockTxHash);
      expect(mockTxSubmissionClient.submitTransaction).toHaveBeenCalledWith(signedTxCbor);
    });

    it('should throw error when backend is shutdown', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).isShutdown = true;

      await expect(backend.submitTransaction('84a300818258201234567890abcdef'))
        .rejects.toThrow('Ogmios client has been shutdown');
    });

    it('should throw error when txSubmissionClient is not initialized', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).txSubmissionClient = null;
      (backend as any).isShutdown = false;

      await expect(backend.submitTransaction('84a300818258201234567890abcdef'))
        .rejects.toThrow();
    });
  });

  describe('evaluateTransaction', () => {
    it('should evaluate a transaction and return execution budgets', async () => {
      const mockEvaluationResult = [
        {
          validator: { purpose: 'spend', index: 0 },
          budget: { memory: 500000, cpu: 200000000 }
        }
      ];

      const mockTxSubmissionClient = {
        evaluateTransaction: jest.fn().mockResolvedValue(mockEvaluationResult)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).isShutdown = false;

      const unsignedTxCbor = '84a400818258201234567890abcdef';
      const result = await backend.evaluateTransaction(unsignedTxCbor);

      expect(result).toEqual(mockEvaluationResult);
      expect(mockTxSubmissionClient.evaluateTransaction).toHaveBeenCalledWith(unsignedTxCbor);
    });

    it('should return multiple validator budgets for multi-script tx', async () => {
      const mockEvaluationResult = [
        { validator: { purpose: 'spend', index: 0 }, budget: { memory: 500000, cpu: 200000000 } },
        { validator: { purpose: 'mint', index: 0 }, budget: { memory: 300000, cpu: 150000000 } }
      ];

      const mockTxSubmissionClient = {
        evaluateTransaction: jest.fn().mockResolvedValue(mockEvaluationResult)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).isShutdown = false;

      const result = await backend.evaluateTransaction('84a400818258201234567890abcdef');

      expect(result).toHaveLength(2);
      expect(result[0].budget.memory).toBe(500000);
      expect(result[1].validator.purpose).toBe('mint');
    });

    it('should throw error when backend is shutdown', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).isShutdown = true;

      await expect(backend.evaluateTransaction('84a400818258201234567890abcdef'))
        .rejects.toThrow('Ogmios client has been shutdown');
    });

    it('should throw error when txSubmissionClient is not initialized', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).txSubmissionClient = null;
      (backend as any).isShutdown = false;

      await expect(backend.evaluateTransaction('84a400818258201234567890abcdef'))
        .rejects.toThrow();
    });

    it('should propagate evaluation errors from ogmios', async () => {
      const mockTxSubmissionClient = {
        evaluateTransaction: jest.fn().mockRejectedValue(
          new Error('Script execution failed: validation error')
        )
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).isShutdown = false;

      await expect(backend.evaluateTransaction('84a400818258201234567890abcdef'))
        .rejects.toThrow('Script execution failed');
    });
  });

  describe('shutdown error handling', () => {
    it('should handle error when stateQueryClient.shutdown fails', async () => {
      const mockStateQueryClient = {
        shutdown: jest.fn().mockRejectedValue(new Error('Shutdown failed'))
      };
      const mockTxSubmissionClient = {
        shutdown: jest.fn().mockResolvedValue(undefined)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).context = null;
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
    });

    it('should handle error when txSubmissionClient.shutdown fails', async () => {
      const mockStateQueryClient = {
        shutdown: jest.fn().mockResolvedValue(undefined)
      };
      const mockTxSubmissionClient = {
        shutdown: jest.fn().mockRejectedValue(new Error('TX client shutdown failed'))
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).context = null;
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
    });

    it('should handle error when socket.close fails', async () => {
      const mockSocket = {
        close: jest.fn().mockImplementation(() => {
          throw new Error('Socket close failed');
        })
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = null;
      (backend as any).txSubmissionClient = null;
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
    });

    it('should handle all shutdown errors simultaneously', async () => {
      const mockStateQueryClient = {
        shutdown: jest.fn().mockRejectedValue(new Error('State query shutdown failed'))
      };
      const mockTxSubmissionClient = {
        shutdown: jest.fn().mockRejectedValue(new Error('TX submission shutdown failed'))
      };
      const mockSocket = {
        close: jest.fn().mockImplementation(() => {
          throw new Error('Socket close failed');
        })
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).txSubmissionClient = mockTxSubmissionClient;
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
      expect((backend as any).stateQueryClient).toBe(null);
      expect((backend as any).txSubmissionClient).toBe(null);
      expect((backend as any).context).toBe(null);
    });
  });

  // Note: createInteractionContext, getAddressUtxos, and getProtocolParameters error handling
  // is tested through BackendInitError in init() tests - the underlying Ogmios client
  // errors are wrapped and thrown appropriately by the backend implementation.
});
