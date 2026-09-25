import cds from '@sap/cds';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';

/**
 * Transaction helpers for the sign-service and background workers. @cap-js/sqlite has a single pooled
 * connection held by the request tx, so a new root tx awaited by that request would wait forever.
 */

const logger = cds.log('tx-utils');

/** Default acquire budget for detached bookkeeping transactions. */
export const DETACHED_TX_TIMEOUT_MS = 10_000;

/** ODATANO_DETACHED_TX_TIMEOUT_MS override, else the default; read per call. */
function effectiveTimeoutMs(): number {
  const fromEnv = Number(process.env.ODATANO_DETACHED_TX_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DETACHED_TX_TIMEOUT_MS;
}

/**
 * Run `fn` with `cds.context` cleared so inner `db.run` calls get short-lived transactions instead of
 * joining a long-lived ambient one; keeps the single sqlite connection free during long awaits.
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
 * `cds.tx(fn)` as a new root transaction with a deadlock guard: throws BackendError 503
 * `ODATANO_NESTED_TX_TIMEOUT` when no pooled connection arrives in time, and a late grant does no work.
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
    // The connection is acquired lazily by the first statement: force it now, then check the abort
    // flag so a grant after the timeout rolls back before doing any work.
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
        `transaction is open; detach your reads into a committed cds.tx first). ` +
        `Alternatively the connection pool is exhausted.`,
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
      // The orphaned acquire may still be granted; observe its rejection so it is never unhandled.
      work.catch((e: unknown) => {
        if (!(e instanceof DetachedTxAbortedError)) {
          logger.warn(`Orphaned detached tx '${label}' failed after timeout: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    }
  }
}
