/**
 * submitAndFinalize and the reconciler: what a failed submit proves. A refusal of a transaction
 * that is not on chain ends as 'failed', no verdict leaves the record open, the chain overrules both.
 */
export {};

interface Query { op: string; entity: unknown; set?: Record<string, unknown>; where?: Record<string, unknown>; and?: unknown; columns?: unknown[] }

const { commits, onChain, respond, verifyOrThrow } = vi.hoisted(() => ({
  commits: [] as string[],
  onChain: vi.fn(),
  respond: vi.fn(),
  verifyOrThrow: vi.fn(),
}));

vi.mock('@sap/cds', () => {
  const make = (op: string, entity: unknown) => {
    const query: Query = { op, entity };
    const api = {
      query,
      set: (data: Record<string, unknown>) => { query.set = data; return api; },
      where: (cond: Record<string, unknown>) => { query.where = cond; return api; },
      and: (cond: unknown) => { query.and = cond; return api; },
      columns: (...cols: unknown[]) => { query.columns = cols; return api; },
    };
    return api;
  };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ql: {
      SELECT: { from: (e: unknown) => make('SELECT', e), one: { from: (e: unknown) => make('SELECT_ONE', e) } },
      UPDATE: { entity: (e: unknown) => make('UPDATE', e) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/tx-utils', () => ({
  detachedTx: async (label: string, fn: (db: unknown) => Promise<unknown>) => {
    const result = await fn({ run: async (q: { query: Query }) => respond(q.query) });
    commits.push(label);
    return result;
  },
  runWithoutAmbientTx: (fn: () => unknown) => fn(),
}));
vi.mock('../../srv/blockchain/signing/external-signer', () => ({ getExternalSignerModule: () => ({ verifyOrThrow }) }));
vi.mock('../../srv/blockchain/transaction-presence', () => ({ isTransactionOnChain: onChain }));
vi.mock('#cds-models/CardanoTransactionService', () => ({
  AddressTransactionBuilds: 'AddressTransactionBuilds', TransactionSubmissions: 'TransactionSubmissions',
}));
vi.mock('../../srv/utils/tx-build-helper', () => ({ extractTxCacheTargets: () => ({ spentInputs: [], outputAddresses: [] }) }));

import {
  RESUBMIT_WINDOW_MS, redriveInterruptedSubmissions, submitAndFinalize,
} from '../../srv/blockchain/signing/submission-finalizer';
import {
  ProviderUnavailableError, SubmitOutcomeUnknownError, TransactionAlreadySubmittedError, TransactionValidationError,
} from '../../srv/utils/errors';

const REQUESTS = 'odatano.cardano.SigningRequests';
const SUBMISSION = { id: 'sub-1', txHash: 'h', status: 'submitted' };
const VERIFICATION = { txBodyHash: 'h', witnessCount: 1, signerKeyHashes: ['k'], warnings: [] };
const params = { signingRequestId: 'req-1', buildId: 'b1', fullSignedTxCbor: 'beef', txHash: 'h', verificationResult: VERIFICATION };

function makeDeps(submit: () => Promise<string> = async () => 'h') {
  return {
    indexer: {
      indexVerifiedTransactionSubmission: vi.fn(async () => SUBMISSION),
      persistTransactionSubmission: vi.fn(),
      updateSubmissionStatus: vi.fn(async () => undefined),
      dropDuplicateSubmission: vi.fn(async () => false),
      invalidateUtxoCacheForTx: vi.fn(async () => undefined),
      findIndexedTransaction: vi.fn(async () => null),
    },
    client: { submitTransaction: vi.fn(submit), getTransaction: vi.fn(), supports: vi.fn(() => true) },
  };
}

/** Queries the fake db saw, by operation. */
function queries(op: string): Query[] {
  return respond.mock.calls.map(([q]) => q as Query).filter((q) => q.op === op);
}

const run = (deps: ReturnType<typeof makeDeps>, send = true) =>
  submitAndFinalize(REQUESTS, params, undefined, send, deps as never);

beforeEach(() => {
  commits.length = 0;
  onChain.mockReset();
  onChain.mockResolvedValue(false);
  verifyOrThrow.mockReset();
  verifyOrThrow.mockReturnValue(VERIFICATION);
  respond.mockReset();
  // every guarded UPDATE wins unless a test says otherwise
  respond.mockImplementation(async (q: Query) => (q.op === 'UPDATE' ? 1 : undefined));
});

describe('submitAndFinalize', () => {
  it('finalizes an accepted transaction once, guarded on the open status', async () => {
    const deps = makeDeps();

    await expect(run(deps)).resolves.toBe(SUBMISSION);

    expect(queries('UPDATE')).toEqual([expect.objectContaining({
      set: { status: 'submitted', errorMessage: null },
      where: { id: 'req-1', status: { in: ['submitting', 'failed'] } },
    })]);
    expect(deps.indexer.indexVerifiedTransactionSubmission).toHaveBeenCalledTimes(1);
    expect(onChain).not.toHaveBeenCalled();
  });

  it('returns the stored submission when another caller finalized first', async () => {
    const deps = makeDeps();
    respond.mockImplementation(async (q: Query) => {
      if (q.op === 'UPDATE') return 0;
      return q.entity === REQUESTS ? { submission_id: 'sub-1' } : SUBMISSION;
    });

    await expect(run(deps)).resolves.toBe(SUBMISSION);

    expect(deps.indexer.indexVerifiedTransactionSubmission).not.toHaveBeenCalled();
  });

  it('finalizes when the node already holds the transaction', async () => {
    const deps = makeDeps(async () => { throw new TransactionAlreadySubmittedError('h'); });

    await expect(run(deps)).resolves.toBe(SUBMISSION);

    expect(onChain).not.toHaveBeenCalled();
  });

  it('marks the request failed and rethrows when the node refused a transaction that is not on chain', async () => {
    const err = new TransactionValidationError('ValueNotConserved', undefined);
    const deps = makeDeps(async () => { throw err; });

    await expect(run(deps)).rejects.toBe(err);

    expect(queries('UPDATE')).toEqual([expect.objectContaining({
      set: { status: 'failed', errorMessage: 'ValueNotConserved' },
      where: { id: 'req-1', status: 'submitting' },
    })]);
    expect(deps.indexer.indexVerifiedTransactionSubmission).not.toHaveBeenCalled();
  });

  it('finalizes a refused transaction that is on chain', async () => {
    onChain.mockResolvedValue(true);
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(run(deps)).resolves.toBe(SUBMISSION);
  });

  it('writes nothing and answers 503 when the submit got no verdict', async () => {
    const deps = makeDeps(async () => { throw new ProviderUnavailableError('node down', 'ogmios'); });

    const thrown = await run(deps).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(SubmitOutcomeUnknownError);
    expect(thrown).toMatchObject({ statusCode: 503, code: 'ODATANO_SUBMIT_OUTCOME_UNKNOWN', txHash: 'h' });
    expect(respond).not.toHaveBeenCalled();
  });

  it('writes nothing when the node refused but the chain lookup failed', async () => {
    onChain.mockRejectedValue(new ProviderUnavailableError('lookup down', 'koios'));
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(run(deps)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);

    expect(respond).not.toHaveBeenCalled();
  });

  it('takes the refusal as final when no backend can look transactions up', async () => {
    onChain.mockResolvedValue(null);
    const err = new TransactionValidationError('ValueNotConserved', undefined);
    const deps = makeDeps(async () => { throw err; });

    await expect(run(deps)).rejects.toBe(err);

    expect(queries('UPDATE')[0].set).toMatchObject({ status: 'failed' });
  });

  describe('without sending', () => {
    it('fails a transaction that is not on chain and names the window', async () => {
      const deps = makeDeps();

      await expect(run(deps, false)).rejects.toThrow(`not on chain ${RESUBMIT_WINDOW_MS / 60_000} minutes after its submit`);

      expect(deps.client.submitTransaction).not.toHaveBeenCalled();
      expect(queries('UPDATE')[0].set).toMatchObject({ status: 'failed' });
    });

    it('finalizes a transaction that is on chain', async () => {
      onChain.mockResolvedValue(true);
      const deps = makeDeps();

      await expect(run(deps, false)).resolves.toBe(SUBMISSION);

      expect(deps.client.submitTransaction).not.toHaveBeenCalled();
    });

    it('stays open when the lookup fails', async () => {
      onChain.mockRejectedValue(new ProviderUnavailableError('lookup down', 'koios'));
      const deps = makeDeps();

      await expect(run(deps, false)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
    });

    it('sends all the same when no backend can look transactions up', async () => {
      onChain.mockResolvedValue(null);
      const deps = makeDeps();
      deps.client.supports.mockReturnValue(false);

      await expect(run(deps, false)).resolves.toBe(SUBMISSION);

      expect(deps.client.submitTransaction).toHaveBeenCalledWith('beef');
    });
  });
});

describe('redriveInterruptedSubmissions', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const request = (id: string, signedAt: string) => ({ id, build_id: 'b1', txBodyHash: 'h', signedTxCbor: 'beef', signedAt });

  function open(requests: unknown[], submissions: unknown[]) {
    respond.mockImplementation(async (q: Query) => {
      if (q.op === 'UPDATE') return 1;
      if (q.op === 'SELECT') return q.entity === REQUESTS ? requests : submissions;
      return undefined;
    });
  }

  it('selects open signing requests with a stored transaction and pending submissions', async () => {
    open([], []);

    await expect(redriveInterruptedSubmissions(makeDeps() as never)).resolves.toBe(0);

    expect(queries('SELECT')).toEqual([
      expect.objectContaining({ entity: REQUESTS, where: { status: 'submitting' }, and: 'signedTxCbor is not null' }),
      expect.objectContaining({ entity: 'TransactionSubmissions', where: { status: 'pending' } }),
    ]);
  });

  it('sends a young signing request again and finalizes it', async () => {
    open([request('req-young', minutesAgo(1))], []);
    const deps = makeDeps();

    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(1);

    expect(deps.client.submitTransaction).toHaveBeenCalledWith('beef');
    expect(deps.indexer.indexVerifiedTransactionSubmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signingRequestId: 'req-young' }));
  });

  it('only reads the chain for a signing request older than the window', async () => {
    open([request('req-old', minutesAgo(RESUBMIT_WINDOW_MS / 60_000 + 1))], []);
    const deps = makeDeps();

    await redriveInterruptedSubmissions(deps as never);

    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
    expect(queries('UPDATE')[0]).toMatchObject({ set: { status: 'failed' }, where: { id: 'req-old', status: 'submitting' } });
  });

  it('leaves a request open when its submit still gets no verdict', async () => {
    open([request('req-open', minutesAgo(1))], []);
    const deps = makeDeps(async () => { throw new ProviderUnavailableError('node down', 'ogmios'); });

    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(1);

    expect(queries('UPDATE')).toEqual([]);
  });

  it('reports a request whose stored transaction no longer verifies once and skips it afterwards', async () => {
    open([request('req-broken', minutesAgo(1))], []);
    verifyOrThrow.mockImplementation(() => { throw new Error('bad witness'); });
    const deps = makeDeps();

    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(0);
    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(0);

    expect(verifyOrThrow).toHaveBeenCalledTimes(1);
    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
  });

  it('skips a signing request this process is sending right now', async () => {
    let release!: (hash: string) => void;
    const sending = makeDeps(() => new Promise<string>((resolve) => { release = resolve; }));
    const inFlight = submitAndFinalize(REQUESTS, { ...params, signingRequestId: 'req-busy' }, undefined, true, sending as never);
    open([request('req-busy', minutesAgo(1))], []);
    const deps = makeDeps();

    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(0);
    expect(deps.client.submitTransaction).not.toHaveBeenCalled();

    release('h');
    await inFlight;
  });

  it('settles a pending submission: sent again while young, chain only when old', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    open([], [
      { id: 'sub-young', build_id: null, txHash: 'h1', signedTxCbor: 'aa', submittedAt: nowSeconds - 30 },
      { id: 'sub-old', build_id: null, txHash: 'h2', signedTxCbor: 'bb', submittedAt: String(nowSeconds - RESUBMIT_WINDOW_MS / 1000 - 60) },
    ]);
    const deps = makeDeps();

    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(2);

    expect(deps.client.submitTransaction).toHaveBeenCalledTimes(1);
    expect(deps.client.submitTransaction).toHaveBeenCalledWith('aa');
    expect(deps.indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 'sub-young', 'submitted');
    expect(deps.indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 'sub-old', 'failed', expect.stringContaining('not on chain'), 'pending');
  });
});
