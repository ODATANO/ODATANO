/**
 * CheckSubmissionStatus confirms a submitted transaction only once it sits three blocks deep.
 */
export {};

const { fakeDb, indexer } = vi.hoisted(() => ({
  fakeDb: { run: vi.fn() },
  indexer: { resolveTransactionConfirmations: vi.fn() },
}));

vi.mock('@sap/cds', () => {
  const chain = { where: () => chain, columns: () => chain };
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ql: {
      SELECT: { one: { from: () => ({ where: () => ({ _op: 'SELECT' }) }) }, from: () => chain },
      UPDATE: { entity: () => ({ set: (set: unknown) => ({ where: () => ({ _op: 'UPDATE', set }) }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/backend-request-handler', () => ({
  handleRequest: vi.fn((_req: unknown, cb: (db: unknown) => unknown) => cb(fakeDb)),
}));
vi.mock('../../srv/server', () => ({ getCardanoIndexer: () => indexer, getCardanoClient: () => ({ network: 'preview' }) }));

type Handler = (req: Record<string, unknown>) => Promise<unknown>;
const handlers: Record<string, Handler> = {};
beforeAll(async () => {
  const mod: any = await import('../../srv/cardano-tx-service');
  (mod.default ?? mod)({ on: (event: string, h: Handler) => { handlers[event] = h; } });
});

const check = () => handlers.CheckSubmissionStatus({ params: [{ id: 's1' }] });

beforeEach(() => {
  fakeDb.run.mockReset();
  fakeDb.run.mockImplementation(async (q: { _op: string }) =>
    q._op === 'SELECT' ? { id: 's1', txHash: 'ab'.repeat(32), status: 'submitted' } : 1);
});

describe('CheckSubmissionStatus', () => {
  it('keeps a transaction two blocks deep as submitted', async () => {
    indexer.resolveTransactionConfirmations.mockResolvedValue({ confirmations: 2 });
    await expect(check()).resolves.toMatchObject({ status: 'submitted' });
    expect(fakeDb.run.mock.calls.some(([q]) => q._op === 'UPDATE')).toBe(false);
  });

  it('confirms at three blocks', async () => {
    indexer.resolveTransactionConfirmations.mockResolvedValue({ confirmations: 3 });
    await expect(check()).resolves.toMatchObject({ status: 'confirmed' });
    expect(fakeDb.run.mock.calls.some(([q]) => q._op === 'UPDATE' && q.set.status === 'confirmed')).toBe(true);
  });

  it('keeps a transaction not on chain yet as submitted', async () => {
    indexer.resolveTransactionConfirmations.mockResolvedValue({ confirmations: 0 });
    await expect(check()).resolves.toMatchObject({ status: 'submitted' });
  });
});
