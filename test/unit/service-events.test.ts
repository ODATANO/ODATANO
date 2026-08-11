/**
 * CAP service events (v2.0).
 *
 * The crawler and the wallet worker mirror their internal notifications onto their
 * CAP services so consumers can subscribe instead of polling. Because both callers
 * are background loops, the contract that matters here is defensive: an emit must
 * never throw, never block and never fire before the service exists.
 */

// No static imports at the top, so mark this a module (see the sibling suites).
export {};

const { services } = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    services,
  };
  return { default: cdsMock, ...cdsMock };
});

let emitServiceEvent: (s: string, e: string, d: Record<string, unknown>) => void;
beforeAll(async () => {
  ({ emitServiceEvent } = await import('../../srv/utils/service-events'));
});

beforeEach(() => {
  for (const k of Object.keys(services)) delete services[k];
});

/** Let the fire-and-forget promise settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('emitServiceEvent', () => {
  it('delivers the payload to the named service', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    services.CardanoIndexerService = { emit };

    emitServiceEvent('CardanoIndexerService', 'blockIndexed', { hash: 'abc', height: 42 });
    await flush();

    expect(emit).toHaveBeenCalledWith('blockIndexed', { hash: 'abc', height: 42 });
  });

  it('is a no-op when the service is not served yet', () => {
    // Unit tests and the window before CAP's `served` phase — normal, not an error.
    expect(() => emitServiceEvent('CardanoWorkerService', 'jobConfirmed', { jobId: 'j1' })).not.toThrow();
  });

  it('swallows a rejecting subscriber — a broken consumer must not stop the crawler', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('subscriber exploded'));
    services.CardanoIndexerService = { emit };

    expect(() => emitServiceEvent('CardanoIndexerService', 'reorg', { forkSlot: 1 })).not.toThrow();
    await flush(); // the rejection is handled, not an unhandled rejection
    expect(emit).toHaveBeenCalled();
  });

  it('swallows a synchronously throwing emit', () => {
    services.CardanoIndexerService = { emit: () => { throw new Error('boom'); } };

    expect(() => emitServiceEvent('CardanoIndexerService', 'blockIndexed', {})).not.toThrow();
  });

  it('does not block the caller on a slow subscriber', async () => {
    let release!: () => void;
    services.CardanoWorkerService = { emit: () => new Promise<void>((res) => { release = res; }) };

    const before = Date.now();
    emitServiceEvent('CardanoWorkerService', 'jobConfirmed', { jobId: 'j1' });
    // Returned while the subscriber is still pending — block ingestion cannot stall.
    expect(Date.now() - before).toBeLessThan(50);
    release();
    await flush();
  });
});
