/**
 * isTransactionOnChain: the local index answers first, then the backends. Not found on every
 * backend is absence, a failed lookup proves nothing, and no capable backend is its own answer.
 */
export {};

vi.mock('@sap/cds', () => {
  const cdsMock = { tx: (fn: (t: unknown) => unknown) => fn({}) };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/tx-utils', () => ({ runWithoutAmbientTx: (fn: () => unknown) => fn() }));

import { isTransactionOnChain } from '../../srv/blockchain/transaction-presence';
import { AllBackendsFailedError, NotFoundError, ProviderUnavailableError } from '../../srv/utils/errors';

function makeDeps() {
  return {
    indexer: { findIndexedTransaction: vi.fn(async (): Promise<unknown> => null) },
    client: { getTransaction: vi.fn(), supports: vi.fn(() => true) },
  };
}
const lookup = (deps: ReturnType<typeof makeDeps>) => isTransactionOnChain(deps.indexer as never, deps.client as never, 'h');

describe('isTransactionOnChain', () => {
  it('is true from the local index without asking a backend', async () => {
    const deps = makeDeps();
    deps.indexer.findIndexedTransaction.mockResolvedValue({ slot: 1, blockHeight: 1, blockHash: 'b' });

    await expect(lookup(deps)).resolves.toBe(true);
    expect(deps.client.getTransaction).not.toHaveBeenCalled();
  });

  it('is true when a backend returns the transaction', async () => {
    const deps = makeDeps();
    deps.client.getTransaction.mockResolvedValue({ hash: 'h' });

    await expect(lookup(deps)).resolves.toBe(true);
  });

  it('is false when every backend answers not found', async () => {
    const deps = makeDeps();
    deps.client.getTransaction.mockRejectedValue(new AllBackendsFailedError([new NotFoundError('Transaction', 'koios')]));

    await expect(lookup(deps)).resolves.toBe(false);
  });

  it('throws when the lookup fails, also when only one backend failed', async () => {
    const deps = makeDeps();
    const mixed = new AllBackendsFailedError([new NotFoundError('Transaction', 'koios'), new ProviderUnavailableError('down', 'blockfrost')]);
    deps.client.getTransaction.mockRejectedValue(mixed);

    await expect(lookup(deps)).rejects.toBe(mixed);
  });

  it('is null when no backend can look transactions up', async () => {
    const deps = makeDeps();
    deps.client.supports.mockReturnValue(false);

    await expect(lookup(deps)).resolves.toBeNull();
    expect(deps.client.supports).toHaveBeenCalledWith('getTransaction');
    expect(deps.client.getTransaction).not.toHaveBeenCalled();
  });
});
