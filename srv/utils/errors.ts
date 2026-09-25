import { ERROR_CODES, type ErrorCode } from './error-codes';
import { Request } from '@sap/cds';
/** Typed errors for backend communication and request validation. */

/** Base class for all backend-related errors. */
export class BackendError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: ErrorCode = ERROR_CODES.INTERNAL_ERROR,
    public readonly backendName?: string,
    public readonly originalError?: unknown,
    public readonly target?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Resource not found (404); a valid response, not a provider fault. */
export class NotFoundError extends BackendError {
  constructor(resource: string, backendName?: string, originalError?: unknown) {
    super(
      `${resource} not found`,
      404,
      ERROR_CODES.NOT_FOUND,
      backendName,
      originalError
    );
  }
}

/** Transaction failed validation (400): wrong signature, tampered CBOR, invalid witnesses. `code` may be `TX_PARSE_FAILED`. */
export class TransactionValidationError extends BackendError {
  constructor(
    message: string,
    originalError?: unknown,
    code: ErrorCode = ERROR_CODES.TX_VALIDATION_FAILED
  ) {
    super(
      message,
      400,
      code,
      undefined,
      originalError
    );
  }
}

/** Ledger phase-2 script rejection (400): PlutusFailure, CekError, budget, hash mismatch. Not retryable on another provider. */
export class ScriptValidationError extends BackendError {
  constructor(
    message: string,
    originalError?: unknown
  ) {
    super(
      message,
      400,
      ERROR_CODES.SCRIPT_VALIDATION_FAILURE,
      undefined,
      originalError
    );
  }
}

/** Transaction already in mempool or on chain (409). */
export class TransactionAlreadySubmittedError extends BackendError {
  constructor(
    public readonly txHash: string,
    originalError?: unknown
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
 * Not enough of an asset for the transaction (400). `required`/`available` are 0n when unknown;
 * `detail` then replaces the amounts in the message.
 */
export class InsufficientFundsError extends BackendError {
  constructor(
    public readonly assetUnit: string,
    public readonly required: bigint,
    public readonly available: bigint,
    originalError?: unknown,
    detail?: string
  ) {
    super(
      detail
        ? `Insufficient ${assetUnit}: ${detail}`
        : `Insufficient ${assetUnit}: required ${required}, available ${available}`,
      400,
      ERROR_CODES.INSUFFICIENT_FUNDS,
      undefined,
      originalError,
      assetUnit
    );
  }
}

/** UTxO carries native assets where ADA-only is required (400). `utxoRef` is `txHash#outputIndex`. */
export class MixedAssetsError extends BackendError {
  constructor(
    public readonly utxoRef: string,
    public readonly assets: string[],
    originalError?: unknown
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

/** Provider unavailable or timed out (503); retryable. `timeoutMs` is appended to the message. */
export class ProviderUnavailableError extends BackendError {
  constructor(message: string, backendName?: string, timeoutMs?: number, originalError?: unknown) {
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

/** Provider rate limit exceeded (429). `retryAfter` is in seconds. */
export class RateLimitError extends BackendError {
  constructor(message: string, backendName?: string, retryAfter?: number, originalError?: unknown) {
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

/** Every backend failed; carries the last error's status, or 503 when all were skipped. */
export class AllBackendsFailedError extends BackendError {
  constructor(public readonly errors: BackendError[], originalError?: unknown) {
    const lastError = errors[errors.length - 1];

    super(
      // Empty errors: every backend was skipped (method unsupported), nothing failed upstream, so 503
      `All backends failed: ${lastError?.message ?? 'unknown error'}`,
      lastError?.statusCode ?? 503,
      lastError?.code ?? ERROR_CODES.PROVIDER_UNAVAILABLE,
      undefined,
      originalError
    );
  }
}

/**
 * True when the resource is absent on every consulted backend: a NotFoundError, or an
 * AllBackendsFailedError whose per-backend errors are all 404. A mixed result is not proof of absence.
 */
export function isNotFoundOnAllBackends(err: unknown): boolean {
  if (err instanceof NotFoundError) return true;
  return err instanceof AllBackendsFailedError
    && err.errors.length > 0
    && err.errors.every((e) => e instanceof NotFoundError || e.statusCode === 404);
}

/** Simplified shape of HTTP errors from various client libraries. */
export interface HttpErrorLike {
  message?: string;
  code?: string;
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    data?: {
      error?: string;
      message?: string;
      [k: string]: unknown;
    };
  };
  [k: string]: unknown;
}

/**
 * PostgreSQL error-code classes that mean a provider-side fault, which PostgREST (Koios) returns as HTTP 400:
 * 08 connection, 42 undefined object, 53 resources, 57 operator intervention, 58 system, XX internal.
 * Client-input classes (22 etc.) stay 4xx.
 */
const PG_SERVER_ERROR_CODE_CLASSES = ['08', '42', '53', '57', '58', 'XX'];

/** True when a PostgREST error body's `code` denotes a provider-side SQL fault. */
export function isPostgrestServerErrorCode(code: unknown): boolean {
  return typeof code === 'string' && PG_SERVER_ERROR_CODE_CLASSES.some(c => code.startsWith(c));
}

/** HTTP status of an HttpErrorLike, default 500. */
export function getErrorStatus(err: HttpErrorLike | unknown): number {
  const e = (err ?? {}) as HttpErrorLike;
  return e.status ?? e.response?.status ?? 500;
}

/** Message of an HttpErrorLike: `response.data.error` (Koios), else `message`. */
export function getErrorMessage(err: HttpErrorLike | unknown): string {
  const e = (err ?? {}) as HttpErrorLike;

  if (e.response?.data?.error) return e.response.data.error;

  if (e.message) return e.message;

  return 'Unknown error';
}

/**
 * Normalizes any backend error into a typed BackendError. Message hints are checked in priority
 * order (already submitted, script failure, validation, not found, rate limit) before the HTTP status.
 */
export function normalizeBackendError(
  err: unknown,
  backendName?: string,
): BackendError {
  if (err instanceof BackendError) return err;

  // TypeError from calling a method on an uninitialized (null) backend client
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

  // Already submitted / duplicate: 409
  const alreadySubmittedHints = [
    'already exists',
    'already submitted',
    'already known',
    'known transaction',
    'duplicate',
    'in mempool',
  ];
  if (alreadySubmittedHints.some(h => messageLower.includes(h))) {
    const txHashMatch = message.match(/([a-f0-9]{64})/i);
    return new TransactionAlreadySubmittedError(txHashMatch?.[1] || 'unknown', err);
  }

  // Ledger phase-2 script rejection: 400, before the generic validation hints
  const scriptValidationHints = [
    'plutusfailure',
    'plutus failure',
    'cekerror',
    'cek error',
    'overspending the budget',
    'overspent',
    'script failure',
    'script failed',
    'script evaluation',
    'ppviewhashesdontmatch',
    'scriptsnotpaidforall',
  ];
  if (scriptValidationHints.some(h => messageLower.includes(h))) {
    return new ScriptValidationError(
      `Script validation failed: ${message}`,
      err
    );
  }

  // Address-shaped lookup errors: 404, before 'malformed' in the validation hints can catch them
  const addressNotFoundHints = [
    'invalid address',
    'malformed address',
  ];
  if (addressNotFoundHints.some(h => messageLower.includes(h))) {
    return new NotFoundError('Resource', backendName, err);
  }

  // Validation / signature errors: 400
  const validationErrorHints = [
    'signature',
    'witness',
    'verification failed',
    'deserialize',
    'malformed',
    'invalid cbor',
    'invalid transaction',
  ];
  if (validationErrorHints.some(h => messageLower.includes(h))) {
    return new TransactionValidationError(
      `Transaction validation failed: ${message}`,
      err
    );
  }

  // PostgREST server-side SQL faults arrive as HTTP 400 with a PG code: retryable 503 for failover.
  // Before the not-found hints, whose 'does not exist' would match "column ... does not exist".
  const pgErrorBody = (err as HttpErrorLike)?.response?.data;
  if ((status === 400 || status === 422) && isPostgrestServerErrorCode(pgErrorBody?.code)) {
    return new ProviderUnavailableError(
      `Provider database error (${pgErrorBody?.code}): ${pgErrorBody?.message ?? message}`,
      backendName,
      undefined,
      err
    );
  }

  // Not-found messages: 404 regardless of status. 'not available' / bare 'no data' are excluded,
  // they also appear in outage messages and a 404 would be circuit-breaker-exempt.
  const notFoundHints = [
    'not found',
    'has not been found',
    'does not exist',
    'no data found',
    'no records',
    'empty result',
    'no metadata',
  ];
  if (notFoundHints.some(h => messageLower.includes(h))) {
    return new NotFoundError('Resource', backendName, err);
  }

  // Rate limiting: status 429 or message patterns
  if (status === 429 ||
    messageLower.includes('rate limit') ||
    messageLower.includes('too many requests') ||
    messageLower.includes('quota exceeded')) {
    const headers = (err as HttpErrorLike).response?.headers;
    const retryAfter = (headers?.["retry-after"] as string | undefined) ||
      (headers?.["x-ratelimit-reset"] as string | undefined);
    return new RateLimitError(
      message || 'Rate limit exceeded',
      backendName,
      retryAfter ? parseInt(retryAfter, 10) : undefined,
      err
    );
  }

  if (status === 404) {
    return new NotFoundError('Resource', backendName, err);
  }

  // 5xx: provider unavailable (retryable)
  if (status >= 500) {
    return new ProviderUnavailableError(
      message || 'Provider returned server error',
      backendName,
      undefined,
      err
    );
  }

  // Other 4xx by status code
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

  // Unknown / network errors: unavailable
  return new ProviderUnavailableError(
    message || 'Unknown backend error',
    backendName,
    undefined,
    err
  );
}

/** HSM operation failed (session, key access, signing). */
export class HsmError extends BackendError {
  constructor(
    message: string,
    statusCode: number = 503,
    code: ErrorCode = ERROR_CODES.HSM_UNAVAILABLE,
    originalError?: unknown
  ) {
    super(message, statusCode, code, 'hsm', originalError);
    this.name = 'HsmError';
  }
}

/** Configuration error. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Ogmios chain-sync frame that could not be parsed. Names the block (when readable from the raw
 * text) so the crawler can fetch that one block through the paginating backend instead.
 */
export class ChainSyncFrameError extends BackendError {
  constructor(
    public readonly height: number | null,
    public readonly id: string | null,
    reason: string
  ) {
    super(
      `Ogmios chain-sync frame for block ${height ?? '?'} ${id ?? ''} could not be parsed: ${reason}`,
      503,
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      'ogmios'
    );
  }
}

/** A backend failed to initialize. */
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

/** Every backend failed to initialize. */
export class AllBackendsInitFailedError extends Error {
  constructor(public readonly errors: BackendInitError[]) {
    const summary = errors
      .map(e => `${e.backendName}: ${e.originalError instanceof Error ? e.originalError.message : String(e.originalError)}`)
      .join(' | ');
    super(`CardanoClient startup failed: all backends failed to initialize. ${summary}`);
    this.name = 'AllBackendsInitFailedError';
  }
}

/** Throws a 400 INVALID_INPUT BackendError `<ctx>: <message>`. */
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

/** Throws a 400 INVALID_INPUT BackendError for a missing required field. */
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

/** Validation error from validators.ts */
interface ValidationError {
  type: 'missing' | 'invalid';
  field: string;
  message: string;
}

/** Throws a BackendError for the first validation error, if any. */
export function throwIfValidationErrors(req: Request, ctx: string, errors: ValidationError[]): void {
  if (errors.length === 0) return;

  const firstError = errors[0];
  if (firstError.type === 'missing') {
    rejectMissing(req, ctx, firstError.field);
  } else {
    rejectInvalid(req, ctx, firstError.message, firstError.field);
  }
}