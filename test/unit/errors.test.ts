import {
  BackendError,
  NotFoundError,
  TimeoutError,
  ProviderBadResponseError,
  AllBackendsFailedError,
  ConfigError,
  BackendInitError,
  AllBackendsInitFailedError,
  getErrorStatus,
  getErrorMessage,
  normalizeBackendError,
} from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';

describe('Error Classes', () => {
  
  // ============================================================================
  // BackendError
  // ============================================================================
  describe('BackendError', () => {
    it('should create error with default values', () => {
      const error = new BackendError('Test error');
      
      expect(error.message).toBe('Test error');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(error.name).toBe('BackendError');
      expect(error instanceof Error).toBe(true);
    });

    it('should create error with custom values', () => {
      const error = new BackendError(
        'Custom error',
        400,
        ERROR_CODES.INVALID_INPUT,
        'blockfrost',
        { original: 'error' },
        'field1'
      );
      
      expect(error.message).toBe('Custom error');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(ERROR_CODES.INVALID_INPUT);
      expect(error.backendName).toBe('blockfrost');
      expect(error.originalError).toEqual({ original: 'error' });
      expect(error.target).toBe('field1');
    });
  });

  // ============================================================================
  // NotFoundError
  // ============================================================================
  describe('NotFoundError', () => {
    it('should create 404 error for resource', () => {
      const error = new NotFoundError('Transaction');
      
      expect(error.message).toBe('Transaction not found');
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(error.name).toBe('NotFoundError');
    });

    it('should include backend name', () => {
      const error = new NotFoundError('Address', 'koios');
      
      expect(error.message).toBe('Address not found');
      expect(error.backendName).toBe('koios');
    });

    it('should store original error', () => {
      const originalError = new Error('Original');
      const error = new NotFoundError('Block', 'blockfrost', originalError);
      
      expect(error.originalError).toBe(originalError);
    });
  });

  // ============================================================================
  // TimeoutError
  // ============================================================================
  describe('TimeoutError', () => {
    it('should create timeout error with default message', () => {
      const error = new TimeoutError();
      
      expect(error.message).toBe('Backend timeout or unreachable');
      expect(error.statusCode).toBe(503);
      expect(error.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
      expect(error.name).toBe('TimeoutError');
    });

    it('should include backend name in timeout error', () => {
      const error = new TimeoutError('koios');
      
      expect(error.backendName).toBe('koios');
      expect(error.message).toBe('Backend timeout or unreachable');
    });

    it('should include timeout duration in message', () => {
      const error = new TimeoutError('blockfrost', 5000);
      
      expect(error.message).toBe('Backend timeout after 5000ms');
      expect(error.statusCode).toBe(503);
    });
  });

  // ============================================================================
  // ProviderBadResponseError
  // ============================================================================
  describe('ProviderBadResponseError', () => {
    it('should create 502 error with custom message', () => {
      const error = new ProviderBadResponseError('Invalid response format');
      
      expect(error.message).toBe('Invalid response format');
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe(ERROR_CODES.PROVIDER_BAD_RESPONSE);
      expect(error.name).toBe('ProviderBadResponseError');
    });

    it('should include backend name', () => {
      const error = new ProviderBadResponseError('Bad response', 'koios');
      
      expect(error.backendName).toBe('koios');
    });

    it('should store original error', () => {
      const originalError = new Error('Original');
      const error = new ProviderBadResponseError('Bad data', 'blockfrost', originalError);
      
      expect(error.originalError).toBe(originalError);
    });
  });

  // ============================================================================
  // AllBackendsFailedError
  // ============================================================================
  describe('AllBackendsFailedError', () => {
    it('should create error with multiple backend failures', () => {
      const errors = [
        new BackendError('Error 1', 503, ERROR_CODES.PROVIDER_UNAVAILABLE, 'blockfrost'),
        new BackendError('Error 2', 500, ERROR_CODES.INTERNAL_ERROR, 'koios'),
      ];
      
      const error = new AllBackendsFailedError(errors);
      
      expect(error.message).toBe('All backends failed: Error 2');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(error.errors).toEqual(errors);
      expect(error.name).toBe('AllBackendsFailedError');
    });

    it('should use last error status and code', () => {
      const errors = [
        new BackendError('Error 1', 500),
        new ProviderBadResponseError('Bad response'),
      ];
      
      const error = new AllBackendsFailedError(errors);
      
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe(ERROR_CODES.PROVIDER_BAD_RESPONSE);
    });

    it('should handle empty errors array', () => {
      const error = new AllBackendsFailedError([]);
      
      expect(error.message).toContain('All backends failed');
      expect(error.statusCode).toBe(500);
    });
  });

  // ============================================================================
  // ConfigError
  // ============================================================================
  describe('ConfigError', () => {
    it('should create config error', () => {
      const error = new ConfigError('Missing BLOCKFROST_KEY');
      
      expect(error.message).toBe('Missing BLOCKFROST_KEY');
      expect(error.name).toBe('ConfigError');
      expect(error instanceof Error).toBe(true);
    });
  });

  // ============================================================================
  // BackendInitError
  // ============================================================================
  describe('BackendInitError', () => {
    it('should create init error with backend name', () => {
      const originalError = new Error('Connection failed');
      const error = new BackendInitError('koios', originalError);
      
      expect(error.message).toBe('Failed to initialize backend: koios');
      expect(error.backendName).toBe('koios');
      expect(error.originalError).toBe(originalError);
      expect(error.name).toBe('BackendInitError');
    });
  });

  // ============================================================================
  // AllBackendsInitFailedError
  // ============================================================================
  describe('AllBackendsInitFailedError', () => {
    it('should create error with all init failures', () => {
      const errors = [
        new BackendInitError('blockfrost', new Error('Auth failed')),
        new BackendInitError('koios', new Error('Connection timeout')),
      ];
      
      const error = new AllBackendsInitFailedError(errors);
      
      expect(error.message).toContain('CardanoClient startup failed');
      expect(error.message).toContain('blockfrost: Auth failed');
      expect(error.message).toContain('koios: Connection timeout');
      expect(error.errors).toEqual(errors);
      expect(error.name).toBe('AllBackendsInitFailedError');
    });

    it('should handle init errors with non-string originals', () => {
      const errors = [
        new BackendInitError('blockfrost', { code: 500 }),
      ];
      
      const error = new AllBackendsInitFailedError(errors);
      
      expect(error.message).toContain('blockfrost');
    });
  });

  // ============================================================================
  // getErrorStatus
  // ============================================================================
  describe('getErrorStatus', () => {
    it('should extract status from error.status', () => {
      const err = { status: 404 };
      expect(getErrorStatus(err)).toBe(404);
    });

    it('should extract status from error.response.status', () => {
      const err = { response: { status: 503 } };
      expect(getErrorStatus(err)).toBe(503);
    });

    it('should prefer direct status over response status', () => {
      const err = { status: 400, response: { status: 503 } };
      expect(getErrorStatus(err)).toBe(400);
    });

    it('should return 500 for unknown error', () => {
      expect(getErrorStatus({})).toBe(500);
      expect(getErrorStatus(null)).toBe(500);
      expect(getErrorStatus(undefined)).toBe(500);
    });
  });

  // ============================================================================
  // getErrorMessage
  // ============================================================================
  describe('getErrorMessage', () => {
    it('should extract message from error.message', () => {
      const err = new Error('Test error');
      expect(getErrorMessage(err)).toBe('Test error');
    });

    it('should return unknown for empty error', () => {
      expect(getErrorMessage({})).toBe('Unknown error');
      expect(getErrorMessage(null)).toBe('Unknown error');
      expect(getErrorMessage(undefined)).toBe('Unknown error');
    });

    it('should handle error with only code', () => {
      const err = { code: 'SOME_CODE' };
      expect(getErrorMessage(err)).toBe('Unknown error');
    });
  });

  // ============================================================================
  // normalizeBackendError
  // ============================================================================
  describe('normalizeBackendError', () => {
    it('should return already normalized BackendError', () => {
      const originalError = new BackendError('Already normalized');
      const result = normalizeBackendError(originalError);
      
      expect(result).toBe(originalError);
    });

    it('should convert 5xx error to 503 PROVIDER_UNAVAILABLE', () => {
      const error = { status: 500, message: 'Server error' };
      const result = normalizeBackendError(error, 'blockfrost');
      
      expect(result.statusCode).toBe(503);
      expect(result.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
      expect(result.backendName).toBe('blockfrost');
    });

    it('should convert 4xx error to 502 PROVIDER_BAD_RESPONSE', () => {
      const error = { status: 400, message: 'Bad request' };
      const result = normalizeBackendError(error, 'koios');
      
      expect(result).toBeInstanceOf(ProviderBadResponseError);
      expect(result.statusCode).toBe(502);
      expect(result.code).toBe(ERROR_CODES.PROVIDER_BAD_RESPONSE);
    });

    it('should convert unknown error to 503 PROVIDER_UNAVAILABLE', () => {
      const error = new Error('Unknown error');
      const result = normalizeBackendError(error);
      
      // Unknown errors get status 500 from getErrorStatus, which triggers >= 500 path → 503
      expect(result.statusCode).toBe(503);
      expect(result.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
    });

    it('should preserve original error', () => {
      const originalError = { status: 503, message: 'Timeout' };
      const result = normalizeBackendError(originalError, 'blockfrost');
      
      expect(result.originalError).toBe(originalError);
    });
  });
});
