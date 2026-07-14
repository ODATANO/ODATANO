/**
 * Wallet worker — engine (W3/W6).
 * Drives executeJob/tick against the stateful in-memory CQL fake with mocked
 * client/indexer/signer. Covers: happy path, per-wallet serialization (a
 * submitted job blocks the queue until confirmation), transient retry with
 * backoff, deterministic terminal failure, and "already known" submit tolerance.
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
    run: async (raw: { _op: string; entity: string; where?: Record<string, unknown>; set?: Record<string, unknown>; entries?: unknown; orderBy?: unknown[]; _q?: never }) => {
      // SELECT chains carry their data under `_q`; INSERT/UPDATE are flat.
      const q = ((raw as { _q?: typeof raw })._q ?? raw) as typeof raw;
      const rows = tableOf(q.entity);
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

const MOCK_TX_HASH = 'c'.repeat(64);
vi.mock('../../srv/utils/tx-build-helper', () => ({
  getTxHashFromCbor: vi.fn(() => 'c'.repeat(64)),
}));

import cds from '@sap/cds';
import {
  CardanoWalletWorker,
  isTransientJobError,
  retryBackoffMs,
  type WalletWorkerConfig,
} from '../../srv/blockchain/wallet-worker/wallet-worker';
import {
  insertJob, getJobById, upsertWalletRegistration,
  JOB_ERROR_CODES,
  type WalletJobRow,
} from '../../srv/blockchain/wallet-worker/job-store';
import {
  ProviderUnavailableError,
  RateLimitError,
  AllBackendsFailedError,
  HsmError,
  TransactionValidationError,
  InsufficientFundsError,
  TransactionAlreadySubmittedError,
  NotFoundError,
} from '../../srv/utils/errors';

const db = (cds as unknown as { __db: unknown }).__db as never;
const tables = (cds as unknown as { __tables: Map<string, Record<string, unknown>[]> }).__tables;

const TX_HASH = 'b'.repeat(64);

const CONFIG: WalletWorkerConfig = {
  enabled: true,
  wallets: [{ walletId: 'w1', signerType: 'software', keyEnv: 'X' }],
  maxConcurrentWallets: 4,
  confirmationDepth: 3,
  confirmationTimeoutMs: 600_000,
  pollIntervalMs: 60_000,
  defaultMaxAttempts: 3,
  resubmitOnRollback: true,
};

function makeDeps() {
  const client = {
    submitTransaction: vi.fn().mockResolvedValue(TX_HASH),
    getTransaction: vi.fn(),
    getLatestBlock: vi.fn(),
  };
  const indexer = {
    indexSimpleBuildResult: vi.fn().mockResolvedValue({
      id: 'build-1', unsignedTxCbor: 'dead', txBodyHash: 'e'.repeat(64), fee: '170000',
    }),
    indexMintBuildResult: vi.fn(),
    indexMetadataBuildResult: vi.fn(),
    indexMultiAssetBuildResult: vi.fn(),
    indexPlutusSpendBuildResult: vi.fn(),
    persistTransactionSubmission: vi.fn().mockResolvedValue({}),
  };
  const signer = {
    type: 'software' as const,
    getAddress: vi.fn(() => 'addr_test1_worker'),
    getPublicKeyHash: vi.fn(() => 'f'.repeat(56)),
    signTransaction: vi.fn(() => 'beef'),
  };
  return { client, indexer, signer };
}

function makeWorker(deps: ReturnType<typeof makeDeps>, config: WalletWorkerConfig = CONFIG) {
  const worker = new CardanoWalletWorker({
    client: deps.client as never,
    indexer: deps.indexer as never,
    network: 'preview',
    config,
    instanceId: 'test-instance',
  });
  (worker as unknown as { signers: Map<string, unknown> }).signers.set('w1', deps.signer);
  (worker as unknown as { running: boolean }).running = true; // dispatch without timers
  return worker;
}

async function seedJob(kind = 'simpleAda', request = '{"recipientAddress":"addr_test1_r","lovelaceAmount":"1000000"}'): Promise<WalletJobRow> {
  await upsertWalletRegistration(db, { walletId: 'w1', signerType: 'software', address: 'addr_test1_worker', publicKeyHash: 'f'.repeat(56) });
  const { jobId } = await insertJob(db, { walletId: 'w1', kind: kind as never, request });
  return (await getJobById(db, jobId))!;
}

afterEach(() => {
  tables.clear();
  vi.clearAllMocks();
});

describe('engine: retry classification', () => {
  it('classifies provider/rate-limit/HSM errors as transient', () => {
    expect(isTransientJobError(new ProviderUnavailableError('down', 'koios'))).toBe(true);
    expect(isTransientJobError(new RateLimitError('slow down', 'koios'))).toBe(true);
    expect(isTransientJobError(new AllBackendsFailedError([], undefined))).toBe(true);
    expect(isTransientJobError(new HsmError('hsm gone'))).toBe(true);
  });

  it('classifies deterministic rejections as terminal', () => {
    expect(isTransientJobError(new TransactionValidationError('bad tx', undefined))).toBe(false);
    expect(isTransientJobError(new InsufficientFundsError('lovelace', 0n, 0n))).toBe(false);
    expect(isTransientJobError(new NotFoundError('Utxo', 'koios'))).toBe(false);
    expect(isTransientJobError(new Error('random'))).toBe(false);
  });

  it('backs off exponentially with a 60s cap', () => {
    expect(retryBackoffMs(1)).toBe(5_000);
    expect(retryBackoffMs(2)).toBe(10_000);
    expect(retryBackoffMs(3)).toBe(20_000);
    expect(retryBackoffMs(10)).toBe(60_000);
  });
});

describe('engine: executeJob', () => {
  it('happy path: builds with the wallet as sender, signs, submits, transitions to submitted', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedJob();

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    // sender/change forced to the wallet address
    const buildReq = deps.indexer.indexSimpleBuildResult.mock.calls[0][1];
    expect(buildReq.senderAddress).toBe('addr_test1_worker');
    expect(buildReq.changeAddress).toBe('addr_test1_worker');
    expect(buildReq.network).toBe('preview');

    expect(deps.signer.signTransaction).toHaveBeenCalledWith('dead', 'e'.repeat(64));
    expect(deps.client.submitTransaction).toHaveBeenCalledWith('beef');
    expect(deps.indexer.persistTransactionSubmission).toHaveBeenCalled();

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('submitted');
    expect(row.txHash).toBe(TX_HASH);
    expect(row.signedTxCbor).toBe('beef');
    expect(row.attempt).toBe(1);
    expect(worker.getStatusSummary().awaitingConfirmation).toBe(1);
  });

  it('transient failure re-queues with future notBefore and keeps attempts bounded', async () => {
    const deps = makeDeps();
    deps.indexer.indexSimpleBuildResult.mockRejectedValue(new ProviderUnavailableError('backend down', 'koios'));
    const worker = makeWorker(deps);
    const job = await seedJob();

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(1);
    expect(Date.parse(row.notBefore!)).toBeGreaterThan(Date.now());
    expect(row.errorMessage).toContain('backend down');
  });

  it('exhausted transient retries fail as RETRIES_EXHAUSTED', async () => {
    const deps = makeDeps();
    deps.indexer.indexSimpleBuildResult.mockRejectedValue(new ProviderUnavailableError('still down', 'koios'));
    const worker = makeWorker(deps);
    const seeded = await seedJob();
    // Simulate two prior attempts: maxAttempts 3, this execution is attempt 3.
    tables.get('odatano.cardano.CardanoWalletJobs')![0].attempt = 2;
    const job = (await getJobById(db, seeded.ID))!;

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe(JOB_ERROR_CODES.RETRIES_EXHAUSTED);
  });

  it('deterministic rejection fails immediately with the backend error code', async () => {
    const deps = makeDeps();
    deps.indexer.indexSimpleBuildResult.mockRejectedValue(new InsufficientFundsError('lovelace', 0n, 0n));
    const worker = makeWorker(deps);
    const job = await seedJob();

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(1);
    // wallet stats bumped on terminal failure
    const wallet = tables.get('odatano.cardano.CardanoWorkerWallets')![0];
    expect(Number(wallet.jobsFailed)).toBe(1);
  });

  it('treats "already submitted" as success (crash-retry idempotency)', async () => {
    const deps = makeDeps();
    deps.client.submitTransaction.mockRejectedValue(new TransactionAlreadySubmittedError(TX_HASH));
    const worker = makeWorker(deps);
    const job = await seedJob();

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('submitted');
    expect(row.txHash).toBe(MOCK_TX_HASH); // derived from the signed CBOR
  });

  it('submitSigned submits the provided CBOR without building or signing', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedJob('submitSigned', JSON.stringify({ signedTxCbor: 'f00d' }));

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    expect(deps.indexer.indexSimpleBuildResult).not.toHaveBeenCalled();
    expect(deps.signer.signTransaction).not.toHaveBeenCalled();
    expect(deps.client.submitTransaction).toHaveBeenCalledWith('f00d');
    expect((await getJobById(db, job.ID))!.status).toBe('submitted');
  });
});

describe('engine: per-wallet serialization (design §6)', () => {
  async function runTick(worker: CardanoWalletWorker): Promise<void> {
    await (worker as unknown as { tick: () => Promise<void> }).tick();
    await Promise.allSettled([...(worker as unknown as { executionPromises: Set<Promise<void>> }).executionPromises]);
  }

  it('a submitted job blocks the wallet queue until confirmation', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    await seedJob(); // job 1
    const { jobId: secondId } = await insertJob(db, { walletId: 'w1', kind: 'simpleAda', request: '{}' });

    await runTick(worker);

    // Job 1 submitted, job 2 untouched.
    expect(deps.client.submitTransaction).toHaveBeenCalledTimes(1);
    expect((await getJobById(db, secondId))!.status).toBe('pending');

    // Second tick: wallet still has an active (submitted) job → nothing dispatches.
    await runTick(worker);
    expect(deps.client.submitTransaction).toHaveBeenCalledTimes(1);
    expect((await getJobById(db, secondId))!.status).toBe('pending');
  });

  it('different wallets execute independently', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    await seedJob(); // w1
    await upsertWalletRegistration(db, { walletId: 'w2', signerType: 'software', address: 'addr_test1_w2', publicKeyHash: 'e'.repeat(56) });
    const { jobId: w2Job } = await insertJob(db, { walletId: 'w2', kind: 'simpleAda', request: '{}' });
    (worker as unknown as { signers: Map<string, unknown> }).signers.set('w2', deps.signer);

    await runTick(worker);

    expect((await getJobById(db, w2Job))!.status).toBe('submitted');
    expect(deps.client.submitTransaction).toHaveBeenCalledTimes(2);
  });

  it('skips wallets this instance has no signer for', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    await upsertWalletRegistration(db, { walletId: 'foreign', signerType: 'hsm', address: 'addr_test1_f', publicKeyHash: 'd'.repeat(56) });
    const { jobId } = await insertJob(db, { walletId: 'foreign', kind: 'simpleAda', request: '{}' });

    await runTick(worker);

    expect((await getJobById(db, jobId))!.status).toBe('pending');
    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
  });
});
