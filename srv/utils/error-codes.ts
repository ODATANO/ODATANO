/** 
 * Error codes used throughout the ODATANO backend 
 */
export const ERROR_CODES = {
  /**
   * 400 – Invalid input
   * Indicates that the input provided by the client is invalid (malformed address, invalid transaction hash, etc.)
   */
  INVALID_INPUT: 'ODATANO_INVALID_INPUT',

  /**
   * 404 – Data not found
   * Indicates that the requested resource could not be found (Empty result set Address with no UTxOs, Transaction hash not found, etc.)
   */
  NOT_FOUND: 'ODATANO_NOT_FOUND',

  /**
    * 429 – Rate limiting
    * indicates temporary unavailability
    */
  PROVIDER_RATE_LIMITED: 'ODATANO_PROVIDER_RATE_LIMITED',

  /**
   * 503 – Upstream / connectivity 
   * Indicates that the Cardano data provider is currently unavailable
   */
  PROVIDER_UNAVAILABLE: 'ODATANO_PROVIDER_UNAVAILABLE',

  /** 
   * 500 – Internal fallback
   * Indicates an unexpected internal error
   */
  INTERNAL_ERROR: 'ODATANO_INTERNAL_ERROR',
} as const;

/** 
 * EnumType representing all possible error codes
 */
export type ErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
