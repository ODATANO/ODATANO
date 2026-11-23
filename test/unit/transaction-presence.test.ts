/**
 * findOnChain: the crawled chain answers first, then the backends. Not found on every backend is
 * absence, a failed lookup proves nothing, and no capable backend is its own answer.
 */
export {};

vi.mock('@sap/cds', () => {
  const cdsMock = { tx: (fn: (t: unknown) => unknown) => fn({}) };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/tx-utils', () => ({ runWithoutAmbientTx: (fn: () => unknown) => fn() }));

import { findOnChain } from '../../srv/blockchain/transaction-presence';
import { AllBackendsFailedError, NotFoundError, ProviderUnavailableError } from '../../srv/utils/errors';

function makeDeps() {
  return {
    indexer: { findCrawledTransaction: vi.fn(async (): Promise<unknown> => null) },
    client: { getTransaction: vi.fn(), supports: vi.fn(() => true) },
  };
}
const lookup = (deps: ReturnType<typeof makeDeps>) => findOnChain(deps.indexer as never, deps.client as never, 'h');

describe('findOnChain', () => {
  it('answers from the crawled chain without asking a backend', async () => {
    const deps = makeDeps();
    deps.indexer.findCrawledTransaction.mockResolvedValue({ slot: 1, blockHeight: 7, blockHash: 'b', tipHeight: 9, spendsCollaterals: false });

    await expect(lookup(deps)).resolves.toEqual({ slot: 1, height: 7, scriptFailed: false });
    expect(deps.client.getTransaction).not.toHaveBeenCalled();
  });

  it('answers from a backend, with a failed script phase as the backend reports it', async () => {
    const deps = makeDeps();
    deps.client.getTransaction.mockResolvedValue({ hash: 'h', slot: 5, blockHeight: 3, spendsCollaterals: true });

    await expect(lookup(deps)).resolves.toEqual({ slot: 5, height: 3, scriptFailed: true, validityKnown: true });
  });

  it('is null when every backend answers not found', async () => {
    const deps = makeDeps();
    deps.client.getTransaction.mockRejectedValue(new AllBackendsFailedError([new NotFoundError('Transaction', 'koios')]));

    await expect(lookup(deps)).resolves.toBeNull();
  });

  it('throws when the lookup fails, also when only one backend failed', async () => {
    const deps = makeDeps();
    const mixed = new AllBackendsFailedError([new NotFoundError('Transaction', 'koios'), new ProviderUnavailableError('down', 'blockfrost')]);
    deps.client.getTransaction.mockRejectedValue(mixed);

    await expect(lookup(deps)).rejects.toBe(mixed);
  });

  it('is undefined when no backend can look transactions up', async () => {
    const deps = makeDeps();
    deps.client.supports.mockReturnValue(false);

    await expect(lookup(deps)).resolves.toBeUndefined();
    expect(deps.client.supports).toHaveBeenCalledWith('getTransaction');
    expect(deps.client.getTransaction).not.toHaveBeenCalled();
  });
});
