/**
 * submitRecorded: the submission row and its outcome commit in their own transactions,
 * so a rejected submit still leaves a 'failed' row behind.
 */
export {};

const { commits } = vi.hoisted(() => ({ commits: [] as string[] }));

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
vi.mock('#cds-models/CardanoTransactionService', () => ({ AddressTransactionBuilds: 'AddressTransactionBuilds' }));
vi.mock('../../srv/utils/tx-build-helper', () => ({ extractTxCacheTargets: () => ({ spentInputs: [], outputAddresses: [] }) }));

import { submitRecorded } from '../../srv/blockchain/signing/submission-finalizer';
import { ProviderUnavailableError, TransactionAlreadySubmittedError } from '../../srv/utils/errors';

function makeIndexer() {
  return {
    persistTransactionSubmission: vi.fn(async () => ({ id: 's1', txHash: 'h', status: 'pending' as const })),
    updateSubmissionStatus: vi.fn(async () => undefined),
    dropDuplicateSubmission: vi.fn(async () => false),
    invalidateUtxoCacheForTx: vi.fn(async () => undefined),
  };
}
const params = { signedTxCbor: 'beef', txHash: 'h', buildId: 'b1' };

beforeEach(() => { commits.length = 0; });

describe('submitRecorded', () => {
  it('commits pending before the network call and submitted after it', async () => {
    const indexer = makeIndexer();
    const client = { submitTransaction: vi.fn(async () => { expect(commits).toEqual(['record transaction submission']); return 'h'; }) };

    const result = await submitRecorded(params, indexer as never, client as never);

    expect(result.status).toBe('submitted');
    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'submitted');
    expect(indexer.invalidateUtxoCacheForTx).toHaveBeenCalledWith(expect.anything(), expect.anything(), ['addr_test1_sender']);
    expect(commits).toHaveLength(2);
  });

  it('commits failed with the message and rethrows the submit error', async () => {
    const indexer = makeIndexer();
    const err = new ProviderUnavailableError('node down', 'ogmios');
    const client = { submitTransaction: vi.fn(async () => { throw err; }) };

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'failed', expect.stringContaining('node down'));
    expect(commits).toEqual(['record transaction submission', 'record submission outcome']);
  });

  it('records an already-submitted tx as submitted and still answers 409', async () => {
    const indexer = makeIndexer();
    const err = new TransactionAlreadySubmittedError('h');
    const client = { submitTransaction: vi.fn(async () => { throw err; }) };

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(indexer.dropDuplicateSubmission).toHaveBeenCalledWith(expect.anything(), 's1', 'h');
    expect(indexer.updateSubmissionStatus).toHaveBeenCalledWith(expect.anything(), 's1', 'submitted');
  });

  it('drops its own row on a resubmit when the transaction already has one, and still answers 409', async () => {
    const indexer = makeIndexer();
    indexer.dropDuplicateSubmission.mockResolvedValue(true);
    const err = new TransactionAlreadySubmittedError('h');
    const client = { submitTransaction: vi.fn(async () => { throw err; }) };

    await expect(submitRecorded(params, indexer as never, client as never)).rejects.toBe(err);

    expect(indexer.dropDuplicateSubmission).toHaveBeenCalledWith(expect.anything(), 's1', 'h');
    expect(indexer.updateSubmissionStatus).not.toHaveBeenCalled();
  });

  it('keeps the submitted status when cache invalidation fails', async () => {
    const indexer = makeIndexer();
    indexer.invalidateUtxoCacheForTx.mockRejectedValue(new Error('cache'));
    const client = { submitTransaction: vi.fn(async () => 'h') };

    await expect(submitRecorded(params, indexer as never, client as never)).resolves.toMatchObject({ status: 'submitted' });
  });
});
