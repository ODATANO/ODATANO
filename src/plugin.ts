import cds from '@sap/cds';

const logger = cds.log('ODATANO');

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
    '@odatano/core/srv/cardano-tx-service'
  ]
};

// CRITICAL: Also set model directly on the requires entry.
// CAP's _link_required_services() merges kind→requires BEFORE cds-plugin.js runs,
// so the model array on the kind is never merged. Set it directly.
const req = (cds.env.requires as Record<string, any>)['odatano-core'];
if (req) {
  req.model = [
    '@odatano/core/db/schema',
    '@odatano/core/srv/cardano-service',
    '@odatano/core/srv/cardano-tx-service'
  ];
}

logger.debug('Plugin registered');

/**
 * Initialize blockchain components when services are served
 */
cds.on('served', async () => {
  if (initialized) return;

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
