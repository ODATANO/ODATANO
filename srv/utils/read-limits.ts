// Statement timeout for reads that come in over the API. Crawler, backfills and worker run in
// contexts without an HTTP request and keep running without a limit.
import cds from '@sap/cds';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';
import { loadReadTimeoutMs } from '../config';

const logger = cds.log('ReadLimits');
const INSTALLED = Symbol.for('odatano.readTimeout');

/** Contexts of API requests whose database transactions get the timeout. */
const limitedContexts = new WeakSet<object>();

/** PostgreSQL error code of a statement cancelled by statement_timeout. */
export const QUERY_CANCELED = '57014';

export function markLimited(context: unknown): void {
  if (context && typeof context === 'object') limitedContexts.add(context);
}

export function isLimited(context: unknown): boolean {
  return Boolean(context && typeof context === 'object' && limitedContexts.has(context));
}

/** The 503 for a cancelled statement, or null for any other error. */
export function queryTimeoutError(err: unknown): BackendError | null {
  if ((err as { code?: unknown } | null)?.code !== QUERY_CANCELED) return null;
  return new BackendError(
    'The read took longer than the read timeout and was cancelled; narrow it with a filter on an indexed field',
    503,
    ERROR_CODES.QUERY_TIMEOUT,
  );
}

type ErrorFields = { status?: unknown; statusCode?: unknown; code?: unknown; message: string };

/** Rewrites a cancelled statement in place, so a generic read answers 503 instead of 500. */
export function rewriteQueryTimeout(err: unknown): void {
  const mapped = queryTimeoutError(err);
  if (!mapped || !(err instanceof Error)) return;
  const fields = err as unknown as ErrorFields;
  fields.status = mapped.statusCode;
  fields.statusCode = mapped.statusCode;
  fields.code = mapped.code;
  fields.message = `[${mapped.code}] ${mapped.message}`;
}

type ServiceHooks = Pick<cds.Service, 'before' | 'on' | 'prepend'>;

/** Marks every HTTP request of `srv` as an API read; called once per service implementation. */
export function limitApiReads(srv: ServiceHooks): void {
  // Synchronous and first, so the mark is set before any handler opens the transaction.
  // cds.tx(req) opens its transaction with the request itself as context, so both are marked
  srv.prepend(() => srv.before('*', (req: cds.Request) => {
    const context = (req as unknown as { context?: { http?: unknown } }).context;
    if (!context?.http) return;
    markLimited(context);
    markLimited(req);
  }));
  srv.on('error', (err: Error) => rewriteQueryTimeout(err));
}

type DbHooks = { kind?: string; after: (event: string, handler: (this: DbTx) => Promise<void>) => unknown };
type DbTx = { context?: unknown; exec: (sql: string) => Promise<unknown> };

/** Sets the timeout after BEGIN in every transaction of a marked context; PostgreSQL only. */
export function installReadTimeout(db: DbHooks | undefined = cds.db as unknown as DbHooks | undefined, ms: number = loadReadTimeoutMs()): boolean {
  if (!db || db.kind !== 'postgres' || ms <= 0) return false;
  const holder = db as unknown as Record<symbol, unknown>;
  if (holder[INSTALLED]) return true;
  db.after('BEGIN', async function (this: DbTx) {
    if (isLimited(this.context)) await this.exec(`SET LOCAL statement_timeout = ${ms}`);
  });
  holder[INSTALLED] = true;
  logger.info(`API reads on PostgreSQL time out after ${ms} ms`);
  return true;
}
