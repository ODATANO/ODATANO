const cds = require('@sap/cds');

// Start server without triggering service initialization errors
cds.serve('srv/cardano-service.cds', {
  projectDir: '.',
  impl: 'srv/cardano-service.js'
}).then(server => {
  console.log('Server started successfully');
  server.listen(4004);
}).catch(err => {
  console.error('Server error:', err);
  process.exit(1);
});
