// Error codes used throughout the application
export const ERROR_CODES = {
  // 400 – Client / validation
  INVALID_INPUT: 'ODATANO_INVALID_INPUT',

  // 404 – Data not found
  NOT_FOUND: 'ODATANO_NOT_FOUND',

  // 401 / 403 – Authentication / authorization
  UNAUTHORIZED: 'ODATANO_UNAUTHORIZED',
  FORBIDDEN: 'ODATANO_FORBIDDEN',

  // 503 – Upstream / connectivity
  PROVIDER_UNAVAILABLE: 'ODATANO_PROVIDER_UNAVAILABLE',

  // 429 / 503 – Upstream rate limiting
  PROVIDER_RATE_LIMITED: 'ODATANO_PROVIDER_RATE_LIMITED',

  // 502 – Upstream returned unexpected / invalid response
  PROVIDER_BAD_RESPONSE: 'ODATANO_PROVIDER_BAD_RESPONSE',

  // 500 – Internal fallback
  INTERNAL_ERROR: 'ODATANO_INTERNAL_ERROR',
} as const;

export type ErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
