import {
  BackendError,
  NotFoundError,
  TimeoutError,
  UnauthorizedError,
  ProviderBadResponseError,
  AllBackendsFailedError,
  normalizeBackendError,
  isNotFoundError,
  isTimeoutError,
  isUnauthorizedError,
  isForbiddenError,
  isRateLimitedError,
  getErrorStatus,
  getErrorMessage,
  RateLimitedError,
  ForbiddenError,
  ConfigError,
  BackendInitError,
  AllBackendsInitFailedError,
  rejectInvalid,
  rejectMissing,
} from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';

describe('Typed Backend Errors', () => {
  describe('BackendError', () => {
    test('creates error with message and status code', () => {
      const err = new BackendError('Test error', 500, ERROR_CODES.INTERNAL_ERROR, 'koios');
      expect(err.message).toBe('Test error');
      expect(err.statusCode).toBe(500);
      expect(err.backendName).toBe('koios');
      expect(err.name).toBe('BackendError');
    });

    test('captures stack trace', () => {
      const err = new BackendError('Test');
      expect(err.stack).toBeDefined();
    });

    test('stores original error', () => {
      const original = new Error('Original');
      const err = new BackendError('Wrapped', 500, ERROR_CODES.INTERNAL_ERROR, 'koios', original);
      expect(err.originalError).toBe(original);
    });
  });

  describe('NotFoundError', () => {
    test('creates 404 error with resource name', () => {
      const err = new NotFoundError('Transaction', 'koios');
      expect(err.message).toBe('Transaction not found');
      expect(err.statusCode).toBe(404);
      expect(err.backendName).toBe('koios');
      expect(err.name).toBe('NotFoundError');
    });
  });

  describe('TimeoutError', () => {
    test('creates 503 error without timeout value', () => {
      const err = new TimeoutError('koios');
      expect(err.message).toBe('Backend timeout or unreachable');
      expect(err.statusCode).toBe(503);
      expect(err.backendName).toBe('koios');
    });

    test('creates 503 error with timeout value', () => {
      const err = new TimeoutError('koios', 5000);
      expect(err.message).toBe('Backend timeout after 5000ms');
      expect(err.statusCode).toBe(503);
    });
  });

  describe('UnauthorizedError', () => {
    test('creates 401 error', () => {
      const err = new UnauthorizedError('koios');
      expect(err.message).toBe('Unauthorized access to provider');
      expect(err.statusCode).toBe(401);
      expect(err.backendName).toBe('koios');
    });
  });

  describe('ProviderBadResponseError', () => {
    test('creates 502 error with custom message', () => {
      const err = new ProviderBadResponseError('Invalid JSON response', 'koios');
      expect(err.message).toBe('Invalid JSON response');
      expect(err.statusCode).toBe(502);
      expect(err.backendName).toBe('koios');
    });
  });

  describe('AllBackendsFailedError', () => {
    test('combines multiple backend errors', () => {
      const errors = [
        new TimeoutError('blockfrost', 5000),
        new NotFoundError('Transaction', 'koios'),
      ];
      const err = new AllBackendsFailedError(errors);
      
      expect(err.message).toContain('All backends failed');
      expect(err.message).toContain('Transaction not found');
      expect(err.statusCode).toBe(404); // Last error status
      expect(err.errors).toEqual(errors);
    });

    test('handles empty errors array', () => {
      const err = new AllBackendsFailedError([]);
      expect(err.message).toContain('unknown error');
      expect(err.statusCode).toBe(500);
    });
  });
});

describe('Error Detection Functions', () => {
  describe('isNotFoundError', () => {
    test('detects direct status 404', () => {
      expect(isNotFoundError({ status: 404 })).toBe(true);
    });

    test('detects response status 404', () => {
      expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    });

    test('detects NOT_FOUND message', () => {
      expect(isNotFoundError({ message: 'NOT_FOUND' })).toBe(true);
      expect(isNotFoundError({ message: 'not found' })).toBe(true);
    });

    test('detects message containing "not found"', () => {
      expect(isNotFoundError({ message: 'Transaction not found' })).toBe(true);
    });

    test('returns false for other errors', () => {
      expect(isNotFoundError({ status: 500 })).toBe(false);
      expect(isNotFoundError({ message: 'timeout' })).toBe(false);
    });
  });

  describe('isTimeoutError', () => {
    test('detects ECONNABORTED code', () => {
      expect(isTimeoutError({ code: 'ECONNABORTED' })).toBe(true);
    });

    test('detects ETIMEDOUT code', () => {
      expect(isTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    test('detects timeout in message', () => {
      expect(isTimeoutError({ message: 'Request timeout' })).toBe(true);
      expect(isTimeoutError({ message: 'Operation timed out' })).toBe(true);
    });

    test('returns false for other errors', () => {
      expect(isTimeoutError({ status: 404 })).toBe(false);
    });
  });

  describe('isUnauthorizedError', () => {
    test('detects status 401', () => {
      expect(isUnauthorizedError({ status: 401 })).toBe(true);
    });

    test('does not detect status 403 (that is Forbidden)', () => {
      expect(isUnauthorizedError({ status: 403 })).toBe(false);
    });

    test('detects response status 401', () => {
      expect(isUnauthorizedError({ response: { status: 401 } })).toBe(true);
    });

    test('detects unauthorized in message', () => {
      expect(isUnauthorizedError({ message: 'Unauthorized access' })).toBe(true);
      expect(isUnauthorizedError({ message: 'Forbidden' })).toBe(false);
    });

    test('returns false for other errors', () => {
      expect(isUnauthorizedError({ status: 404 })).toBe(false);
    });
  });

  describe('getErrorStatus', () => {
    test('extracts direct status', () => {
      expect(getErrorStatus({ status: 404 })).toBe(404);
    });

    test('extracts response status', () => {
      expect(getErrorStatus({ response: { status: 401 } })).toBe(401);
    });

    test('defaults to 500', () => {
      expect(getErrorStatus({})).toBe(500);
      expect(getErrorStatus(null)).toBe(500);
    });
  });

  describe('getErrorMessage', () => {
    test('extracts response data message', () => {
      const err = { response: { data: { message: 'API error' } } };
      expect(getErrorMessage(err)).toBe('API error');
    });

    test('extracts response data error', () => {
      const err = { response: { data: { error: 'Bad request' } } };
      expect(getErrorMessage(err)).toBe('Bad request');
    });

    test('extracts direct message', () => {
      expect(getErrorMessage({ message: 'Direct error' })).toBe('Direct error');
    });

    test('defaults to "Unknown error"', () => {
      expect(getErrorMessage({})).toBe('Unknown error');
      expect(getErrorMessage(null)).toBe('Unknown error');
    });
  });
});

describe('normalizeBackendError', () => {
  test('returns BackendError as is', () => {
    const original = new BackendError('Test', 500, ERROR_CODES.INTERNAL_ERROR, 'koios');
    const result = normalizeBackendError(original);
    expect(result).toBe(original);
  });

  test('converts 404 to NotFoundError', () => {
    const err = { status: 404, message: 'Not found' };
    const result = normalizeBackendError(err, 'koios', 'Transaction');
    
    expect(result).toBeInstanceOf(NotFoundError);
    expect(result.message).toBe('Transaction not found');
    expect(result.statusCode).toBe(404);
    expect(result.backendName).toBe('koios');
  });

  test('converts timeout to TimeoutError', () => {
    const err = { code: 'ETIMEDOUT', message: 'Request timed out' };
    const result = normalizeBackendError(err, 'blockfrost');
    
    expect(result).toBeInstanceOf(TimeoutError);
    expect(result.statusCode).toBe(503);
    expect(result.backendName).toBe('blockfrost');
  });

  test('converts 401/403 to UnauthorizedError', () => {
    const err = { status: 401, message: 'Invalid API key' };
    const result = normalizeBackendError(err, 'koios');
    
    expect(result).toBeInstanceOf(UnauthorizedError);
    expect(result.statusCode).toBe(401);
    expect(result.backendName).toBe('koios');
  });

  test('converts axios-style error', () => {
    const err = { 
      response: { 
        status: 500, 
        data: { message: 'Internal server error' } 
      } 
    };
    const result = normalizeBackendError(err, 'koios');
    
    expect(result).toBeInstanceOf(BackendError);
    expect(result.message).toBe('Internal server error');
    expect(result.statusCode).toBe(503); // 5xx errors are normalized to 503 (PROVIDER_UNAVAILABLE)
    expect(result.backendName).toBe('koios');
  });

  test('handles timeout message pattern', () => {
    const err = new Error('Primary getTransaction timed out after 8000ms');
    const result = normalizeBackendError(err, 'blockfrost');
    
    expect(result).toBeInstanceOf(TimeoutError);
    expect(result.statusCode).toBe(503);
  });
  describe('Advanced Error Handling - Coverage Improvements', () => {
    
    describe('RateLimitedError', () => {
      test('creates 503 error for rate limiting', () => {
        const err = new RateLimitedError('blockfrost');
        expect(err.message).toBe('Provider rate limit exceeded');
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe(ERROR_CODES.PROVIDER_RATE_LIMITED);
        expect(err.backendName).toBe('blockfrost');
      });
  
      test('stores original error', () => {
        const original = new Error('Rate limit: 429');
        const err = new RateLimitedError('blockfrost', original);
        expect(err.originalError).toBe(original);
      });
    });
  
    describe('ForbiddenError', () => {
      test('creates 403 error', () => {
        const err = new ForbiddenError('koios');
        expect(err.message).toBe('Forbidden access to provider');
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe(ERROR_CODES.FORBIDDEN);
        expect(err.backendName).toBe('koios');
      });
  
      test('stores original error', () => {
        const original = new Error('Access denied');
        const err = new ForbiddenError('koios', original);
        expect(err.originalError).toBe(original);
      });
    });
  
    describe('normalizeBackendError - Rate Limit Detection', () => {
      test('detects rate limit error from status 429', () => {
        const err = {
          response: { status: 429 },
          message: 'Too many requests'
        };
        const normalized = normalizeBackendError(err, 'blockfrost');
        expect(normalized).toBeInstanceOf(RateLimitedError);
        expect(normalized.statusCode).toBe(503);
      });
  
      test('detects rate limit from error message patterns - case insensitive', () => {
        const patterns = [
          'rate limit exceeded',
          'too many requests',
          'rate limited',
          'rate limit',
          'rate-limit',
          'ratelimit'
        ];
  
        patterns.forEach(pattern => {
          const err = { message: pattern };
          const normalized = normalizeBackendError(err, 'backend');
          expect(normalized).toBeInstanceOf(BackendError);
        });
      });
  
      test('detects rate limit from axios error with message', () => {
        const err = {
          message: 'Request failed with status code 429: rate limit exceeded',
          isAxiosError: true
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(RateLimitedError);
      });
    });
  
    describe('normalizeBackendError - Timeout Detection', () => {
      test('detects timeout from ECONNABORTED code', () => {
        const err = { code: 'ECONNABORTED', message: 'timeout' };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(TimeoutError);
        expect(normalized.statusCode).toBe(503);
      });
  
      test('detects timeout from ETIMEDOUT code', () => {
        const err = { code: 'ETIMEDOUT', message: 'timeout' };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(TimeoutError);
      });
  
      test('detects timeout from error message patterns', () => {
        const patterns = [
          'timeout',
          'timed out',
          'TIMEOUT',
          'connection timeout'
        ];
  
        patterns.forEach(pattern => {
          const err = { message: pattern };
          const normalized = normalizeBackendError(err, 'backend');
          expect(normalized).toBeInstanceOf(TimeoutError);
        });
      });
    });
  
    describe('normalizeBackendError - Unauthorized Detection', () => {
      test('detects unauthorized from status 401', () => {
        const err = {
          response: { status: 401 },
          message: 'Unauthorized'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(UnauthorizedError);
        expect(normalized.statusCode).toBe(401);
      });
  
      test('detects unauthorized from error message patterns', () => {
        const patterns = [
          'unauthorized',
          'UNAUTHORIZED',
          'Unauthorized',
          'invalid api key',
          'Invalid API Key',
          'INVALID API KEY',
          'authentication failed',
          'Authentication Failed',
          'not authenticated',
          'Not Authenticated'
        ];
  
        patterns.forEach(pattern => {
          const err = { message: pattern };
          const normalized = normalizeBackendError(err, 'backend');
          expect(normalized).toBeInstanceOf(BackendError);
        });
      });
    });
  
    describe('normalizeBackendError - Forbidden Detection', () => {
      test('detects forbidden from status 403', () => {
        const err = {
          response: { status: 403 },
          message: 'Forbidden'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(ForbiddenError);
        expect(normalized.statusCode).toBe(403);
      });
  
      test('detects forbidden from error message', () => {
        const err = { message: 'forbidden access' };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(ForbiddenError);
      });
    });
  
    describe('normalizeBackendError - 5xx Status Codes', () => {
      test('converts 500 to provider unavailable', () => {
        const err = {
          response: { status: 500 },
          message: 'Internal server error'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized.statusCode).toBe(503);
        expect(normalized.code).toBe(ERROR_CODES.PROVIDER_UNAVAILABLE);
      });
  
      test('converts 502 to provider unavailable', () => {
        const err = {
          response: { status: 502 },
          message: 'Bad gateway'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized.statusCode).toBe(503);
      });
  
      test('converts 504 to provider unavailable', () => {
        const err = {
          response: { status: 504 },
          message: 'Gateway timeout'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized.statusCode).toBe(503);
      });

      test('convert Unknown / non-http error → internal ', () => {
        const err = {
          response: { status: 100 },
          message: 'what even is this?'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized.statusCode).toBe(500);
      });
    });
  
    describe('normalizeBackendError - 4xx Status Codes', () => {
      test('converts 400 to provider bad response', () => {
        const err = {
          response: { status: 400 },
          message: 'Bad request'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(ProviderBadResponseError);
        expect(normalized.statusCode).toBe(502);
      });
  
      test('converts 422 to provider bad response', () => {
        const err = {
          response: { status: 422 },
          message: 'Unprocessable entity'
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(ProviderBadResponseError);
      });
    });
  
    describe('normalizeBackendError - Unknown Errors', () => {
      test('converts unknown error to internal error', () => {
        const err = { message: 'Something went wrong' };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized.statusCode).toBe(503);
        expect(normalized.code).toBe('ODATANO_PROVIDER_UNAVAILABLE');
      });
  
      test('handles error without message', () => {
        const err = {};
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized.statusCode).toBe(503);
      });
  
      test('handles error with nested response data', () => {
        const err = {
          response: {
            status: 418, // I'm a teapot (4xx but not caught)
            data: { error: 'Custom error' }
          }
        };
        const normalized = normalizeBackendError(err, 'backend');
        expect(normalized).toBeInstanceOf(ProviderBadResponseError);
      });
    });
  
    describe('ConfigError', () => {
      test('creates config error with message', () => {
        const err = new ConfigError('Invalid configuration');
        expect(err.message).toBe('Invalid configuration');
        expect(err.name).toBe('ConfigError');
      });
    });
  
    describe('BackendInitError', () => {
      test('creates backend init error', () => {
        const original = new Error('Init failed');
        const err = new BackendInitError('blockfrost', original);
        expect(err.message).toBe('Failed to initialize backend: blockfrost');
        expect(err.backendName).toBe('blockfrost');
        expect(err.originalError).toBe(original);
        expect(err.name).toBe('BackendInitError');
      });
    });
  
    describe('AllBackendsInitFailedError', () => {
      test('creates error with multiple backend init failures', () => {
        const errors = [
          new BackendInitError('blockfrost', new Error('API key invalid')),
          new BackendInitError('koios', new Error('Connection refused'))
        ];
        const err = new AllBackendsInitFailedError(errors);
        
        expect(err.message).toContain('all backends failed to initialize');
        expect(err.message).toContain('blockfrost');
        expect(err.message).toContain('koios');
        expect(err.name).toBe('AllBackendsInitFailedError');
      });
  
      test('handles backend init error without error message', () => {
        const errors = [
          new BackendInitError('backend1', 'string error'),
          new BackendInitError('backend2', null)
        ];
        const err = new AllBackendsInitFailedError(errors);
        expect(err.message).toContain('backend1');
        expect(err.message).toContain('backend2');
      });
    });
  
    describe('rejectInvalid', () => {
      test('creates rejection with custom message', () => {
        const mockReq = {
          reject: jest.fn()
        };
        
        rejectInvalid(mockReq as any, 'TestContext', 'Invalid data', 'field1');
        
        expect(mockReq.reject).toHaveBeenCalledWith(
          400,
          '[ODATANO_INVALID_INPUT] TestContext: Invalid data',
          'field1'
        );
      });
  
      test('creates rejection without target field', () => {
        const mockReq = {
          reject: jest.fn()
        };
        
        rejectInvalid(mockReq as any, 'TestContext', 'Invalid data');
        
        expect(mockReq.reject).toHaveBeenCalledWith(
          400,
          '[ODATANO_INVALID_INPUT] TestContext: Invalid data',
          undefined
        );
      });
    });
  
    describe('rejectMissing', () => {
      test('creates rejection for missing field', () => {
        const mockReq = {
          reject: jest.fn()
        };
        
        rejectMissing(mockReq as any, 'TestContext', 'requiredField');
        
        expect(mockReq.reject).toHaveBeenCalledWith(
          400,
          '[ODATANO_INVALID_INPUT] TestContext: requiredField is required',
          'requiredField'
        );
      });
    });
  
    describe('BackendError with target field', () => {
      test('includes target field in error', () => {
        const err = new BackendError(
          'Validation failed',
          400,
          ERROR_CODES.INVALID_INPUT,
          'backend',
          null,
          'txHash'
        );
        expect(err.target).toBe('txHash');
      });
    }); 

    describe('isForbiddenError', () => {
      test('returns true for 403 status', () => {
        const err = { status: 403 };
        expect(isForbiddenError(err)).toBe(true);
      });

      test('returns true for 403 response status', () => {
        const err = { response: { status: 403 } };
        expect(isForbiddenError(err)).toBe(true);
      });

      test('returns true for forbidden message', () => {
        const err = { message: 'Forbidden access' };
        expect(isForbiddenError(err)).toBe(true);
      });

      test('returns false for non-forbidden errors', () => {
        const err = { status: 404 };
        expect(isForbiddenError(err)).toBe(false);
      });
    });

    describe('isRateLimitedError', () => {
      test('returns true for 429 status', () => {
        const err = { status: 429 };
        expect(isRateLimitedError(err)).toBe(true);
      });

      test('returns true for 429 response status', () => {
        const err = { response: { status: 429 } };
        expect(isRateLimitedError(err)).toBe(true);
      });

      test('returns true for rate limit message', () => {
        const err = { message: 'rate limit exceeded' };
        expect(isRateLimitedError(err)).toBe(true);
      });

      test('returns true for too many requests message', () => {
        const err = { message: 'Too many requests' };
        expect(isRateLimitedError(err)).toBe(true);
      });

      test('returns false for non-rate-limit errors', () => {
        const err = { status: 500 };
        expect(isRateLimitedError(err)).toBe(false);
      });
    });

    describe('getErrorStatus', () => {
      test('returns status from error', () => {
        const err = { status: 404 };
        expect(getErrorStatus(err)).toBe(404);
      });

      test('returns status from response', () => {
        const err = { response: { status: 503 } };
        expect(getErrorStatus(err)).toBe(503);
      });

      test('returns 500 for errors without status', () => {
        const err = { message: 'Some error' };
        expect(getErrorStatus(err)).toBe(500);
      });

      test('returns 500 for null/undefined', () => {
        expect(getErrorStatus(null)).toBe(500);
        expect(getErrorStatus(undefined)).toBe(500);
      });
    });

    describe('getErrorMessage', () => {
      test('extracts message from response.data.message', () => {
        const err = { response: { data: { message: 'Response error' } } };
        expect(getErrorMessage(err)).toBe('Response error');
      });

      test('extracts message from response.data.error', () => {
        const err = { response: { data: { error: 'Error description' } } };
        expect(getErrorMessage(err)).toBe('Error description');
      });

      test('extracts message from error.message', () => {
        const err = { message: 'Direct message' };
        expect(getErrorMessage(err)).toBe('Direct message');
      });

      test('returns Unknown error for empty errors', () => {
        expect(getErrorMessage({})).toBe('Unknown error');
        expect(getErrorMessage(null)).toBe('Unknown error');
      });
    });

    describe('normalizeBackendError - additional cases', () => {
      test('converts rate limited error', () => {
        const err = { status: 429, message: 'Rate limit exceeded' };
        const result = normalizeBackendError(err, 'blockfrost');
        
        expect(result).toBeInstanceOf(RateLimitedError);
        expect(result.statusCode).toBe(503);
      });

      test('converts forbidden error', () => {
        const err = { status: 403, message: 'Forbidden' };
        const result = normalizeBackendError(err, 'koios');
        
        expect(result).toBeInstanceOf(ForbiddenError);
        expect(result.statusCode).toBe(403);
      });

      test('returns BackendError as-is', () => {
        const err = new BackendError('Test', 500, ERROR_CODES.INTERNAL_ERROR, 'backend');
        const result = normalizeBackendError(err, 'backend');
        
        expect(result).toBe(err);
      });
    });
});
}); 
