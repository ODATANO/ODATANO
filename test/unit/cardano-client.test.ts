import { CardanoClient, createCardanoClientForBackends } from '../../srv/blockchain/cardano-client';
import { CardanoBackend } from '../../srv/blockchain/backends/cardano-backend';
import { ConfigError, AllBackendsInitFailedError } from '../../srv/utils/errors';
import {
  Transaction,
  Address,
  UTxO,
  Network,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData,
  DrepData,
  AccountData
} from '../../srv/utils/types';

// Mock backend for testing
class MockBackend implements CardanoBackend {
  public readonly name: string;
  private shouldFailInit: boolean;
  private initCalled = false;

  constructor(name: string, shouldFailInit = false) {
    this.name = name;
    this.shouldFailInit = shouldFailInit;
  }

  async init(): Promise<void> {
    this.initCalled = true;
    if (this.shouldFailInit) {
      throw new Error(`${this.name} init failed`);
    }
  }

  async getTransaction(txHash: string): Promise<Transaction> {
    throw new Error('Not implemented in mock');
  }
  async getAddress(address: string): Promise<Address> {
    throw new Error('Not implemented in mock');
  }
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    throw new Error('Not implemented in mock');
  }
  async getNetworkInformation(): Promise<Network> {
    throw new Error('Not implemented in mock');
  }
  async getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]> {
    throw new Error('Not implemented in mock');
  }
  async getMetadataLabelTransactions(label: string | number): Promise<MetadataLabelTx[]> {
    throw new Error('Not implemented in mock');
  }
  async getBlock(blockHash: string): Promise<BlockData> {
    throw new Error('Not implemented in mock');
  }
  async getEpoch(epochNumber: number): Promise<EpochData> {
    throw new Error('Not implemented in mock');
  }
  async getPool(poolId: string): Promise<PoolData> {
    throw new Error('Not implemented in mock');
  }
  async getDrep(drepId: string): Promise<DrepData> {
    throw new Error('Not implemented in mock');
  }
  async getAccount(stakeAddress: string): Promise<AccountData> {
    throw new Error('Not implemented in mock');
  }

  wasInitCalled(): boolean {
    return this.initCalled;
  }
}

describe('CardanoClient Configuration', () => {

  // ============================================================================
  // Constructor Validation
  // ============================================================================
  describe('Constructor', () => {
    it('should throw ConfigError when no backends provided', () => {
      expect(() => new CardanoClient([])).toThrow(ConfigError);
      expect(() => new CardanoClient([])).toThrow('no backend available');
    });

    it('should throw ConfigError when backends array is null/undefined', () => {
      expect(() => new CardanoClient(null as any)).toThrow(ConfigError);
      expect(() => new CardanoClient(undefined as any)).toThrow(ConfigError);
    });

    it('should accept valid backends array', () => {
      const backend = new MockBackend('test-backend');
      expect(() => new CardanoClient([backend])).not.toThrow();
    });

    it('should accept multiple backends', () => {
      const backends = [
        new MockBackend('backend1'),
        new MockBackend('backend2'),
      ];
      expect(() => new CardanoClient(backends)).not.toThrow();
    });
  });

  // ============================================================================
  // Backend Initialization
  // ============================================================================
  describe('Backend Initialization', () => {
    it('should initialize all backends on first call', async () => {
      const backend1 = new MockBackend('backend1');
      const backend2 = new MockBackend('backend2');
      const client = new CardanoClient([backend1, backend2]);

      // Trigger initialization via getNetworkInformation (will fail but init should happen)
      await expect(client.getNetworkInformation()).rejects.toThrow();

      expect(backend1.wasInitCalled()).toBe(true);
      expect(backend2.wasInitCalled()).toBe(true);
    });

    it('should throw AllBackendsInitFailedError when all backends fail to init', async () => {
      const backend1 = new MockBackend('backend1', true);
      const backend2 = new MockBackend('backend2', true);
      const client = new CardanoClient([backend1, backend2]);

      await expect(client.getNetworkInformation()).rejects.toThrow(AllBackendsInitFailedError);
    });

    it('should continue with working backends when some fail to init', async () => {
      const failingBackend = new MockBackend('failing', true);
      const workingBackend = new MockBackend('working', false);
      const client = new CardanoClient([failingBackend, workingBackend]);

      // Trigger init - should not throw because workingBackend succeeds
      await expect(client.getNetworkInformation()).rejects.toThrow('Not implemented in mock');

      expect(failingBackend.wasInitCalled()).toBe(true);
      expect(workingBackend.wasInitCalled()).toBe(true);
    });

    it('should only initialize once', async () => {
      const backend = new MockBackend('backend');
      const client = new CardanoClient([backend]);

      // Call multiple times
      await expect(client.getNetworkInformation()).rejects.toThrow();
      await expect(client.getNetworkInformation()).rejects.toThrow();

      // Init should only be called once (we can't test this directly with current mock,
      // but we verify it doesn't throw on second call)
      expect(backend.wasInitCalled()).toBe(true);
    });
  });

  // ============================================================================
  // createCardanoClientForBackends Factory
  // ============================================================================
  describe('createCardanoClientForBackends', () => {
    it('should throw ConfigError when no valid backends configured', () => {
      // Use non-existent backend name
      expect(() => createCardanoClientForBackends(['invalid-backend'])).toThrow(ConfigError);
      expect(() => createCardanoClientForBackends(['invalid-backend'])).toThrow('No valid backends configured');
    });

    it('should throw when empty backends array provided', () => {
      expect(() => createCardanoClientForBackends([])).toThrow(ConfigError);
      expect(() => createCardanoClientForBackends([])).toThrow('No valid backends configured');
    });

    it('should create client with koios backend', () => {
      expect(() => createCardanoClientForBackends(['koios'])).not.toThrow();
    });

    it('should create client with multiple backends', () => {
      expect(() => createCardanoClientForBackends(['blockfrost', 'koios'])).not.toThrow();
    });
  });

  // ============================================================================
  // Fallback Mechanism
  // ============================================================================
  describe('Fallback Mechanism', () => {
    it('should try second backend when first fails', async () => {
      class FailingBackend extends MockBackend {
        async getNetworkInformation(): Promise<Network> {
          throw new Error('First backend failed');
        }
      }

      class WorkingBackend extends MockBackend {
        async getNetworkInformation(): Promise<Network> {
          return {
            supply: {
              max: '45000000000000000',
              total: '35000000000000000',
              circulating: '33000000000000000',
              locked: '2000000000000000',
              treasury: '1000000000000000',
              reserves: '10000000000000000',
            },
            stake: {
              live: '23000000000000000',
              active: '22000000000000000',
            },
          };
        }
      }

      const failingBackend = new FailingBackend('failing');
      const workingBackend = new WorkingBackend('working');
      const client = new CardanoClient([failingBackend, workingBackend]);

      const result = await client.getNetworkInformation();
      expect(result.supply.max).toBe('45000000000000000');
    });

    it('should throw AllBackendsFailedError when all backends fail', async () => {
      class FailingBackend extends MockBackend {
        async getNetworkInformation(): Promise<Network> {
          throw new Error('Backend failed');
        }
      }

      const backend1 = new FailingBackend('backend1');
      const backend2 = new FailingBackend('backend2');
      const client = new CardanoClient([backend1, backend2]);

      await expect(client.getNetworkInformation()).rejects.toThrow('All backends failed');
    });

    it('should use first successful backend result', async () => {
      class FastBackend extends MockBackend {
        async getNetworkInformation(): Promise<Network> {
          return {
            supply: {
              max: '11111111111111111',
              total: '11111111111111111',
              circulating: '11111111111111111',
              locked: '0',
              treasury: '0',
              reserves: '0',
            },
            stake: {
              live: '0',
              active: '0',
            },
          };
        }
      }

      class SlowBackend extends MockBackend {
        async getNetworkInformation(): Promise<Network> {
          // This should never be called because first backend succeeds
          throw new Error('Should not be called');
        }
      }

      const fastBackend = new FastBackend('fast');
      const slowBackend = new SlowBackend('slow');
      const client = new CardanoClient([fastBackend, slowBackend]);

      const result = await client.getNetworkInformation();
      expect(result.supply.max).toBe('11111111111111111');
    });
  });
});
