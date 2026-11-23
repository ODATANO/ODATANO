/**
 * submitAndFinalize and the reconciler: what a failed submit proves. A refusal that holds for the
 * bytes ends as 'failed'. A refusal over spent inputs, no verdict or elapsed time keep the record
 * open until the chain proves the transaction can never land, or the horizon passes without proof:
 * then it is unresolved. The chain overrules all of them. Expired bytes are never sent.
 */
export {};

interface Query { op: string; entity: unknown; set?: Record<string, unknown>; where?: Record<string, unknown>; and?: unknown; columns?: unknown[] }

const { commits, onChain, respond, verifyOrThrow, facts, perCbor } = vi.hoisted(() => ({
  commits: [] as string[],
  onChain: vi.fn(),
  respond: vi.fn(),
  verifyOrThrow: vi.fn(),
  facts: { inputs: [{ txHash: 'in', outputIndex: 0 }], outputCount: 1, ttlSlot: 1000 as number | null, isValid: true, collateralInputs: [] as unknown[], hasCollateralReturn: false },
  perCbor: {} as Record<string, { ttlSlot: number | null }>,
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
vi.mock('../../srv/blockchain/transaction-presence', () => ({ findOnChain: onChain }));
vi.mock('#cds-models/CardanoTransactionService', () => ({
  AddressTransactionBuilds: 'AddressTransactionBuilds', TransactionSubmissions: 'TransactionSubmissions',
}));
vi.mock('../../srv/utils/tx-build-helper', () => ({ extractTxCacheTargets: (cbor: string) => ({ ...facts, ...perCbor[cbor], outputAddresses: [] }) }));

import {
  RESUBMIT_WINDOW_MS, redriveInterruptedSubmissions, submitAndFinalize,
} from '../../srv/blockchain/signing/submission-finalizer';
import { settleSlots } from '../../srv/blockchain/signing/landing-proof';
import { posixToSlot } from '../../srv/utils/epoch-slots';
import {
  ProviderUnavailableError, SubmitOutcomeUnknownError, TransactionAlreadySubmittedError, TransactionValidationError,
} from '../../srv/utils/errors';

const REQUESTS = 'odatano.cardano.SigningRequests';
const SUBMISSION = { id: 'sub-1', txHash: 'h', status: 'submitted' };
const VERIFICATION = { txBodyHash: 'h', witnessCount: 1, signerKeyHashes: ['k'], warnings: [] };
const params = { signingRequestId: 'req-1', buildId: 'b1', fullSignedTxCbor: 'beef', txHash: 'h', verificationResult: VERIFICATION };

/** The chain as the fake client reads it: tip slot and which outputs are unspent. */
const chain = { tip: 500, unspent: new Set<string>(['in#0']) };
const SETTLE = settleSlots('preview');
/** An expiry an hour ahead: the bytes may still be sent. */
const futureTtl = () => posixToSlot('preview', Date.now() + 3_600_000);
/** An expiry long gone by the wall clock; the tip decides how far past it the chain is. */
const OLD_TTL = 1000;
const onChainHit = { slot: 1, height: 1, scriptFailed: false };

function makeDeps(submit: () => Promise<string> = async () => 'h') {
  return {
    indexer: {
      indexVerifiedTransactionSubmission: vi.fn(async () => SUBMISSION),
      persistTransactionSubmission: vi.fn(),
      updateSubmissionStatus: vi.fn(async () => undefined),
      dropDuplicateSubmission: vi.fn(async () => false),
      invalidateUtxoCacheForTx: vi.fn(async () => undefined),
      findCrawledTransaction: vi.fn(async () => null),
    },
    client: {
      network: 'preview' as const,
      submitTransaction: vi.fn(submit), getTransaction: vi.fn(), supports: vi.fn(() => true),
      isUtxoUnspent: vi.fn(async (txHash: string, index: number) => chain.unspent.has(`${txHash}#${index}`)),
      readLedger: vi.fn(async (refs: Array<{ txHash: string; outputIndex: number }>) =>
        ({ live: true, tip: chain.tip, unspent: refs.map((r) => chain.unspent.has(`${r.txHash}#${r.outputIndex}`)) })),
    },
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
  chain.tip = 500;
  chain.unspent = new Set(['in#0']);
  Object.assign(facts, { inputs: [{ txHash: 'in', outputIndex: 0 }], outputCount: 1, ttlSlot: futureTtl(), validityStartSlot: null, isValid: true, collateralInputs: [], hasCollateralReturn: false });
  for (const key of Object.keys(perCbor)) delete perCbor[key];
  onChain.mockReset();
  onChain.mockResolvedValue(null);
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

  it('marks the request failed and rethrows when the node refused the transaction for a reason that holds for its bytes', async () => {
    const err = new TransactionValidationError('ConwayUtxowFailure (InvalidWitnessesUTXOW [...])', undefined);
    const deps = makeDeps(async () => { throw err; });

    await expect(run(deps)).rejects.toBe(err);

    expect(queries('UPDATE')).toEqual([expect.objectContaining({
      set: { status: 'failed', errorMessage: 'ConwayUtxowFailure (InvalidWitnessesUTXOW [...])' },
      where: { id: 'req-1', status: 'submitting' },
    })]);
    expect(deps.indexer.indexVerifiedTransactionSubmission).not.toHaveBeenCalled();
  });

  it('finalizes a refused transaction that is on chain', async () => {
    onChain.mockResolvedValue(onChainHit);
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

  it('keeps a refusal over spent inputs open while an input is unspent and the expiry is ahead', async () => {
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(run(deps)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);

    expect(respond).not.toHaveBeenCalled();
  });

  it('fails with a 400, without sending the expired bytes, once the tip is past the horizon and an input is unspent', async () => {
    facts.ttlSlot = OLD_TTL;
    chain.tip = OLD_TTL + SETTLE + 1;
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    const err = await run(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(err).toMatchObject({ statusCode: 400, message: expect.stringContaining('expired at slot 1000') });
    expect(deps.client.submitTransaction).not.toHaveBeenCalled();
    expect(queries('UPDATE')[0].set).toMatchObject({ status: 'failed' });
  });

  it('marks the request unresolved past the horizon when every input is spent and nothing shows by whom', async () => {
    facts.ttlSlot = OLD_TTL;
    chain.unspent.clear();
    chain.tip = 1_000_000;
    const deps = makeDeps();

    await expect(run(deps)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
    expect(queries('UPDATE')).toEqual([expect.objectContaining({
      set: expect.objectContaining({ status: 'unresolved' }),
      where: { id: 'req-1', status: 'submitting' },
    })]);
    expect(deps.indexer.indexVerifiedTransactionSubmission).not.toHaveBeenCalled();
  });

  it('fails the request with a 400 when the transaction landed with failing scripts', async () => {
    onChain.mockResolvedValue({ ...onChainHit, scriptFailed: true });
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    const err = await run(deps).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, message: expect.stringContaining('failing scripts') });
    expect(queries('UPDATE')[0].set).toMatchObject({ status: 'failed' });
    expect(deps.indexer.indexVerifiedTransactionSubmission).not.toHaveBeenCalled();
  });

  it('keeps a refusal over spent inputs open before the expiry', async () => {
    chain.unspent.clear();
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(run(deps)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
  });

  it('takes a validity-interval refusal as no verdict, before and after the start', async () => {
    const outside = () => makeDeps(async () => { throw new TransactionValidationError('OutsideValidityIntervalUTxO', undefined); });

    await expect(run(outside())).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
    chain.tip = 600;
    await expect(run(outside())).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
  });

  it('counts the transaction as landed when one of its own outputs is unspent', async () => {
    facts.ttlSlot = OLD_TTL;
    chain.tip = OLD_TTL + SETTLE + 1;
    chain.unspent = new Set(['h#0']);
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(run(deps)).resolves.toBe(SUBMISSION);
  });

  it('writes nothing when the node refused but the chain lookup failed', async () => {
    onChain.mockRejectedValue(new ProviderUnavailableError('lookup down', 'koios'));
    const deps = makeDeps(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(run(deps)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);

    expect(respond).not.toHaveBeenCalled();
  });

  it('takes the refusal as final when no backend can look transactions up', async () => {
    onChain.mockResolvedValue(undefined);
    const err = new TransactionValidationError('ConwayUtxowFailure (InvalidWitnessesUTXOW [...])', undefined);
    const deps = makeDeps(async () => { throw err; });

    await expect(run(deps)).rejects.toBe(err);

    expect(queries('UPDATE')[0].set).toMatchObject({ status: 'failed' });
  });

  describe('without sending', () => {
    it('keeps a transaction that is not on chain open while its expiry is ahead', async () => {
      const deps = makeDeps();

      await expect(run(deps, false)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);

      expect(deps.client.submitTransaction).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    });

    it('fails a transaction once the tip is past its expiry by the horizon and an input is still unspent', async () => {
      facts.ttlSlot = OLD_TTL;
      chain.tip = OLD_TTL + SETTLE + 1;
      const deps = makeDeps();

      await expect(run(deps, false)).rejects.toThrow('expired at slot 1000');

      expect(queries('UPDATE')[0].set).toMatchObject({ status: 'failed' });
    });

    it('never fails a transaction without an expiry by time', async () => {
      facts.ttlSlot = null;
      chain.tip = 10_000_000;
      const deps = makeDeps();

      await expect(run(deps, false)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
    });

    it('finalizes a transaction that is on chain', async () => {
      onChain.mockResolvedValue(onChainHit);
      const deps = makeDeps();

      await expect(run(deps, false)).resolves.toBe(SUBMISSION);

      expect(deps.client.submitTransaction).not.toHaveBeenCalled();
    });

    it('stays open when the lookup fails', async () => {
      onChain.mockRejectedValue(new ProviderUnavailableError('lookup down', 'koios'));
      const deps = makeDeps();

      await expect(run(deps, false)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
    });

    it('sends all the same when no backend can look transactions up, but never past the expiry', async () => {
      onChain.mockResolvedValue(undefined);
      const deps = makeDeps();
      deps.client.supports.mockReturnValue(false);

      await expect(run(deps, false)).resolves.toBe(SUBMISSION);

      expect(deps.client.submitTransaction).toHaveBeenCalledWith('beef');

      facts.ttlSlot = OLD_TTL;
      const expired = makeDeps();
      expired.client.supports.mockReturnValue(false);
      await expect(run(expired, false)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);
      expect(expired.client.submitTransaction).not.toHaveBeenCalled();
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
    facts.ttlSlot = OLD_TTL;
    chain.tip = OLD_TTL + SETTLE + 1;
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
    perCbor.bb = { ttlSlot: OLD_TTL };
    chain.tip = OLD_TTL + SETTLE + 1;
    const nowSeconds = Math.floor(Date.now() / 1000);
    open([], [
      { id: 'sub-young', build_id: null, txHash: 'h1', signedTxCbor: 'aa', submittedAt: nowSeconds - 30 },
      { id: 'sub-old', build_id: null, txHash: 'h2', signedTxCbor: 'bb', submittedAt: String(nowSeconds - RESUBMIT_WINDOW_MS / 1000 - 60) },
    ]);
    const deps = makeDeps();

    await expect(redriveInterruptedSubmissions(deps as never)).resolves.toBe(2);

    expect(deps.client.submitTransaction).toHaveBeenCalledTimes(1);
    expect(deps.client.submitTransaction).toHaveBeenCalledWith('aa');
    expect(deps.indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 'sub-young', 'submitted', undefined, 'pending');
    expect(deps.indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 'sub-old', 'failed', expect.stringContaining('expired at slot'), 'pending');
  });
});
