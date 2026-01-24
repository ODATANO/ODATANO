import nock from 'nock';

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
    koiosApiUrl: 'https://api.koios.rest/api/v1',
    network: 'mainnet',
    primaryTimeoutMs: 5000,
    CARDANO_PROTOCOL: {
      MAX_LOVELACE_SUPPLY: '45000000000000000',
    },
  },
}));

import { KoiosBackend } from '../../srv/blockchain/backends/koios-backend';
import { CONFIG } from '../../config/config';

describe('KoiosBackend', () => {
  let backend: KoiosBackend;

  beforeEach(() => {
    backend = new KoiosBackend();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('getNetworkInformation', () => {
    it('should return network info from /totals endpoint when data is available (mainnet)', async () => {
      // Mock data based on actual mainnet response
      const totalsResponse = [{
        epoch_no: 608,
        circulation: '36035240284477897',
        treasury: '1614459422162537',
        reward: '733225009829408',
        supply: '38388567212743111',
        reserves: '6611432787256889',
        fees: '39018273269',
        deposits_stake: '4399478000000',
        deposits_drep: '504000000000',
        deposits_proposal: '700000000000'
      }];

      nock('https://api.koios.rest')
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, totalsResponse);

      const result = await backend.getNetworkInformation();

      expect(result).toEqual({
        supply: {
          max: CONFIG.CARDANO_PROTOCOL.MAX_LOVELACE_SUPPLY,
          total: '38388567212743111',
          circulating: '36035240284477897',
          locked: '0',
          treasury: '1614459422162537',
          reserves: '6611432787256889',
        },
        stake: {
          live: '0',
          active: '0',
        },
      });
    });

    it('should fallback to /genesis endpoint when /totals returns empty array (preview/preprod)', async () => {
      // Mock empty /totals response (preview/preprod behavior)
      nock('https://api.koios.rest')
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, []);

      // Mock /genesis response
      const genesisResponse = [{
        networkmagic: '1',
        networkid: 'preview',
        epochlength: 86400,
        slotlength: 1,
        maxlovelacesupply: '45000000000000000',
        systemstart: '2022-04-01T00:00:00Z',
        activeslotcoeff: '0.05',
        slotsperkesperiod: 129600,
        maxkesrevolutions: 62,
        securityparam: 2160,
        updatequorum: 5,
        alonzogenesis: '{}',
        conwaygenesis: '{}'
      }];

      nock('https://api.koios.rest')
        .get('/api/v1/genesis')
        .reply(200, genesisResponse);

      const result = await backend.getNetworkInformation();

      // Fallback uses mainnet epoch 608 snapshot as defaults
      expect(result).toEqual({
        supply: {
          max: '45000000000000000',
          total: '38388567212743111',
          circulating: '36035240284477897',
          locked: '0',
          treasury: '1614459422162537',
          reserves: '6611432787256889',
        },
        stake: {
          live: '0',
          active: '0',
        },
      });
    });

    it('should use CONFIG max supply when genesis maxlovelacesupply is missing', async () => {
      nock('https://api.koios.rest')
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, []);

      // Genesis without maxlovelacesupply
      nock('https://api.koios.rest')
        .get('/api/v1/genesis')
        .reply(200, [{ networkmagic: '1' }]);

      const result = await backend.getNetworkInformation();

      expect(result.supply.max).toBe(CONFIG.CARDANO_PROTOCOL.MAX_LOVELACE_SUPPLY);
    });
  });
});
