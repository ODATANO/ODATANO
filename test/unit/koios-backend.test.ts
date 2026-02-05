import nock from 'nock';

jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

import { KoiosBackend } from '../../srv/blockchain/backends/koios-backend';
import { CARDANO_DEFAULTS } from '../../srv/utils/const';

describe('KoiosBackend', () => {
  let backend: KoiosBackend;

  const NETWORK = 'mainnet' as const;
  const TIMEOUT_MS = 5000;
  const KOIOS_BASE_URL = 'https://api.koios.rest';

  beforeEach(() => {
    backend = new KoiosBackend(NETWORK, TIMEOUT_MS);
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

      nock(KOIOS_BASE_URL)
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, totalsResponse);

      const result = await backend.getNetworkInformation();

      expect(result).toEqual({
        supply: {
          max: CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY,
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
      nock(KOIOS_BASE_URL)
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

      nock(KOIOS_BASE_URL)
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

    it('should use CARDANO_DEFAULTS max supply when genesis maxlovelacesupply is missing', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, []);

      // Genesis without maxlovelacesupply
      nock(KOIOS_BASE_URL)
        .get('/api/v1/genesis')
        .reply(200, [{ networkmagic: '1' }]);

      const result = await backend.getNetworkInformation();

      expect(result.supply.max).toBe(CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY);
    });
  });

  describe('constructor', () => {
    it('should create backend with API key', () => {
      const backendWithKey = new KoiosBackend('preview', 10000, 'test-api-key');
      expect(backendWithKey.name).toBe('koios');
    });

    it('should create backend without API key', () => {
      const backendWithoutKey = new KoiosBackend('preprod', 10000);
      expect(backendWithoutKey.name).toBe('koios');
    });
  });

  describe('getProtocolParameters', () => {
    it('should return protocol parameters from /cli_protocol_params', async () => {
      const mockProtocolParams = {
        txFeePerByte: 44,
        txFeeFixed: 155381,
        maxTxSize: 16384,
        maxBlockHeaderSize: 1100,
        maxBlockBodySize: 65536,
        stakeAddressDeposit: 2000000,
        stakePoolDeposit: 500000000,
        poolRetireMaxEpoch: 18,
        stakePoolTargetNum: 500,
        poolPledgeInfluence: 0.3,
        monetaryExpansion: 0.003,
        treasuryCut: 0.2,
        minPoolCost: 340000000,
        protocolVersion: { major: 8, minor: 0 },
        executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 },
        maxTxExecutionUnits: { memory: 14000000, steps: 10000000000 },
        maxBlockExecutionUnits: { memory: 62000000, steps: 20000000000 },
        maxValueSize: 5000,
        collateralPercentage: 150,
        maxCollateralInputs: 3,
        utxoCostPerByte: 4310,
        costModels: {
          'PlutusV3': Array(297).fill(1000)
        }
      };

      nock(KOIOS_BASE_URL)
        .get('/api/v1/cli_protocol_params')
        .reply(200, mockProtocolParams);

      const result = await backend.getProtocolParameters();

      expect(result).toHaveProperty('minFeeA', 44);
      expect(result).toHaveProperty('minFeeB', 155381);
      expect(result).toHaveProperty('maxTxSize', 16384);
      expect(result).toHaveProperty('network', 'mainnet');
    });

    it('should throw on API error', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/cli_protocol_params')
        .reply(500, { error: 'Internal server error' });

      await expect(backend.getProtocolParameters()).rejects.toThrow();
    });
  });
});
