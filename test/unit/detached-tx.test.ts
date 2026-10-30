/**
 * detachedTx: the timeout bounds acquiring the connection, never the work after it.
 */
export {};

const { acquireDelay } = vi.hoisted(() => ({ acquireDelay: { ms: 0 } }));

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    tx: (fn: (db: unknown) => Promise<unknown>) =>
      fn({ begin: () => new Promise(resolve => setTimeout(resolve, acquireDelay.ms)) }),
  };
  return { default: cdsMock, ...cdsMock };
});

import { detachedTx } from '../../srv/utils/tx-utils';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('detachedTx', () => {
  it('lets work that outlasts the timeout finish once the connection is acquired', async () => {
    acquireDelay.ms = 0;
    await expect(detachedTx('slow work', async () => { await sleep(60); return 'done'; }, 20)).resolves.toBe('done');
  });

  it('answers 503 and skips the work when the connection arrives too late', async () => {
    acquireDelay.ms = 60;
    const work = vi.fn(async () => 'never');
    await expect(detachedTx('late acquire', work, 20)).rejects.toMatchObject({ statusCode: 503 });
    await sleep(80);
    expect(work).not.toHaveBeenCalled();
  });
});
