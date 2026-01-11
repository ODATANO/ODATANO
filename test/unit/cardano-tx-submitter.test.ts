import { CardanoTransactionSubmitter } from '../../srv/blockchain/cardano-tx-submitter';
import cardano from '../../srv/blockchain/cardano-client';

// Mock the cardano client
jest.mock('../../srv/blockchain/cardano-client', () => ({
  __esModule: true,
  default: {
    submitTransaction: jest.fn()
  }
}));

// Mock logger to avoid console output during tests
jest.mock('../../srv/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

describe('CardanoTransactionSubmitter Unit Tests', () => {
  let submitter: CardanoTransactionSubmitter;
  const mockSubmitTransaction = cardano.submitTransaction as jest.MockedFunction<typeof cardano.submitTransaction>;

  beforeEach(() => {
    // Create a new submitter instance for each test
    submitter = new CardanoTransactionSubmitter();

    // Clear all mock calls before each test
    jest.clearAllMocks();
  });

  describe('submitTransaction', () => {
    const mockTxCborHex = '84a300818258200123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef00018182581d60a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d41a000f424002182a030aa100818258200123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef5840abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const mockTxHash = 'e3a7c8d2f1b9a6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3e2d1';

    it('should submit a transaction and return transaction hash', async () => {
      mockSubmitTransaction.mockResolvedValue(mockTxHash);

      const result = await submitter.submitTransaction(mockTxCborHex);

      expect(mockSubmitTransaction).toHaveBeenCalledWith(mockTxCborHex);
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
      expect(result).toBe(mockTxHash);
    });

    it('should handle different transaction CBOR formats', async () => {
      const differentTxCbor = '84a40081825820abc123def456abc123def456abc123def456abc123def456abc123def456abc1230001818258390011223344556677889900112233445566778899001122334455667788990011223344556677889900112233445566778899001122334455667788991a001e848002182a030aa10081825820abc123def456abc123def456abc123def456abc123def456abc123def456abc123584012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678';
      const differentTxHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

      mockSubmitTransaction.mockResolvedValue(differentTxHash);

      const result = await submitter.submitTransaction(differentTxCbor);

      expect(mockSubmitTransaction).toHaveBeenCalledWith(differentTxCbor);
      expect(result).toBe(differentTxHash);
    });

    it('should propagate errors from cardano client', async () => {
      const errorMessage = 'Transaction submission failed';
      mockSubmitTransaction.mockRejectedValue(new Error(errorMessage));

      await expect(submitter.submitTransaction(mockTxCborHex)).rejects.toThrow(errorMessage);
      expect(mockSubmitTransaction).toHaveBeenCalledWith(mockTxCborHex);
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network timeout');
      mockSubmitTransaction.mockRejectedValue(networkError);

      await expect(submitter.submitTransaction(mockTxCborHex)).rejects.toThrow('Network timeout');
      expect(mockSubmitTransaction).toHaveBeenCalledWith(mockTxCborHex);
    });

    it('should handle invalid transaction errors', async () => {
      const invalidTxError = new Error('Invalid transaction format');
      mockSubmitTransaction.mockRejectedValue(invalidTxError);

      await expect(submitter.submitTransaction(mockTxCborHex)).rejects.toThrow('Invalid transaction format');
      expect(mockSubmitTransaction).toHaveBeenCalledWith(mockTxCborHex);
    });

    it('should handle backend unavailable errors', async () => {
      const backendError = new Error('All backends unavailable');
      mockSubmitTransaction.mockRejectedValue(backendError);

      await expect(submitter.submitTransaction(mockTxCborHex)).rejects.toThrow('All backends unavailable');
      expect(mockSubmitTransaction).toHaveBeenCalledWith(mockTxCborHex);
    });

    it('should handle empty CBOR hex string', async () => {
      const emptyError = new Error('Empty transaction CBOR');
      mockSubmitTransaction.mockRejectedValue(emptyError);

      await expect(submitter.submitTransaction('')).rejects.toThrow('Empty transaction CBOR');
      expect(mockSubmitTransaction).toHaveBeenCalledWith('');
    });

    it('should handle malformed CBOR hex string', async () => {
      const malformedCbor = 'not-a-valid-cbor-hex';
      const malformedError = new Error('Invalid CBOR format');
      mockSubmitTransaction.mockRejectedValue(malformedError);

      await expect(submitter.submitTransaction(malformedCbor)).rejects.toThrow('Invalid CBOR format');
      expect(mockSubmitTransaction).toHaveBeenCalledWith(malformedCbor);
    });

    it('should successfully submit multiple transactions in sequence', async () => {
      const txHash1 = 'hash1';
      const txHash2 = 'hash2';
      const txCbor1 = '84a3008182582001010101010101010101010101010101010101010101010101010101010101010001818258390011223344556677889900112233445566778899001122334455667788990011223344556677889900112233445566778899001122334455667788991a001e848002182a030aa10081825820010101010101010101010101010101010101010101010101010101010101015840abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const txCbor2 = '84a3008182582002020202020202020202020202020202020202020202020202020202020202020001818258390011223344556677889900112233445566778899001122334455667788990011223344556677889900112233445566778899001122334455667788991a001e848002182a030aa10081825820020202020202020202020202020202020202020202020202020202020202025840abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

      mockSubmitTransaction
        .mockResolvedValueOnce(txHash1)
        .mockResolvedValueOnce(txHash2);

      const result1 = await submitter.submitTransaction(txCbor1);
      const result2 = await submitter.submitTransaction(txCbor2);

      expect(result1).toBe(txHash1);
      expect(result2).toBe(txHash2);
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    });

    it('should return the exact hash format provided by the backend', async () => {
      const expectedHash = 'f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4b5a69788f1e2d3c4b5a69788';
      mockSubmitTransaction.mockResolvedValue(expectedHash);

      const result = await submitter.submitTransaction(mockTxCborHex);

      expect(result).toBe(expectedHash);
      expect(typeof result).toBe('string');
    });
  });

  describe('Singleton Instance', () => {
    it('should export a default singleton instance', async () => {
      const defaultSubmitter = (await import('../../srv/blockchain/cardano-tx-submitter')).default;

      expect(defaultSubmitter).toBeDefined();
      expect(defaultSubmitter).toBeInstanceOf(CardanoTransactionSubmitter);
    });
  });
});
