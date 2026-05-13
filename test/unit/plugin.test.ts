import cds from '@sap/cds';
import type { EventEmitter } from 'events';

// At runtime `cds` is an EventEmitter, but its public TS type doesn't expose
// `listeners`/`emit`/`removeAllListeners`. Cast once for use in this suite.
const cdsBus = cds as unknown as EventEmitter;

/**
 * Plugin bootstrap contract:
 * `src/plugin.ts` registers a `served` handler that initializes the core via
 * dynamic import. If that initialization throws, the failure must be swallowed
 * (logged only) so a host CAP app never crashes because of a plugin error.
 *
 * These tests exercise the `served` handler in isolation by mocking
 * `src/index` to throw from `initialize()`, then emitting `served` and
 * asserting the promise resolves without rejecting.
 */

describe('src/plugin.ts — bootstrap fault tolerance', () => {
  // Snapshot the cds listeners we'll mutate, so other suites in the same worker are unaffected.
  let originalServedListeners: Array<(...args: unknown[]) => unknown>;
  let originalShutdownListeners: Array<(...args: unknown[]) => unknown>;
  let originalLoadedListeners: Array<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    jest.resetModules();
    originalServedListeners = cdsBus.listeners('served') as Array<(...args: unknown[]) => unknown>;
    originalShutdownListeners = cdsBus.listeners('shutdown') as Array<(...args: unknown[]) => unknown>;
    originalLoadedListeners = cdsBus.listeners('loaded') as Array<(...args: unknown[]) => unknown>;
    cdsBus.removeAllListeners('served');
    cdsBus.removeAllListeners('shutdown');
    cdsBus.removeAllListeners('loaded');
  });

  afterEach(() => {
    cdsBus.removeAllListeners('served');
    cdsBus.removeAllListeners('shutdown');
    cdsBus.removeAllListeners('loaded');
    for (const fn of originalServedListeners) cds.on('served', fn as never);
    for (const fn of originalShutdownListeners) cds.on('shutdown', fn as never);
    for (const fn of originalLoadedListeners) cds.on('loaded', fn as never);
  });

  it('does not throw when core.initialize() rejects', async () => {
    // Mock the dynamic `import('./index')` target so initialize() throws.
    jest.doMock('../../src/index', () => ({
      initialize: jest.fn().mockRejectedValue(new Error('synthetic init failure')),
      shutdown: jest.fn().mockResolvedValue(undefined),
    }));

    // Loading plugin.ts registers its `served`/`shutdown`/`loaded` listeners.
    require('../../src/plugin');

    // Emitting 'served' should not reject — the plugin must swallow init errors.
    let caught: unknown;
    try {
      await Promise.resolve(cdsBus.emit('served'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeUndefined();
  });

  it('does not throw on shutdown when never initialized', async () => {
    jest.doMock('../../src/index', () => ({
      initialize: jest.fn(),
      shutdown: jest.fn(),
    }));
    require('../../src/plugin');

    // The shutdown handler short-circuits when `initialized` is false; this
    // guards against accidental cleanup work that would crash a host app on
    // graceful shutdown after a failed init. cds.emit may return a non-Promise
    // when no async handler runs, so we wrap defensively.
    let caught: unknown;
    try {
      await Promise.resolve(cdsBus.emit('shutdown'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeUndefined();
  });
});
