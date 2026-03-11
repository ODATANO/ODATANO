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
 * TransactionValidationError - Transaction failed validation (400)
 * Indicates that the transaction failed validation checks
 * Examples: wrong signature, tampered CBOR, invalid witnesses
 */
export class TransactionValidationError extends BackendError {
  /** Constructor
   * @param message detailed validation failure message
   * @param originalError original error object
   */
  constructor(
    message: string,
    originalError?: any
  ) {
    super(
      message,
      400,
      ERROR_CODES.TX_VALIDATION_FAILED,
      undefined,
      originalError
    );
  }
}

/**
 * TransactionAlreadySubmittedError - Transaction already exists (409)
 * Indicates that the transaction has already been submitted (duplicate/replay)
 * Examples: same txHash already in mempool or on chain
 */
export class TransactionAlreadySubmittedError extends BackendError {
  /** Constructor
   * @param txHash the transaction hash that was already submitted
   * @param originalError original error object
   */
  constructor(
    public readonly txHash: string,
    originalError?: any
  ) {
    super(
      `Transaction ${txHash} already exists in mempool or on chain`,
      409,
      ERROR_CODES.TX_ALREADY_SUBMITTED,
      undefined,
      originalError
    );
  }
}

/**
 * InsufficientFundsError - Not enough funds or assets available (400)
 * Indicates that the address does not have enough of a specific asset to complete the transaction
 * Examples: trying to send more ADA than available, not enough native tokens
 */
export class InsufficientFundsError extends BackendError {
  /** Constructor
   * @param assetUnit the asset unit that is insufficient (e.g., "lovelace" or "policyId.assetName")
   * @param required the required amount
   * @param available the available amount
   * @param originalError original error object
   */
  constructor(
    public readonly assetUnit: string,
    public readonly required: bigint,
    public readonly available: bigint,
    originalError?: any
  ) {
    super(
      `Insufficient ${assetUnit}: required ${required}, available ${available}`,
      400,
      ERROR_CODES.INSUFFICIENT_FUNDS,
      undefined,
      originalError,
      assetUnit
    );
  }
}

/** 
 * MixedAssetsError - UTxO contains mixed assets when pure ADA is required (400)
 * Indicates that a UTxO contains native assets in addition to ADA, but the operation requires ADA-only UTxOs
 */
export class MixedAssetsError extends BackendError {
  /** Constructor
   * @param utxoRef UTxO reference (txHash#outputIndex)
   * @param assets list of non-ADA assets found in the UTxO
   * @param originalError original error object
   */
  constructor(
    public readonly utxoRef: string,
    public readonly assets: string[],
    originalError?: any
  ) {
    super(
      `UTxO ${utxoRef} contains non-ADA assets: ${assets.join(', ')}`,
      400,
      ERROR_CODES.INVALID_INPUT,
      undefined,
      originalError,
      utxoRef
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

  // Check Axios response.data.error (Koios format)
  if (e.response?.data?.error) return e.response.data.error;

  // Check direct message property
  if (e.message) return e.message;

  return 'Unknown error';
}

/**
 * Normalizes any backend error into a typed BackendError
 *
 * Priority (checked in order):
 * 1. TX Submission — Already submitted/duplicate → 409
 * 2. TX Submission — Validation/Signature errors → 400
 * 3. Message indicates "not found" → 404 (even if provider returns 5xx)
 * 4. Rate limiting (status 429 or message patterns) → 429
 * 5. Explicit 404 status → 404
 * 6. 5xx errors → 503 (Provider unavailable, retry-able)
 * 7. Other 4xx → 503
 * 8. Unknown/network errors → 503 (default fallback)
 */
export function normalizeBackendError(
  err: any,
  backendName?: string,
): BackendError {
  // Already normalized
  if (err instanceof BackendError) return err;

  // Check for uninitialized backend client (TypeError from calling methods on null/undefined client)
  if (err instanceof TypeError &&
      (err.message.includes('Cannot read properties of null') ||
       err.message.includes('Cannot read properties of undefined') ||
       err.message.includes('null is not an object') ||
       err.message.includes('undefined is not an object'))) {
    return new BackendInitError(
      backendName || 'unknown',
      new Error('Backend client not initialized - call init() first')
    );
  }

  const message = getErrorMessage(err);
  const status = getErrorStatus(err);
  const messageLower = message.toLowerCase();

  // Priority 1: TX Submission - Already submitted/duplicate → 409
  const alreadySubmittedHints = [
    'already exists',
    'already submitted',
    'already known',
    'known transaction',
    'duplicate',
    'in mempool',
  ];
  if (alreadySubmittedHints.some(h => messageLower.includes(h))) {
    // Try to extract txHash from message
    const txHashMatch = message.match(/([a-f0-9]{64})/i);
    return new TransactionAlreadySubmittedError(txHashMatch?.[1] || 'unknown', err);
  }

  // Priority 2: TX Submission - Validation/Signature errors → 400
  const validationErrorHints = [
    'signature',
    'witness',
    'verification failed',
    'deserialize',
    'malformed',
    'invalid cbor',
    'invalid transaction',
    'script failure',
  ];
  if (validationErrorHints.some(h => messageLower.includes(h))) {
    return new TransactionValidationError(
      `Transaction validation failed: ${message}`,
      err
    );
  }

  // Priority 3: Message indicates "not found" or equivalent → always 404
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

  // Priority 4: Rate limiting detection (status 429 or message patterns)
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

  // Priority 5: Explicit 404 status
  if (status === 404) {
    return new NotFoundError('Resource', backendName, err);
  }

  // Priority 6: 5xx errors → Provider unavailable (retry-able)
  if (status >= 500) {
    return new ProviderUnavailableError(
      message || 'Provider returned server error',
      backendName,
      undefined,
      err
    );
  }

  // Priority 7: Other 4xx → differentiate by status code
  if (status === 400 || status === 422) {
    return new TransactionValidationError(
      message || `Provider returned ${status}: invalid request`, err);
  }
  if (status === 401 || status === 403) {
    return new BackendError(
      `Provider authentication failed (${status}): ${message}`,
      status, ERROR_CODES.PROVIDER_UNAVAILABLE, backendName, err);
  }
  if (status >= 400) {
    return new ProviderUnavailableError(
      message || 'Provider request failed',
      backendName,
      undefined,
      err
    );
  }

  // Priority 8: Unknown/network errors → treat as unavailable (default fallback)
  return new ProviderUnavailableError(
    message || 'Unknown backend error',
    backendName,
    undefined,
    err
  );
}

/**
 * HsmError - Error related to HSM operations (signing, session, key access)
 * Indicates that the Hardware Security Module is unavailable or signing failed
 */
export class HsmError extends BackendError {
  constructor(
    message: string,
    statusCode: number = 503,
    code: ErrorCode = ERROR_CODES.HSM_UNAVAILABLE,
    originalError?: any
  ) {
    super(message, statusCode, code, 'hsm', originalError);
    this.name = 'HsmError';
  }
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
export class BackendInitError extends BackendError {
  constructor(
    backendName: string,
    originalError: unknown
  ) {
    super(
      `Failed to initialize backend: ${backendName}`,
      500,
      ERROR_CODES.INTERNAL_ERROR,
      backendName,
      originalError
    );
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
      .map(e => `${e.backendName}: ${e.originalError instanceof Error ? e.originalError.message : String(e.originalError)}`)
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
 * @throws {BackendError} BackendError with 400 status code
 */
export function rejectInvalid(req: Request, ctx: string, message: string, target?: string): never {
  throw new BackendError(
    `${ctx}: ${message}`,
    400,
    ERROR_CODES.INVALID_INPUT,
    undefined,
    undefined,
    target
  );
}

/**
 * Function to reject requests for missing required fields
 * @param req - The incoming request
 * @param ctx - Context string for the error
 * @param field - Name of the missing field
 * @throws {BackendError} BackendError with 400 status code
*/
export function rejectMissing(req: Request, ctx: string, field: string): never {
  throw new BackendError(
    `${ctx}: ${field} is required`,
    400,
    ERROR_CODES.INVALID_INPUT,
    undefined,
    undefined,
    field
  );
}

/**
 * Validation error from validators.ts
 */
interface ValidationError {
  type: 'missing' | 'invalid';
  field: string;
  message: string;
}

/**
 * Throw BackendError for the first validation error in the list
 * @param req - The incoming request
 * @param ctx - Context string for the error
 * @param errors - Array of validation errors from validateTransactionInputs
 * @throws {BackendError} if errors array is not empty
 */
export function throwIfValidationErrors(req: Request, ctx: string, errors: ValidationError[]): void {
  if (errors.length === 0) return;

  const firstError = errors[0];
  if (firstError.type === 'missing') {
    rejectMissing(req, ctx, firstError.field);
  } else {
    rejectInvalid(req, ctx, firstError.message, firstError.field);
  }
}