import cds from '@sap/cds';
import path from 'path';

const logger = cds.log('ODATANO');
const pluginRoot = path.resolve(__dirname, '..');

let initialized = false;

// CAP plugin registration for @odatano/core; loaded via cds-plugin.js.

// Register the service kind so consumer apps can configure via cds.env.requires
if (!cds.env.requires) {
  (cds.env as { requires?: Record<string, unknown> }).requires = {};
}

if (!(cds.env.requires as Record<string, unknown>).kinds) {
  (cds.env.requires as { kinds?: Record<string, unknown> }).kinds = {};
}

/** The schema and the six CDS services this package ships, package-qualified. */
const PLUGIN_MODEL = [
  '@odatano/core/db/schema',
  '@odatano/core/srv/cardano-service',
  '@odatano/core/srv/cardano-tx-service',
  '@odatano/core/srv/cardano-sign-service',
  '@odatano/core/srv/cardano-indexer-service',
  '@odatano/core/srv/cardano-worker-service',
  '@odatano/core/srv/cardano-agent-service'
];

/** Relative `@impl` values used in the CDS files (rewritten in plugin mode, see below). */
const IMPL_PATHS = [
  'srv/cardano-service',
  'srv/cardano-tx-service',
  'srv/cardano-sign-service',
  'srv/cardano-indexer-service',
  'srv/cardano-worker-service',
  'srv/cardano-agent-service'
];

(cds.env.requires as { kinds?: Record<string, unknown> }).kinds!['odatano-core'] = {
  impl: '@odatano/core',
  model: [...PLUGIN_MODEL]
};

// Also set model on the requires entry: CAP merges kind→requires before cds-plugin.js
// runs, so the model array on the kind alone is never picked up.
const req = (cds.env.requires as Record<string, { model?: string[] } | undefined>)['odatano-core'];
if (req) {
  req.model = [...PLUGIN_MODEL];
}

logger.debug('Plugin registered');

/**
 * Agent grants (off by default). Must run at plugin load, before CAP builds its
 * middlewares, because it swaps the auth impl. Idempotent; server.ts repeats it for standalone.
 */
(require('../srv/utils/agent-grants-config') as typeof import('../srv/utils/agent-grants-config'))
  .activateAgentGrants();

/**
 * Plugin mode: relative @impl paths resolve from cds.root (the consumer app), so
 * rewrite them to package-qualified paths that Node module resolution can find.
 */
cds.on('loaded', (model) => {
  if (path.resolve(cds.root) === pluginRoot) return;
  const defs = (model as { definitions?: Record<string, { '@impl'?: string }> }).definitions ?? {};
  for (const def of Object.values(defs)) {
    const impl = def['@impl'];
    if (impl && IMPL_PATHS.includes(impl)) {
      def['@impl'] = `@odatano/core/${impl}`;
    }
  }
});

// Initialize blockchain components once services are served.
cds.on('served', async () => {
  if (initialized) return;

  // SKIP_AUTO_INIT lets consumer test suites mount the plugin without backend connections.
  if (process.env.SKIP_AUTO_INIT === 'true') {
    logger.info('Skipping plugin auto-initialization (SKIP_AUTO_INIT=true)');
    return;
  }

  logger.debug('Plugin activation triggered');

  try {
    const core = await import('./index');
    await core.initialize();
    logger.info('Plugin initialized successfully');
    initialized = true;
  } catch (err) {
    // Never throw: a plugin failure must not crash the host app.
    logger.error('Failed to initialize plugin:', err);
  }
});

cds.on('shutdown', async () => {
  if (!initialized) return;

  try {
    logger.debug('Shutting down...');
    const core = await import('./index');
    await core.shutdown();
    initialized = false;
    logger.info('Plugin shutdown complete');
  } catch (err) {
    logger.error('Error during shutdown:', err);
  }
});

export {};
