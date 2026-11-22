/**
 * buildReadiness: ready needs the app context, a database that answers a schema read and,
 * when an HSM is configured, its session.
 */
export {};

const { state, detachedTx } = vi.hoisted(() => ({
  state: { db: {} as unknown },
  detachedTx: vi.fn(),
}));

vi.mock('@sap/cds', () => {
  const query = { columns: () => query };
  const cdsMock = {
    get db() { return state.db; },
    ql: { SELECT: { one: { from: () => query } } },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/tx-utils', () => ({ detachedTx }));

import { buildReadiness } from '../../srv/utils/readiness';

const NOW = new Date('2026-11-16T12:00:00.000Z');

beforeEach(() => {
  state.db = {};
  detachedTx.mockReset();
  detachedTx.mockResolvedValue(undefined);
});

describe('buildReadiness', () => {
  it('is ready with context and database, and reports no HSM as null', async () => {
    await expect(buildReadiness({ context: true, hsm: null }, NOW)).resolves.toEqual({
      status: 'ready', timestamp: '2026-11-16T12:00:00.000Z', context: true, database: true, hsm: null,
    });
    expect(detachedTx).toHaveBeenCalledWith('readiness probe', expect.any(Function), 3000);
  });

  it('is ready with a connected HSM', async () => {
    await expect(buildReadiness({ context: true, hsm: true }, NOW)).resolves.toMatchObject({ status: 'ready', hsm: true });
  });

  it.each([
    ['the app context is missing', { context: false, hsm: null }],
    ['a configured HSM is not connected', { context: true, hsm: false }],
  ])('is not ready when %s', async (_label, parts) => {
    await expect(buildReadiness(parts, NOW)).resolves.toMatchObject({ status: 'not_ready', database: true, ...parts });
  });

  it('is not ready when the schema read fails, and names no cause', async () => {
    detachedTx.mockRejectedValue(new Error('no such table: odatano_cardano_CardanoSyncState'));

    const body = await buildReadiness({ context: true, hsm: null }, NOW);

    expect(body).toEqual({ status: 'not_ready', timestamp: '2026-11-16T12:00:00.000Z', context: true, database: false, hsm: null });
  });

  it('is not ready without a database and opens no transaction', async () => {
    state.db = undefined;

    await expect(buildReadiness({ context: true, hsm: null }, NOW)).resolves.toMatchObject({ status: 'not_ready', database: false });
    expect(detachedTx).not.toHaveBeenCalled();
  });
});
