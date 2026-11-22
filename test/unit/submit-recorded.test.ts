/**
 * submitRecorded: the submission row and its outcome commit in their own transactions.
 * A refusal ends as 'failed', a submit without a verdict leaves the row 'pending'.
 */
export {};

const { commits, onChain } = vi.hoisted(() => ({ commits: [] as string[], onChain: vi.fn() }));

vi.mock('@sap/cds', () => {
  const chain = { columns: () => chain, where: () => chain };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ql: { SELECT: { from: () => chain, one: { from: () => chain } }, UPDATE: { entity: () => ({ set: () => chain }) } },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/tx-utils', () => ({
  detachedTx: async (label: string, fn: (db: unknown) => Promise<unknown>) => {
    const result = await fn({ run: vi.fn(async () => [{ address_address: 'addr_test1_sender' }]) });
    commits.push(label);
    return result;
  },
  runWithoutAmbientTx: (fn: () => unknown) => fn(),
}));
vi.mock('../../srv/blockchain/signing/external-signer', () => ({ getExternalSignerModule: vi.fn() }));
vi.mock('../../srv/blockchain/transaction-presence', () => ({ isTransactionOnChain: onChain }));
vi.mock('#cds-models/CardanoTransactionService', () => ({
  AddressTransactionBuilds: 'AddressTransactionBuilds', TransactionSubmissions: 'TransactionSubmissions',
}));
vi.mock('../../srv/utils/tx-build-helper', () => ({ extractTxCacheTargets: () => ({ spentInputs: [], outputAddresses: [] }) }));

import { submitRecorded } from '../../srv/blockchain/signing/submission-finalizer';
import {
  ProviderUnavailableError, SubmitOutcomeUnknownError, TransactionAlreadySubmittedError, TransactionValidationError,
} from '../../srv/utils/errors';

function makeIndexer() {
  return {
    persistTransactionSubmission: vi.fn(async () => ({ id: 's1', txHash: 'h', status: 'pending' as const })),
    updateSubmissionStatus: vi.fn(async () => undefined),
    dropDuplicateSubmission: vi.fn(async () => false),
    invalidateUtxoCacheForTx: vi.fn(async () => undefined),
    findIndexedTransaction: vi.fn(async () => null),
  };
}
function makeClient(submit: () => Promise<string>) {
  return { submitTransaction: vi.fn(submit), getTransaction: vi.fn(), supports: vi.fn(() => true) };
}
const params = { signedTxCbor: 'beef', txHash: 'h', buildId: 'b1' };

beforeEach(() => {
  commits.length = 0;
  onChain.mockReset();
  onChain.mockResolvedValue(false);
});

describe('submitRecorded', () => {
  it('commits pending before the network call and submitted after it', async () => {
    const indexer = makeIndexer();
    const client = makeClient(async () => { expect(commits).toEqual(['record transaction submission']); return 'h'; });

    const result = await submitRecorded(params, indexer as never, client as never);

    expect(result.status).toBe('submitted');
    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'submitted');
    expect(indexer.invalidateUtxoCacheForTx).toHaveBeenCalledWith(expect.anything(), expect.anything(), ['addr_test1_sender']);
    expect(onChain).not.toHaveBeenCalled();
    expect(commits).toHaveLength(2);
  });

  it('commits failed with the message and rethrows when the node refused a transaction that is not on chain', async () => {
    const indexer = makeIndexer();
    const err = new TransactionValidationError('ValueNotConserved', undefined);
    const client = makeClient(async () => { throw err; });

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'failed', expect.stringContaining('ValueNotConserved'), 'pending');
    expect(commits).toEqual(['record transaction submission', 'record submission outcome']);
  });

  it('leaves the row pending and answers 503 when the submit got no verdict', async () => {
    const indexer = makeIndexer();
    const client = makeClient(async () => { throw new ProviderUnavailableError('node down', 'ogmios'); });

    const thrown = await submitRecorded(params, indexer as never, client as never).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(SubmitOutcomeUnknownError);
    expect(thrown).toMatchObject({ statusCode: 503, code: 'ODATANO_SUBMIT_OUTCOME_UNKNOWN', txHash: 'h' });
    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'pending', expect.stringContaining('node down'));
    expect(indexer.updateSubmissionStatus).not.toHaveBeenCalledWith(expect.anything(), 's1', 'failed', expect.anything(), expect.anything());
  });

  it('leaves the row pending when the node refused but the chain lookup failed', async () => {
    const indexer = makeIndexer();
    onChain.mockRejectedValue(new ProviderUnavailableError('lookup down', 'koios'));
    const client = makeClient(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBeInstanceOf(SubmitOutcomeUnknownError);

    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'pending', expect.stringContaining('BadInputsUTxO'));
  });

  it('records a refused transaction that is on chain as submitted and answers 409', async () => {
    const indexer = makeIndexer();
    onChain.mockResolvedValue(true);
    const client = makeClient(async () => { throw new TransactionValidationError('BadInputsUTxO', undefined); });

    const thrown = await submitRecorded(params, indexer as never, client as never).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TransactionAlreadySubmittedError);
    expect(indexer.dropDuplicateSubmission).toHaveBeenCalledWith(expect.anything(), 's1', 'h');
    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'submitted');
  });

  it('takes the refusal as final when no backend can look transactions up', async () => {
    const indexer = makeIndexer();
    onChain.mockResolvedValue(null);
    const err = new TransactionValidationError('ValueNotConserved', undefined);
    const client = makeClient(async () => { throw err; });

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'failed', expect.anything(), 'pending');
  });

  it('records an already-submitted tx as submitted and still answers 409', async () => {
    const indexer = makeIndexer();
    const err = new TransactionAlreadySubmittedError('h');
    const client = makeClient(async () => { throw err; });

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(onChain).not.toHaveBeenCalled();
    expect(indexer.dropDuplicateSubmission).toHaveBeenCalledWith(expect.anything(), 's1', 'h');
    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'submitted');
  });

  it('drops its own row on a resubmit when the transaction already has one, and still answers 409', async () => {
    const indexer = makeIndexer();
    indexer.dropDuplicateSubmission.mockResolvedValue(true);
    const err = new TransactionAlreadySubmittedError('h');
    const client = makeClient(async () => { throw err; });

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(indexer.dropDuplicateSubmission).toHaveBeenCalledWith(expect.anything(), 's1', 'h');
    expect(indexer.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it('keeps the submitted status when cache invalidation fails', async () => {
    const indexer = makeIndexer();
    indexer.invalidateUtxoCacheForTx.mockRejectedValue(new Error('cache'));
    const client = makeClient(async () => 'h');

    await expect(submitRecorded(params, indexer as never, client as never)).resolves.toMatchObject({ status: 'submitted' });
  });
});
