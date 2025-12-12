import { handleBackendError } from '../../srv/blockchain/backend-error-handler';
import { BackendError, NotFoundError, TimeoutError } from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';

describe('Backend Error Handler', () => {
  describe('handleBackendError', () => {
    test('executes function successfully and returns result', async () => {
      const mockFn = jest.fn().mockResolvedValue({ data: 'test' });
      
      const result = await handleBackendError(mockFn, 'blockfrost', 'Transaction');
      
      expect(result).toEqual({ data: 'test' });
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('wraps generic error as BackendError', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('Generic error'));
      
      await expect(
        handleBackendError(mockFn, 'blockfrost', 'Transaction')
      ).rejects.toThrow(BackendError);
    });

    test('preserves BackendError as is', async () => {
      const originalError = new BackendError('Test error', 500, ERROR_CODES.INTERNAL_ERROR, 'blockfrost');
      const mockFn = jest.fn().mockRejectedValue(originalError);
      
      await expect(
        handleBackendError(mockFn, 'blockfrost', 'Transaction')
      ).rejects.toBe(originalError);
    });

    test('converts 404 error to NotFoundError with resource name', async () => {
      const mockFn = jest.fn().mockRejectedValue({ status: 404, message: 'Not found' });
      
      await expect(
        handleBackendError(mockFn, 'koios', 'Transaction')
      ).rejects.toThrow(NotFoundError);
      
      try {
        await handleBackendError(mockFn, 'koios', 'Transaction');
      } catch (err: any) {
        expect(err.message).toBe('Transaction not found');
        expect(err.backendName).toBe('koios');
      }
    });

    test('converts timeout error to TimeoutError', async () => {
      const mockFn = jest.fn().mockRejectedValue({ code: 'ETIMEDOUT', message: 'timeout' });
      
      await expect(
        handleBackendError(mockFn, 'blockfrost')
      ).rejects.toThrow(TimeoutError);
      
      try {
        await handleBackendError(mockFn, 'blockfrost');
      } catch (err: any) {
        expect(err.statusCode).toBe(503);
        expect(err.backendName).toBe('blockfrost');
      }
    });

    test('preserves backend name in error', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('Test'));
      
      try {
        await handleBackendError(mockFn, 'koios', 'Address');
      } catch (err: any) {
        expect(err.backendName).toBe('koios');
      }
    });

    test('includes original error in BackendError', async () => {
      const originalError = new Error('Original');
      const mockFn = jest.fn().mockRejectedValue(originalError);
      
      try {
        await handleBackendError(mockFn, 'blockfrost');
      } catch (err: any) {
        expect(err.originalError).toBe(originalError);
      }
    });
  });
});
