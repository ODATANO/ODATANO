# Error Handling in ODATANO

**Version:** v2.0.0-rc.x

How a failure becomes a typed error and an HTTP answer. The classes are in `srv/utils/errors.ts`, the codes in
`srv/utils/error-codes.ts`.

## Error Classes

`BackendError` is the base class. It carries:

- `statusCode`: the HTTP status
- `code`: the `ODATANO_*` code
- `backendName`: the backend that failed, when one did
- `originalError`: the error it was made from; stays on the server
- `target`: the field or resource the error is about

| Class | Status | Meaning | Retry |
|---|---|---|---|
| `NotFoundError` | 404 | The resource is not on chain. Not a provider fault | No |
| `TransactionValidationError` | 400 | Wrong signature, changed CBOR, invalid witnesses, or CBOR that cannot be decoded | No |
| `ScriptValidationError` | 400 | The ledger refused a script in phase 2 | No |
| `InsufficientFundsError` | 400 | The address lacks the funds or assets | After a top-up |
| `MixedAssetsError` | 400 | A UTxO carries native assets where only ADA is allowed | With other inputs |
| `TransactionAlreadySubmittedError` | 409 | The transaction is in the mempool or on chain | No, it is there |
| `ChainPointMismatchError` | 409 | A crawler cursor block is not on this instance's chain | From the fork point |
| `RateLimitError` | 429 | A provider throttled the request. `retryAfter` in seconds when the provider named it | After waiting |
| `ProviderUnavailableError` | 503 | A provider did not answer, timed out or failed | Yes |
| `SubmitOutcomeUnknownError` | 503 | A submit ended without a verdict. The transaction may still reach the chain | Read the status first |
| `HsmError` | 503 | An HSM session, key access or signing failed | Depends on the cause |
| `BackendInitError` | 500 | One backend failed to initialize | |
| `AllBackendsFailedError` | 404 when every backend answered 404, otherwise the status of the last other error | Every backend failed. Carries each error. 503 when no backend was called | |

Three classes report a chain-sync stream that closed or sent a frame the parser could not read:
`ChainSyncClosedError`, `ChainSyncStalledError` and `ChainSyncFrameError`. The crawler handles them: it
reopens the stream or fetches the block over pagination. A client does not see them.

Two classes are not a `BackendError`:

- `ConfigError`: a setting is missing or invalid, for example an unknown `NETWORK`.
- `AllBackendsInitFailedError`: every backend failed to initialize. It carries each `BackendInitError`.

### Signing

The sign service answers 400 `ODATANO_INVALID_INPUT` for a request it cannot work with:

| Case | Answer |
|---|---|
| Signing request or build not found | 400 `Signing request not found` or `Build not found` |
| Signing request expired (30 minutes by default) | 400 `Signing request has expired`; the request ends as `expired` |
| Signing request in another status than the action expects | 400 with the status in the message |
| `VerifySignature` with a signature that does not verify | 200; the verification record has `isValid: false` |
| `SubmitVerifiedTransaction` with a signature that does not verify | 400, `TransactionValidationError` |

## Error Codes

An error from a handler carries its code in `error.code`.

| Code | HTTP | Meaning |
|------|------|---------|
| `ODATANO_INVALID_INPUT` | 400 | Malformed address or hash, missing field, value out of range |
| `ODATANO_INSUFFICIENT_FUNDS` | 400 | Not enough funds or assets for the transaction |
| `ODATANO_TX_VALIDATION_FAILED` | 400 | The transaction failed validation |
| `ODATANO_TX_PARSE_FAILED` | 400 | The transaction CBOR could not be decoded |
| `ODATANO_SCRIPT_VALIDATION_FAILURE` | 400 | The ledger refused the transaction in phase-2 script evaluation |
| `ODATANO_QUERY_NOT_INDEXED` | 400 | A read on a large entity set that no index serves: `$filter` or `$orderby` on a field without an index, `$count` without an `eq` filter on an indexed field, `$apply`. The message names the indexed fields |
| `ODATANO_HSM_NOT_CONFIGURED` | 503 | `SignWithHsm` or `SignAndSubmitWithHsm` without a configured or connected HSM |
| `ODATANO_FORBIDDEN` | 403 | Logged in, but without the role. The HSM actions need `hsm.requiresRole`. `SubmitWalletJob` needs the wallet's `requiresRole` and, for an HSM wallet, `hsm.requiresRole`. The message starts with `[ODATANO_FORBIDDEN] <Action>:` |
| `ODATANO_NOT_FOUND` | 404 | The resource is not on chain |
| `ODATANO_TX_ALREADY_SUBMITTED` | 409 | The transaction is already in the mempool or on chain |
| `ODATANO_CHAIN_POINT_MISMATCH` | 409 | `GetNextBlocks`: the cursor block is not on this instance's chain. The message starts with `CHAIN_POINT_MISMATCH:` |
| `ODATANO_IDEMPOTENCY_KEY_CONFLICT` | 409 | The idempotency key belongs to a wallet job with another request |
| `ODATANO_PROVIDER_RATE_LIMITED` | 429 | A provider's rate limit was hit |
| `ODATANO_INTERNAL_ERROR` | 500 | Unexpected error |
| `ODATANO_HSM_SIGNING_FAILED` | 500 | The HSM signing operation failed |
| `ODATANO_PROVIDER_UNAVAILABLE` | 503 | No provider answered |
| `ODATANO_SUBMIT_OUTCOME_UNKNOWN` | 503 | A submit got no verdict from the node. The record stays open (`submitting` or `pending`) and the server resolves it |
| `ODATANO_HSM_UNAVAILABLE` | 503 | HSM device or session not available |
| `ODATANO_QUERY_TIMEOUT` | 503 | An API read on PostgreSQL ran longer than the read timeout (`READ_TIMEOUT_MS`, default 15000) and was cancelled |
| `ODATANO_NESTED_TX_TIMEOUT` | 503 | A submit action got no database connection within 10 seconds, because the caller's own transaction holds it. See "From your own CAP handler: `deferSubmit`" in the User Guide |

## Failures That Are Not HTTP Errors

The crawler and the wallet worker run in the background. Their failures are written to a row.

- **Wallet jobs** carry `errorCode`, `errorMessage` and a final `status`. `errorCode` is the `ODATANO_*` code
  of the error that ended the job, or one of `PROCESS_RESTART`, `TX_DROPPED`, `RETRIES_EXHAUSTED`,
  `CANCELLED`, `SUBMIT_REJECTED`, `EXECUTION_FAILED`, `SCRIPT_FAILED` (it landed with failing scripts),
  `OUTCOME_UNRESOLVED` (status `unresolved`), `RESOLVED_FAILED` (an Admin resolved it as failed) and
  `INVALIDATED` (a self-transfer spent an input of a transaction without an expiry).
- `SUBMIT_REJECTED` and `TX_DROPPED` are written only with proof that the transaction can never land; see
  [What a failed submit means](../guides/TRANSACTION_WORKFLOW.md#what-a-failed-submit-means).
- The Resolve actions answer 409 `ODATANO_OUTCOME_STILL_OPEN` for `failed` while the bytes can still land,
  and 409 `ODATANO_RESOLVED_CONCURRENTLY` when another call resolved the record first.
- A job whose submit outcome is unknown stays `submitting` and is checked against the chain. Failing it
  would release the idempotency key and allow a second payment.
- **The crawler** writes `syncStatus`, `lastError` and `consecutiveErrors` to its cursor row. After a
  runtime failure a restart resumes at the cursor. A refused chain-sync rollback sets `nodeBehindSince`
  (the node is behind the cursor) or `syncStatus = error` (an inconsistent rollback point).
- A block that fails again and again, or a configuration the crawler cannot run with, switches it off for
  all instances (`desiredRunning: false`). `resumeCrawler` switches it on again.

## Normalization

`normalizeBackendError()` turns any error of a backend call into one of the classes. The first rule that
matches decides. Message hints are compared in lower case.

| # | Condition | Result |
|---|---|---|
| 1 | Already a `BackendError` | Returned as it is |
| 2 | `TypeError` from a call on a client that is `null` or `undefined` | 500 `BackendInitError` |
| 3 | Ogmios JSON-RPC code 3010 | 400 `ScriptValidationError` |
| 4 | Message: "already exists", "already submitted", "already known", "known transaction", "duplicate", "in mempool" | 409 `TransactionAlreadySubmittedError`, with the hash when the message holds one |
| 5 | Message: "plutusfailure", "cekerror", "overspending the budget", "script failure", "script failed", "script evaluation", "ppviewhashesdontmatch", "scriptsnotpaidforall" and similar | 400 `ScriptValidationError` |
| 6 | Message: "invalid address", "malformed address" | 404 `NotFoundError` |
| 7 | Message: "signature", "witness", "verification failed", "deserialize", "malformed", "invalid cbor", "invalid transaction" | 400 `TransactionValidationError` |
| 8 | Status 400 or 422 with a PostgreSQL code for a server-side fault | 503 `ProviderUnavailableError` |
| 9 | Message: "not found", "has not been found", "does not exist", "no data found", "no records", "empty result", "no metadata" | 404 `NotFoundError` |
| 10 | Status 429, or message: "rate limit", "too many requests", "quota exceeded" | 429 `RateLimitError`, with `retry-after` or `x-ratelimit-reset` when sent |
| 11 | Status 404 | 404 `NotFoundError` |
| 12 | Status 5xx | 503 `ProviderUnavailableError` |
| 13 | Status 400 or 422 | 400 `TransactionValidationError` |
| 14 | Status 401, 402 or 403 | 503 `ProviderUnavailableError`: the provider refused the key, so the next backend is asked |
| 15 | Any other 4xx | 503 `ProviderUnavailableError` |
| 16 | Anything else, such as a network error | 503 `ProviderUnavailableError` |

Why the order matters:

- Submit errors are matched before the general rules, so a duplicate or a failed script is not read as a
  provider outage.
- The not-found messages are matched before the status. Some providers answer a missing resource with a
  status other than 404.
- Rule 8 comes before rule 9. Koios reports a database fault as status 400, and its message can contain
  "does not exist".
- "not available" and a bare "no data" are no not-found hints. They also appear in outage messages.

A 4xx other than 429 is the verdict of a healthy backend. It is no failure for the circuit breaker, and in
the half-open state it counts like a success. A 429 and an outage count as failures.

## Utilities

| Function | File | Purpose |
|----------|------|---------|
| `handleRequest(req, handler)` | `backend-request-handler.ts` | Runs a service handler on the request transaction and passes every error to `mapError()` |
| `handleBackendRequest(fn, backendName)` | `backend-request-handler.ts` | Runs a backend call and normalizes its error |
| `mapError(req, err, ctx)` | `mappers.ts` | Rejects the request with status, code and message of a `BackendError`. Any other error is logged and answered as 500 without its message |
| `rejectMissing(req, ctx, field)` | `errors.ts` | Throws 400 for a missing parameter |
| `rejectInvalid(req, ctx, message, target)` | `errors.ts` | Throws 400 for an invalid value |
| `throwIfValidationErrors(req, ctx, errors)` | `errors.ts` | Throws for the first error of `validateTransactionInputs()` |

## Rules

- Throw the typed classes, not a plain `Error`.
- Wrap backend calls in `handleBackendRequest()`.
- Wrap service handlers in `handleRequest()`.
- Validate input before `handleRequest()`, not inside it.
- Use `throwIfValidationErrors()` for several fields, `rejectMissing` and `rejectInvalid` for one.

## Tests

- Classes and normalization: [test/unit/errors.test.ts](../../test/unit/errors.test.ts)
- Error paths of the backends: [test/unit/error-paths.test.ts](../../test/unit/error-paths.test.ts)
- Answers of the services: [test/integration/error-handling-service.test.ts](../../test/integration/error-handling-service.test.ts)
