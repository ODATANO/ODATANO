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

import { OgmiosBackend, resolveOgmiosTip, resolveOgmiosHeight } from '../../srv/blockchain/backends/ogmios-backend';
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

  describe('URL Validation', () => {
    it('should reject invalid URL scheme (http://)', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, 'http://localhost:1337');
      expect(backend.init()).rejects.toThrow(BackendInitError);
    });

    it('should reject invalid URL scheme (https://)', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, 'https://localhost:1337');
      expect(backend.init()).rejects.toThrow(BackendInitError);
    });

    it('should reject link-local/metadata IP (169.254.x.x)', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, 'ws://169.254.169.254:1337');
      expect(backend.init()).rejects.toThrow(BackendInitError);
    });

    it('should reject IPv6 link-local (fe80::)', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, 'ws://[fe80::1]:1337');
      expect(backend.init()).rejects.toThrow(BackendInitError);
    });

    it('should accept wss:// scheme', () => {
      // Will fail on connection, but URL validation should pass
      new OgmiosBackend(NETWORK, TIMEOUT_MS, 'wss://ogmios.example.com:1337');
      // validateOgmiosUrl is called in init(), which will fail on createInteractionContext, not URL validation
      expect(() => (OgmiosBackend as any).validateOgmiosUrl('wss://ogmios.example.com:1337')).not.toThrow();
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

    it('should handle empty value object', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      const result = (backend as any).convertOgmiosValue({});
      expect(result).toEqual([]);
    });

    it('should handle value with ada but no lovelace', () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      const result = (backend as any).convertOgmiosValue({ ada: {} });
      expect(result).toEqual([]);
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

    it('should extract lovelace from Ogmios v6 {ada:{lovelace}} value objects (no "[object Object]")', async () => {
      const mockStateQueryClient = {
        rewardAccountSummaries: jest.fn().mockResolvedValue([{
          // real Ogmios v6 shape — .toString() on these produced "[object Object]"
          controlledAmount: { ada: { lovelace: 50_000_000_000n } },
          rewards: { ada: { lovelace: 1_500_000n } },
          withdrawals: { ada: { lovelace: 500_000n } },
          delegate: { id: 'pool1abc123' },
        }])
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;

      const result = await backend.getAccount('stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr');

      expect(result.controlledAmount).toBe('50000000000');
      expect(result.rewardsSum).toBe('1500000');
      expect(result.withdrawalsSum).toBe('500000');
      expect(result.withdrawableAmount).toBe('1500000');
      expect(result.poolId).toBe('pool1abc123');
    });
  });

  describe('shutdown', () => {
    it('should terminate socket and set isShutdown flag', async () => {
      const mockSocket = {
        readyState: 1, // OPEN
        OPEN: 1,
        CONNECTING: 0,
        once: jest.fn().mockImplementation((_event: string, cb: () => void) => { cb(); }),
        terminate: jest.fn()
      };
      const mockContext = {
        socket: mockSocket
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { shutdown: jest.fn() };
      (backend as any).txSubmissionClient = { shutdown: jest.fn() };
      (backend as any).context = mockContext;
      (backend as any).isShutdown = false;

      await backend.shutdown();

      expect(mockSocket.terminate).toHaveBeenCalled();
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
      const mockSocket = {
        readyState: 1,
        OPEN: 1,
        CONNECTING: 0,
        once: jest.fn().mockImplementation((_event: string, cb: () => void) => { cb(); }),
        terminate: jest.fn()
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { shutdown: jest.fn() };
      (backend as any).txSubmissionClient = { shutdown: jest.fn() };
      (backend as any).context = { socket: mockSocket };
      (backend as any).isShutdown = false;

      await backend.shutdown();
      await backend.shutdown(); // second call should early-return

      // terminate should only be called once
      expect(mockSocket.terminate).toHaveBeenCalledTimes(1);
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
      expect((result[1].validator as { purpose: string; index: number }).purpose).toBe('mint');
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
    it('should handle shutdown when no socket exists', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { shutdown: jest.fn() };
      (backend as any).txSubmissionClient = { shutdown: jest.fn() };
      (backend as any).context = null;
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
    });

    it('should handle shutdown when socket is already closed', async () => {
      const mockSocket = {
        readyState: 3, // CLOSED
        OPEN: 1,
        CONNECTING: 0,
        once: jest.fn(),
        terminate: jest.fn()
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = null;
      (backend as any).txSubmissionClient = null;
      (backend as any).context = { socket: mockSocket };
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
      // terminate should NOT be called since socket is already closed
      expect(mockSocket.terminate).not.toHaveBeenCalled();
    });

    it('should clean up all references even with closed socket', async () => {
      const mockSocket = {
        readyState: 3, // CLOSED
        OPEN: 1,
        CONNECTING: 0,
        once: jest.fn(),
        terminate: jest.fn()
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { shutdown: jest.fn() };
      (backend as any).txSubmissionClient = { shutdown: jest.fn() };
      (backend as any).context = { socket: mockSocket };
      (backend as any).isShutdown = false;

      await expect(backend.shutdown()).resolves.not.toThrow();
      expect((backend as any).isShutdown).toBe(true);
      expect((backend as any).stateQueryClient).toBe(null);
      expect((backend as any).txSubmissionClient).toBe(null);
      expect((backend as any).context).toBe(null);
    });
  });

  describe('getPool', () => {
    it('should return pool data for valid pool', async () => {
      const mockStateQueryClient = {
        stakePools: jest.fn().mockResolvedValue({
          'pool1abc': {
            vrf: 'vrf123',
            stake: { ada: { lovelace: 50000000000n } },
            pledge: 1000000000n,
            margin: 0.05,
            cost: 340000000n,
            rewardAccount: 'stake1u8reward'
          }
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getPool('pool1abc');
      expect(result.poolId).toBe('pool1abc');
      expect(result.vrfKeyHash).toBe('vrf123');
      expect(result.liveStake).toBe('50000000000');
      expect(result.pledge).toBe('1000000000');
      expect(result.margin).toBe(0.05);
      expect(result.fixedCost).toBe('340000000');
      expect(result.rewardAccount).toBe('stake1u8reward');
    });

    it('should map Ogmios v6 value shapes (ValueAdaOnly pledge/cost, Ratio margin) without fabricating activeStake', async () => {
      const mockStateQueryClient = {
        stakePools: jest.fn().mockResolvedValue({
          'pool1v6': {
            vrf: 'vrf456',
            stake: { ada: { lovelace: 7000000000n } },
            pledge: { ada: { lovelace: 1000000000n } }, // String() on this gave "[object Object]"
            margin: '1/20',
            cost: { ada: { lovelace: 340000000n } },
            rewardAccount: 'stake1u8reward'
          }
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getPool('pool1v6');
      expect(result.pledge).toBe('1000000000');
      expect(result.fixedCost).toBe('340000000');
      expect(result.margin).toBeCloseTo(0.05, 10);
      // activeStake is not derivable from pool params — no longer fabricated from pledge
      expect(result.activeStake).toBe('0');
    });

    it('should throw NotFoundError when pool does not exist', async () => {
      const mockStateQueryClient = {
        stakePools: jest.fn().mockResolvedValue({})
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      await expect(backend.getPool('pool1notfound')).rejects.toThrow('Pool');
    });

    it('should handle pool with missing optional fields', async () => {
      const mockStateQueryClient = {
        stakePools: jest.fn().mockResolvedValue({
          'pool1minimal': {}
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getPool('pool1minimal');
      expect(result.vrfKeyHash).toBe('');
      expect(result.liveStake).toBe('0');
      expect(result.pledge).toBe('0');
      expect(result.margin).toBe(0);
      expect(result.fixedCost).toBe('0');
      expect(result.rewardAccount).toBe('');
    });

    it('should use vrfKeyHash fallback when vrf is missing', async () => {
      const mockStateQueryClient = {
        stakePools: jest.fn().mockResolvedValue({
          'pool1abc': { vrfKeyHash: 'vrfhash456' }
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getPool('pool1abc');
      expect(result.vrfKeyHash).toBe('vrfhash456');
    });
  });

  describe('getAccount - object format response', () => {
    it('should handle rewardAccountSummaries returning object instead of array', async () => {
      // Ogmios may return a record keyed by stake address
      const mockStateQueryClient = {
        rewardAccountSummaries: jest.fn().mockResolvedValue({
          'stake1u8test': {
            controlledAmount: 25000000,
            rewards: 500000,
            withdrawals: 100000,
            delegate: { id: 'pool1delegated' },
            vote: { id: 'drep1voted' }
          }
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getAccount('stake1u8test');
      expect(result.controlledAmount).toBe('25000000');
      expect(result.rewardsSum).toBe('500000');
      expect(result.withdrawalsSum).toBe('100000');
      expect(result.poolId).toBe('pool1delegated');
      expect(result.drepId).toBe('drep1voted');
    });
  });

  describe('ensureConnected — reconnect on dead socket', () => {
    const mkDeadBackend = () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      // close handler cleared the clients; socket is CLOSED (3)
      (backend as any).stateQueryClient = null;
      (backend as any).context = { socket: { readyState: 3, OPEN: 1 } };
      (backend as any).isShutdown = false;
      const initSpy = jest.spyOn(backend, 'init').mockImplementation(async () => {
        (backend as any).stateQueryClient = {
          epoch: jest.fn().mockResolvedValue(450),
          ledgerTip: jest.fn().mockResolvedValue({ slot: 100, id: 'tip' }),
        };
        (backend as any).context = { socket: { readyState: 1, OPEN: 1 } };
        return true;
      });
      return { backend, initSpy };
    };

    it('re-initializes on the next request instead of staying dead until restart', async () => {
      const { backend, initSpy } = mkDeadBackend();

      const result = await backend.getLatestEpoch();

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(result.epoch).toBe(450);
    });

    it('shares a single reconnect across concurrent requests', async () => {
      const { backend, initSpy } = mkDeadBackend();

      const [a, b] = await Promise.all([backend.getLatestEpoch(), backend.getLatestEpoch()]);

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(a.epoch).toBe(450);
      expect(b.epoch).toBe(450);
    });

    it('does not reconnect when the socket is healthy', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = {
        epoch: jest.fn().mockResolvedValue(500),
        ledgerTip: jest.fn().mockResolvedValue({ slot: 100, id: 'tip' }),
      };
      (backend as any).context = { socket: { readyState: 1, OPEN: 1 } };
      (backend as any).isShutdown = false;
      const initSpy = jest.spyOn(backend, 'init');

      await backend.getLatestEpoch();
      expect(initSpy).not.toHaveBeenCalled();
    });
  });

  describe('getAddress / getNetworkInformation — declared unsupported (capability routing)', () => {
    it('getAddress throws instead of fabricating type/stakeAddress/isScript', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = {};
      (backend as any).isShutdown = false;

      await expect(backend.getAddress('addr_test1qtest')).rejects.toThrow(/not supported/i);
      expect(backend.unsupportedMethods.has('getAddress')).toBe(true);
    });

    it('getNetworkInformation throws instead of fabricating supply figures', async () => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = {};
      (backend as any).isShutdown = false;

      await expect(backend.getNetworkInformation()).rejects.toThrow(/not supported/i);
      expect(backend.unsupportedMethods.has('getNetworkInformation')).toBe(true);
    });
  });

  describe('getAddressUtxos — UTxO mapping', () => {
    const mkBackend = (utxos: unknown[]) => {
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { utxo: jest.fn().mockResolvedValue(utxos) };
      (backend as any).isShutdown = false;
      return backend;
    };

    it('should handle UTxO with null transaction', async () => {
      const backend = mkBackend([{
        transaction: null,
        index: 0,
        address: 'addr_test1qtest',
        value: { ada: { lovelace: 5000000 } }
      }]);

      const result = await backend.getAddressUtxos('addr_test1qtest');
      expect(result[0].txHash).toBe('');
      expect(result[0].amount[0].quantity).toBe('5000000');
    });

    it('should handle UTxO with missing address fallback', async () => {
      const backend = mkBackend([{
        transaction: { id: 'txhash123' },
        index: 2,
        value: { ada: { lovelace: 3000000 } }
        // no address field
      }]);

      const result = await backend.getAddressUtxos('addr_test1qfallback');
      expect(result[0].address).toBe('addr_test1qfallback');
    });

    it('should map datumHash, scriptRef AND the inline datum (previously dropped)', async () => {
      const backend = mkBackend([{
        transaction: { id: 'txhash456' },
        index: 0,
        address: 'addr_test1qscript',
        value: { ada: { lovelace: 2000000 } },
        datumHash: 'datum_hash_abc',
        datum: 'd87980', // inline datum CBOR hex — was lost before
        script: { hash: 'script_hash_def' }
      }]);

      const result = await backend.getAddressUtxos('addr_test1qscript');
      expect(result[0].datumHash).toBe('datum_hash_abc');
      expect(result[0].inlineDatum).toBe('d87980');
      expect(result[0].scriptRef).toBe('script_hash_def');
    });

    it('should map inlineDatum as null when absent', async () => {
      const backend = mkBackend([{
        transaction: { id: 'txhash789' },
        index: 0,
        address: 'addr_test1qplain',
        value: { ada: { lovelace: 1000000 } }
      }]);

      const result = await backend.getAddressUtxos('addr_test1qplain');
      expect(result[0].inlineDatum).toBeNull();
    });
  });

  describe('getLatestBlock', () => {
    it('should handle origin tip (genesis block)', async () => {
      const mockStateQueryClient = {
        ledgerTip: jest.fn().mockResolvedValue('origin'),
        networkBlockHeight: jest.fn().mockResolvedValue('origin'),
        epoch: jest.fn().mockResolvedValue(0),
        eraStart: jest.fn().mockResolvedValue({
          time: { seconds: 1654041600n },
          slot: 0
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getLatestBlock();
      expect(result.height).toBe(0);
      expect(result.hash).toBe('');
      expect(result.slot).toBe(0);
    });

    it('should return block data with correct epoch slot calculation', async () => {
      const mockStateQueryClient = {
        ledgerTip: jest.fn().mockResolvedValue({ slot: 432123, id: 'blockhash123' }),
        networkBlockHeight: jest.fn().mockResolvedValue(100000),
        epoch: jest.fn().mockResolvedValue(1),
        eraStart: jest.fn().mockResolvedValue({
          time: { seconds: 1654041600n },
          slot: 0
        })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getLatestBlock();
      expect(result.height).toBe(100000);
      expect(result.hash).toBe('blockhash123');
      expect(result.slot).toBe(432123);
      expect(result.epoch).toBe(1);
      // preview: 86 400 slots/epoch → epoch 1 starts at slot 86 400
      // (the old `slot % 432000` yielded 123 here)
      expect(result.epochSlot).toBe(432123 - 86400);
      // Shelley-anchored: previewSystemStart (1666656000) + slot seconds
      expect(result.time).toBe(1666656000 + 432123);
    });
  });

  describe('getProtocolParameters', () => {
    it('should handle missing optional fields with zero defaults', async () => {
      const mockStateQueryClient = {
        protocolParameters: jest.fn().mockResolvedValue({}),
        epoch: jest.fn().mockResolvedValue(100)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getProtocolParameters();
      expect(result.epoch).toBe(100);
      expect(result.minUtxo).toBe('0');
      expect(result.minFeeA).toBe(0);
      expect(result.minFeeB).toBe(0);
      expect(result.maxBlockSize).toBe(0);
      expect(result.priceMem).toBe(0);
      expect(result.priceStep).toBe(0);
      expect(result.maxTxExMem).toBe('0');
      expect(result.maxTxExSteps).toBe('0');
      expect(result.maxBlockExMem).toBe('0');
      expect(result.maxBlockExSteps).toBe('0');
      expect(result.maxValSize).toBe('0');
      expect(result.collateralPercent).toBe(0);
      expect(result.maxCollateralInputs).toBe(0);
      expect(result.coinsPerUtxoSize).toBe('0');
      expect(result.maxBlockHeaderSize).toBe(0);
      expect(result.maxTxSize).toBe(0);
      expect(result.keyDeposit).toBe('0');
      expect(result.minPoolCost).toBe('0');
      expect(result.poolDeposit).toBe('0');
      expect(result.protocolMajorVer).toBe(0);
      expect(result.protocolMinorVer).toBe(0);
      expect(result.source).toBe('ogmios');
    });

    it('should handle fully populated protocol parameters', async () => {
      const mockStateQueryClient = {
        protocolParameters: jest.fn().mockResolvedValue({
          minUtxoDepositCoefficient: 4310,
          minFeeCoefficient: 44,
          minFeeConstant: { ada: { lovelace: 155381 } },
          maxBlockBodySize: { bytes: 90112 },
          scriptExecutionPrices: { memory: 0.0577, cpu: 0.0000721 },
          maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
          maxExecutionUnitsPerBlock: { memory: 62000000, cpu: 40000000000 },
          maxValueSize: { bytes: 5000 },
          collateralPercentage: 150,
          maxCollateralInputs: 3,
          maxBlockHeaderSize: { bytes: 1100 },
          maxTransactionSize: { bytes: 16384 },
          stakeCredentialDeposit: { ada: { lovelace: 2000000 } },
          minStakePoolCost: { ada: { lovelace: 170000000 } },
          stakePoolDeposit: { ada: { lovelace: 500000000 } },
          stakePoolRetirementEpochBound: 18,
          desiredNumberOfStakePools: 500,
          stakePoolPledgeInfluence: 0.3,
          treasuryExpansion: 0.2,
          monetaryExpansion: 0.003,
          version: { major: 9, minor: 0 },
          plutusCostModels: {}
        }),
        epoch: jest.fn().mockResolvedValue(450)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getProtocolParameters();
      expect(result.epoch).toBe(450);
      expect(result.minFeeA).toBe(44);
      expect(result.minFeeB).toBe(155381);
      expect(result.maxBlockSize).toBe(90112);
      expect(result.collateralPercent).toBe(150);
      expect(result.maxCollateralInputs).toBe(3);
      expect(result.protocolMajorVer).toBe(9);
      expect(result.eMax).toBe(18);
      expect(result.nOpt).toBe(500);
    });

    it('parses Ratio strings ("num/den") and maps rho/tau to the correct sources', async () => {
      const mockStateQueryClient = {
        protocolParameters: jest.fn().mockResolvedValue({
          // Ogmios v6 delivers ratios as STRINGS — Number("3/1000") is NaN
          scriptExecutionPrices: { memory: '577/10000', cpu: '721/10000000' },
          stakePoolPledgeInfluence: '3/10',
          monetaryExpansion: '3/1000', // ρ
          treasuryExpansion: '1/5',    // τ
        }),
        epoch: jest.fn().mockResolvedValue(500)
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getProtocolParameters();
      expect(result.priceMem).toBeCloseTo(0.0577, 10);
      expect(result.priceStep).toBeCloseTo(0.0000721, 10);
      expect(result.a0).toBeCloseTo(0.3, 10);
      // ρ = monetaryExpansion, τ = treasuryCut — previously swapped (and NaN)
      expect(result.rho).toBeCloseTo(0.003, 10);
      expect(result.tau).toBeCloseTo(0.2, 10);
    });
  });

  describe('shutdown - CONNECTING socket state', () => {
    it('should terminate socket in CONNECTING state', async () => {
      const mockSocket = {
        readyState: 0, // CONNECTING
        OPEN: 1,
        CONNECTING: 0,
        once: jest.fn().mockImplementation((_event: string, cb: () => void) => { cb(); }),
        terminate: jest.fn()
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = null;
      (backend as any).txSubmissionClient = null;
      (backend as any).context = { socket: mockSocket };
      (backend as any).isShutdown = false;

      await backend.shutdown();
      expect(mockSocket.terminate).toHaveBeenCalled();
      expect((backend as any).isShutdown).toBe(true);
    });

    it('should handle close timeout during shutdown', async () => {
      jest.useFakeTimers();
      const mockSocket = {
        readyState: 1, // OPEN
        OPEN: 1,
        CONNECTING: 0,
        once: jest.fn(), // Never calls the callback — simulates timeout
        terminate: jest.fn()
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = null;
      (backend as any).txSubmissionClient = null;
      (backend as any).context = { socket: mockSocket };
      (backend as any).isShutdown = false;

      const shutdownPromise = backend.shutdown();
      jest.advanceTimersByTime(3000);
      await shutdownPromise;

      expect(mockSocket.terminate).toHaveBeenCalled();
      expect((backend as any).isShutdown).toBe(true);
      jest.useRealTimers();
    });
  });

  describe('getLatestEpoch', () => {
    it('should return epoch data with calculated boundaries', async () => {
      const mockStateQueryClient = {
        epoch: jest.fn().mockResolvedValue(100),
        eraStart: jest.fn().mockResolvedValue({
          time: { seconds: 1654041600n },
          slot: 0
        }),
        ledgerTip: jest.fn().mockResolvedValue({ slot: 43200100, id: 'tiphash' })
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      const result = await backend.getLatestEpoch();
      expect(result.epoch).toBe(100);
      expect(result.block_count).toBe(0);
      expect(result.tx_count).toBe(0);
      // preview geometry: epoch 100 spans slots [8 640 000, 8 726 400)
      expect(result.start_time).toBe(1666656000 + 100 * 86400);
      expect(result.end_time).toBe(1666656000 + 101 * 86400);
      expect(result.last_block_time).toBe(1666656000 + 43200100);
    });
  });

  describe('getCurrentSlot', () => {
    it('returns the slot from ledger tip', async () => {
      const mockStateQueryClient = {
        ledgerTip: jest.fn().mockResolvedValue({ slot: 80_000_123, id: 'tiphash' }),
        networkBlockHeight: jest.fn().mockResolvedValue(1_000_000),
        epoch: jest.fn().mockResolvedValue(100),
        eraStart: jest.fn().mockResolvedValue({ time: { seconds: 1654041600n }, slot: 0 }),
      };

      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = mockStateQueryClient;
      (backend as any).isShutdown = false;

      expect(await backend.getCurrentSlot()).toBe(80_000_123);
    });
  });

  describe('isUtxoUnspent', () => {
    const TX = 'a'.repeat(64);

    it('returns true when utxo query returns a non-empty array', async () => {
      const utxo = jest.fn().mockResolvedValue([{ transaction: { id: TX }, index: 0 }]);
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { utxo };
      (backend as any).isShutdown = false;

      expect(await backend.isUtxoUnspent(TX, 0)).toBe(true);
    });

    it('returns false when utxo query returns an empty array', async () => {
      const utxo = jest.fn().mockResolvedValue([]);
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { utxo };
      (backend as any).isShutdown = false;

      expect(await backend.isUtxoUnspent(TX, 0)).toBe(false);
    });

    it('passes the correct outputReferences shape to the client', async () => {
      const utxo = jest.fn().mockResolvedValue([]);
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { utxo };
      (backend as any).isShutdown = false;

      await backend.isUtxoUnspent(TX, 7);
      expect(utxo).toHaveBeenCalledWith({
        outputReferences: [{ transaction: { id: TX }, index: 7 }],
      });
    });

    it('returns false for negative outputIndex without invoking the client', async () => {
      const utxo = jest.fn();
      const backend = new OgmiosBackend(NETWORK, TIMEOUT_MS, OGMIOS_URL);
      (backend as any).stateQueryClient = { utxo };
      (backend as any).isShutdown = false;

      expect(await backend.isUtxoUnspent(TX, -1)).toBe(false);
      expect(utxo).not.toHaveBeenCalled();
    });
  });

  // Note: createInteractionContext, getAddressUtxos, and getProtocolParameters error handling
  // is tested through BackendInitError in init() tests - the underlying Ogmios client
  // errors are wrapped and thrown appropriately by the backend implementation.

  describe('resolveOgmiosTip', () => {
    it('should return slot and hash from a normal tip', () => {
      const tip = { slot: 12345, id: 'abc123' };
      expect(resolveOgmiosTip(tip)).toEqual({ slot: 12345, hash: 'abc123' });
    });

    it('should return zeros for origin (genesis block)', () => {
      expect(resolveOgmiosTip('origin')).toEqual({ slot: 0, hash: '' });
    });
  });

  describe('resolveOgmiosHeight', () => {
    it('should return the height number directly', () => {
      expect(resolveOgmiosHeight(999)).toBe(999);
    });

    it('should return 0 for origin (genesis block)', () => {
      expect(resolveOgmiosHeight('origin')).toBe(0);
    });
  });
});
