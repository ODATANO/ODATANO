# Error Handling in ODATANO

**Version:** v0.3-milestone3 | **Last Updated:** March 2026

This documentation describes error handling in ODATANO, specifically how backend
errors are normalized and propagated to the client.

## Error Classes Overview

ODATANO uses **13 specialized error classes** for comprehensive error handling:

### Backend Communication Errors

#### 1. `BackendError` (Base Class)

Base class for all backend-related errors with:
- `statusCode`: HTTP status code (400-599)
- `code`: Error code from ERROR_CODES
- `backendName`: Which backend failed (e.g., "Blockfrost", "Koios")
- `originalError`: Original error object for debugging
- `target`: Affected resource/field

#### 2. `NotFoundError` (404)

Resource does not exist on the blockchain. This is **not** a provider error.
- **Not retry-able**: The resource genuinely doesn't exist
- **Example**: Transaction hash not found, address never used

#### 3. `RateLimitError` (429)

Provider has throttled the request due to usage limits.
- **Retry-able**: After waiting (check `retry-after` hint)
- **Example**: Blockfrost 10 req/sec exceeded
- **Response**: May include `retry-after` seconds

#### 4. `ProviderUnavailableError` (503)

Transient provider, network, or timeout issues.
- **Retry-able**: Temporary issue, may succeed on retry
- **Example**: Network timeout (8s), provider 5xx errors, service down

#### 5. `AllBackendsFailedError` (502/503)

All configured backends failed for the operation.
- **Contains**: Array of individual backend errors
- **Status**: Inherits status of last failed backend
- **Indicates**: Systemic issue beyond single resource

### Configuration & Initialization Errors

#### 6. `ConfigError` (500)

Configuration error (missing API keys, invalid settings).
- **Example**: BLOCKFROST_API_KEY not set, invalid network
- **Fix**: Check environment variables and config.ts

#### 7. `BackendInitError` (500)

Single backend failed to initialize.
- **Contains**: Backend name and original error
- **Example**: Invalid Blockfrost API key, network mismatch

#### 8. `AllBackendsInitFailedError` (500)

All backends failed during initialization.
- **Contains**: Array of BackendInitError instances
- **Result**: Service startup fails (no backends available)

### Transaction Errors (M2)

#### 9. `InsufficientFundsError` (400)

Sender address doesn't have enough UTxOs to cover amount + fees.
- **Error Code**: `ODATANO_INSUFFICIENT_FUNDS`
- **Example**: Address has 5 ADA but needs 10 ADA + fees
- **Fix**: Top up sender address or reduce amount

#### 10. `TransactionValidationError` (400)

Transaction failed Cardano protocol validation.
- **Error Code**: `ODATANO_TX_VALIDATION_FAILED`
- **Example**: Invalid signature, malformed CBOR, wrong signing key
- **Fix**: Verify signing key matches sender address

#### 11. `TransactionAlreadySubmittedError` (409)

Transaction with same hash already exists on chain or in mempool.
- **Error Code**: `ODATANO_TX_ALREADY_SUBMITTED`
- **Example**: Duplicate submission of same transaction
- **Result**: Idempotent - transaction already processed

#### 12. `MixedAssetsError` (400)

UTxO contains non-ADA assets when ADA-only transaction was requested.
- **Error Code**: `ODATANO_INVALID_INPUT`
- **Example**: Simple ADA transfer includes UTxO with native tokens
- **Fix**: Use multi-asset transaction or select different UTxOs

### HSM Errors (M3)

#### 13. `HsmError` (503)

Hardware Security Module operation failed (signing, session, key access).
- **Error Code**: `ODATANO_HSM_UNAVAILABLE`
- **Retry-able**: Depends on root cause (session timeout vs misconfiguration)
- **Example**: HSM device unavailable, signing session expired, key not accessible

### External Signing Errors (M3)

M3 reuses existing error classes for signing-specific scenarios:

**Signing Request Not Found (404)**
- Uses `NotFoundError`
- Signing request ID doesn't exist or has been cleaned up

**Signing Request Expired (400)**
- Uses `rejectInvalid` with "Signing request expired" message
- Request exceeded 30-minute TTL

**Signature Verification Failed (400)**
- Uses `TransactionValidationError`
- Invalid signature, wrong signing key, or malformed CBOR
- **Example**: Signed with wrong key, tampered transaction

**Build Not Found (404)**
- Uses `NotFoundError`
- Transaction build ID doesn't exist or has expired

## Error Codes

All error codes are defined in `srv/utils/error-codes.ts` and follow the `ODATANO_*` prefix convention:

| Code | HTTP | Description |
|------|------|-------------|
| `ODATANO_INVALID_INPUT` | 400 | Malformed address, invalid transaction hash, missing fields |
| `ODATANO_NOT_FOUND` | 404 | Resource not found on blockchain |
| `ODATANO_INSUFFICIENT_FUNDS` | 400 | Not enough funds/assets for transaction |
| `ODATANO_TX_VALIDATION_FAILED` | 400 | Transaction failed protocol validation |
| `ODATANO_TX_ALREADY_SUBMITTED` | 409 | Duplicate transaction (already in mempool/on chain) |
| `ODATANO_PROVIDER_RATE_LIMITED` | 429 | Backend rate limit exceeded |
| `ODATANO_PROVIDER_UNAVAILABLE` | 503 | Backend temporarily unavailable |
| `ODATANO_INTERNAL_ERROR` | 500 | Unexpected internal error (fallback) |
| `ODATANO_HSM_UNAVAILABLE` | 503 | HSM device or session not available |
| `ODATANO_HSM_SIGNING_FAILED` | 500 | HSM signing operation failed |
| `ODATANO_HSM_NOT_CONFIGURED` | 400 | HSM signing requested but not configured |

## Normalization Rules

The `normalizeBackendError()` function converts any error into a typed `BackendError` using this priority:

### Priority Order

1. **Already a `BackendError`** → return as-is (no re-normalization)

2. **TypeError (null/undefined access) → 500 (BackendInitError)**
   - Detects uninitialized backend clients (`Cannot read properties of null`)
   - **Why**: Catches `init()` not called before use

3. **TX already submitted hints → 409 (TransactionAlreadySubmittedError)**
   - Hints: "already exists", "already submitted", "already known", "known transaction", "duplicate", "in mempool"
   - Extracts txHash from message if present (64 hex chars)

4. **TX validation hints → 400 (TransactionValidationError)**
   - Hints: "signature", "witness", "verification failed", "deserialize", "malformed", "invalid cbor", "invalid transaction", "script failure"

5. **Not-found message hints → 404 (NotFoundError)**
   - Hints: "not found", "has not been found", "does not exist", "no data", "no records", "empty result", "not available", "no metadata", "invalid address", "malformed address"
   - **Why**: Some providers return 5xx for missing resources (Koios)

6. **Status 429 or rate-limit messages → 429 (RateLimitError)**
   - Patterns: "rate limit", "too many requests", "quota exceeded"
   - Extracts `retry-after` / `x-ratelimit-reset` header if present

7. **Status 404 → 404 (NotFoundError)**
   - Direct mapping for well-behaved providers (Blockfrost)

8. **Status 5xx → 503 (ProviderUnavailableError)**
   - Provider server errors are retry-able

9. **Status 4xx → 503 (ProviderUnavailableError)**
   - Other client errors treated as provider issue

10. **Unknown/network errors → 503 (ProviderUnavailableError)**
    - Timeouts, connection refused, etc.

### Why This Approach?
**Transaction-specific detection first** ensures that TX submission errors are classified correctly before falling through to generic provider error handling.

**Message-first detection** for not-found ensures consistent 404 responses even when providers return incorrect status codes (critical for Koios-Blockfrost compatibility).

## Backend Notes

- **Blockfrost**: Returns correct HTTP statuses; 404 maps directly to NotFoundError.
- **Koios**: May return 5xx for "not found"; normalization converts to 404 for consistency.
- **Ogmios**: WebSocket-based live backend for protocol parameters, UTxO queries, and transaction submission. Connection errors normalized to ProviderUnavailableError.

## Error Handling Utilities

| Function | Location | Purpose |
|----------|----------|---------|
| `handleRequest(req, handler)` | `backend-request-handler.ts` | Service-level wrapper — opens `cds.tx(req)`, catches errors, calls `mapError()` |
| `handleBackendRequest(fn, backendName)` | `backend-request-handler.ts` | Backend-level wrapper — normalizes errors via `normalizeBackendError()` |
| `mapError(req, err, ctx)` | `mappers.ts` | Converts `BackendError` → `req.reject()`, unknown errors → 500 |
| `rejectMissing(req, ctx, field)` | `errors.ts` | Throws 400 for missing required parameter |
| `rejectInvalid(req, ctx, message, target)` | `errors.ts` | Throws 400 for invalid input format |
| `throwIfValidationErrors(req, ctx, errors)` | `errors.ts` | Batch validation — throws first error from `validateTransactionInputs()` |

## Best Practices

- Throw typed error classes (`NotFoundError`, `ProviderUnavailableError`, etc.) — avoid generic `Error`
- Wrap backend calls with `handleBackendRequest()` for automatic normalization
- Use `handleRequest()` in CDS service handlers (full request lifecycle)
- Input validation MUST happen **before** `handleRequest()`, not inside it
- Use `throwIfValidationErrors()` for multi-field validation, `rejectMissing`/`rejectInvalid` for single fields

## Testing References

- Error normalization unit tests: [test/unit/errors.test.ts](../../test/unit/errors.test.ts) (52 tests)
- Blockfrost backend constructor tests: [test/unit/blockfrost-backend.test.ts](../../test/unit/blockfrost-backend.test.ts)
- Error handling service integration tests: [test/integration/error-handling-service.test.ts](../../test/integration/error-handling-service.test.ts) (34 tests)

