jest.mock('../../srv/utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
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
        acquireLedgerState: jest.fn().mockResolvedValue(undefined),
        rewardAccountSummaries: jest.fn().mockResolvedValue({
          'stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr': {
            controlledAmount: 50000000000,
            rewards: 1500000,
            withdrawals: 500000,
            delegation: { poolId: 'pool1abc123' },
            drep: { id: 'drep1xyz456' }
          }
        }),
        releaseLedgerState: jest.fn().mockResolvedValue(undefined)
      };

      const backend = new OgmiosBackend();
      (backend as any).stateQueryClient = mockStateQueryClient;

      const result = await backend.getAccount('stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr');

      expect(mockStateQueryClient.acquireLedgerState).toHaveBeenCalledWith('origin');
      expect(mockStateQueryClient.rewardAccountSummaries).toHaveBeenCalledWith({
        keys: ['stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr']
      });
      expect(mockStateQueryClient.releaseLedgerState).toHaveBeenCalled();
      
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
        acquireLedgerState: jest.fn().mockResolvedValue(undefined),
        rewardAccountSummaries: jest.fn().mockResolvedValue({}),
        releaseLedgerState: jest.fn().mockResolvedValue(undefined)
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
      ).rejects.toThrow('Ogmios state query client not initialized');
    });

    it('should handle account with no delegation or drep', async () => {
      const mockStateQueryClient = {
        acquireLedgerState: jest.fn().mockResolvedValue(undefined),
        rewardAccountSummaries: jest.fn().mockResolvedValue({
          'stake1u8a9qstrmj4rvc3k5z8fems7f0j2vzrem30yavmgfswmswysxcgvr': {
            controlledAmount: 2000000,
            rewards: 0,
            withdrawals: 0
          }
        }),
        releaseLedgerState: jest.fn().mockResolvedValue(undefined)
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
});
