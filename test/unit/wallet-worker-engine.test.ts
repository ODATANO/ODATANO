/**
 * Wallet worker — engine (W3/W6).
 * Drives executeJob/tick against the stateful in-memory CQL fake with mocked
 * client/indexer/signer. Covers: happy path, per-wallet serialization (a
 * submitted job blocks the queue until confirmation), transient retry with
 * backoff, deterministic terminal failure, "already known" submit tolerance,
 * and the durable pre-submit state (`submitting`) with its chain reconciliation.
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
  insertJob, getJobById, upsertWalletRegistration, tryAcquireWalletLease, releaseWalletLease,
  markBuilding, markSubmitting,
  JOB_ERROR_CODES, WORKER_LEASE_TTL_MS,
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
  // executeJob fences on a held lease (renewWalletLease before build) — tests
  // driving executeJob directly must hold it, like the dispatch path would.
  await tryAcquireWalletLease(db, 'w1', 'test-instance');
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

  it('persists the signed tx BEFORE submitting, so a crash mid-submit is recoverable', async () => {
    const deps = makeDeps();
    // The row must already carry the signed CBOR + hash when submit is called.
    let rowAtSubmit: WalletJobRow | null = null;
    const worker = makeWorker(deps);
    const job = await seedJob();
    deps.client.submitTransaction.mockImplementation(async () => {
      rowAtSubmit = await getJobById(db, job.ID);
      return TX_HASH;
    });

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    expect(rowAtSubmit).toMatchObject({
      status: 'submitting',
      txHash: MOCK_TX_HASH, // derived from the signed bytes, not from the response
      signedTxCbor: 'beef',
      unsignedTxCbor: 'dead',
    });
    expect((rowAtSubmit as unknown as WalletJobRow).submittedAt).toBeTruthy();
  });

  it('a failed submit leaves the job submitting (never re-queued, never failed)', async () => {
    const deps = makeDeps();
    deps.client.submitTransaction.mockRejectedValue(new ProviderUnavailableError('submit timed out', 'ogmios'));
    const worker = makeWorker(deps);
    const job = await seedJob();

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    const row = (await getJobById(db, job.ID))!;
    // Rebuilding this request would risk a second payment — the stored tx stays.
    expect(row.status).toBe('submitting');
    expect(row.signedTxCbor).toBe('beef');
    expect(row.txHash).toBe(MOCK_TX_HASH);
    expect(worker.getStatusSummary().awaitingConfirmation).toBe(0);
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

describe('engine: wallet lease fencing during execution', () => {
  const WALLETS_TABLE = 'odatano.cardano.CardanoWorkerWallets';

  /** Another instance takes the wallet over, as it may once the lease has expired. */
  function stealLease(owner = 'other-instance'): void {
    const wallet = tables.get(WALLETS_TABLE)!.find(w => w.walletId === 'w1')!;
    wallet.leaseOwner = owner;
    wallet.leaseUntil = new Date(Date.now() + 60_000).toISOString();
  }

  it('does NOT submit when the lease is lost while signing', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedJob();
    // Signing is the last step before the submit fence — lose the wallet there.
    deps.signer.signTransaction.mockImplementation(() => { stealLease(); return 'beef'; });

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
    const row = (await getJobById(db, job.ID))!;
    // Still pre-submit: the takeover's orphan cleanup fails it, the caller retries.
    expect(row.status).toBe('building');
    expect(row.signedTxCbor).toBeNull();
    // …and the stale executor did not clear the new owner's lease on the way out.
    expect(tables.get(WALLETS_TABLE)!.find(w => w.walletId === 'w1')!.leaseOwner).toBe('other-instance');
  });

  it('does not build at all when the lease is already gone', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedJob();
    stealLease();

    await (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> }).executeJob(job, deps.signer);

    expect(deps.indexer.indexSimpleBuildResult).not.toHaveBeenCalled();
    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
  });

  it('keeps the lease alive across a build that outlasts the TTL', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      let finishBuild!: () => void;
      deps.indexer.indexSimpleBuildResult.mockImplementation(() => new Promise((resolve) => {
        finishBuild = () => resolve({ id: 'build-1', unsignedTxCbor: 'dead', txBodyHash: 'e'.repeat(64), fee: '170000' });
      }));
      const worker = makeWorker(deps);
      const job = await seedJob();

      const execution = (worker as unknown as { executeJob: (j: WalletJobRow, s: unknown) => Promise<void> })
        .executeJob(job, deps.signer);

      // Twice the raw lease TTL passes while the build is still in flight.
      await vi.advanceTimersByTimeAsync(WORKER_LEASE_TTL_MS * 2);
      const wallet = tables.get(WALLETS_TABLE)!.find(w => w.walletId === 'w1')!;
      expect(wallet.leaseOwner).toBe('test-instance');
      expect(Date.parse(String(wallet.leaseUntil))).toBeGreaterThan(Date.now());

      finishBuild();
      await execution;
      expect((await getJobById(db, job.ID))!.status).toBe('submitted');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('engine: reconciling an interrupted submit', () => {
  async function seedInterruptedSubmit(): Promise<WalletJobRow> {
    const job = await seedJob();
    await markBuilding(db, job.ID, 1);
    await markSubmitting(db, job.ID, {
      txHash: MOCK_TX_HASH, unsignedTxCbor: 'dead', signedTxCbor: 'beef', fee: '170000',
    });
    await releaseWalletLease(db, 'w1', 'test-instance'); // executor died
    return (await getJobById(db, job.ID))!;
  }

  const reconcile = (worker: CardanoWalletWorker, job: WalletJobRow) =>
    (worker as unknown as { reconcileSubmitting: (j: WalletJobRow) => Promise<void> }).reconcileSubmitting(job);

  it('re-submits the stored CBOR verbatim and promotes the job to submitted', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();

    await reconcile(worker, job);

    expect(deps.client.submitTransaction).toHaveBeenCalledWith('beef'); // no rebuild
    expect(deps.indexer.indexSimpleBuildResult).not.toHaveBeenCalled();
    expect((await getJobById(db, job.ID))!.status).toBe('submitted');
    expect(worker.getStatusSummary().awaitingConfirmation).toBe(1);
  });

  it('treats "already known" as proof the original submit landed', async () => {
    const deps = makeDeps();
    deps.client.submitTransaction.mockRejectedValue(new TransactionAlreadySubmittedError(MOCK_TX_HASH));
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();

    await reconcile(worker, job);

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('submitted');
    expect(row.txHash).toBe(MOCK_TX_HASH);
  });

  it('adopts the job when the chain has the tx even though the re-submit was rejected', async () => {
    const deps = makeDeps();
    // Inputs already spent — by our own transaction, which is on-chain.
    deps.client.submitTransaction.mockRejectedValue(new TransactionValidationError('BadInputsUTxO', undefined));
    deps.client.getTransaction.mockResolvedValue({ hash: MOCK_TX_HASH, blockHeight: 42, slot: 100 });
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();

    await reconcile(worker, job);

    expect((await getJobById(db, job.ID))!.status).toBe('submitted');
    expect(worker.getStatusSummary().awaitingConfirmation).toBe(1);
  });

  it('keeps the job submitting while the failure is transient and the tx is absent', async () => {
    const deps = makeDeps();
    deps.client.submitTransaction.mockRejectedValue(new ProviderUnavailableError('node down', 'ogmios'));
    deps.client.getTransaction.mockRejectedValue(new NotFoundError('Transaction', 'koios'));
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();

    await reconcile(worker, job);

    expect((await getJobById(db, job.ID))!.status).toBe('submitting');
  });

  it('fails only once the chain proves absence and the tx is permanently rejected', async () => {
    const deps = makeDeps();
    deps.client.submitTransaction.mockRejectedValue(new TransactionValidationError('ValueNotConserved', undefined));
    deps.client.getTransaction.mockRejectedValue(new NotFoundError('Transaction', 'koios'));
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();

    await reconcile(worker, job);

    const row = (await getJobById(db, job.ID))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe(JOB_ERROR_CODES.SUBMIT_REJECTED);
    expect(Number(tables.get('odatano.cardano.CardanoWorkerWallets')![0].jobsFailed)).toBe(1);
  });

  it('a tick picks up an orphaned submitting row even with no pending jobs', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();

    await (worker as unknown as { tick: () => Promise<void> }).tick();
    await Promise.allSettled([...(worker as unknown as { executionPromises: Set<Promise<void>> }).executionPromises]);

    expect(deps.client.submitTransaction).toHaveBeenCalledWith('beef');
    expect((await getJobById(db, job.ID))!.status).toBe('submitted');
  });

  it('leaves the row alone while another live executor holds the wallet lease', async () => {
    const deps = makeDeps();
    const worker = makeWorker(deps);
    const job = await seedInterruptedSubmit();
    await tryAcquireWalletLease(db, 'w1', 'other-instance');

    await (worker as unknown as { tick: () => Promise<void> }).tick();
    await Promise.allSettled([...(worker as unknown as { executionPromises: Set<Promise<void>> }).executionPromises]);

    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
    expect((await getJobById(db, job.ID))!.status).toBe('submitting');
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
    const { jobId: w2Job } = await insertJob(db, { walletId: 'w2', kind: 'simpleAda', request: '{"recipientAddress":"addr_test1_r","lovelaceAmount":"1000000"}' });
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
