import cds from '@sap/cds';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';

// @cap-js/sqlite has a single pooled connection held by the request transaction.
// A new root transaction awaited by that request would wait forever.

const logger = cds.log('tx-utils');

/** Default acquire budget for detached bookkeeping transactions. */
export const DETACHED_TX_TIMEOUT_MS = 10_000;

/** ODATANO_DETACHED_TX_TIMEOUT_MS override, else the default; read per call. */
function effectiveTimeoutMs(): number {
  const fromEnv = Number(process.env.ODATANO_DETACHED_TX_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DETACHED_TX_TIMEOUT_MS;
}

// Clears cds.context so inner db.run calls use short transactions instead of joining an ambient one.
// This keeps the single SQLite connection free during long awaits.
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

// New root transaction with a deadlock guard. Throws 503 ODATANO_NESTED_TX_TIMEOUT when no
// connection arrives in time. A connection granted after the timeout does no work.
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
    // the timeout bounds the acquire only; once begun, the work runs to its own commit
    if (timer) clearTimeout(timer);
    return fn(db);
  });

  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new BackendError(
        `${label}: could not begin a detached DB transaction within ${effectiveTimeout}ms. ` +
        `Most likely the calling request still holds the pooled DB connection open ` +
        `(in-process nested call: do not await this action while your request ` +
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
