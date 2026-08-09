/**
 * Wallet worker — lease heartbeat.
 * The renewal callback is injected, so these drive the timing/failure semantics
 * directly: periodic renewal, lenient beats vs. strict fences, and standing down
 * once the lease provably belongs to someone else.
 */

// `ql` is only here because job-store (imported for WORKER_LEASE_TTL_MS)
// destructures it at module load; the heartbeat itself touches no CQL.
vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    ql: { SELECT: {}, INSERT: {}, UPDATE: {} },
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  CardanoWalletJobs: 'odatano.cardano.CardanoWalletJobs',
  CardanoWorkerWallets: 'odatano.cardano.CardanoWorkerWallets',
}));

import { LeaseHeartbeat, LEASE_HEARTBEAT_INTERVAL_MS } from '../../srv/blockchain/wallet-worker/lease-heartbeat';
import { WORKER_LEASE_TTL_MS } from '../../srv/blockchain/wallet-worker/job-store';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LeaseHeartbeat', () => {
  it('beats often enough that two consecutive misses still cannot expire the lease', () => {
    expect(LEASE_HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(WORKER_LEASE_TTL_MS);
  });

  it('renews on the interval until stopped', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1');
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 3);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(heartbeat.isLost()).toBe(false);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 3);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it('marks the lease lost and stops beating once a renewal says it is not ours', async () => {
    const renew = vi.fn().mockResolvedValue(false);
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1');
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    expect(heartbeat.isLost()).toBe(true);

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 5);
    expect(renew).toHaveBeenCalledTimes(1); // no further beats after standing down
    expect(await heartbeat.fence()).toBe(false);
  });

  it('tolerates a failing renewal in a beat (transient DB error) but not in a fence', async () => {
    const renew = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1');
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeat.isLost()).toBe(false); // keep working, retry next beat

    // A fence guards an irreversible step: unverifiable ownership counts as lost.
    expect(await heartbeat.fence()).toBe(false);
    expect(heartbeat.isLost()).toBe(true);
    heartbeat.stop();
  });

  it('fence returns true while the lease is held', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1');

    expect(await heartbeat.fence()).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('start twice keeps a single interval, and stop is safe to repeat', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1');

    heartbeat.start();
    heartbeat.start(); // no second timer

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 2);
    expect(renew).toHaveBeenCalledTimes(2);

    heartbeat.stop();
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 2);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('a lost lease short-circuits fence without another renewal attempt', async () => {
    const renew = vi.fn().mockResolvedValue(false);
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1');

    expect(await heartbeat.fence()).toBe(false); // one attempt, definitive
    expect(await heartbeat.fence()).toBe(false); // no further attempts
    expect(renew).toHaveBeenCalledTimes(1);
    expect(heartbeat.isLost()).toBe(true);
  });

  it('honours a custom interval', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = new LeaseHeartbeat(renew, 'wallet w1', 1_000);
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(renew).toHaveBeenCalledTimes(3);
    heartbeat.stop();
  });
});
