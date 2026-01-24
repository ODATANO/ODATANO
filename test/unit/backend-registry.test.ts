jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('../../config/config', () => ({
  CONFIG: {
    backends: ['ogmios'],
    ogmiosUrl: 'ws://localhost:1337',
    network: 'preview'
  }
}));

jest.mock('../../srv/blockchain/backends/ogmios-backend', () => ({
  OgmiosBackend: jest.fn().mockImplementation(() => ({ name: 'ogmios' }))
}));

jest.mock('../../srv/blockchain/backends/blockfrost-backend', () => ({
  BlockfrostBackend: jest.fn().mockImplementation(() => ({ name: 'blockfrost' }))
}));

jest.mock('../../srv/blockchain/backends/koios-backend', () => ({
  KoiosBackend: jest.fn().mockImplementation(() => ({ name: 'koios' }))
}));

import { BackendRegistry } from '../../srv/blockchain/backends/backend-registry';
import { ConfigError } from '../../srv/utils/errors';

describe('BackendRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw ConfigError for unknown backend name', () => {
      const unknownBackend = 'unknown-backend';

      expect(() => BackendRegistry.create(unknownBackend))
        .toThrow(ConfigError);
      expect(() => BackendRegistry.create(unknownBackend))
        .toThrow(`Unknown backend: ${unknownBackend}`);
    });

    it('should throw ConfigError with correct message for empty string', () => {
      expect(() => BackendRegistry.create(''))
        .toThrow(ConfigError);
      expect(() => BackendRegistry.create(''))
        .toThrow('Unknown backend: ');
    });
  });
});
