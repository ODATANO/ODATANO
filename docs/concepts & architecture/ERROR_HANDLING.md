# Error Handling in ODATANO

This documentation describes error handling in ODATANO, specifically how backend
errors are normalized and propagated to the client.

## Error Classes Overview

ODATANO uses **11 specialized error classes** for comprehensive error handling:

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
- **Example**: BLOCKFROST_KEY not set, invalid network
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

## Normalization Rules

The `normalizeBackendError()` function converts any error into a typed `BackendError` using this priority:

### Priority Order

1. **Message hints → 404 (NotFoundError)**
   - Hints: "not found", "has not been found", "does not exist", "no data", "no records", "empty result", "not available", "no metadata", "invalid address", "malformed address"
   - **Why**: Some providers return 5xx for missing resources (Koios)
   
2. **Status 429 or rate-limit messages → 429 (RateLimitError)**
   - Patterns: "rate limit", "too many requests", "quota exceeded"
   - Extracts `retry-after` header if present
   
3. **Status 404 → 404 (NotFoundError)**
   - Direct mapping for well-behaved providers (Blockfrost)
   
4. **Status 5xx → 503 (ProviderUnavailableError)**
   - Provider server errors are retry-able
   
5. **Status 4xx → Check message**
   - If "not found" in message → 404 (NotFoundError)
   - Otherwise → 503 (ProviderUnavailableError)
   
6. **Unknown/network errors → 503 (ProviderUnavailableError)**
   - Timeouts, connection refused, etc.

### Why This Approach?

**Message-first detection** ensures consistent 404 responses even when providers return incorrect status codes. This is critical for Koios compatibility, which may return 5xx for missing resources.

## Backend Notes

- **Blockfrost**: Returns correct HTTP statuses; 404 maps directly to NotFoundError.
- **Koios**: May return 5xx for "not found"; normalization converts to 404 for consistency.
- **Ogmios** (M2): WebSocket-based live backend for protocol parameters, UTxO queries, and transaction submission. Connection errors normalized to ProviderUnavailableError.

## Best Practices

### In Backend Code

- Throw `NotFoundError` for empty/missing blockchain resources
- Throw `ProviderUnavailableError` for timeouts or network errors
- Avoid generic errors - use typed error classes

### In Service Handlers

**Input Validation:**
```typescript
import { rejectInvalid, rejectMissing } from './utils/errors';

// Missing required parameter
if (!hash) {
    return rejectMissing(req, 'Transactions', 'hash');
}

// Invalid format
if (!isTxHash(hash)) {
    return rejectInvalid(req, 'Transactions', 'Invalid hash format', 'hash');
}
```

**Error Handling with handleRequest:**
```typescript
import { handleRequest } from './utils/backend-request-handler';

return handleRequest(req, async (db) => {
    // All BackendErrors are automatically caught and normalized
    const tx = await indexer.indexTransaction(db, hash);
    return tx;
});
```

**Response Mapping:**
- **404 (NotFoundError)**: Reject without logging noise
- **429 (RateLimitError)**: Warn; include retry guidance; reject
- **503 (ProviderUnavailableError)**: Warn; reject; callers may retry
- **500 (ConfigError)**: Error; fix configuration before retry
- **Unknown**: Error; reject 500

## Testing References

- Error normalization unit tests: [test/unit/errors.test.ts](../../test/unit/errors.test.ts) (52 tests)
- Blockfrost backend constructor tests: [test/unit/blockfrost-backend.test.ts](../../test/unit/blockfrost-backend.test.ts)
- Error handling service integration tests: [test/integration/error-handling-service.test.ts](../../test/integration/error-handling-service.test.ts) (34 tests)

## Summary

### Runtime Errors (Client-Facing)

1. **404 = NotFoundError** – Resource doesn't exist (not retry-able)
2. **429 = RateLimitError** – Too many requests (retry after backoff)
3. **503 = ProviderUnavailableError** – Temporary issue (retry-able)
4. **502/503 = AllBackendsFailedError** – All backends down (retry later)

### Configuration Errors (Startup)

5. **500 = ConfigError** – Invalid configuration (fix config)
6. **500 = BackendInitError** – Single backend init failed
7. **500 = AllBackendsInitFailedError** – All backends init failed (service won't start)

### Input Validation (Service Layer)

8. **400 = rejectInvalid/rejectMissing** – Invalid or missing parameters

### Transaction Errors (M2)

9. **400 = InsufficientFundsError** – Not enough UTxOs for amount + fees
10. **400 = TransactionValidationError** – Invalid signature or CBOR
11. **409 = TransactionAlreadySubmittedError** – Duplicate transaction

### Key Principles

✅ **Normalization checks message AND status** – Koios 5xx→404 if "not found"\
✅ **Backends throw typed errors** – `NotFoundError` for missing resources\
✅ **Tests expect consistent 404** – Both backends normalized\
✅ **handleRequest wrapper** – Automatically catches and normalizes errors\
✅ **Input validation helpers** – `rejectInvalid` and `rejectMissing` for 400 errors

This enables clear client semantics and consistent behavior across all backends.

---
