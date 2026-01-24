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
   * 400 – Insufficient funds/assets
   * Indicates that the address does not have enough funds or assets to complete the transaction
   */
  INSUFFICIENT_FUNDS: 'ODATANO_INSUFFICIENT_FUNDS',

  /**
   * 400 – Transaction validation failed
   * Indicates that the transaction failed validation (wrong signature, tampered CBOR, etc.)
   */
  TX_VALIDATION_FAILED: 'ODATANO_TX_VALIDATION_FAILED',

  /**
   * 409 – Transaction already submitted
   * Indicates that the transaction has already been submitted (duplicate/replay)
   */
  TX_ALREADY_SUBMITTED: 'ODATANO_TX_ALREADY_SUBMITTED',

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
