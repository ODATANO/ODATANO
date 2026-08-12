import cds from '@sap/cds';
import type { EventEmitter } from 'events';
import path from 'path';
import packageJson from '../../package.json';
import routerPackageJson from '../../app/router/package.json';
import security from '../../xs-security.json';

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
    vi.resetModules();
    originalServedListeners = cdsBus.listeners('served') as Array<(...args: unknown[]) => unknown>;
    originalShutdownListeners = cdsBus.listeners('shutdown') as Array<(...args: unknown[]) => unknown>;
    originalLoadedListeners = cdsBus.listeners('loaded') as Array<(...args: unknown[]) => unknown>;
    cdsBus.removeAllListeners('served');
    cdsBus.removeAllListeners('shutdown');
    cdsBus.removeAllListeners('loaded');
  });

  it('builds package artifacts during prepare without duplicate pack hooks', () => {
    expect(packageJson.scripts.prepare).toBe('npm run build:package');
    expect((packageJson.scripts as Record<string, string | undefined>).prepack).toBeUndefined();
    expect(packageJson.dependencies['@harmoniclabs/cardano-ledger-ts']).toBe('^0.5.6');
    expect(packageJson.overrides.esbuild).toBe('0.28.1');
    expect(packageJson.overrides.ws).toBe('7.5.11');
    expect(routerPackageJson.dependencies['@sap/approuter']).toBe('22.0.3');
    // The router must NOT depend on the root package: a `file:../..` dependency
    // makes the MTA production install run the root `prepare` build without
    // devDependencies (cds-typer missing) — removed for 2.0.0.
    expect((routerPackageJson.dependencies as Record<string, string | undefined>)['@odatano/core']).toBeUndefined();
    expect((routerPackageJson.dependencies as Record<string, string | undefined>).odatano).toBeUndefined();
    expect(routerPackageJson.overrides['form-data']).toBe('4.0.6');
    expect(routerPackageJson.overrides.ws).toBe('7.5.11');
  });

  it('gates crawler control actions with the XSUAA Admin scope', async () => {
    const model = await cds.load(path.resolve(__dirname, '../../srv/cardano-indexer-service.cds'));
    const definitions = model.definitions as Record<string, any>;
    const pause = definitions['CardanoIndexerService.pauseCrawler'];
    const resume = definitions['CardanoIndexerService.resumeCrawler'];

    expect(pause['@requires']).toBe('Admin');
    expect(resume['@requires']).toBe('Admin');
    expect(security.scopes).toContainEqual(expect.objectContaining({ name: '$XSAPPNAME.Admin' }));
    expect(security['role-templates']).toContainEqual(expect.objectContaining({
      name: 'CardanoAdmin',
      'scope-references': expect.arrayContaining(['$XSAPPNAME.Admin']),
    }));
    // Least privilege (review 2026-08-08): CardanoUser must NOT carry the Admin
    // scope — operational control (crawler/worker) is CardanoAdmin-only.
    const cardanoUser = (security['role-templates'] as Array<{ name: string; 'scope-references': string[] }>)
      .find((t) => t.name === 'CardanoUser');
    expect(cardanoUser).toBeDefined();
    expect(cardanoUser!['scope-references']).not.toContain('$XSAPPNAME.Admin');
    expect(security.authorities).not.toContain('$XSAPPNAME.Admin');
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
    vi.doMock('../../src/index', () => ({
      initialize: vi.fn().mockRejectedValue(new Error('synthetic init failure')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }));

    // Loading plugin.ts registers its `served`/`shutdown`/`loaded` listeners.
    await import('../../src/plugin');

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
    vi.doMock('../../src/index', () => ({
      initialize: vi.fn(),
      shutdown: vi.fn(),
    }));
    await import('../../src/plugin');

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
