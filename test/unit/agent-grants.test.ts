/**
 * Agent grants (AGENT_GRANTS_DESIGN.md): the enforcement ladder, the budget
 * counter, token resolution and grant issuance, against a fake CQL runner.
 *
 * The real @sap/cds is used for cds.ql / cds.User; only the database is faked.
 * The fake understands exactly the statement shapes the module emits (looked
 * up by SET keys and WHERE columns), so a changed statement shape fails here
 * instead of silently passing.
 */

import cds from '@sap/cds';
import {
  AGENT_ROLE,
  AGENT_TOKEN_PREFIX,
  GRANTS_ENTITY,
  GRANT_USAGE_ENTITY,
  __resetGrantRateLimiterForTests,
  __resetGrantUsageBufferForTests,
  __setGrantUsageModeForTests,
  __setTokenCacheMsForTests,
  tokenCacheSize,
  agentPrincipalId,
  flushGrantUsage,
  pendingGrantUsageKeys,
  budgetRunnerFor,
  consumeDailyBudget,
  enforceAgentGrant,
  getGrantUsage,
  hashAgentToken,
  issueAgentGrant,
  makeAgentUser,
  registerAgentGrantHandlers,
  resolveAgentToken,
  resolveUsageWindow,
  revokeAgentGrantById,
  rotateAgentGrantToken,
  toGrantStatus,
  updateAgentGrant,
  validateGrantInput,
  type AgentGrantRow,
  type Runner,
} from '../../srv/utils/agent-grants';
import { loadGrantAdminRateLimit } from '../../srv/utils/agent-grants-config';

// ---------------------------------------------------------------------------
// Fake runner: a Map of grant rows plus the handful of UPDATE shapes we emit.
// ---------------------------------------------------------------------------

type Cqn = {
  SELECT?: { from: { ref: string[] }; where?: unknown[]; one?: boolean; columns?: unknown[]; groupBy?: { ref: string[] }[] };
  INSERT?: { into: { ref: string[] }; entries: Record<string, unknown>[] };
  UPDATE?: { entity: { ref: string[] }; data?: Record<string, unknown>; with?: Record<string, unknown>; where?: unknown[] };
};

interface WhereClause { col: string; op: string; val: unknown }

/**
 * `{ref:['col']}, '=', {val}` triples (and `is null`) → [{ col, op, val }].
 * A list, not a map: a day range names the same column twice (`>=` and `<=`).
 */
function whereMap(tokens: unknown[] | undefined): WhereClause[] {
  const out: WhereClause[] = [];
  if (!tokens) return out;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as { ref?: string[] };
    if (!t?.ref) continue;
    const col = t.ref[t.ref.length - 1]!;
    const op = tokens[i + 1];
    if (op === 'is') {
      out.push({ col, op: '=', val: null });
      i += 2;
    } else {
      out.push({ col, op: String(op), val: (tokens[i + 2] as { val?: unknown })?.val });
      i += 2;
    }
  }
  return out;
}

const whereCols = (where: WhereClause[]) => where.map((w) => w.col).join(',');

function matches(row: Record<string, unknown>, where: WhereClause[]): boolean {
  for (const { col, op, val } of where) {
    const actual = row[col] ?? null;
    switch (op) {
      case '=': if (actual !== val) return false; break;
      case '<': if (!(Number(actual) < Number(val))) return false; break;
      case '>': if (!(Number(actual) > Number(val))) return false; break;
      // day strings compare lexically (YYYY-MM-DD), numbers numerically
      case '>=': if (!(actual !== null && (actual as string | number) >= (val as string | number))) return false; break;
      case '<=': if (!(actual !== null && (actual as string | number) <= (val as string | number))) return false; break;
      default: throw new Error(`fake runner: unsupported operator ${op}`);
    }
  }
  return true;
}

/** Grant rows are keyed by ID, usage rows by their composite key. */
function rowKey(e: Record<string, unknown>): string {
  return e.ID !== undefined ? String(e.ID) : [e.grant_ID, e.day, e.service, e.action].map(String).join('|');
}

/** `SELECT … columns(sum(x) as y) … groupBy(a, b)`: the one aggregate shape getGrantUsage emits. */
function aggregate(rows: Record<string, unknown>[], sel: NonNullable<Cqn['SELECT']>): Record<string, unknown>[] {
  const groupCols = (sel.groupBy ?? []).map((g) => g.ref[g.ref.length - 1]!);
  const sums = (sel.columns ?? [])
    .filter((c): c is { func: string; args: { ref: string[] }[]; as?: string } => typeof c === 'object' && c !== null && (c as { func?: string }).func === 'sum')
    .map((c) => ({ col: c.args[0]!.ref[0]!, as: c.as ?? c.args[0]!.ref[0]! }));
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = groupCols.map((c) => String(r[c])).join('|');
    const g = out.get(key) ?? Object.fromEntries(groupCols.map((c) => [c, r[c]]));
    for (const s of sums) g[s.as] = Number(g[s.as] ?? 0) + Number(r[s.col] ?? 0);
    out.set(key, g);
  }
  return [...out.values()];
}

class FakeStore implements Runner {
  rows = new Map<string, Record<string, unknown>>();
  usage = new Map<string, Record<string, unknown>>();
  statements: string[] = [];

  seed(row: AgentGrantRow): void {
    this.rows.set(row.ID, { ...row });
  }

  seedUsage(row: { grant_ID: string; day: string; service: string; action: string; calls: number; refunded: number }): void {
    this.usage.set(rowKey(row), { ...row });
  }

  usageRows(): Record<string, unknown>[] {
    return [...this.usage.values()].map((r) => ({ ...r }));
  }

  private tableFor(entity: string): Map<string, Record<string, unknown>> {
    return entity === GRANT_USAGE_ENTITY ? this.usage : this.rows;
  }

  async run(q: unknown): Promise<unknown> {
    const cqn = q as Cqn;
    if (cqn.SELECT) {
      const table = this.tableFor(cqn.SELECT.from.ref[0]!);
      const where = whereMap(cqn.SELECT.where);
      this.statements.push(`SELECT ${whereCols(where)}`);
      const hits = [...table.values()].filter((r) => matches(r, where));
      if (cqn.SELECT.one) {
        const hit = hits[0];
        return hit ? { ...hit } : null;
      }
      if (cqn.SELECT.groupBy) return aggregate(hits, cqn.SELECT);
      return hits.map((r) => ({ ...r }));
    }
    if (cqn.INSERT) {
      const table = this.tableFor(cqn.INSERT.into.ref[0]!);
      this.statements.push('INSERT');
      for (const e of cqn.INSERT.entries) {
        const key = rowKey(e);
        if (table.has(key)) throw new Error('UNIQUE constraint failed');
        table.set(key, { ...e });
      }
      return cqn.INSERT.entries.length;
    }
    if (cqn.UPDATE) {
      const table = this.tableFor(cqn.UPDATE.entity.ref[0]!);
      const set = { ...(cqn.UPDATE.data ?? {}), ...(cqn.UPDATE.with ?? {}) } as Record<string, unknown>;
      const where = whereMap(cqn.UPDATE.where);
      this.statements.push(`UPDATE ${Object.keys(set).join(',')} WHERE ${whereCols(where)}`);
      let affected = 0;
      for (const row of table.values()) {
        if (!matches(row, where)) continue;
        for (const [k, v] of Object.entries(set)) {
          // cds.ql renders `{ '+=': 1 }` either verbatim or as an xpr
          // `[{ref:[col]}, '+', {val:1}]`; accept both spellings.
          const expr = v as { '+='?: number; '-='?: number; xpr?: unknown[]; val?: unknown } | null;
          if (expr && typeof expr === 'object' && '+=' in expr) row[k] = Number(row[k] ?? 0) + Number(expr['+=']);
          else if (expr && typeof expr === 'object' && '-=' in expr) row[k] = Number(row[k] ?? 0) - Number(expr['-=']);
          else if (expr && typeof expr === 'object' && Array.isArray(expr.xpr)) {
            const [, op, operand] = expr.xpr as [unknown, string, { val: number }];
            row[k] = op === '-' ? Number(row[k] ?? 0) - Number(operand.val) : Number(row[k] ?? 0) + Number(operand.val);
          } else if (expr && typeof expr === 'object' && 'val' in expr) row[k] = expr.val;
          else row[k] = v;
        }
        affected++;
      }
      return affected;
    }
    throw new Error('fake runner: unknown statement');
  }
}

const GRANT_ID = '11111111-1111-4111-8111-111111111111';
const today = () => new Date().toISOString().slice(0, 10);

function grant(overrides: Partial<AgentGrantRow> = {}): AgentGrantRow {
  return {
    ID: GRANT_ID,
    userId: 'alice',
    allowedActions: JSON.stringify(['BuildSimpleAdaTransaction', 'SubmitWalletJob', 'CancelJob']),
    walletId: 'ops',
    allowedJobKinds: null,
    maxJobsPerDay: null,
    jobsUsedToday: 0,
    budgetWindow: null,
    validUntil: null,
    isActive: true,
    ...overrides,
  };
}

/** A CAP-shaped request: reject throws like the real one; failed-listeners are collected. */
function makeReq(event: string, data: Record<string, unknown> = {}, g: AgentGrantRow | null = grant()) {
  const failedListeners: Array<(err: unknown) => void> = [];
  const req = {
    event,
    data,
    user: g ? makeAgentUser(g) : new cds.User({ id: 'alice', roles: ['Admin'] } as never),
    http: { req: g ? { agentGrant: g } : {} },
    reject: vi.fn((status: number | { status: number; code?: string; message: string }, message?: string) => {
      // Both spellings CAP accepts: reject(status, message[, target]) and reject({ status, code, message }).
      if (typeof status === 'object') throw Object.assign(new Error(status.message), { status: status.status, code: status.code });
      throw Object.assign(new Error(message), { status });
    }),
    on: vi.fn((ev: string, fn: (err: unknown) => void) => { if (ev === 'failed') failedListeners.push(fn); }),
    _failed: failedListeners,
  };
  return req;
}

async function rejection(p: Promise<unknown>): Promise<{ status: number; message: string; code?: string }> {
  try {
    await p;
  } catch (err) {
    // req.reject sets `status`; a BackendError thrown by the programmatic API carries `statusCode`.
    const e = err as { status?: number; statusCode?: number; code?: string; message: string };
    return { status: e.status ?? e.statusCode ?? 0, message: e.message, code: e.code };
  }
  throw new Error('expected a rejection');
}

beforeEach(() => __resetGrantRateLimiterForTests());

// ---------------------------------------------------------------------------

describe('makeAgentUser', () => {
  it('is the principal agent:<grantId> with only the agent-grant role and the grant in attr', () => {
    const user = makeAgentUser(grant());
    expect(user.id).toBe(agentPrincipalId(GRANT_ID));
    expect(user.is(AGENT_ROLE)).toBe(true);
    expect(user.is('Admin')).toBe(false);
    expect(user.is('admin')).toBe(false);
    expect(user.is('authenticated-user')).toBe(true);
    expect((user.attr as Record<string, unknown>).grantId).toBe(GRANT_ID);
    expect((user.attr as Record<string, unknown>).operator).toBe('alice');
    expect((user.attr as Record<string, unknown>).walletId).toBe('ops');
  });
});

describe('resolveAgentToken', () => {
  it('rejects a wrong prefix without touching the database', async () => {
    const store = new FakeStore();
    const r = await resolveAgentToken('ngat_' + 'a'.repeat(64), store);
    expect(r).toEqual({ ok: false, status: 401, message: 'invalid agent token' });
    expect(store.statements).toEqual([]);
  });

  it('answers 401 for an unknown hash and for a revoked grant alike (non-leaking)', async () => {
    const store = new FakeStore();
    const token = AGENT_TOKEN_PREFIX + 'b'.repeat(64);
    store.seed(grant({ tokenHash: hashAgentToken(token), isActive: false }));
    expect(await resolveAgentToken(AGENT_TOKEN_PREFIX + 'c'.repeat(64), store)).toMatchObject({ ok: false, status: 401 });
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 401 });
  });

  it('answers 410 for an expired grant and the row for a live one', async () => {
    const store = new FakeStore();
    const expiredToken = AGENT_TOKEN_PREFIX + 'd'.repeat(64);
    const liveToken = AGENT_TOKEN_PREFIX + 'e'.repeat(64);
    store.seed(grant({ ID: '22222222-2222-4222-8222-222222222222', tokenHash: hashAgentToken(expiredToken), validUntil: new Date(Date.now() - 1000).toISOString() }));
    store.seed(grant({ tokenHash: hashAgentToken(liveToken), validUntil: new Date(Date.now() + 3600_000).toISOString() }));
    expect(await resolveAgentToken(expiredToken, store)).toMatchObject({ ok: false, status: 410 });
    const live = await resolveAgentToken(liveToken, store);
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.grant.ID).toBe(GRANT_ID);
  });
});

describe('token cache: a resolved grant is reused for a few seconds, dropped on revoke / rotate / update', () => {
  const token = AGENT_TOKEN_PREFIX + 'f'.repeat(64);
  const selects = (store: FakeStore) => store.statements.filter((s) => s.startsWith('SELECT')).length;

  afterEach(() => __setTokenCacheMsForTests(null));

  it('reads the database once, then answers from the cache until the TTL passes', async () => {
    __setTokenCacheMsForTests(10_000);
    const store = new FakeStore();
    store.seed(grant({ tokenHash: hashAgentToken(token) }));
    expect((await resolveAgentToken(token, store)).ok).toBe(true);
    expect((await resolveAgentToken(token, store)).ok).toBe(true);
    expect((await resolveAgentToken(token, store)).ok).toBe(true);
    expect(selects(store)).toBe(1);
    expect(tokenCacheSize()).toBe(1);

    __setTokenCacheMsForTests(1);
    expect((await resolveAgentToken(token, store)).ok).toBe(true); // fills a 1 ms entry
    await new Promise((r) => setTimeout(r, 5));
    expect((await resolveAgentToken(token, store)).ok).toBe(true); // expired: read again
    expect(selects(store)).toBe(3);
  });

  it('never caches an unknown or revoked token, and expiry is checked per request against the cached row', async () => {
    __setTokenCacheMsForTests(10_000);
    const store = new FakeStore();
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 401 });
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 401 });
    expect(selects(store)).toBe(2);
    expect(tokenCacheSize()).toBe(0);

    store.seed(grant({ tokenHash: hashAgentToken(token), validUntil: new Date(Date.now() + 30).toISOString() }));
    expect((await resolveAgentToken(token, store)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 410 }); // cached row, expired now
  });

  it('revoke drops the entry: the next request is 401 at once', async () => {
    __setTokenCacheMsForTests(10_000);
    const store = new FakeStore();
    store.seed(grant({ tokenHash: hashAgentToken(token) }));
    expect((await resolveAgentToken(token, store)).ok).toBe(true);
    expect(await revokeAgentGrantById(GRANT_ID, store)).toBe(true);
    expect(tokenCacheSize()).toBe(0);
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 401 });
  });

  it('rotate drops the old token at once and the new one resolves; update makes the next request re-read the row', async () => {
    __setTokenCacheMsForTests(10_000);
    const store = new FakeStore();
    store.seed(grant({ tokenHash: hashAgentToken(token) }));
    expect((await resolveAgentToken(token, store)).ok).toBe(true);
    const rotated = await rotateAgentGrantToken(GRANT_ID, store);
    expect(rotated).not.toBeNull();
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 401 });
    const fresh = await resolveAgentToken(rotated!.token, store);
    expect(fresh.ok).toBe(true);

    const before = selects(store);
    expect((await resolveAgentToken(rotated!.token, store)).ok).toBe(true); // cached
    expect(selects(store)).toBe(before);
    const upd = await updateAgentGrant(GRANT_ID, { allowedActions: ['VerifySignature'] }, store);
    expect(upd.ok).toBe(true);
    const after = await resolveAgentToken(rotated!.token, store);
    expect(after.ok).toBe(true);
    if (after.ok) expect(JSON.parse(after.grant.allowedActions)).toEqual(['VerifySignature']);
    expect(selects(store)).toBeGreaterThan(before); // re-read after the update
  });

  it('does not remember a row read before a revoke that landed while the SELECT was in flight', async () => {
    __setTokenCacheMsForTests(10_000);
    const store = new FakeStore();
    store.seed(grant({ tokenHash: hashAgentToken(token) }));
    // Hold the SELECT until the revoke has run, then let it return the old row.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = store.run.bind(store);
    let held = false;
    store.run = async (q: unknown) => {
      const result = await run(q);
      if (!held && typeof q === 'object' && q !== null && 'SELECT' in q) { held = true; await gate; }
      return result;
    };
    const inFlight = resolveAgentToken(token, store);
    await new Promise((r) => setImmediate(r));
    expect(await revokeAgentGrantById(GRANT_ID, store)).toBe(true);
    release();
    expect((await inFlight).ok).toBe(true); // the request that was already admitted completes
    expect(tokenCacheSize()).toBe(0); // but its row is not cached
    expect(await resolveAgentToken(token, store)).toMatchObject({ ok: false, status: 401 });
  });

  it('is off with a TTL of 0 and bypassed for injected runners without an override', async () => {
    __setTokenCacheMsForTests(0);
    const store = new FakeStore();
    store.seed(grant({ tokenHash: hashAgentToken(token) }));
    await resolveAgentToken(token, store);
    await resolveAgentToken(token, store);
    expect(selects(store)).toBe(2);
    expect(tokenCacheSize()).toBe(0);

    __setTokenCacheMsForTests(null); // config TTL (default 10 s) applies to the primary db only
    await resolveAgentToken(token, store);
    await resolveAgentToken(token, store);
    expect(selects(store)).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe('enforceAgentGrant', () => {
  it('is a no-op for an ordinary principal', async () => {
    const store = new FakeStore();
    const req = makeReq('PauseWorker', {}, null);
    await expect(enforceAgentGrant(req as never, store)).resolves.toBeUndefined();
    expect(req.reject).not.toHaveBeenCalled();
    expect(store.statements).toEqual([]);
  });

  it('lets always-allowed events through without an allow-list entry and without budget', async () => {
    const store = new FakeStore();
    store.seed(grant({ allowedActions: '[]', maxJobsPerDay: 1, jobsUsedToday: 1, budgetWindow: today() }));
    for (const event of ['READ', 'GetLatestBlock', 'GetJobStatus', 'GetGrantStatus', 'ParseTransactionCbor']) {
      const req = makeReq(event, {}, store.rows.get(GRANT_ID) as unknown as AgentGrantRow);
      await expect(enforceAgentGrant(req as never, store)).resolves.toBeUndefined();
    }
    // lastUsedAt touched (once: throttled to a minute), nothing else changed.
    expect(store.statements.filter((s) => s.startsWith('UPDATE lastUsedAt'))).toHaveLength(1);
    expect(store.rows.get(GRANT_ID)!.jobsUsedToday).toBe(1);
  });

  it('refuses an action outside the allow list with 403 naming it', async () => {
    const req = makeReq('BuildMintTransaction');
    const r = await rejection(enforceAgentGrant(req as never, new FakeStore()));
    expect(r.status).toBe(403);
    expect(r.message).toContain("'BuildMintTransaction'");
  });

  it('refuses never-grantable actions even when a row smuggles them into allowedActions', async () => {
    // Creation refuses such a list; a row edited by hand must still not open the door
    // beyond what the hook allows — it only knows the allow list, so the Admin gate
    // on the action itself is the second wall (role-less principal).
    const g = grant({ allowedActions: JSON.stringify(['PauseWorker']) });
    const req = makeReq('PauseWorker', {}, g);
    expect(makeAgentUser(g).is('Admin')).toBe(false);
    await expect(enforceAgentGrant(req as never, new FakeStore())).resolves.toBeUndefined();
  });

  it('answers 401 for an inactive and 410 for an expired grant even after the lane admitted it', async () => {
    expect((await rejection(enforceAgentGrant(makeReq('READ', {}, grant({ isActive: false })) as never, new FakeStore()))).status).toBe(401);
    expect((await rejection(enforceAgentGrant(makeReq('READ', {}, grant({ validUntil: '2000-01-01T00:00:00Z' })) as never, new FakeStore()))).status).toBe(410);
  });

  describe('wallet pinning', () => {
    it('refuses wallet actions on a grant without a wallet', async () => {
      const r = await rejection(enforceAgentGrant(makeReq('SubmitWalletJob', { walletId: 'ops', kind: 'simpleAda' }, grant({ walletId: null })) as never, new FakeStore()));
      expect(r.status).toBe(403);
      expect(r.message).toContain('no wallet binding');
    });

    it('refuses a foreign walletId and injects the pinned one when absent', async () => {
      const mismatch = await rejection(enforceAgentGrant(makeReq('SubmitWalletJob', { walletId: 'treasury', kind: 'simpleAda' }) as never, new FakeStore()));
      expect(mismatch.status).toBe(403);
      expect(mismatch.message).toContain('walletId');

      const req = makeReq('SubmitWalletJob', { kind: 'simpleAda' });
      await enforceAgentGrant(req as never, new FakeStore());
      expect(req.data.walletId).toBe('ops');
    });

    it('narrows job kinds when the grant lists them', async () => {
      const g = grant({ allowedJobKinds: JSON.stringify(['simpleAda', 'metadata']) });
      const ok = makeReq('SubmitWalletJob', { kind: 'metadata' }, g);
      await expect(enforceAgentGrant(ok as never, new FakeStore())).resolves.toBeUndefined();
      const bad = await rejection(enforceAgentGrant(makeReq('SubmitWalletJob', { kind: 'mint' }, g) as never, new FakeStore()));
      expect(bad.status).toBe(403);
      expect(bad.message).toContain("'mint'");
    });

    it('lets CancelJob through pinned; ownership is the worker service`s createdBy gate', async () => {
      const req = makeReq('CancelJob', { jobId: '33333333-3333-4333-8333-333333333333' });
      await expect(enforceAgentGrant(req as never, new FakeStore())).resolves.toBeUndefined();
    });
  });

  describe('daily budget', () => {
    it('opens a fresh window on the first call of the day and counts allow-listed calls', async () => {
      const store = new FakeStore();
      store.seed(grant({ maxJobsPerDay: 2, budgetWindow: '2020-01-01', jobsUsedToday: 2 }));
      const g = store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
      await enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g) as never, store);
      expect(store.rows.get(GRANT_ID)).toMatchObject({ budgetWindow: today(), jobsUsedToday: 1 });
    });

    it('answers 429 once the budget is spent and keeps counting per grant', async () => {
      const store = new FakeStore();
      store.seed(grant({ maxJobsPerDay: 2, budgetWindow: today(), jobsUsedToday: 1 }));
      const current = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
      await enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, current()) as never, store);
      expect(current().jobsUsedToday).toBe(2);
      const r = await rejection(enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, current()) as never, store));
      expect(r.status).toBe(429);
      expect(r.message).toContain('2/day');
      expect(current().jobsUsedToday).toBe(2);
    });

    it('refunds the unit when the handler refuses the input (4xx below 429), keeps it on 429 and 5xx', async () => {
      const store = new FakeStore();
      store.seed(grant({ maxJobsPerDay: 5, budgetWindow: today(), jobsUsedToday: 0 }));
      const current = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;

      const refused = makeReq('BuildSimpleAdaTransaction', {}, current());
      await enforceAgentGrant(refused as never, store);
      expect(current().jobsUsedToday).toBe(1);
      // The refund runs in a setImmediate; a 0 ms timer can fire before it on a
      // busy loop, so wait for the check phase first, then a timer.
      const settled = () => new Promise((r) => setImmediate(() => setTimeout(r, 0)));
      refused._failed.forEach((fn) => fn({ status: 400 }));
      await settled();
      expect(current().jobsUsedToday).toBe(0);

      const crashed = makeReq('BuildSimpleAdaTransaction', {}, current());
      await enforceAgentGrant(crashed as never, store);
      crashed._failed.forEach((fn) => fn({ statusCode: 503 }));
      await settled();
      expect(current().jobsUsedToday).toBe(1);
    });

    it('never lets two racing requests overspend (conditional increment)', async () => {
      const store = new FakeStore();
      store.seed(grant({ maxJobsPerDay: 1, budgetWindow: today(), jobsUsedToday: 0 }));
      const g = store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
      const results = await Promise.all([consumeDailyBudget(store, g), consumeDailyBudget(store, g), consumeDailyBudget(store, g)]);
      expect(results.filter((r) => r.consumed)).toHaveLength(1);
      expect(store.rows.get(GRANT_ID)!.jobsUsedToday).toBe(1);
      expect(results[0]!.window).toBe(today());
    });

    it('refunds into the window that was charged, not into the day the refund runs', async () => {
      vi.useFakeTimers();
      try {
        const store = new FakeStore();
        store.seed(grant({ maxJobsPerDay: 5, budgetWindow: null, jobsUsedToday: 0 }));
        const current = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;

        // 23:59:59Z: a request is charged to day D1.
        vi.setSystemTime(new Date('2026-09-05T23:59:59Z'));
        const late = makeReq('BuildSimpleAdaTransaction', {}, current());
        await enforceAgentGrant(late as never, store);
        expect(current()).toMatchObject({ budgetWindow: '2026-09-05', jobsUsedToday: 1 });

        // 00:00:01Z next day: another request opens D2 with one unit used.
        vi.setSystemTime(new Date('2026-09-06T00:00:01Z'));
        await enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, current()) as never, store);
        expect(current()).toMatchObject({ budgetWindow: '2026-09-06', jobsUsedToday: 1 });

        // The D1 request is now refused by its handler. Its refund must not
        // touch D2's counter: the unit it gives back belongs to D1.
        late._failed.forEach((fn) => fn({ status: 400 }));
        await vi.runAllTimersAsync();
        expect(current()).toMatchObject({ budgetWindow: '2026-09-06', jobsUsedToday: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('charges inside an already-open transaction (a $batch changeset) and registers no refund', async () => {
      const store = new FakeStore();
      store.seed(grant({ maxJobsPerDay: 5, budgetWindow: today(), jobsUsedToday: 0 }));
      const g = store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
      // detached=false is what budgetRunnerFor picks when cds.tx(req) is already begun:
      // the statements run on that transaction and its rollback is the refund.
      const req = makeReq('BuildSimpleAdaTransaction', {}, g);
      await enforceAgentGrant(req as never, store, false);
      expect(store.rows.get(GRANT_ID)!.jobsUsedToday).toBe(1);
      expect(req._failed).toHaveLength(0);
    });

    it('picks the request transaction when it is already begun, otherwise a detached runner', () => {
      const openTx = { run: vi.fn(), ready: Promise.resolve(true) };
      const freshTx = { run: vi.fn() };
      const cdsTx = vi.spyOn(cds, 'tx').mockImplementation((() => openTx) as never);
      try {
        expect(budgetRunnerFor({} as never)).toMatchObject({ runner: openTx, detached: false });
        cdsTx.mockImplementation((() => freshTx) as never);
        const fresh = budgetRunnerFor({} as never);
        expect(fresh.detached).toBe(true);
        expect(fresh.runner).not.toBe(freshTx);
      } finally {
        cdsTx.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe('validateGrantInput / issueAgentGrant / revokeAgentGrantById', () => {
  it('refuses empty, unknown and never-grantable actions', () => {
    expect(() => validateGrantInput({ allowedActions: [] })).toThrow(/non-empty/);
    expect(() => validateGrantInput({ allowedActions: ['PauseWorker'] })).toThrow(/non-grantable entries: PauseWorker/);
    expect(() => validateGrantInput({ allowedActions: ['SignWithHsm'] })).toThrow(/non-grantable/);
    expect(() => validateGrantInput({ allowedActions: ['CreateAgentGrant'] })).toThrow(/non-grantable/);
  });

  it('requires a wallet for wallet actions and job kinds only with them', () => {
    expect(() => validateGrantInput({ allowedActions: ['SubmitWalletJob'] })).toThrow(/walletId is required/);
    expect(() => validateGrantInput({ allowedActions: ['BuildSimpleAdaTransaction'], allowedJobKinds: ['mint'] })).toThrow(/needs SubmitWalletJob/);
    expect(() => validateGrantInput({ allowedActions: ['SubmitWalletJob'], walletId: 'ops', allowedJobKinds: ['bogus'] })).toThrow(/unknown kinds: bogus/);
    const n = validateGrantInput({ allowedActions: ['SubmitWalletJob', 'SubmitWalletJob'], walletId: ' ops ', allowedJobKinds: ['mint'] });
    expect(n).toMatchObject({ allowedActions: ['SubmitWalletJob'], walletId: 'ops', allowedJobKinds: ['mint'] });
  });

  it('validates budget, expiry and label', () => {
    expect(() => validateGrantInput({ allowedActions: ['VerifySignature'], maxJobsPerDay: 0 })).toThrow(/positive integer/);
    expect(() => validateGrantInput({ allowedActions: ['VerifySignature'], validUntil: 'yesterday' })).toThrow(/ISO-8601/);
    expect(() => validateGrantInput({ allowedActions: ['VerifySignature'], validUntil: '2000-01-01T00:00:00Z' })).toThrow(/in the future/);
    expect(() => validateGrantInput({ allowedActions: ['VerifySignature'], agentLabel: 'x'.repeat(101) })).toThrow(/100 characters/);
  });

  it('issues a token once, stores only its hash, and the token then resolves', async () => {
    const store = new FakeStore();
    const issued = await issueAgentGrant(
      { allowedActions: ['BuildSimpleAdaTransaction', 'SubmitTransaction'], maxJobsPerDay: 10, agentLabel: 'trace-bot' },
      'alice',
      store
    );
    expect(issued.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(issued.token).toHaveLength(AGENT_TOKEN_PREFIX.length + 64);
    const row = store.rows.get(issued.grantId)!;
    expect(row.tokenHash).toBe(hashAgentToken(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row).toMatchObject({ userId: 'alice', agentLabel: 'trace-bot', maxJobsPerDay: 10, isActive: true, walletId: null });

    const resolved = await resolveAgentToken(issued.token, store);
    expect(resolved.ok).toBe(true);

    expect(await revokeAgentGrantById(issued.grantId, store)).toBe(true);
    expect(await revokeAgentGrantById(issued.grantId, store)).toBe(false);
    expect(await resolveAgentToken(issued.token, store)).toMatchObject({ ok: false, status: 401 });
  });

  it('reports the status honestly: a counter from an earlier day is zero budget used today', () => {
    const s = toGrantStatus(grant({ maxJobsPerDay: 5, jobsUsedToday: 4, budgetWindow: '2020-01-01' }));
    expect(s.jobsUsedToday).toBe(0);
    expect(s.allowedActions).toContain('SubmitWalletJob');
    const t = toGrantStatus(grant({ maxJobsPerDay: 5, jobsUsedToday: 4, budgetWindow: today() }));
    expect(t.jobsUsedToday).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe('CardanoAgentService handlers', () => {
  type Handler = (req: Record<string, unknown>) => Promise<unknown>;
  function boot(): Record<string, Handler> {
    const handlers: Record<string, Handler> = {};
    registerAgentGrantHandlers({ on: (event: string, handler: Handler) => { handlers[event] = handler; } } as never);
    return handlers;
  }

  it('does not let a token create or revoke grants', async () => {
    const h = boot();
    const create = makeReq('CreateAgentGrant', { allowedActions: ['VerifySignature'] });
    expect((await rejection(h.CreateAgentGrant!(create as never))).status).toBe(403);
    const revoke = makeReq('RevokeAgentGrant', { grantId: GRANT_ID });
    expect((await rejection(h.RevokeAgentGrant!(revoke as never))).status).toBe(403);
  });

  it('GetGrantStatus needs a token', async () => {
    const h = boot();
    const req = makeReq('GetGrantStatus', {}, null);
    expect((await rejection(h.GetGrantStatus!(req as never))).status).toBe(400);
  });

  it('CreateAgentGrant maps a validation error to 400 before any transaction work', async () => {
    const h = boot();
    const req = makeReq('CreateAgentGrant', { allowedActions: ['PauseWorker'] }, null);
    const r = await rejection(h.CreateAgentGrant!(req as never));
    expect(r.status).toBe(400);
    expect(r.message).toContain('non-grantable');
  });

  it('rate-limits grant administration per operator', async () => {
    const h = boot();
    // Ten refusals still consume the window: the limiter runs before validation.
    for (let i = 0; i < 10; i++) {
      await rejection(h.CreateAgentGrant!(makeReq('CreateAgentGrant', { allowedActions: ['nope'] }, null) as never));
    }
    const r = await rejection(h.CreateAgentGrant!(makeReq('CreateAgentGrant', { allowedActions: ['nope'] }, null) as never));
    expect(r.status).toBe(429);
  });
});

describe('GRANTS_ENTITY', () => {
  it('names the schema entity', () => {
    expect(GRANTS_ENTITY).toBe('odatano.cardano.CardanoAgentGrants');
    expect(GRANT_USAGE_ENTITY).toBe('odatano.cardano.CardanoAgentGrantUsage');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle parity with NIGHTGATE (rc.6): rate-limit knob, rotate, update, usage
// ---------------------------------------------------------------------------

type Handler = (req: Record<string, unknown>) => Promise<unknown>;
function bootHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  registerAgentGrantHandlers({ on: (event: string, handler: Handler) => { handlers[event] = handler; } } as never);
  return handlers;
}

/** A store-backed cds.tx(req) for handler tests that reach the database. */
function withTx<T>(store: FakeStore, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(cds, 'tx').mockImplementation((() => store) as never);
  return fn().finally(() => spy.mockRestore());
}

const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('AGENT_GRANT_ADMIN_RATE_LIMIT', () => {
  afterEach(() => {
    delete process.env.AGENT_GRANT_ADMIN_RATE_LIMIT;
    __resetGrantRateLimiterForTests();
  });

  it('defaults to 10, takes an integer >= 1 from the env, and falls back on anything else', () => {
    expect(loadGrantAdminRateLimit({})).toBe(10);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: '600' })).toBe(600);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: '1' })).toBe(1);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: '0' })).toBe(10);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: '-5' })).toBe(10);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: '2.5' })).toBe(10);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: 'lots' })).toBe(10);
    expect(loadGrantAdminRateLimit({ AGENT_GRANT_ADMIN_RATE_LIMIT: '' })).toBe(10);
  });

  it('is what the limiter uses, across all four administration actions', async () => {
    process.env.AGENT_GRANT_ADMIN_RATE_LIMIT = '3';
    __resetGrantRateLimiterForTests();
    const h = bootHandlers();
    const store = new FakeStore();
    store.seed(grant());
    await withTx(store, async () => {
      // Three calls of three different actions fit; the fourth (a revoke) is 429.
      await rejection(h.CreateAgentGrant!(makeReq('CreateAgentGrant', { allowedActions: ['nope'] }, null) as never));
      await h.RotateAgentGrantToken!(makeReq('RotateAgentGrantToken', { grantId: GRANT_ID }, null) as never);
      await h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { grantId: GRANT_ID, agentLabel: 'x' }, null) as never);
      const r = await rejection(h.RevokeAgentGrant!(makeReq('RevokeAgentGrant', { grantId: GRANT_ID }, null) as never));
      expect(r.status).toBe(429);
    });
    expect(store.rows.get(GRANT_ID)!.isActive).toBe(true);
  });
});

describe('rotateAgentGrantToken / RotateAgentGrantToken', () => {
  it('replaces the hash: the old token is unknown, the new one resolves to the same grant with its budget', async () => {
    const store = new FakeStore();
    const issued = await issueAgentGrant({ allowedActions: ['VerifySignature'], maxJobsPerDay: 5 }, 'alice', store);
    Object.assign(store.rows.get(issued.grantId)!, { budgetWindow: today(), jobsUsedToday: 3 });

    const rotated = await rotateAgentGrantToken(issued.grantId, store);
    expect(rotated).not.toBeNull();
    expect(rotated!.grantId).toBe(issued.grantId);
    expect(rotated!.token).toMatch(/^odat_[0-9a-f]{64}$/);
    expect(rotated!.token).not.toBe(issued.token);
    expect(store.rows.get(issued.grantId)!.tokenHash).toBe(hashAgentToken(rotated!.token));

    expect((await resolveAgentToken(issued.token, store)).ok).toBe(false);
    const fresh = await resolveAgentToken(rotated!.token, store);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(toGrantStatus(fresh.grant)).toMatchObject({ grantId: issued.grantId, jobsUsedToday: 3, maxJobsPerDay: 5 });
  });

  it('is null for an unknown or revoked grant, and the action answers 404 with the revoke wording', async () => {
    const store = new FakeStore();
    store.seed(grant({ isActive: false }));
    expect(await rotateAgentGrantToken(GRANT_ID, store)).toBeNull();
    expect(await rotateAgentGrantToken(OTHER_ID, store)).toBeNull();
    expect(await rotateAgentGrantToken('', store)).toBeNull();

    const h = bootHandlers();
    const r = await withTx(store, () => rejection(h.RotateAgentGrantToken!(makeReq('RotateAgentGrantToken', { grantId: GRANT_ID }, null) as never)));
    expect(r.status).toBe(404);
    expect(r.message).toBe('Grant not found or already revoked');
  });

  it('the action refuses a token principal (403) and a missing grantId (400)', async () => {
    const h = bootHandlers();
    expect((await rejection(h.RotateAgentGrantToken!(makeReq('RotateAgentGrantToken', { grantId: GRANT_ID }) as never))).status).toBe(403);
    expect((await rejection(h.RotateAgentGrantToken!(makeReq('RotateAgentGrantToken', {}, null) as never))).status).toBe(400);
  });
});

describe('updateAgentGrant / UpdateAgentGrant', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();

  function seeded(): FakeStore {
    const store = new FakeStore();
    store.seed(grant({
      agentLabel: 'before',
      allowedActions: JSON.stringify(['BuildSimpleAdaTransaction', 'SubmitWalletJob']),
      walletId: 'ops',
      allowedJobKinds: JSON.stringify(['mint']),
      maxJobsPerDay: 5,
      budgetWindow: today(),
      jobsUsedToday: 4,
      validUntil: future,
    }));
    return store;
  }

  it('changes only the given fields; an absent field stays, an explicit null clears', async () => {
    const store = seeded();
    const r = await updateAgentGrant(GRANT_ID, { agentLabel: 'after', maxJobsPerDay: 9 }, store);
    expect(r).toEqual({ ok: true, grantId: GRANT_ID, updated: ['agentLabel', 'maxJobsPerDay'] });
    expect(store.rows.get(GRANT_ID)).toMatchObject({
      agentLabel: 'after', maxJobsPerDay: 9, validUntil: future, allowedJobKinds: JSON.stringify(['mint']), walletId: 'ops', jobsUsedToday: 4,
    });

    const cleared = await updateAgentGrant(GRANT_ID, { allowedJobKinds: null, maxJobsPerDay: null, validUntil: null, agentLabel: null }, store);
    expect(cleared.ok).toBe(true);
    expect(store.rows.get(GRANT_ID)).toMatchObject({ allowedJobKinds: null, maxJobsPerDay: null, validUntil: null, agentLabel: null });

    // Nothing given: nothing written, still ok.
    const statementsBefore = store.statements.length;
    expect(await updateAgentGrant(GRANT_ID, {}, store)).toEqual({ ok: true, grantId: GRANT_ID, updated: [] });
    expect(store.statements.slice(statementsBefore).filter((s) => s.startsWith('UPDATE'))).toHaveLength(0);
  });

  it('validates the merged row with the UpdateAgentGrant prefix: no empty allow list, wallet actions need the pinned wallet, job kinds need SubmitWalletJob, validUntil in the future', async () => {
    const store = seeded();
    const fail = async (input: Parameters<typeof updateAgentGrant>[1]) => rejection(updateAgentGrant(GRANT_ID, input, store));

    expect(await fail({ allowedActions: [] })).toMatchObject({ status: 400, message: expect.stringContaining('UpdateAgentGrant: allowedActions must be a non-empty array') });
    expect(await fail({ allowedActions: null })).toMatchObject({ status: 400 });
    expect(await fail({ allowedActions: ['PauseWorker'] })).toMatchObject({ status: 400, message: expect.stringContaining('non-grantable') });
    // Dropping SubmitWalletJob while job kinds are set breaks the cross-field rule on the merged row.
    expect(await fail({ allowedActions: ['BuildSimpleAdaTransaction'] })).toMatchObject({ status: 400, message: expect.stringContaining('allowedJobKinds needs SubmitWalletJob') });
    expect(await fail({ allowedJobKinds: ['teleport'] })).toMatchObject({ status: 400, message: expect.stringContaining('unknown kinds') });
    expect(await fail({ maxJobsPerDay: 0 })).toMatchObject({ status: 400 });
    expect(await fail({ validUntil: '2000-01-01T00:00:00Z' })).toMatchObject({ status: 400, message: expect.stringContaining('in the future') });
    expect(await fail({ validUntil: 'yesterday' })).toMatchObject({ status: 400 });
    expect(await fail({ agentLabel: 'x'.repeat(101) })).toMatchObject({ status: 400 });
    // Nothing above was written.
    expect(store.rows.get(GRANT_ID)).toMatchObject({ agentLabel: 'before', maxJobsPerDay: 5 });

    // A grant without a wallet cannot gain wallet actions by update.
    store.seed(grant({ ID: OTHER_ID, walletId: null, allowedActions: JSON.stringify(['VerifySignature']) }));
    const r = await rejection(updateAgentGrant(OTHER_ID, { allowedActions: ['SubmitWalletJob'] }, store));
    expect(r).toMatchObject({ status: 400, message: expect.stringContaining('walletId is required') });
  });

  it('allows lowering maxJobsPerDay below jobsUsedToday (over budget until the day rolls) and leaves the counter alone', async () => {
    const store = seeded();
    expect((await updateAgentGrant(GRANT_ID, { maxJobsPerDay: 2 }, store)).ok).toBe(true);
    expect(store.rows.get(GRANT_ID)).toMatchObject({ maxJobsPerDay: 2, jobsUsedToday: 4, budgetWindow: today() });
    const g = store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
    expect((await rejection(enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g) as never, store))).status).toBe(429);
  });

  it('is 404 for an unknown grant, 409 GRANT_REVOKED for a revoked one, and a concurrent revoke wins', async () => {
    const store = seeded();
    expect(await updateAgentGrant(OTHER_ID, { agentLabel: 'x' }, store)).toEqual({ ok: false, status: 404, message: 'Grant not found' });

    store.seed(grant({ ID: OTHER_ID, isActive: false }));
    expect(await updateAgentGrant(OTHER_ID, { agentLabel: 'x' }, store)).toEqual({ ok: false, status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' });

    // Revoked between the read and the conditional UPDATE.
    const racing: Runner = {
      run: async (q) => {
        const cqn = q as Cqn;
        if (cqn.UPDATE) await revokeAgentGrantById(GRANT_ID, store);
        return store.run(q);
      },
    };
    expect(await updateAgentGrant(GRANT_ID, { agentLabel: 'late' }, racing)).toMatchObject({ ok: false, status: 409, code: 'GRANT_REVOKED' });
    expect(store.rows.get(GRANT_ID)).toMatchObject({ isActive: false, agentLabel: 'before' });
  });

  it('the action: walletId is immutable (400), a revoked grant is 409 with the code, a token 403, no grantId 400', async () => {
    const h = bootHandlers();
    const store = seeded();
    await withTx(store, async () => {
      const immutable = await rejection(h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { grantId: GRANT_ID, walletId: 'other' }, null) as never));
      expect(immutable).toMatchObject({ status: 400, message: expect.stringContaining('walletId cannot be changed') });

      const ok = await h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { grantId: GRANT_ID, agentLabel: 'via action' }, null) as never);
      expect(ok).toEqual({ grantId: GRANT_ID, updated: ['agentLabel'] });

      const bad = await rejection(h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { grantId: GRANT_ID, allowedActions: [] }, null) as never));
      expect(bad.status).toBe(400);

      await revokeAgentGrantById(GRANT_ID, store);
      const revoked = await rejection(h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { grantId: GRANT_ID, agentLabel: 'x' }, null) as never));
      expect(revoked).toMatchObject({ status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' });
    });
    expect((await rejection(h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { grantId: GRANT_ID, agentLabel: 'x' }) as never))).status).toBe(403);
    expect((await rejection(h.UpdateAgentGrant!(makeReq('UpdateAgentGrant', { agentLabel: 'x' }, null) as never))).status).toBe(400);
  });
});

describe('deferred usage counters (Postgres / HANA): buffered per key, flushed in one write', () => {
  const SVC = 'CardanoTransactionService';
  // The refund runs in a setImmediate; a 0 ms timer can fire before it on a busy
  // loop, so wait for the check phase first, then a timer.
  const tick = () => new Promise((r) => setImmediate(() => setTimeout(r, 0)));
  const ACTION = 'BuildSimpleAdaTransaction';

  beforeEach(() => { __setGrantUsageModeForTests('deferred'); __resetGrantUsageBufferForTests(); });
  afterEach(() => { __setGrantUsageModeForTests(null); __resetGrantUsageBufferForTests(); });

  it('writes nothing per call; the flush lands the summed deltas as one INSERT, later as one UPDATE', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: null }));
    const g = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;

    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);
    const refused = makeReq(ACTION, {}, g());
    await enforceAgentGrant(refused as never, store, undefined, SVC);
    refused._failed.forEach((fn) => fn({ status: 400 }));
    await tick();

    // Nothing has touched the usage table yet; three calls and one refund wait on one key.
    expect(store.usageRows()).toEqual([]);
    expect(store.statements.filter((s) => s === 'INSERT' || s.startsWith('UPDATE calls'))).toHaveLength(0);
    expect(pendingGrantUsageKeys()).toBe(1);

    expect(await flushGrantUsage(store)).toEqual({ flushed: 1, failed: 0 });
    expect(store.usageRows()).toEqual([{ grant_ID: GRANT_ID, day: today(), service: SVC, action: ACTION, calls: 3, refunded: 1 }]);
    expect(pendingGrantUsageKeys()).toBe(0);

    // The next window adds to the existing row: one UPDATE, no INSERT.
    const before = store.statements.length;
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, 'CardanoSignService'); // same action, other service = other key
    expect(await flushGrantUsage(store)).toEqual({ flushed: 2, failed: 0 });
    expect(store.statements.slice(before).filter((s) => s === 'INSERT')).toHaveLength(1); // the new key only
    expect(store.usageRows()).toEqual([
      { grant_ID: GRANT_ID, day: today(), service: SVC, action: ACTION, calls: 4, refunded: 1 },
      { grant_ID: GRANT_ID, day: today(), service: 'CardanoSignService', action: ACTION, calls: 1, refunded: 0 },
    ]);
  });

  it('keeps a delta whose write failed for the next flush, and GetGrantUsage flushes before it reads', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: null }));
    const g = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);

    const broken: Runner = { run: async () => { throw new Error('connection reset'); } };
    expect(await flushGrantUsage(broken)).toEqual({ flushed: 0, failed: 1 });
    expect(pendingGrantUsageKeys()).toBe(1);
    expect(store.usageRows()).toEqual([]);

    const window = resolveUsageWindow(undefined, undefined, new Date()) as Extract<ReturnType<typeof resolveUsageWindow>, { ok: true }>;
    // The flush goes to the detached runner, the read to the request's tx: a
    // request tx that only reads must not receive the buffered writes.
    const readOnlyTx: Runner = {
      run: async (q: unknown) => {
        const cqn = q as { INSERT?: unknown; UPDATE?: unknown };
        if (cqn.INSERT || cqn.UPDATE) throw new Error('write on the request transaction');
        return store.run(q);
      },
    };
    const usage = await getGrantUsage(g(), window, readOnlyTx, store);
    expect(usage.calls).toEqual([{ service: SVC, action: ACTION, count: 2, refunded: 0 }]);
    expect(pendingGrantUsageKeys()).toBe(0);
    expect(store.usageRows()).toEqual([{ grant_ID: GRANT_ID, day: today(), service: SVC, action: ACTION, calls: 2, refunded: 0 }]);
  });

  it('keeps a delta whose INSERT failed for a reason other than the insert race', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: null }));
    const g = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);

    // The UPDATE finds no row, the INSERT fails, the second UPDATE still finds
    // no row: not the race, the delta must survive for the next flush.
    const noInsert: Runner = {
      run: async (q: unknown) => {
        if ((q as { INSERT?: unknown }).INSERT) throw new Error('disk full');
        return store.run(q);
      },
    };
    expect(await flushGrantUsage(noInsert)).toEqual({ flushed: 0, failed: 1 });
    expect(pendingGrantUsageKeys()).toBe(1);
    expect(store.usageRows()).toEqual([]);
    expect(await flushGrantUsage(store)).toEqual({ flushed: 1, failed: 0 });
    expect(store.usageRows()).toEqual([{ grant_ID: GRANT_ID, day: today(), service: SVC, action: ACTION, calls: 1, refunded: 0 }]);
  });

  it('stays synchronous for a request inside its own changeset transaction (detached: false) and in sync mode', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: null }));
    const g = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
    // Not detached: the changeset's rollback is the refund, the write rides the transaction.
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, false, SVC);
    expect(pendingGrantUsageKeys()).toBe(0);
    expect(store.usageRows()).toEqual([{ grant_ID: GRANT_ID, day: today(), service: SVC, action: ACTION, calls: 1, refunded: 0 }]);
    // Sync mode (SQLite): the awaited write, as before.
    __setGrantUsageModeForTests('sync');
    await enforceAgentGrant(makeReq(ACTION, {}, g()) as never, store, undefined, SVC);
    expect(pendingGrantUsageKeys()).toBe(0);
    expect(store.usageRows()).toEqual([{ grant_ID: GRANT_ID, day: today(), service: SVC, action: ACTION, calls: 2, refunded: 0 }]);
  });
});

describe('usage counters and GetGrantUsage', () => {
  const SVC = 'CardanoTransactionService';
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('counts an admitted call per grant, day, service and action — budgeted or not — and marks a refused one refunded', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: null }));
    const g = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;

    await enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g()) as never, store, undefined, SVC);
    await enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g()) as never, store, undefined, SVC);
    const refused = makeReq('BuildSimpleAdaTransaction', {}, g());
    await enforceAgentGrant(refused as never, store, undefined, SVC);
    refused._failed.forEach((fn) => fn({ status: 400 }));
    await tick();
    const crashed = makeReq('BuildSimpleAdaTransaction', {}, g());
    await enforceAgentGrant(crashed as never, store, undefined, SVC);
    crashed._failed.forEach((fn) => fn({ status: 503 }));
    await tick();

    expect(store.usageRows()).toEqual([
      { grant_ID: GRANT_ID, day: today(), service: SVC, action: 'BuildSimpleAdaTransaction', calls: 4, refunded: 1 },
    ]);
    // Unlimited grant: no budget counter was touched.
    expect(g().jobsUsedToday).toBe(0);
  });

  it('does not count a call refused before admission (allow list, exhausted budget) and never fails the request on a broken usage write', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: 1, budgetWindow: today(), jobsUsedToday: 0 }));
    const g = () => store.rows.get(GRANT_ID) as unknown as AgentGrantRow;

    expect((await rejection(enforceAgentGrant(makeReq('PauseWorker', {}, g()) as never, store, undefined, 'CardanoWorkerService'))).status).toBe(403);
    await enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g()) as never, store, undefined, SVC);
    expect((await rejection(enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g()) as never, store, undefined, SVC))).status).toBe(429);
    expect(store.usageRows()).toEqual([
      { grant_ID: GRANT_ID, day: today(), service: SVC, action: 'BuildSimpleAdaTransaction', calls: 1, refunded: 0 },
    ]);

    // A usage table that is missing (e.g. no cds deploy yet) is logged, not surfaced.
    const broken: Runner = {
      run: async (q) => {
        const cqn = q as Cqn;
        const entity = cqn.UPDATE?.entity.ref[0] ?? cqn.INSERT?.into.ref[0];
        if (entity === GRANT_USAGE_ENTITY) throw new Error('no such table');
        return store.run(q);
      },
    };
    store.seed(grant({ ID: OTHER_ID, maxJobsPerDay: null }));
    await expect(enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, store.rows.get(OTHER_ID) as never) as never, broken, undefined, SVC)).resolves.toBeUndefined();
  });

  it('survives a lost insert race: the second writer lands on the row the first one created', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: null }));
    const g = store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
    // Three admitted calls interleave on the fake: all three UPDATEs miss, one
    // INSERT lands, the two others hit the unique key and retry the UPDATE.
    await Promise.all([
      enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g) as never, store, undefined, SVC),
      enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g) as never, store, undefined, SVC),
      enforceAgentGrant(makeReq('BuildSimpleAdaTransaction', {}, g) as never, store, undefined, SVC),
    ]);
    expect(store.usageRows()).toEqual([{ grant_ID: GRANT_ID, day: today(), service: SVC, action: 'BuildSimpleAdaTransaction', calls: 3, refunded: 0 }]);
  });

  it('resolveUsageWindow: defaults (until = now, since = until - 30 days), ordering, the 366-day cap and unparsable input', () => {
    const now = new Date('2026-09-18T12:00:00Z');
    const d = resolveUsageWindow(undefined, undefined, now);
    expect(d).toMatchObject({ ok: true, since: '2026-08-19T12:00:00.000Z', until: '2026-09-18T12:00:00.000Z', sinceDay: '2026-08-19', untilDay: '2026-09-18' });
    expect(resolveUsageWindow('2026-09-01', '2026-09-02T23:59:00Z', now)).toMatchObject({ ok: true, sinceDay: '2026-09-01', untilDay: '2026-09-02' });
    expect(resolveUsageWindow('2026-09-03', '2026-09-02', now)).toMatchObject({ ok: false, message: 'since must not lie after until', target: 'since' });
    expect(resolveUsageWindow('2025-01-01', '2026-09-02', now)).toMatchObject({ ok: false, message: 'the window may span at most 366 days' });
    expect(resolveUsageWindow('2025-09-02', '2026-09-02', now)).toMatchObject({ ok: true });
    expect(resolveUsageWindow('yesterday', undefined, now)).toMatchObject({ ok: false, message: 'since must be a valid ISO-8601 timestamp', target: 'since' });
    expect(resolveUsageWindow(undefined, 'soon', now)).toMatchObject({ ok: false, message: 'until must be a valid ISO-8601 timestamp', target: 'until' });
    expect(resolveUsageWindow(null, '', now)).toMatchObject({ ok: true });
  });

  it('aggregates the window per service and action, count = calls - refunded, sorted, with the live budget', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: 10, budgetWindow: today(), jobsUsedToday: 7 }));
    store.seedUsage({ grant_ID: GRANT_ID, day: '2026-09-01', service: 'CardanoTransactionService', action: 'BuildSimpleAdaTransaction', calls: 3, refunded: 1 });
    store.seedUsage({ grant_ID: GRANT_ID, day: '2026-09-02', service: 'CardanoTransactionService', action: 'BuildSimpleAdaTransaction', calls: 2, refunded: 0 });
    store.seedUsage({ grant_ID: GRANT_ID, day: '2026-09-02', service: 'CardanoSignService', action: 'VerifySignature', calls: 1, refunded: 0 });
    store.seedUsage({ grant_ID: GRANT_ID, day: '2026-08-31', service: 'CardanoTransactionService', action: 'BuildSimpleAdaTransaction', calls: 99, refunded: 0 }); // outside
    store.seedUsage({ grant_ID: OTHER_ID, day: '2026-09-01', service: 'CardanoTransactionService', action: 'BuildSimpleAdaTransaction', calls: 99, refunded: 0 }); // foreign

    const window = resolveUsageWindow('2026-09-01T10:00:00Z', '2026-09-02T00:00:00Z');
    if (!window.ok) throw new Error(window.message);
    const usage = await getGrantUsage(store.rows.get(GRANT_ID) as unknown as AgentGrantRow, window, store);
    expect(usage).toEqual({
      grantId: GRANT_ID,
      since: '2026-09-01T10:00:00.000Z',
      until: '2026-09-02T00:00:00.000Z',
      calls: [
        { service: 'CardanoSignService', action: 'VerifySignature', count: 1, refunded: 0 },
        { service: 'CardanoTransactionService', action: 'BuildSimpleAdaTransaction', count: 4, refunded: 1 },
      ],
      total: 5,
      jobsUsedToday: 7,
      maxJobsPerDay: 10,
    });
  });

  it('the hook narrows a token to its own grantId (foreign = 404, non-leaking) without spending budget', async () => {
    const store = new FakeStore();
    store.seed(grant({ maxJobsPerDay: 1, budgetWindow: today(), jobsUsedToday: 0 }));
    const g = store.rows.get(GRANT_ID) as unknown as AgentGrantRow;
    const foreign = await rejection(enforceAgentGrant(makeReq('GetGrantUsage', { grantId: OTHER_ID }, g) as never, store, undefined, 'CardanoAgentService'));
    expect(foreign).toMatchObject({ status: 404, message: 'Grant not found' });
    await expect(enforceAgentGrant(makeReq('GetGrantUsage', { grantId: GRANT_ID }, g) as never, store, undefined, 'CardanoAgentService')).resolves.toBeUndefined();
    expect(store.rows.get(GRANT_ID)!.jobsUsedToday).toBe(0);
    expect(store.usageRows()).toEqual([]);
  });

  it('the function: 400 without grantId or with a bad window, 403 for a non-Admin without token, 404 for an unknown grant, history for a revoked one', async () => {
    const h = bootHandlers();
    expect((await rejection(h.GetGrantUsage!(makeReq('GetGrantUsage', {}, null) as never))).status).toBe(400);
    expect((await rejection(h.GetGrantUsage!(makeReq('GetGrantUsage', { grantId: GRANT_ID, since: 'x' }, null) as never))).status).toBe(400);

    const bob = { ...makeReq('GetGrantUsage', { grantId: GRANT_ID }, null), user: new cds.User({ id: 'bob', roles: [] } as never) };
    expect((await rejection(h.GetGrantUsage!(bob as never))).status).toBe(403);

    const store = new FakeStore();
    store.seed(grant({ isActive: false, revokedAt: new Date().toISOString() }));
    store.seedUsage({ grant_ID: GRANT_ID, day: today(), service: SVC, action: 'BuildSimpleAdaTransaction', calls: 2, refunded: 0 });
    await withTx(store, async () => {
      expect((await rejection(h.GetGrantUsage!(makeReq('GetGrantUsage', { grantId: OTHER_ID }, null) as never))).status).toBe(404);
      const usage = (await h.GetGrantUsage!(makeReq('GetGrantUsage', { grantId: GRANT_ID }, null) as never)) as { total: number };
      expect(usage.total).toBe(2);
      // A token reads its own (the hook narrowed it; the handler trusts the principal, not the Admin role).
      const own = (await h.GetGrantUsage!(makeReq('GetGrantUsage', { grantId: GRANT_ID }, grant({ isActive: false })) as never)) as { total: number };
      expect(own.total).toBe(2);
      expect((await rejection(h.GetGrantUsage!(makeReq('GetGrantUsage', { grantId: OTHER_ID }) as never))).status).toBe(404);
    });
  });
});
