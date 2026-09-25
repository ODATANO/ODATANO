/** Error codes used throughout the backend. */
export const ERROR_CODES = {
  /** 400: malformed client input (address, tx hash, ...). */
  INVALID_INPUT: 'ODATANO_INVALID_INPUT',

  /** 403: authenticated but lacking the required role (e.g. hsm.requiresRole). */
  FORBIDDEN: 'ODATANO_FORBIDDEN',

  /** 404: requested resource not found (unknown tx hash, address without UTxOs, ...). */
  NOT_FOUND: 'ODATANO_NOT_FOUND',

  /** 400: address lacks the funds or assets for the transaction. */
  INSUFFICIENT_FUNDS: 'ODATANO_INSUFFICIENT_FUNDS',

  /** 400: decoded transaction failed validation (wrong signature, tampered CBOR, ...). */
  TX_VALIDATION_FAILED: 'ODATANO_TX_VALIDATION_FAILED',

  /** 400: transaction CBOR could not be decoded (malformed, truncated, not a Conway tx). */
  TX_PARSE_FAILED: 'ODATANO_TX_PARSE_FAILED',

  /** 400: ledger rejected the tx on script evaluation (PlutusFailure, CekError, budget, hash mismatch). */
  SCRIPT_VALIDATION_FAILURE: 'ODATANO_SCRIPT_VALIDATION_FAILURE',

  /** 409: transaction already submitted (duplicate / replay). */
  TX_ALREADY_SUBMITTED: 'ODATANO_TX_ALREADY_SUBMITTED',

  /** 429: provider rate limit hit. */
  PROVIDER_RATE_LIMITED: 'ODATANO_PROVIDER_RATE_LIMITED',

  /** 503: Cardano data provider unavailable. */
  PROVIDER_UNAVAILABLE: 'ODATANO_PROVIDER_UNAVAILABLE',

  /** 500: unexpected internal error. */
  INTERNAL_ERROR: 'ODATANO_INTERNAL_ERROR',

  /** 503: HSM device or session not available. */
  HSM_UNAVAILABLE: 'ODATANO_HSM_UNAVAILABLE',

  /** 500: HSM signing operation failed. */
  HSM_SIGNING_FAILED: 'ODATANO_HSM_SIGNING_FAILED',

  /** 400: HSM signing requested but HSM not configured. */
  HSM_NOT_CONFIGURED: 'ODATANO_HSM_NOT_CONFIGURED',

  /**
   * 503: a detached bookkeeping transaction could not acquire a pooled DB connection in time,
   * typically because an in-process caller awaits the action while its own request tx holds the single sqlite connection.
   */
  NESTED_TX_TIMEOUT: 'ODATANO_NESTED_TX_TIMEOUT',
} as const;

/** Union of all error code values. */
export type ErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
