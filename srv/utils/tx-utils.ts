import cds from '@sap/cds';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';

/**
 * Transaction utilities shared by the sign-service and the background workers.
 *
 * Context: @cap-js/sqlite runs on a SINGLE pooled connection. A request
 * transaction begins lazily on its first CQL statement and holds that
 * connection until the request commits. Any code that then needs a NEW ROOT
 * transaction (detached committed bookkeeping) waits on the pool — forever,
 * if the waiter is awaited by the very request holding the connection
 * (docs/KNOWN_ISSUES.md issue 11).
 */

const logger = cds.log('tx-utils');

/** Default acquire budget for detached bookkeeping transactions. */
export const DETACHED_TX_TIMEOUT_MS = 10_000;

/** Effective timeout: env override (ODATANO_DETACHED_TX_TIMEOUT_MS) > default. Read per call so tests can tune it. */
function effectiveTimeoutMs(): number {
  const fromEnv = Number(process.env.ODATANO_DETACHED_TX_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DETACHED_TX_TIMEOUT_MS;
}

/**
 * Run `fn` with `cds.context` cleared, so any `db.run(...)` inside it gets a
 * fresh short-lived transaction instead of joining a long-lived ambient one.
 * Under @cap-js/sqlite (pool.max=1) this is what keeps the single pooled
 * connection free during long awaits (NIGHTGATE lesson 2; used by the
 * wallet-worker job loops).
 */
export function runWithoutAmbientTx<T>(fn: () => Promise<T>): Promise<T> {
  return (cds as unknown as { _with: <R>(store: undefined, fn: () => Promise<R>) => Promise<R> })._with(undefined, fn);
}

/** Thrown inside an orphaned `cds.tx` callback after its caller already timed out. */
class DetachedTxAbortedError extends Error {
  constructor(label: string) {
    super(`Detached transaction '${label}' aborted: acquire succeeded only after the caller timed out`);
    this.name = 'DetachedTxAbortedError';
  }
}

/**
 * `cds.tx(fn)` with a deadlock guard: a NEW ROOT transaction that fails fast
 * instead of hanging forever when no pooled connection becomes available.
 *
 * Why: the sign-service must commit its submit bookkeeping (claim, finalize,
 * failure marker) independently of the caller's request transaction. When an
 * in-process consumer awaits the action while its own request transaction
 * holds the single pooled sqlite connection, the acquire can never succeed —
 * without this guard that is a silent, zero-CPU, infinite hang.
 *
 * Guarantees:
 * - On timeout, throws `BackendError` 503 `ODATANO_NESTED_TX_TIMEOUT` with a
 *   diagnosis pointing at KNOWN_ISSUES #11.
 * - A late connection grant (after the timeout already fired) performs NO
 *   work: the callback forces the acquire via an explicit `begin()` and
 *   checks the abort flag right after it, so it rolls back immediately and
 *   the caller never observes an error for work that then silently happened
 *   anyway. (A flag check at callback ENTRY would run long before the lazy
 *   acquire and miss the timeout.)
 */
export async function detachedTx<T>(
  label: string,
  fn: (db: cds.Transaction) => Promise<T>,
  timeoutMs?: number
): Promise<T> {
  const effectiveTimeout = timeoutMs ?? effectiveTimeoutMs();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = cds.tx(async (db: cds.Transaction) => {
    // cds.tx() starts this callback immediately; the pooled connection is only
    // acquired lazily by the first statement. Force the acquire NOW, then check
    // the abort flag — a late grant (after the caller already received the
    // timeout error) must roll back before doing any work.
    await (db as unknown as { begin: () => Promise<unknown> }).begin();
    if (timedOut) throw new DetachedTxAbortedError(label);
    return fn(db);
  });

  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new BackendError(
        `${label}: could not begin a detached DB transaction within ${effectiveTimeout}ms. ` +
        `Most likely the calling request still holds the pooled DB connection open ` +
        `(in-process nested call — do not await this action while your request ` +
        `transaction is open; detach your reads into a committed cds.tx first, ` +
        `see docs/KNOWN_ISSUES.md issue 11). Alternatively the connection pool is exhausted.`,
        503,
        ERROR_CODES.NESTED_TX_TIMEOUT
      ));
    }, effectiveTimeout);
  });

  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      // The orphaned acquire may still be granted later; its callback aborts
      // itself via the flag. Observe the rejection so it never surfaces as an
      // unhandled promise rejection.
      work.catch((e: unknown) => {
        if (!(e instanceof DetachedTxAbortedError)) {
          logger.warn(`Orphaned detached tx '${label}' failed after timeout: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    }
  }
}
