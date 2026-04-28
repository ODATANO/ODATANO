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
   * 400 – Transaction CBOR parse failed
   * Indicates that the provided transaction CBOR could not be decoded
   * (malformed bytes, truncated, not a Cardano Conway tx). Distinct from
   * TX_VALIDATION_FAILED which applies to decoded-but-invalid transactions.
   */
  TX_PARSE_FAILED: 'ODATANO_TX_PARSE_FAILED',

  /**
   * 400 – Plutus script validation failed
   * Indicates that the ledger cleanly rejected the transaction due to script
   * evaluation — e.g. PlutusFailure, CekError, overspent budget, script hash
   * mismatch. Distinct from provider outages (503) and generic tx validation.
   */
  SCRIPT_VALIDATION_FAILURE: 'ODATANO_SCRIPT_VALIDATION_FAILURE',

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

  /**
   * 503 – HSM unavailable
   * Indicates the HSM device or session is not available
   */
  HSM_UNAVAILABLE: 'ODATANO_HSM_UNAVAILABLE',

  /**
   * 500 – HSM signing failed
   * Indicates the HSM signing operation failed
   */
  HSM_SIGNING_FAILED: 'ODATANO_HSM_SIGNING_FAILED',

  /**
   * 400 – HSM not configured
   * Indicates HSM signing was requested but HSM is not configured
   */
  HSM_NOT_CONFIGURED: 'ODATANO_HSM_NOT_CONFIGURED',
} as const;

/** 
 * EnumType representing all possible error codes
 */
export type ErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
