import { ERROR_CODES, type ErrorCode } from './error-codes';
import { Request } from '@sap/cds'; 
/** 
 * Backend Errors Implementation
 * Defines typed errors for backend communication issues
 */

/** 
 * BackendError Base class for all backend-related errors
 */
export class BackendError extends Error {
  /** Constructor
   * @param message error message string
   * @param statusCode error status code
   * @param code error code
   * @param backendName name of the backend where the error originated
   * @param originalError original error object
   * @param target target resource (if applicable)
   */
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: ErrorCode = ERROR_CODES.INTERNAL_ERROR,
    public readonly backendName?: string,
    public readonly originalError?: any,
    public readonly target?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 
 * NotFoundError - Resource not found in backend (404)
 * This is NOT a provider error - it's a valid response indicating the resource doesn't exist
 * Examples: transaction hash not found, address has no UTxOs
 */
export class NotFoundError extends BackendError {
  /** Constructor
   * @param resource name of the resource that was not found
   * @param backendName name of the backend where the error originated
   * @param originalError original error object
   */
  constructor(resource: string, backendName?: string, originalError?: any) {
    super(
      `${resource} not found`,
      404,
      ERROR_CODES.NOT_FOUND,
      backendName,
      originalError
    );
  }
}

/** 
 * ProviderUnavailableError - Provider unavailable or timeout (503)
 * Indicates a temporary issue - retrying may help
 * Examples: network timeout, 5xx errors, service down
 */
export class ProviderUnavailableError extends BackendError {
  /** Constructor
   * @param message error message string
   * @param backendName name of the backend where the error originated
   * @param timeoutMs optional timeout duration in milliseconds
   * @param originalError original error object
   */
  constructor(message: string, backendName?: string, timeoutMs?: number, originalError?: any) {
    const msg = timeoutMs
      ? `${message} (timeout after ${timeoutMs}ms)`
      : message;

    super(
      msg,
      503,
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      backendName,
      originalError
    );
  }
}

/** 
 * RateLimitError - Provider rate limit exceeded (429)
 * Indicates too many requests - client should back off and retry later
 * Examples: Blockfrost 10 req/sec limit, Koios tier limits
 */
export class RateLimitError extends BackendError {
  /** Constructor
   * @param message error message string
   * @param backendName name of the backend where the error originated
   * @param retryAfter optional retry-after duration in seconds
   * @param originalError original error object
   */
  constructor(message: string, backendName?: string, retryAfter?: number, originalError?: any) {
    const msg = retryAfter
      ? `${message} (retry after ${retryAfter}s)`
      : message;

    super(
      msg,
      429,
      ERROR_CODES.PROVIDER_RATE_LIMITED,
      backendName,
      originalError
    );
  }
}

/** 
 * AllBackendsFailedError - All backends failed
 * Aggregates multiple backend errors and returns the most relevant status
 */
export class AllBackendsFailedError extends BackendError {
  /** Constructor
   * @param errors array of backend errors
   * @param originalError original error object
   */
  constructor(public readonly errors: BackendError[], originalError?: any) {
    const lastError = errors[errors.length - 1];

    super(
      `All backends failed: ${lastError?.message ?? 'unknown error'}`,
      lastError?.statusCode ?? 502,
      lastError?.code ?? ERROR_CODES.PROVIDER_UNAVAILABLE,
      undefined,
      originalError
    );
  }
}

/**
 *  HttpErrorLike - Simplified interface for HTTP errors from various libraries 
 */
export interface HttpErrorLike {
  message?: string;
  code?: string;
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, any>;
    data?: {
      error?: string;
      message?: string;
      [k: string]: any;
    };
  };
  [k: string]: any;
}

/** 
 * Utility functions to extract status and message from HttpErrorLike
 * @param err error object
 * @returns {number} status code
 */
export function getErrorStatus(err: HttpErrorLike | unknown): number {
  const e = (err ?? {}) as HttpErrorLike;
  return e.status ?? e.response?.status ?? 500;
}

/** 
 * Utility functions to extract status and message from HttpErrorLike
 * @param err error object
 * @returns {string} error message
 */
export function getErrorMessage(err: HttpErrorLike | unknown): string {
  const e = (err ?? {}) as HttpErrorLike;

  if (e.message) return e.message;

  return 'Unknown error';
}

/** 
 * Normalizes any backend error into a typed BackendError
 * 
 * Priority:
 * 1. Check message for "not found" → 404 (even if provider returns 5xx)
 * 2. Check HTTP status 429 or rate limit messages → 429
 * 3. Check HTTP status 404 → 404
 * 4. Check HTTP status 5xx → 503 (retry-able)
 * 5. Check HTTP status 4xx → 404 if "not found", otherwise 503
 * 6. Unknown/network errors → 503
 */
export function normalizeBackendError(
  err: any,
  backendName?: string,
): BackendError {
  // Already normalized
  if (err instanceof BackendError) return err;

  const message = getErrorMessage(err);
  const status = getErrorStatus(err);
  const messageLower = message.toLowerCase();

  // Priority 1: Message indicates "not found" or equivalent → always 404
  // This also handles providers returning wrong status codes for missing resources
  const notFoundHints = [
    'not found',
    'has not been found',
    'does not exist',
    'no data',
    'no records',
    'empty result',
    'not available',
    'no metadata',
    'invalid address',
    'malformed address',
  ];
  if (notFoundHints.some(h => messageLower.includes(h))) {
    return new NotFoundError('Resource', backendName, err);
  }

  // Priority 2: Rate limiting detection (status 429 or message patterns)
  if (status === 429 || 
      messageLower.includes('rate limit') || 
      messageLower.includes('too many requests') ||
      messageLower.includes('quota exceeded')) {
    // Try to extract retry-after header
    const retryAfter = err.response?.headers?.["retry-after"] || 
                       err.response?.headers?.["x-ratelimit-reset"];
    return new RateLimitError(
      message || 'Rate limit exceeded',
      backendName,
      retryAfter ? parseInt(retryAfter, 10) : undefined,
      err
    );
  }

  // Priority 3: Explicit 404 status
  if (status === 404) {
    return new NotFoundError('Resource', backendName, err);
  }

  // Priority 4: 5xx errors → Provider unavailable (retry-able)
  if (status >= 500) {
    return new ProviderUnavailableError(
      message || 'Provider returned server error',
      backendName,
      undefined,
      err
    );
  }

  // Priority 5: Other 4xx → Check if it's a disguised "not found"
  if (status >= 400) {
    if (messageLower.includes('not found') || messageLower.includes('does not exist')) {
      return new NotFoundError('Resource', backendName, err);
    }
    // Other 4xx like bad requests → treat as unavailable
    return new ProviderUnavailableError(
      message || 'Provider request failed',
      backendName,
      undefined,
      err
    );
  }

  // Priority 6: Network/unknown errors → Provider unavailable
  return new ProviderUnavailableError(
    message || 'Provider communication failed',
    backendName,
    undefined,
    err
  );
}

/** 
 * ConfigError - Error in configuration settings
 * Captures configuration-related issues
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 
 * BackendInitError - Error initializing a specific backend
 * Captures backend name and original error
 */
export class BackendInitError extends Error {
  constructor(
    public readonly backendName: String,
    public readonly originalError: unknown
  ) {
    super(`Failed to initialize backend: ${backendName}`);
    this.name = 'BackendInitError';
  }
}

/** 
 * AllBackendsInitFailedError - All backends failed to initialize
 * Aggregates multiple backend initialization errors
 */
export class AllBackendsInitFailedError extends Error {
  constructor(public readonly errors: BackendInitError[]) {
    const summary = errors
      .map(e => `${e.backendName}: ${String((e.originalError as any)?.message ?? e.originalError)}`)
      .join(' | ');
    super(`CardanoClient startup failed: all backends failed to initialize. ${summary}`);
    this.name = 'AllBackendsInitFailedError';
  }
}

/** 
 * Function to reject requests with standardized error messages
 * @param req - The incoming request
 * @param ctx - Context string for the error
 * @param message - Detailed error message
 * @param target - Optional target resource
 * @returns {Promise<any>} rejection response
 */
export function rejectInvalid(req: Request, ctx: string, message: string, target?: string) {
  return req .reject(400, `[${ERROR_CODES.INVALID_INPUT}] ${ctx}: ${message}`, target);
}

/** 
 * Function to reject requests for missing required fields
 * @param req - The incoming request
 * @param ctx - Context string for the error
 * @param field - Name of the missing field
 * @returns {Promise<any>} rejection response 
*/
export function rejectMissing(req: Request, ctx: string, field: string) {
  return req.reject(400, `[${ERROR_CODES.INVALID_INPUT}] ${ctx}: ${field} is required`, field);
}