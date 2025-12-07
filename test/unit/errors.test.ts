import {
  BackendError,
  NotFoundError,
  TimeoutError,
  UnauthorizedError,
  InvalidDataError,
  AllBackendsFailedError,
  normalizeBackendError,
  isNotFoundError,
  isTimeoutError,
  isUnauthorizedError,
  getErrorStatus,
  getErrorMessage,
} from '../../srv/utils/errors';

describe('Typed Backend Errors', () => {
  describe('BackendError', () => {
    test('creates error with message and status code', () => {
      const err = new BackendError('Test error', 500, 'koios');
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
      const err = new BackendError('Wrapped', 500, 'koios', original);
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

  describe('InvalidDataError', () => {
    test('creates 500 error with custom message', () => {
      const err = new InvalidDataError('Invalid JSON response', 'koios');
      expect(err.message).toBe('Invalid JSON response');
      expect(err.statusCode).toBe(500);
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

    test('detects status 403', () => {
      expect(isUnauthorizedError({ status: 403 })).toBe(true);
    });

    test('detects response status 401/403', () => {
      expect(isUnauthorizedError({ response: { status: 401 } })).toBe(true);
      expect(isUnauthorizedError({ response: { status: 403 } })).toBe(true);
    });

    test('detects unauthorized in message', () => {
      expect(isUnauthorizedError({ message: 'Unauthorized access' })).toBe(true);
      expect(isUnauthorizedError({ message: 'Forbidden' })).toBe(true);
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
    const original = new BackendError('Test', 500, 'koios');
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
    expect(result.statusCode).toBe(500);
    expect(result.backendName).toBe('koios');
  });

  test('handles timeout message pattern', () => {
    const err = new Error('Primary getTransaction timed out after 8000ms');
    const result = normalizeBackendError(err, 'blockfrost');
    
    expect(result).toBeInstanceOf(TimeoutError);
    expect(result.statusCode).toBe(503);
  });
});
