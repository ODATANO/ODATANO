/**
 * Wallet worker — confirmation tracker (W4/W6).
 * Real crawler hooks + real job-store against a stateful in-memory CQL fake;
 * fake CardanoClient. Covers: hook-path confirmation at depth, reorg
 * invalidation + same-CBOR re-submit, polling discovery and TX_DROPPED timeout.
 */

vi.mock('@sap/cds', () => {
  // Query data lives under _q so the chaining METHODS (where/orderBy/columns)
  // can't clobber the captured where/orderBy DATA of the same name — the
  // original flat shape silently matched every row.
  const chain = (data: Record<string, unknown>) => ({
    _q: data,
    where: (w: unknown) => chain({ ...data, where: w }),
    orderBy: (...o: unknown[]) => chain({ ...data, orderBy: o }),
    columns: (...c: unknown[]) => chain({ ...data, columns: c }),
  });
  const tables = new Map<string, Record<string, unknown>[]>();
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const matches = (row: Record<string, unknown>, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'in' in (v as Record<string, unknown>)) {
        return ((v as { in: unknown[] }).in).includes(row[k]);
      }
      return row[k] === v || (v === null && (row[k] === null || row[k] === undefined));
    });
  };
  const db = {
    run: async (raw: { _op: string; entity: string; where?: Record<string, unknown>; set?: Record<string, unknown>; entries?: unknown; _q?: never }) => {
      // SELECT chains carry their data under `_q`; INSERT/UPDATE are flat.
      const q = ((raw as { _q?: typeof raw })._q ?? raw) as typeof raw;
      const rows = tableOf(q.entity);
      switch (q._op) {
        case 'SELECT.one': {
          const found = rows.filter(r => matches(r, q.where));
          return found.length ? { ...found[found.length - 1] } : undefined;
        }
        case 'SELECT':
          return rows.filter(r => matches(r, q.where)).map(r => ({ ...r }));
        case 'INSERT': {
          const entries = Array.isArray(q.entries) ? q.entries : [q.entries];
          rows.push(...(entries as Record<string, unknown>[]).map(e => ({ ...e })));
          return entries.length;
        }
        case 'UPDATE': {
          let n = 0;
          for (const row of rows) if (matches(row, q.where)) { Object.assign(row, q.set); n++; }
          return n;
        }
        default: throw new Error(`Unsupported op ${q._op}`);
      }
    },
  };
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
    tx: (fn: (tx: unknown) => unknown) => fn(db),
    _with: (_store: undefined, fn: () => unknown) => fn(),
    __db: db,
    __tables: tables,
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  CardanoWalletJobs: 'odatano.cardano.CardanoWalletJobs',
  CardanoWorkerWallets: 'odatano.cardano.CardanoWorkerWallets',
}));

import cds from '@sap/cds';
import { ConfirmationTracker } from '../../srv/blockchain/wallet-worker/confirmation-tracker';
import { emitBlockIndexed, emitReorg } from '../../srv/blockchain/crawler/hooks';
import {
  insertJob, markBuilding, markSubmitting, markSubmitted, getJobById, upsertWalletRegistration,
  JOB_ERROR_CODES,
} from '../../srv/blockchain/wallet-worker/job-store';
import { NotFoundError, TransactionAlreadySubmittedError } from '../../srv/utils/errors';

const db = (cds as unknown as { __db: unknown }).__db as never;
const tables = (cds as unknown as { __tables: Map<string, Record<string, unknown>[]> }).__tables;

const flush = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };

const TX_HASH = 'a'.repeat(64);

function makeClient() {
  return {
    getTransaction: vi.fn(),
    getLatestBlock: vi.fn(),
    submitTransaction: vi.fn(),
  };
}

async function seedSubmittedJob(walletId = 'w1', txHash = TX_HASH, signedTxCbor = 'cafe01'): Promise<string> {
  await upsertWalletRegistration(db, { walletId, signerType: 'software', address: 'addr_test1x', publicKeyHash: 'f'.repeat(56) });
  const { jobId } = await insertJob(db, { walletId, kind: 'simpleAda', request: '{}' });
  await markBuilding(db, jobId, 1);
  await markSubmitting(db, jobId, { txHash, unsignedTxCbor: 'dead', signedTxCbor, fee: '170000' });
  await markSubmitted(db, jobId, txHash);
  return jobId;
}

function makeTracker(client: ReturnType<typeof makeClient>, options: Partial<{ confirmationDepth: number; confirmationTimeoutMs: number; resubmitOnRollback: boolean }> = {}) {
  const onFinal = vi.fn();
  const tracker = new ConfirmationTracker({
    client: client as never,
    options: {
      confirmationDepth: options.confirmationDepth ?? 3,
      confirmationTimeoutMs: options.confirmationTimeoutMs ?? 600_000,
      pollIntervalMs: 60_000,
      resubmitOnRollback: options.resubmitOnRollback ?? true,
    },
    onFinal,
  });
  return { tracker, onFinal };
}

afterEach(() => {
  tables.clear();
});

describe('ConfirmationTracker: crawler hook path', () => {
  it('records the inclusion block and confirms once the tip is deep enough', async () => {
    const client = makeClient();
    const { tracker, onFinal } = makeTracker(client, { confirmationDepth: 3 });
    const jobId = await seedSubmittedJob();
    tracker.start();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: 'cafe01' });

    // Inclusion block at height 100, tip 100 → 1 confirmation, not enough for depth 3.
    emitBlockIndexed({ hash: 'b1', slot: 500, height: 100, txHashes: [TX_HASH], tipSlot: 500, tipHeight: 100 });
    await flush();
    expect((await getJobById(db, jobId))!.status).toBe('submitted');
    expect((await getJobById(db, jobId))!.confirmedHeight).toBe(100);

    // Two more blocks → tip 102 → 3 confirmations → confirmed.
    emitBlockIndexed({ hash: 'b2', slot: 510, height: 101, txHashes: [], tipSlot: 510, tipHeight: 101 });
    emitBlockIndexed({ hash: 'b3', slot: 520, height: 102, txHashes: [], tipSlot: 520, tipHeight: 102 });
    await flush();

    const job = (await getJobById(db, jobId))!;
    expect(job.status).toBe('confirmed');
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      jobId, walletId: 'w1', outcome: 'confirmed', txHash: TX_HASH,
    }));
    expect(tracker.size()).toBe(0);

    // Wallet stats bumped
    const wallet = tables.get('odatano.cardano.CardanoWorkerWallets')![0];
    expect(Number(wallet.jobsConfirmed)).toBe(1);
    tracker.stop();
  });

  it('depth 1 confirms immediately on inclusion', async () => {
    const client = makeClient();
    const { tracker, onFinal } = makeTracker(client, { confirmationDepth: 1 });
    const jobId = await seedSubmittedJob();
    tracker.start();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: null });

    emitBlockIndexed({ hash: 'b1', slot: 500, height: 100, txHashes: [TX_HASH], tipSlot: 500, tipHeight: 100 });
    await flush();

    expect((await getJobById(db, jobId))!.status).toBe('confirmed');
    expect(onFinal).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it('a reorg past the inclusion point clears it and re-submits the SAME signed CBOR', async () => {
    const client = makeClient();
    client.submitTransaction.mockResolvedValue(TX_HASH);
    const { tracker } = makeTracker(client, { confirmationDepth: 3 });
    const jobId = await seedSubmittedJob('w1', TX_HASH, 'cafe01');
    tracker.start();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: 'cafe01' });

    emitBlockIndexed({ hash: 'b1', slot: 500, height: 100, txHashes: [TX_HASH], tipSlot: 500, tipHeight: 100 });
    await flush();
    expect((await getJobById(db, jobId))!.confirmedSlot).toBe(500);

    emitReorg({ forkSlot: 400, forkHeight: 80 });
    await flush();

    const job = (await getJobById(db, jobId))!;
    expect(job.status).toBe('submitted');
    expect(job.confirmedSlot).toBeNull();
    expect(client.submitTransaction).toHaveBeenCalledWith('cafe01');
    expect(tracker.size()).toBe(1); // still watching
    tracker.stop();
  });

  it('an "already known" answer on rollback re-submit is success, not an error', async () => {
    const client = makeClient();
    client.submitTransaction.mockRejectedValue(new TransactionAlreadySubmittedError(TX_HASH));
    const { tracker } = makeTracker(client);
    const jobId = await seedSubmittedJob();
    tracker.start();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: 'cafe01' });
    emitBlockIndexed({ hash: 'b1', slot: 500, height: 100, txHashes: [TX_HASH], tipSlot: 500, tipHeight: 100 });
    await flush();

    emitReorg({ forkSlot: 400, forkHeight: 80 });
    await flush();

    expect((await getJobById(db, jobId))!.status).toBe('submitted'); // keeps watching, no crash
    tracker.stop();
  });

  it('a reorg BEFORE the inclusion point leaves the confirmation intact', async () => {
    const client = makeClient();
    const { tracker } = makeTracker(client, { confirmationDepth: 3 });
    const jobId = await seedSubmittedJob();
    tracker.start();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: 'cafe01' });
    emitBlockIndexed({ hash: 'b1', slot: 500, height: 100, txHashes: [TX_HASH], tipSlot: 500, tipHeight: 100 });
    await flush();

    emitReorg({ forkSlot: 600, forkHeight: 120 }); // fork after our slot — not affected
    await flush();

    expect((await getJobById(db, jobId))!.confirmedSlot).toBe(500);
    expect(client.submitTransaction).not.toHaveBeenCalled();
    tracker.stop();
  });
});

describe('ConfirmationTracker: polling path', () => {
  it('finds the tx via getTransaction and confirms at depth', async () => {
    const client = makeClient();
    client.getLatestBlock.mockResolvedValue({ height: 104, hash: 'tip', slot: 999 });
    client.getTransaction.mockResolvedValue({ hash: TX_HASH, slot: 500, blockHeight: 100 });
    const { tracker, onFinal } = makeTracker(client, { confirmationDepth: 3 });
    const jobId = await seedSubmittedJob();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: null });
    (tracker as unknown as { running: boolean }).running = true; // poll without timers

    await tracker.pollOnce();

    const job = (await getJobById(db, jobId))!;
    expect(job.status).toBe('confirmed');
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      jobId, walletId: 'w1', outcome: 'confirmed', txHash: TX_HASH,
    }));
  });

  it('fails a tx unseen past the confirmation timeout as TX_DROPPED', async () => {
    const client = makeClient();
    client.getLatestBlock.mockResolvedValue({ height: 104, hash: 'tip', slot: 999 });
    client.getTransaction.mockRejectedValue(new NotFoundError('Transaction', 'test'));
    const { tracker, onFinal } = makeTracker(client, { confirmationTimeoutMs: 1_000 });
    const jobId = await seedSubmittedJob();
    tracker.track({
      jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: null,
      submittedAt: new Date(Date.now() - 60_000).toISOString(), // long past the timeout
    });
    (tracker as unknown as { running: boolean }).running = true;

    await tracker.pollOnce();

    const job = (await getJobById(db, jobId))!;
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe(JOB_ERROR_CODES.TX_DROPPED);
    // The failure payload carries what a jobFailed subscriber needs to act.
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      jobId, walletId: 'w1', outcome: 'failed', txHash: TX_HASH,
      errorCode: JOB_ERROR_CODES.TX_DROPPED,
      errorMessage: expect.stringContaining('not seen on-chain'),
    }));
  });

  it('keeps waiting while the tx is unseen but within the timeout', async () => {
    const client = makeClient();
    client.getLatestBlock.mockResolvedValue({ height: 104, hash: 'tip', slot: 999 });
    client.getTransaction.mockRejectedValue(new NotFoundError('Transaction', 'test'));
    const { tracker, onFinal } = makeTracker(client, { confirmationTimeoutMs: 600_000 });
    const jobId = await seedSubmittedJob();
    tracker.track({ jobId, walletId: 'w1', txHash: TX_HASH, signedTxCbor: null });
    (tracker as unknown as { running: boolean }).running = true;

    await tracker.pollOnce();

    expect((await getJobById(db, jobId))!.status).toBe('submitted');
    expect(onFinal).not.toHaveBeenCalled();
    expect(tracker.size()).toBe(1);
  });
});
