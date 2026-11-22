/**
 * readOutside: a database read before a provider call must not make the request transaction
 * take its connection.
 */
export {};

const { opened, ambient } = vi.hoisted(() => ({ opened: [] as unknown[], ambient: [] as unknown[] }));

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    _with: (store: unknown, fn: () => Promise<unknown>) => { ambient.push(store); return fn(); },
    tx: async (fn: (db: unknown) => Promise<unknown>) => {
      const own = { own: true };
      opened.push(own);
      return fn(own);
    },
  };
  return { default: cdsMock, ...cdsMock };
});

import { readOutside, holdsConnection } from '../../srv/utils/tx-utils';

beforeEach(() => {
  opened.length = 0;
  ambient.length = 0;
});

describe('holdsConnection', () => {
  it('is false for a transaction that ran no statement yet', () => {
    expect(holdsConnection({ begin: () => undefined })).toBe(false);
    expect(holdsConnection(null)).toBe(false);
  });

  it('is true once the transaction began or holds a connection', () => {
    expect(holdsConnection({ ready: Promise.resolve(true) })).toBe(true);
    expect(holdsConnection({ dbc: {} })).toBe(true);
  });
});

describe('readOutside', () => {
  it('reads in a transaction of its own while the given one is idle, outside the request context', async () => {
    const idle = { begin: vi.fn(), run: vi.fn() };
    const read = vi.fn(async (db: unknown) => db);

    const used = await readOutside(idle as never, read as never);

    expect(used).toBe(opened[0]);
    expect(ambient).toEqual([undefined]);
    expect(idle.begin).not.toHaveBeenCalled();
    expect(idle.run).not.toHaveBeenCalled();
  });

  it('reads on a transaction that already holds its connection', async () => {
    const held = { begin: vi.fn(), ready: Promise.resolve(true), run: vi.fn() };

    const used = await readOutside(held as never, (async (db: unknown) => db) as never);

    expect(used).toBe(held);
    expect(opened).toEqual([]);
  });

  it('reads on a runner that is no lazily beginning transaction', async () => {
    const runner = { run: vi.fn() };

    const used = await readOutside(runner as never, (async (db: unknown) => db) as never);

    expect(used).toBe(runner);
    expect(opened).toEqual([]);
  });

  it('passes a failed read on', async () => {
    const idle = { begin: vi.fn() };
    await expect(readOutside(idle as never, (async () => { throw new Error('read failed'); }) as never)).rejects.toThrow('read failed');
  });
});
