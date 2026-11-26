/**
 * Read timeout: only transactions of HTTP requests to the read services get statement_timeout,
 * and a cancelled statement answers 503 ODATANO_QUERY_TIMEOUT.
 */
import cds from '@sap/cds';
import { installReadTimeout, isLimited, limitApiReads, markLimited, queryTimeoutError, rewriteQueryTimeout, QUERY_CANCELED } from '../../srv/utils/read-limits';
import { loadReadTimeoutMs, READ_TIMEOUT_MS_DEFAULT } from '../../srv/config';
import { ERROR_CODES } from '../../srv/utils/error-codes';
import { readOutside } from '../../srv/utils/tx-utils';

type BeginHandler = (this: { context?: unknown; exec: (sql: string) => Promise<unknown> }) => Promise<void>;

const fakeDb = (kind: string) => {
  const handlers: BeginHandler[] = [];
  return { kind, handlers, after: (event: string, h: BeginHandler) => { if (event === 'BEGIN') handlers.push(h); } };
};

const cancelled = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: QUERY_CANCELED });

describe('installReadTimeout', () => {
  it('sets the timeout after BEGIN for a marked context only', async () => {
    const db = fakeDb('postgres');
    expect(installReadTimeout(db, 15000)).toBe(true);
    const marked = {};
    markLimited(marked);
    const exec = vi.fn(async () => undefined);
    await db.handlers[0].call({ context: marked, exec });
    await db.handlers[0].call({ context: {}, exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('SET LOCAL statement_timeout = 15000');
  });

  it('installs once per database service', () => {
    const db = fakeDb('postgres');
    installReadTimeout(db, 15000);
    installReadTimeout(db, 15000);
    expect(db.handlers).toHaveLength(1);
  });

  it('does nothing on SQLite or when turned off', () => {
    expect(installReadTimeout(fakeDb('sqlite'), 15000)).toBe(false);
    const off = fakeDb('postgres');
    expect(installReadTimeout(off, 0)).toBe(false);
    expect(off.handlers).toHaveLength(0);
  });
});

describe('limitApiReads', () => {
  const register = () => {
    const before: Array<(req: unknown) => void> = [];
    const errors: Array<(err: Error) => void> = [];
    const srv = {
      prepend: (fn: () => void) => fn(),
      before: (_e: string, h: (req: unknown) => void) => before.push(h),
      on: (_e: string, h: (err: Error) => void) => errors.push(h),
    };
    limitApiReads(srv as never);
    return { mark: before[0], onError: errors[0] };
  };

  it('marks the context of an HTTP request, not an in-process call', () => {
    const { mark } = register();
    const http = { http: { req: {}, res: {} } };
    const inProcess = {};
    const req = { context: http };
    const local = { context: inProcess };
    mark(req);
    mark(local);
    expect(isLimited(http)).toBe(true);
    expect(isLimited(inProcess)).toBe(false);
    // handleRequest opens its transaction with cds.tx(req), whose context is the request itself
    expect(isLimited(req)).toBe(true);
    expect(isLimited(local)).toBe(false);
  });

  it('turns a cancelled statement into a 503 with the ODATANO code', () => {
    const { onError } = register();
    const err = cancelled();
    onError(err);
    expect(err).toMatchObject({ status: 503, statusCode: 503, code: ERROR_CODES.QUERY_TIMEOUT });
    expect(err.message).toContain(ERROR_CODES.QUERY_TIMEOUT);
  });
});

describe('queryTimeoutError', () => {
  it('maps only the cancel code', () => {
    expect(queryTimeoutError(cancelled())).toMatchObject({ statusCode: 503, code: ERROR_CODES.QUERY_TIMEOUT });
    expect(queryTimeoutError(Object.assign(new Error('x'), { code: '23505' }))).toBeNull();
    expect(queryTimeoutError(null)).toBeNull();
  });

  it('leaves other errors untouched', () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    rewriteQueryTimeout(err);
    expect(err).toMatchObject({ code: '23505', message: 'duplicate key' });
  });
});

describe('readOutside', () => {
  it('keeps the mark on the short transaction of a marked request', async () => {
    const request = { context: { http: {} } } as unknown as cds.Transaction & { context: object };
    markLimited(request.context);
    const seen = await readOutside(Object.assign(request, { begin: () => undefined }), async (db) => isLimited((db as unknown as { context?: unknown }).context));
    expect(seen).toBe(true);
  });

  it('adds no mark for an unmarked caller', async () => {
    const caller = { context: {}, begin: () => undefined } as unknown as cds.Transaction;
    const seen = await readOutside(caller, async (db) => isLimited((db as unknown as { context?: unknown }).context));
    expect(seen).toBe(false);
  });
});

describe('loadReadTimeoutMs', () => {
  it('reads READ_TIMEOUT_MS, 0 turns it off, garbage falls back', () => {
    expect(loadReadTimeoutMs({})).toBe(READ_TIMEOUT_MS_DEFAULT);
    expect(loadReadTimeoutMs({ READ_TIMEOUT_MS: '8000' })).toBe(8000);
    expect(loadReadTimeoutMs({ READ_TIMEOUT_MS: '0' })).toBe(0);
    expect(loadReadTimeoutMs({ READ_TIMEOUT_MS: 'soon' })).toBe(READ_TIMEOUT_MS_DEFAULT);
  });
});
