/**
 * Wallet worker — job store (W1/W6).
 * Mocks the @sap/cds CQL layer (crawler-sync-state test style) with a small
 * stateful in-memory store, and drives the job state machine, idempotency,
 * crash recovery and the per-wallet lease through it.
 */

vi.mock('@sap/cds', () => {
  // Query data lives under `_q` so the chaining METHODS (where/orderBy/columns)
  // can't clobber the captured where/orderBy DATA of the same name — the
  // original flat shape silently matched every row.
  const chain = (data: Record<string, unknown>) => ({
    _q: data,
    where: (w: unknown) => chain({ ...data, where: w }),
    orderBy: (...o: unknown[]) => chain({ ...data, orderBy: o }),
    columns: (...c: unknown[]) => chain({ ...data, columns: c }),
  });
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ql: {
      SELECT: {
        one: { from: (e: unknown) => chain({ _op: 'SELECT.one', entity: e }) },
        from: (e: unknown) => chain({ _op: 'SELECT', entity: e }),
      },
      INSERT: { into: (e: unknown) => ({ entries: (rows: unknown) => ({ _op: 'INSERT', entity: e, entries: rows }) }) },
      UPDATE: { entity: (e: unknown) => ({ set: (s: unknown) => ({ where: (w: unknown) => ({ _op: 'UPDATE', entity: e, set: s, where: w }) }) }) },
    },
    _with: (_store: undefined, fn: () => unknown) => fn(),
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  CardanoWalletJobs: 'odatano.cardano.CardanoWalletJobs',
  CardanoWorkerWallets: 'odatano.cardano.CardanoWorkerWallets',
}));

import {
  insertJob,
  getJobById,
  findDueJobs,
  findSubmittedJobs,
  walletHasActiveJob,
  markBuilding,
  markSubmitted,
  markConfirmed,
  markFailed,
  markCancelled,
  requeueForRetry,
  recoverInterruptedJobs,
  upsertWalletRegistration,
  readWallet,
  tryAcquireWalletLease,
  renewWalletLease,
  releaseWalletLease,
  bumpWalletStats,
  JOB_ERROR_CODES,
} from '../../srv/blockchain/wallet-worker/job-store';

// ---- Tiny in-memory CQL interpreter -----------------------------------------

type Row = Record<string, unknown>;
type Query = { _op: string; entity: string; where?: Row; set?: Row; entries?: Row | Row[]; orderBy?: unknown[] };

function makeStore() {
  const tables = new Map<string, Row[]>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const matches = (row: Row, where?: Row): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'in' in (v as Row)) {
        return ((v as { in: unknown[] }).in).includes(row[k]);
      }
      return row[k] === v || (v === null && (row[k] === null || row[k] === undefined));
    });
  };
  const db = {
    run: vi.fn(async (raw: Query & { _q?: Query }) => {
      // SELECT chains carry their data under `_q`; INSERT/UPDATE are flat.
      const q = raw._q ?? raw;
      const rows = table(q.entity);
      switch (q._op) {
        case 'SELECT.one': {
          const found = rows.filter(r => matches(r, q.where));
          return found.length ? { ...found[found.length - 1] } : undefined;
        }
        case 'SELECT': {
          let found = rows.filter(r => matches(r, q.where));
          if (q.orderBy?.length) {
            found = [...found].sort((a, b) =>
              (Number(a.priority ?? 0) - Number(b.priority ?? 0)) ||
              String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
          }
          return found.map(r => ({ ...r }));
        }
        case 'INSERT': {
          const entries = Array.isArray(q.entries) ? q.entries : [q.entries!];
          rows.push(...entries.map(e => ({ ...e })));
          return entries.length;
        }
        case 'UPDATE': {
          let n = 0;
          for (const row of rows) {
            if (matches(row, q.where)) { Object.assign(row, q.set); n++; }
          }
          return n;
        }
        default:
          throw new Error(`Unsupported op ${q._op}`);
      }
    }),
    tables,
  };
  return db;
}

const JOBS = 'odatano.cardano.CardanoWalletJobs';
const WALLETS = 'odatano.cardano.CardanoWorkerWallets';

describe('job-store: insertJob + idempotency', () => {
  it('inserts a pending job with defaults', async () => {
    const db = makeStore();
    const result = await insertJob(db as never, {
      walletId: 'w1', kind: 'simpleAda', request: '{"lovelaceAmount":"1000000"}', createdBy: 'alice',
    });

    expect(result.deduplicated).toBe(false);
    expect(result.status).toBe('pending');
    const row = db.tables.get(JOBS)![0];
    expect(row).toMatchObject({
      walletId: 'w1', kind: 'simpleAda', status: 'pending', attempt: 0, maxAttempts: 3, priority: 100, createdBy: 'alice',
    });
  });

  it('dedupes on (walletId, kind, idempotencyKey) for non-failed rows', async () => {
    const db = makeStore();
    const first = await insertJob(db as never, { walletId: 'w1', kind: 'mint', request: '{}', idempotencyKey: 'k1' });
    const second = await insertJob(db as never, { walletId: 'w1', kind: 'mint', request: '{}', idempotencyKey: 'k1' });

    expect(second.deduplicated).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(db.tables.get(JOBS)).toHaveLength(1);
  });

  it('does NOT dedupe against failed rows (retry path)', async () => {
    const db = makeStore();
    const first = await insertJob(db as never, { walletId: 'w1', kind: 'mint', request: '{}', idempotencyKey: 'k1' });
    await markBuilding(db as never, first.jobId, 1);
    await markFailed(db as never, first.jobId, 'X', new Error('boom'));

    const second = await insertJob(db as never, { walletId: 'w1', kind: 'mint', request: '{}', idempotencyKey: 'k1' });
    expect(second.deduplicated).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
  });
});

describe('job-store: state machine transitions', () => {
  async function seedPending(db: ReturnType<typeof makeStore>): Promise<string> {
    const { jobId } = await insertJob(db as never, { walletId: 'w1', kind: 'simpleAda', request: '{}' });
    return jobId;
  }

  it('walks the happy path pending → building → submitted → confirmed', async () => {
    const db = makeStore();
    const jobId = await seedPending(db);

    expect(await markBuilding(db as never, jobId, 1)).toBe(true);
    expect((await getJobById(db as never, jobId))!.attempt).toBe(1);

    expect(await markSubmitted(db as never, jobId, {
      txHash: 'a'.repeat(64), unsignedTxCbor: 'dead', signedTxCbor: 'beef', fee: '170000',
    })).toBe(true);
    const submitted = (await getJobById(db as never, jobId))!;
    expect(submitted.status).toBe('submitted');
    expect(submitted.txHash).toBe('a'.repeat(64));
    expect(submitted.signedTxCbor).toBe('beef');

    expect(await markConfirmed(db as never, jobId)).toBe(true);
    const confirmed = (await getJobById(db as never, jobId))!;
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.finishedAt).toBeTruthy();
  });

  it('refuses illegal transitions (guarded WHERE)', async () => {
    const db = makeStore();
    const jobId = await seedPending(db);

    // submitted requires building
    expect(await markSubmitted(db as never, jobId, { txHash: 'x', unsignedTxCbor: null, signedTxCbor: 'y', fee: null })).toBe(false);
    // confirmed requires submitted
    expect(await markConfirmed(db as never, jobId)).toBe(false);
    // cancel works from pending only
    expect(await markCancelled(db as never, jobId)).toBe(true);
    // and building can no longer claim a cancelled job
    expect(await markBuilding(db as never, jobId, 1)).toBe(false);
  });

  it('requeueForRetry moves building back to pending with backoff notBefore', async () => {
    const db = makeStore();
    const jobId = await seedPending(db);
    await markBuilding(db as never, jobId, 1);

    const notBefore = new Date(Date.now() + 10_000).toISOString();
    expect(await requeueForRetry(db as never, jobId, new Error('provider down'), notBefore)).toBe(true);
    const row = (await getJobById(db as never, jobId))!;
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(1); // attempt survives, next claim increments
    expect(row.notBefore).toBe(notBefore);
    expect(row.errorMessage).toContain('provider down');
  });

  it('findDueJobs filters notBefore in the future and orders by priority', async () => {
    const db = makeStore();
    const later = new Date(Date.now() + 60_000).toISOString();
    await insertJob(db as never, { walletId: 'w1', kind: 'simpleAda', request: '{}', notBefore: later });
    const { jobId: dueNow } = await insertJob(db as never, { walletId: 'w2', kind: 'simpleAda', request: '{}', priority: 50 });

    const due = await findDueJobs(db as never);
    expect(due.map(j => j.ID)).toEqual([dueNow]);
  });

  it('walletHasActiveJob covers building AND submitted', async () => {
    const db = makeStore();
    const jobId = await seedPending(db);
    expect(await walletHasActiveJob(db as never, 'w1')).toBe(false);
    await markBuilding(db as never, jobId, 1);
    expect(await walletHasActiveJob(db as never, 'w1')).toBe(true);
    await markSubmitted(db as never, jobId, { txHash: 'x', unsignedTxCbor: null, signedTxCbor: 'y', fee: null });
    expect(await walletHasActiveJob(db as never, 'w1')).toBe(true);
    await markConfirmed(db as never, jobId);
    expect(await walletHasActiveJob(db as never, 'w1')).toBe(false);
  });
});

describe('job-store: crash recovery (design §8)', () => {
  it('fails building jobs and returns submitted jobs for reconciliation', async () => {
    const db = makeStore();
    const { jobId: interrupted } = await insertJob(db as never, { walletId: 'w1', kind: 'simpleAda', request: '{}' });
    await markBuilding(db as never, interrupted, 1);
    const { jobId: inChain } = await insertJob(db as never, { walletId: 'w2', kind: 'mint', request: '{}' });
    await markBuilding(db as never, inChain, 1);
    await markSubmitted(db as never, inChain, { txHash: 'b'.repeat(64), unsignedTxCbor: null, signedTxCbor: 'cc', fee: null });

    const result = await recoverInterruptedJobs(db as never);

    expect(result.failedBuilding).toBe(1);
    expect(result.submittedToReconcile.map(j => j.ID)).toEqual([inChain]);
    const failed = (await getJobById(db as never, interrupted))!;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe(JOB_ERROR_CODES.PROCESS_RESTART);
    // The submitted job is NOT failed — the chain decides.
    expect((await getJobById(db as never, inChain))!.status).toBe('submitted');
  });
});

describe('job-store: per-wallet lease', () => {
  async function seedWallet(db: ReturnType<typeof makeStore>) {
    await upsertWalletRegistration(db as never, {
      walletId: 'w1', signerType: 'software', address: 'addr_test1x', publicKeyHash: 'f'.repeat(56),
    });
  }

  it('acquires a free lease and blocks a second owner until expiry', async () => {
    const db = makeStore();
    await seedWallet(db);

    expect(await tryAcquireWalletLease(db as never, 'w1', 'owner-A')).toBe(true);
    expect(await tryAcquireWalletLease(db as never, 'w1', 'owner-B')).toBe(false);

    // After TTL expiry the lease is up for grabs.
    const past = new Date(Date.now() + 60_000);
    expect(await tryAcquireWalletLease(db as never, 'w1', 'owner-B', past)).toBe(true);
  });

  it('renew succeeds for the owner only; release never clears a successor', async () => {
    const db = makeStore();
    await seedWallet(db);
    await tryAcquireWalletLease(db as never, 'w1', 'owner-A');

    expect(await renewWalletLease(db as never, 'w1', 'owner-B')).toBe(false);
    expect(await renewWalletLease(db as never, 'w1', 'owner-A')).toBe(true);

    await releaseWalletLease(db as never, 'w1', 'owner-B'); // no-op
    expect((await readWallet(db as never, 'w1'))!.leaseOwner).toBe('owner-A');
    await releaseWalletLease(db as never, 'w1', 'owner-A');
    expect((await readWallet(db as never, 'w1'))!.leaseOwner).toBeNull();
  });

  it('refuses a lease on a disabled wallet', async () => {
    const db = makeStore();
    await seedWallet(db);
    db.tables.get(WALLETS)![0].enabled = false;
    expect(await tryAcquireWalletLease(db as never, 'w1', 'owner-A')).toBe(false);
  });

  it('bumpWalletStats increments the matching counter', async () => {
    const db = makeStore();
    await seedWallet(db);
    await bumpWalletStats(db as never, 'w1', 'confirmed');
    await bumpWalletStats(db as never, 'w1', 'confirmed');
    await bumpWalletStats(db as never, 'w1', 'failed');
    const wallet = (await readWallet(db as never, 'w1'))!;
    expect(wallet.jobsConfirmed).toBe(2);
    expect(wallet.jobsFailed).toBe(1);
  });
});

describe('job-store: findSubmittedJobs', () => {
  it('returns only submitted rows', async () => {
    const db = makeStore();
    const { jobId } = await insertJob(db as never, { walletId: 'w1', kind: 'simpleAda', request: '{}' });
    await insertJob(db as never, { walletId: 'w2', kind: 'mint', request: '{}' });
    await markBuilding(db as never, jobId, 1);
    await markSubmitted(db as never, jobId, { txHash: 'a'.repeat(64), unsignedTxCbor: null, signedTxCbor: 'ff', fee: null });

    const submitted = await findSubmittedJobs(db as never);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].ID).toBe(jobId);
  });
});
