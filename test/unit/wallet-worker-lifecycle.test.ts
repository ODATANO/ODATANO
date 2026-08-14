/**
 * Wallet worker — module singleton lifecycle (srv/blockchain/wallet-worker/index).
 * CardanoWalletWorker is mocked; what matters here is the singleton bookkeeping:
 * idempotent start, replacing a dead worker, dropping the reference when a start
 * fails or refuses, and serializing concurrent start/stop calls.
 * (The engine's own start()/stop() live in wallet-worker-engine.test.ts.)
 */

const { workerInstances, workerCtor } = vi.hoisted(() => {
  const workerInstances: Array<Record<string, unknown>> = [];
  const workerCtor = vi.fn(function (this: Record<string, unknown>, deps: unknown) {
    let running = false;
    Object.assign(this, {
      deps,
      start: vi.fn(async () => { running = true; }),
      stop: vi.fn(async () => { running = false; }),
      isRunning: () => running,
    });
    workerInstances.push(this);
  });
  return { workerInstances, workerCtor };
});

vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('../../srv/blockchain/wallet-worker/wallet-worker', () => ({
  CardanoWalletWorker: workerCtor,
}));

import {
  startWalletWorker,
  stopWalletWorker,
  isWalletWorkerRunning,
  getWalletWorker,
} from '../../srv/blockchain/wallet-worker/index';

const DEPS = {
  client: { network: 'preview' },
  indexer: {},
  network: 'preview',
  config: { enabled: true, wallets: [{ walletId: 'w1', signerType: 'software' }] },
};
const deps = (extra: Record<string, unknown> = {}) => ({ ...DEPS, ...extra }) as never;

afterEach(async () => {
  await stopWalletWorker();
  workerInstances.length = 0;
  vi.clearAllMocks();
});

describe('wallet-worker singleton lifecycle', () => {
  it('starts one worker and exposes it', async () => {
    await startWalletWorker(deps());

    expect(workerInstances).toHaveLength(1);
    expect(isWalletWorkerRunning()).toBe(true);
    expect(getWalletWorker()).toBe(workerInstances[0]);
    expect(workerInstances[0].start).toHaveBeenCalledTimes(1);
  });

  it('derives an instanceId when the caller does not supply one', async () => {
    await startWalletWorker(deps());
    const { instanceId } = (workerInstances[0].deps as { instanceId: string });

    expect(instanceId).toContain(String(process.pid));
  });

  it('keeps a caller-supplied instanceId (lease owner identity)', async () => {
    await startWalletWorker(deps({ instanceId: 'instance-A' }));

    expect((workerInstances[0].deps as { instanceId: string }).instanceId).toBe('instance-A');
  });

  it('is idempotent while a worker is already running', async () => {
    await startWalletWorker(deps());
    await startWalletWorker(deps());

    expect(workerInstances).toHaveLength(1);
    expect(workerInstances[0].start).toHaveBeenCalledTimes(1);
  });

  it('replaces a worker that is no longer running', async () => {
    await startWalletWorker(deps());
    await (workerInstances[0].stop as () => Promise<void>)(); // died on its own

    await startWalletWorker(deps());

    expect(workerInstances).toHaveLength(2);
    expect(workerInstances[0].stop).toHaveBeenCalled();
    expect(getWalletWorker()).toBe(workerInstances[1]);
  });

  it('drops the singleton when start() throws, so the next call can retry', async () => {
    workerCtor.mockImplementationOnce(function (this: Record<string, unknown>) {
      Object.assign(this, {
        start: vi.fn(async () => { throw new Error('signer init exploded'); }),
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      });
      workerInstances.push(this);
    });

    await expect(startWalletWorker(deps())).rejects.toThrow('signer init exploded');
    expect(getWalletWorker()).toBeNull();
    expect(isWalletWorkerRunning()).toBe(false);

    await startWalletWorker(deps());
    expect(isWalletWorkerRunning()).toBe(true);
  });

  it('drops the singleton when start() completes without running (refused to start)', async () => {
    workerCtor.mockImplementationOnce(function (this: Record<string, unknown>) {
      Object.assign(this, {
        start: vi.fn(async () => undefined), // e.g. no wallets configured
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      });
      workerInstances.push(this);
    });

    await startWalletWorker(deps());

    expect(getWalletWorker()).toBeNull();
    expect(isWalletWorkerRunning()).toBe(false);
  });

  it('stop is a no-op when nothing runs, and clears the singleton otherwise', async () => {
    await expect(stopWalletWorker()).resolves.toBeUndefined();

    await startWalletWorker(deps());
    await stopWalletWorker();

    expect(workerInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(getWalletWorker()).toBeNull();
    expect(isWalletWorkerRunning()).toBe(false);
  });

  it('serializes concurrent start/stop calls instead of racing them', async () => {
    await Promise.all([startWalletWorker(deps()), startWalletWorker(deps()), stopWalletWorker()]);

    // Whatever the interleaving, the queue leaves exactly one decision standing.
    expect(workerInstances.length).toBeLessThanOrEqual(2);
    expect(isWalletWorkerRunning()).toBe(getWalletWorker() !== null);
  });

  it('survives a failing operation in the queue and keeps serving later calls', async () => {
    workerCtor.mockImplementationOnce(function (this: Record<string, unknown>) {
      Object.assign(this, {
        start: vi.fn(async () => { throw new Error('boom'); }),
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      });
      workerInstances.push(this);
    });

    await expect(startWalletWorker(deps())).rejects.toThrow('boom');
    await startWalletWorker(deps());

    expect(isWalletWorkerRunning()).toBe(true);
  });
});
