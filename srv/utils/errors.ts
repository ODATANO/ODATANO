// ---------------------------------------------------------------------------
// Typed Backend Errors
// ---------------------------------------------------------------------------

/**
 * Base class for all backend-related errors
 */
export class BackendError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly backendName?: string,
    public readonly originalError?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Resource not found in backend
 */
export class NotFoundError extends BackendError {
  constructor(resource: string, backendName?: string, originalError?: any) {
    super(`${resource} not found`, 404, backendName, originalError);
  }
}

/**
 * Backend timeout or unreachable
 */
export class TimeoutError extends BackendError {
  constructor(backendName?: string, timeoutMs?: number, originalError?: any) {
    const msg = timeoutMs 
      ? `Backend timeout after ${timeoutMs}ms`
      : 'Backend timeout or unreachable';
    super(msg, 503, backendName, originalError);
  }
}

/**
 * Unauthorized access to backend
 */
export class UnauthorizedError extends BackendError {
  constructor(backendName?: string, originalError?: any) {
    super('Unauthorized access to provider', 401, backendName, originalError);
  }
}

/**
 * Invalid data from backend
 */
export class InvalidDataError extends BackendError {
  constructor(message: string, backendName?: string, originalError?: any) {
    super(message, 500, backendName, originalError);
  }
}

/**
 * All backends failed
 */
export class AllBackendsFailedError extends BackendError {
  constructor(
    public readonly errors: BackendError[],
    originalError?: any
  ) {
    const lastError = errors[errors.length - 1];
    super(
      `All backends failed: ${lastError?.message ?? 'unknown error'}`,
      lastError?.statusCode ?? 500,
      undefined,
      originalError
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP Error Detection
// ---------------------------------------------------------------------------

export interface HttpErrorLike {
  message?: string;
  code?: string;
  status?: number;
  response?: {
    status?: number;
    data?: {
      error?: string;
      message?: string;
      [k: string]: any;
    };
  };
  [k: string]: any;
}

/**
 * Detects if error is a 404 Not Found
 */
export function isNotFoundError(err: HttpErrorLike | unknown): boolean {
  const e = (err ?? {}) as HttpErrorLike;
  
  // Check direct status
  if (e.status === 404) return true;
  
  // Check response status
  if (e.response?.status === 404) return true;
  
  // Check message conventions
  const msg = (e.message ?? '').toLowerCase();
  if (msg === 'not_found' || msg === 'not found') return true;
  if (msg.includes('not found')) return true;
  
  return false;
}

/**
 * Detects if error is a timeout
 */
export function isTimeoutError(err: HttpErrorLike | unknown): boolean {
  const e = (err ?? {}) as HttpErrorLike;
  
  // Check error code
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return true;
  
  // Check message
  const msg = (e.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  
  return false;
}

/**
 * Detects if error is unauthorized
 */
export function isUnauthorizedError(err: HttpErrorLike | unknown): boolean {
  const e = (err ?? {}) as HttpErrorLike;
  
  // Check status codes
  if (e.status === 401 || e.status === 403) return true;
  if (e.response?.status === 401 || e.response?.status === 403) return true;
  
  // Check message
  const msg = (e.message ?? '').toLowerCase();
  if (msg.includes('unauthor') || msg.includes('forbidden')) return true;
  
  return false;
}

/**
 * Gets HTTP status code from error
 */
export function getErrorStatus(err: HttpErrorLike | unknown): number {
  const e = (err ?? {}) as HttpErrorLike;
  return e.status ?? e.response?.status ?? 500;
}

/**
 * Gets error message from various error formats
 */
export function getErrorMessage(err: HttpErrorLike | unknown): string {
  const e = (err ?? {}) as HttpErrorLike;
  
  // Try response data first (most detailed)
  if (e.response?.data?.message) return e.response.data.message;
  if (e.response?.data?.error) return e.response.data.error;
  
  // Try direct message
  if (e.message) return e.message;
  
  // Fallback
  return 'Unknown error';
}

// ---------------------------------------------------------------------------
// Backend Error Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes any backend error into a typed BackendError
 */
export function normalizeBackendError(
  err: any,
  backendName?: string,
  resource?: string
): BackendError {
  // Already a BackendError - return as is
  if (err instanceof BackendError) {
    return err;
  }

  // Check for specific error types
  if (isNotFoundError(err)) {
    return new NotFoundError(resource ?? 'Resource', backendName, err);
  }

  if (isTimeoutError(err)) {
    return new TimeoutError(backendName, undefined, err);
  }

  if (isUnauthorizedError(err)) {
    return new UnauthorizedError(backendName, err);
  }

  // Generic backend error
  const message = getErrorMessage(err);
  const status = getErrorStatus(err);
  
  return new BackendError(message, status, backendName, err);
}
