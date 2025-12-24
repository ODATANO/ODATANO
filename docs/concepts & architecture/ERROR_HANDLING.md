# Error Handling in ODATANO

This documentation describes error handling in ODATANO, specifically how backend
errors are normalized and propagated to the client.

## Error Classes Overview

ODATANO uses a four-tier error system for backend communication:

### 1. `NotFoundError` (404)

A valid 404 indicating the requested resource does not exist. This is not a
provider outage; do not retry.

### 2. `RateLimitError` (429)

The provider has throttled the request due to usage limits. Back off and retry
later; responses may include a `retry-after` hint.

### 3. `ProviderUnavailableError` (503)

Transient provider, network, or timeout issues. The resource may exist; retry is
appropriate.

### 4. `AllBackendsFailedError`

All configured backends failed for the operation. The service surfaces the
status/code of the last failure; indicates a systemic issue beyond a single
resource.

## Normalization Rules

1. Message hints → 404
   - Hints: "not found", "has not been found", "does not exist", "no
     data/records", "empty result", "not available", "no metadata", "invalid
     address", "malformed address".
2. Status 429 or rate-limit messages → 429 (+ optional `retry-after`).
3. Status 404 → 404.
4. Status 5xx → 503.
5. Status 4xx → 404 if hints present; otherwise 503.
6. Unknown/network errors → 503.

## Backend Notes

- Blockfrost: returns correct HTTP statuses; 404 maps directly to NotFoundError.
- Koios: may return 5xx for "not found"; normalization converts to 404 for
  consistency.

## Best Practices

- Backend code: throw NotFoundError for empty/missing results; avoid generic
  errors.
- Service mapping:
  - 404: reject without logging noise.
  - 429: warn; include retry guidance; reject.
  - 503: warn; reject; callers may retry.
  - Unknown: error; reject 500.

## Testing References

- Error normalization unit tests: test/unit/errors.test.ts
- Blockfrost backend constructor tests: test/unit/blockfrost-backend.test.ts

## Summary

1. **404 = NotFoundError** – Resource not there, not a provider issue
2. **429 = RateLimitError** – Too many requests, backoff & retry
3. **503 = ProviderUnavailableError** – Temporary error, retry makes sense
4. **Normalization checks message AND status** – Koios 5xx→404 if "not found"
5. **Backends throw typed errors** – `NotFoundError` for missing resources
6. **Tests expect consistent 404** – Both backends normalized

This enables clear client semantics and consistent behavior across all backends.

---
