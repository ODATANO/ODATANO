import cds from '@sap/cds';
import path from 'path';

const logger = cds.log('ODATANO');
const pluginRoot = path.resolve(__dirname, '..');

let initialized = false;

/**
 * CAP Plugin registration for @odatano/core
 * This is executed when the plugin is loaded via cds-plugin.js
 */

// Register service kinds so consumer apps can configure via cds.env.requires
if (!cds.env.requires) {
  (cds.env as { requires?: Record<string, unknown> }).requires = {};
}

if (!(cds.env.requires as Record<string, unknown>).kinds) {
  (cds.env.requires as { kinds?: Record<string, unknown> }).kinds = {};
}

(cds.env.requires as { kinds?: Record<string, unknown> }).kinds!['odatano-core'] = {
  impl: '@odatano/core',
  model: [
    '@odatano/core/db/schema',
    '@odatano/core/srv/cardano-service',
    '@odatano/core/srv/cardano-tx-service',
    '@odatano/core/srv/cardano-sign-service',
    '@odatano/core/srv/cardano-indexer-service'
  ]
};

// CRITICAL: Also set model directly on the requires entry.
// CAP's _link_required_services() merges kind→requires BEFORE cds-plugin.js runs,
// so the model array on the kind is never merged. Set it directly.
const req = (cds.env.requires as Record<string, { model?: string[] } | undefined>)['odatano-core'];
if (req) {
  req.model = [
    '@odatano/core/db/schema',
    '@odatano/core/srv/cardano-service',
    '@odatano/core/srv/cardano-tx-service',
    '@odatano/core/srv/cardano-sign-service',
    '@odatano/core/srv/cardano-indexer-service'
  ];
}

logger.debug('Plugin registered');

/**
 * Rewrite @impl paths for plugin mode.
 * CDS files use relative @impl (e.g. 'srv/cardano-service') which resolves from cds.root.
 * In standalone mode cds.root IS the package root, so it works.
 * In plugin mode cds.root is the consumer app — rewrite to package-qualified paths
 * so CAP resolves via Node module resolution (node_modules/@odatano/core/srv/...).
 */
cds.on('loaded', (model) => {
  if (path.resolve(cds.root) === pluginRoot) return;
  const defs = (model as { definitions?: Record<string, { '@impl'?: string }> }).definitions ?? {};
  for (const def of Object.values(defs)) {
    if (def['@impl'] === 'srv/cardano-service') {
      def['@impl'] = '@odatano/core/srv/cardano-service';
    } else if (def['@impl'] === 'srv/cardano-tx-service') {
      def['@impl'] = '@odatano/core/srv/cardano-tx-service';
    } else if (def['@impl'] === 'srv/cardano-sign-service') {
      def['@impl'] = '@odatano/core/srv/cardano-sign-service';
    } else if (def['@impl'] === 'srv/cardano-indexer-service') {
      def['@impl'] = '@odatano/core/srv/cardano-indexer-service';
    }
  }
});

/**
 * Initialize blockchain components when services are served
 */
cds.on('served', async () => {
  if (initialized) return;

  // Honor SKIP_AUTO_INIT so consumer test suites can mount the plugin without it
  // opening real backend connections (matches srv/server.ts's standalone hook).
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
    // Don't throw - plugin failure shouldn't crash the host app
    logger.error('Failed to initialize plugin:', err);
  }
});

/**
 * Graceful shutdown handler
 */
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
