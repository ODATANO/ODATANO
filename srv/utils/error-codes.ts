// Error codes used throughout the application
export const ERROR_CODES = {
  // 400 – Client / validation
  INVALID_INPUT: 'ODATANO_INVALID_INPUT',

  // 404 – Data not found
  NOT_FOUND: 'ODATANO_NOT_FOUND',

  // 429 – Rate limiting (temporary unavailability)
  PROVIDER_RATE_LIMITED: 'ODATANO_PROVIDER_RATE_LIMITED',

  // 503 – Upstream / connectivity
  PROVIDER_UNAVAILABLE: 'ODATANO_PROVIDER_UNAVAILABLE',

  // 500 – Internal fallback
  INTERNAL_ERROR: 'ODATANO_INTERNAL_ERROR',
} as const;

export type ErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
