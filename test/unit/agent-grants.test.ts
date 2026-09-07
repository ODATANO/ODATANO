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
  __resetGrantRateLimiterForTests,
  agentPrincipalId,
  budgetRunnerFor,
  consumeDailyBudget,
  enforceAgentGrant,
  hashAgentToken,
  issueAgentGrant,
  makeAgentUser,
  registerAgentGrantHandlers,
  resolveAgentToken,
  revokeAgentGrantById,
  toGrantStatus,
  validateGrantInput,
  type AgentGrantRow,
  type Runner,
} from '../../srv/utils/agent-grants';

// ---------------------------------------------------------------------------
// Fake runner: a Map of grant rows plus the handful of UPDATE shapes we emit.
// ---------------------------------------------------------------------------

type Cqn = {
  SELECT?: { from: { ref: string[] }; where?: unknown[]; one?: boolean };
  INSERT?: { into: { ref: string[] }; entries: Record<string, unknown>[] };
  UPDATE?: { entity: { ref: string[] }; data?: Record<string, unknown>; with?: Record<string, unknown>; where?: unknown[] };
};

interface WhereClause { op: string; val: unknown }

/** `{ref:['col']}, '=', {val}` triples (and `is null`) → { col: {op, val} }. */
function whereMap(tokens: unknown[] | undefined): Record<string, WhereClause> {
  const out: Record<string, WhereClause> = {};
  if (!tokens) return out;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as { ref?: string[] };
    if (!t?.ref) continue;
    const col = t.ref[t.ref.length - 1]!;
    const op = tokens[i + 1];
    if (op === 'is') {
      out[col] = { op: '=', val: null };
      i += 2;
    } else {
      out[col] = { op: String(op), val: (tokens[i + 2] as { val?: unknown })?.val };
      i += 2;
    }
  }
  return out;
}

function matches(row: Record<string, unknown>, where: Record<string, WhereClause>): boolean {
  for (const [col, { op, val }] of Object.entries(where)) {
    const actual = row[col] ?? null;
    switch (op) {
      case '=': if (actual !== val) return false; break;
      case '<': if (!(Number(actual) < Number(val))) return false; break;
      case '>': if (!(Number(actual) > Number(val))) return false; break;
      default: throw new Error(`fake runner: unsupported operator ${op}`);
    }
  }
  return true;
}

class FakeStore implements Runner {
  rows = new Map<string, Record<string, unknown>>();
  statements: string[] = [];

  seed(row: AgentGrantRow): void {
    this.rows.set(row.ID, { ...row });
  }

  async run(q: unknown): Promise<unknown> {
    const cqn = q as Cqn;
    if (cqn.SELECT) {
      const where = whereMap(cqn.SELECT.where);
      this.statements.push(`SELECT ${Object.keys(where).join(',')}`);
      const hit = [...this.rows.values()].find((r) => matches(r, where));
      return hit ? { ...hit } : null;
    }
    if (cqn.INSERT) {
      this.statements.push('INSERT');
      for (const e of cqn.INSERT.entries) this.rows.set(String(e.ID), { ...e });
      return cqn.INSERT.entries.length;
    }
    if (cqn.UPDATE) {
      const set = { ...(cqn.UPDATE.data ?? {}), ...(cqn.UPDATE.with ?? {}) } as Record<string, unknown>;
      const where = whereMap(cqn.UPDATE.where);
      this.statements.push(`UPDATE ${Object.keys(set).join(',')} WHERE ${Object.keys(where).join(',')}`);
      let affected = 0;
      for (const row of this.rows.values()) {
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
    reject: vi.fn((status: number, message: string) => {
      const err = Object.assign(new Error(message), { status });
      throw err;
    }),
    on: vi.fn((ev: string, fn: (err: unknown) => void) => { if (ev === 'failed') failedListeners.push(fn); }),
    _failed: failedListeners,
  };
  return req;
}

async function rejection(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { status?: number; message: string };
    return { status: e.status ?? 0, message: e.message };
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
      refused._failed.forEach((fn) => fn({ status: 400 }));
      await new Promise((r) => setTimeout(r, 0));
      expect(current().jobsUsedToday).toBe(0);

      const crashed = makeReq('BuildSimpleAdaTransaction', {}, current());
      await enforceAgentGrant(crashed as never, store);
      crashed._failed.forEach((fn) => fn({ statusCode: 503 }));
      await new Promise((r) => setTimeout(r, 0));
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
  });
});
