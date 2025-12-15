import { CardanoClient } from '../../srv/blockchain/cardano-client';
import { CardanoBackend } from '../../srv/blockchain/backends/cardano-backend';
import { 
  BackendError, 
  TimeoutError, 
  NotFoundError,
  AllBackendsFailedError 
} from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';
import type { Transaction, Address, UTxO, Network, LatestBlock, LatestEpoch } from '../../srv/utils/types';

// Mock backends
class MockBackend implements CardanoBackend {
  name: string;
  initialized = false;
  
  constructor(name: string) {
    this.name = name;
  }

  async init(): Promise<void> {
    this.initialized = true;
  }

  healthCheck  = jest.fn();
  getTransaction = jest.fn();
  getAddress = jest.fn();
  getAddressUtxos = jest.fn();
  getNetworkInformation = jest.fn();
  getTransactionMetadata = jest.fn();
  getMetadataLabelTransactions = jest.fn();
  getLatestBlock = jest.fn();
  getLatestEpoch = jest.fn();
}

describe('CardanoClient', () => {
  let primaryBackend: MockBackend;
  let fallbackBackend: MockBackend;
  let client: CardanoClient;

  beforeEach(() => {
    primaryBackend = new MockBackend('primary');
    fallbackBackend = new MockBackend('fallback');
    client = new CardanoClient([primaryBackend, fallbackBackend]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    test('requires at least one backend', () => {
      expect(() => new CardanoClient([])).toThrow(
        'CardanoClient misconfigured: no backend available'
      );
    });

    test('initializes all backends successfully', async () => {
      const txData: Partial<Transaction> = { hash: 'abc123' };
      primaryBackend.getTransaction.mockResolvedValue(txData);

      await client.getTransaction('abc123');

      expect(primaryBackend.initialized).toBe(true);
      expect(fallbackBackend.initialized).toBe(true);
    });

    test('removes backends that fail initialization', async () => {
      const failingBackend = new MockBackend('failing');
      failingBackend.init = jest.fn().mockRejectedValue(new Error('Init failed'));
      
      const workingBackend = new MockBackend('working');
      const testClient = new CardanoClient([failingBackend, workingBackend]);

      const txData: Partial<Transaction> = { hash: 'abc123' };
      workingBackend.getTransaction.mockResolvedValue(txData);

      const result = await testClient.getTransaction('abc123');

      expect(result).toEqual(txData);
      expect(workingBackend.getTransaction).toHaveBeenCalled();
      expect(failingBackend.getTransaction).not.toHaveBeenCalled();
    });

    test('throws if all backends fail initialization', async () => {
      const backend1 = new MockBackend('backend1');
      const backend2 = new MockBackend('backend2');
      backend1.init = jest.fn().mockRejectedValue(new Error('Init 1 failed'));
      backend2.init = jest.fn().mockRejectedValue(new Error('Init 2 failed'));

      const testClient = new CardanoClient([backend1, backend2]);

      await expect(testClient.getTransaction('abc123')).rejects.toThrow(
        'CardanoClient startup failed'
      );
    });
  });

  describe('Fallback Logic', () => {
    test('uses primary backend when successful', async () => {
      const txData: Partial<Transaction> = { hash: 'abc123', fee: 170000 };
      primaryBackend.getTransaction.mockResolvedValue(txData);

      const result = await client.getTransaction('abc123');

      expect(result).toEqual(txData);
      expect(primaryBackend.getTransaction).toHaveBeenCalledWith('abc123');
      expect(fallbackBackend.getTransaction).not.toHaveBeenCalled();
    });

    test('falls back to secondary backend on primary error', async () => {
      const txData: Partial<Transaction> = { hash: 'abc123' };
      
      primaryBackend.getTransaction.mockRejectedValue(
        new BackendError('Primary error', 500, ERROR_CODES.INTERNAL_ERROR, 'primary')
      );
      fallbackBackend.getTransaction.mockResolvedValue(txData);

      const result = await client.getTransaction('abc123');

      expect(result).toEqual(txData);
      expect(primaryBackend.getTransaction).toHaveBeenCalled();
      expect(fallbackBackend.getTransaction).toHaveBeenCalled();
    });

    test('throws AllBackendsFailedError when all backends fail', async () => {
      primaryBackend.getTransaction.mockRejectedValue(
        new BackendError('Primary failed', 500, ERROR_CODES.INTERNAL_ERROR, 'primary')
      );
      fallbackBackend.getTransaction.mockRejectedValue(
        new BackendError('Fallback failed', 503, ERROR_CODES.PROVIDER_UNAVAILABLE, 'fallback')
      );

      await expect(client.getTransaction('abc123')).rejects.toThrow(
        AllBackendsFailedError
      );

      try {
        await client.getTransaction('abc123');
      } catch (err: any) {
        expect(err.errors).toHaveLength(2);
        expect(err.message).toContain('All backends failed');
      }
    });


  describe('API Methods', () => {
    test('getAddress uses fallback', async () => {
      const addrData: Partial<Address> = { address: 'addr_test1...', type: 'shelley' };
      primaryBackend.getAddress.mockResolvedValue(addrData);

      const result = await client.getAddress('addr_test1...');

      expect(result).toEqual(addrData);
      expect(primaryBackend.getAddress).toHaveBeenCalledWith('addr_test1...');
    });

    test('getAddressUtxos uses fallback', async () => {
      const utxos: Partial<UTxO>[] = [{ txHash: 'abc', outputIndex: 0 }];
      primaryBackend.getAddressUtxos.mockResolvedValue(utxos);

      const result = await client.getAddressUtxos('addr_test1...');

      expect(result).toEqual(utxos);
      expect(primaryBackend.getAddressUtxos).toHaveBeenCalledWith('addr_test1...');
    });

    test('getNetworkInformation uses fallback', async () => {
      const network: Partial<Network> = { 
        supply: { max: '45000000000000000', total: '35000000000000000' } 
      } as any;
      primaryBackend.getNetworkInformation.mockResolvedValue(network);

      const result = await client.getNetworkInformation();

      expect(result).toEqual(network);
      expect(primaryBackend.getNetworkInformation).toHaveBeenCalled();
    });

    test('getLatestBlock uses fallback', async () => {
      const block: Partial<LatestBlock> = { hash: 'block123', height: 9876543 };
      primaryBackend.getLatestBlock.mockResolvedValue(block);

      const result = await client.getLatestBlock();

      expect(result).toEqual(block);
      expect(primaryBackend.getLatestBlock).toHaveBeenCalled();
    });

    test('getLatestEpoch uses fallback', async () => {
      const epoch: Partial<LatestEpoch> = { epoch: 450, block_count: 21600 };
      primaryBackend.getLatestEpoch.mockResolvedValue(epoch);

      const result = await client.getLatestEpoch();

      expect(result).toEqual(epoch);
      expect(primaryBackend.getLatestEpoch).toHaveBeenCalled();
    });

    test('getTransactionMetadata uses fallback', async () => {
      const metadata = [{ tx_hash: 'abc123', label: '721', json: { name: 'NFT' } }];
      primaryBackend.getTransactionMetadata.mockResolvedValue(metadata);

      const result = await client.getTransactionMetadata('abc123');

      expect(result).toEqual(metadata);
      expect(primaryBackend.getTransactionMetadata).toHaveBeenCalledWith('abc123');
    });

    test('getMetadataLabelTransactions uses fallback with string label', async () => {
      const txs = [{ tx_hash: 'abc123', label: '721' }];
      primaryBackend.getMetadataLabelTransactions.mockResolvedValue(txs);

      const result = await client.getMetadataLabelTransactions('721');

      expect(result).toEqual(txs);
      expect(primaryBackend.getMetadataLabelTransactions).toHaveBeenCalledWith('721');
    });

    test('getMetadataLabelTransactions uses fallback with number label', async () => {
      const txs = [{ tx_hash: 'abc123', label: '721' }];
      primaryBackend.getMetadataLabelTransactions.mockResolvedValue(txs);

      const result = await client.getMetadataLabelTransactions(721);

      expect(result).toEqual(txs);
      expect(primaryBackend.getMetadataLabelTransactions).toHaveBeenCalledWith(721);
    });
  });

  describe('withTimeout', () => {
    test('rejects with TimeoutError when the timeout elapses', async () => {
      const localClient = new CardanoClient([new MockBackend('primary')]);
      const neverResolving = new Promise<void>(() => {});

      const p: Promise<unknown> = (localClient as any).withTimeout(
        neverResolving,
        25,
        'primary'
      );

      await expect(p).rejects.toBeInstanceOf(TimeoutError);
      await expect(p).rejects.toMatchObject({
        statusCode: 503,
        backendName: 'primary',
        message: 'Backend timeout after 25ms',
      });
    });
  });

  describe('Error Accumulation', () => {
    test('accumulates all backend errors in AllBackendsFailedError', async () => {
      const error1 = new TimeoutError('primary', 8000);
      const error2 = new NotFoundError('Transaction', 'fallback');

      primaryBackend.getTransaction.mockRejectedValue(error1);
      fallbackBackend.getTransaction.mockRejectedValue(error2);

      try {
        await client.getTransaction('abc123');
        fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AllBackendsFailedError);
        expect(err.errors).toHaveLength(2);
        expect(err.errors[0]).toBe(error1);
        expect(err.errors[1]).toBe(error2);
      }
    });

    test('uses last error status code in AllBackendsFailedError', async () => {
      primaryBackend.getTransaction.mockRejectedValue(
        new BackendError('Error 1', 500, ERROR_CODES.INTERNAL_ERROR, 'primary')
      );
      fallbackBackend.getTransaction.mockRejectedValue(
        new BackendError('Error 2', 404, ERROR_CODES.NOT_FOUND, 'fallback')
      );

      try {
        await client.getTransaction('abc123');
      } catch (err: any) {
        expect(err.statusCode).toBe(404); // Last error's status
      }
    });
  });
});
});
