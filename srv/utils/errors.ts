import { ERROR_CODES, type ErrorCode } from './error-codes';

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

import { Request } from '@sap/cds'; 

/**
 * Resource not found in backend
 */
export class NotFoundError extends BackendError {
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
 * Backend timeout or unreachable
 */
export class TimeoutError extends BackendError {
  constructor(backendName?: string, timeoutMs?: number, originalError?: any) {
    const msg = timeoutMs
      ? `Backend timeout after ${timeoutMs}ms`
      : 'Backend timeout or unreachable';

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
 * Invalid / unexpected data from backend (provider contract mismatch)
 */
export class ProviderBadResponseError extends BackendError {
  constructor(message: string, backendName?: string, originalError?: any) {
    super(
      message,
      502,
      ERROR_CODES.PROVIDER_BAD_RESPONSE,
      backendName,
      originalError
    );
  }
}

/**
 * All backends failed
 */
export class AllBackendsFailedError extends BackendError {
  constructor(public readonly errors: BackendError[], originalError?: any) {
    const lastError = errors[errors.length - 1];

    super(
      `All backends failed: ${lastError?.message ?? 'unknown error'}`,
      lastError?.statusCode ?? 500,
      lastError?.code ?? ERROR_CODES.INTERNAL_ERROR,
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
    headers?: Record<string, any>;
    data?: {
      error?: string;
      message?: string;
      [k: string]: any;
    };
  };
  [k: string]: any;
}

export function getErrorStatus(err: HttpErrorLike | unknown): number {
  const e = (err ?? {}) as HttpErrorLike;
  return e.status ?? e.response?.status ?? 500;
}

export function getErrorMessage(err: HttpErrorLike | unknown): string {
  const e = (err ?? {}) as HttpErrorLike;

  if (e.message) return e.message;

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
  // Already normalized
  if (err instanceof BackendError) return err;

  const message = getErrorMessage(err);
  const status = getErrorStatus(err);

  // Upstream 5xx → retryable provider failure
  if (status >= 500) {
    return new BackendError(
      message,
      503,
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      backendName,
      err
    );
  }

  // Any other upstream 4xx (not caught above) → provider contract/request mismatch
  if (status >= 400) {
    return new ProviderBadResponseError(
      message,
      backendName,
      err
    );
  }

  // Unknown / non-http error → internal
  return new BackendError(
    message,
    500,
    ERROR_CODES.INTERNAL_ERROR,
    backendName,
    err
  );
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class BackendInitError extends Error {
  constructor(
    public readonly backendName: String,
    public readonly originalError: unknown
  ) {
    super(`Failed to initialize backend: ${backendName}`);
    this.name = 'BackendInitError';
  }
}

export class AllBackendsInitFailedError extends Error {
  constructor(public readonly errors: BackendInitError[]) {
    const summary = errors
      .map(e => `${e.backendName}: ${String((e.originalError as any)?.message ?? e.originalError)}`)
      .join(' | ');
    super(`CardanoClient startup failed: all backends failed to initialize. ${summary}`);
    this.name = 'AllBackendsInitFailedError';
  }
}

export function rejectInvalid(req: Request, ctx: string, message: string, target?: string) {
  return req .reject(400, `[${ERROR_CODES.INVALID_INPUT}] ${ctx}: ${message}`, target);
}

export function rejectMissing(req: Request, ctx: string, field: string) {
  return req.reject(400, `[${ERROR_CODES.INVALID_INPUT}] ${ctx}: ${field} is required`, field);
}