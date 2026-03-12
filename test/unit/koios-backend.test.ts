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
  const TEST_ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

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

      // Fallback uses genesis max supply for all supply fields
      expect(result).toEqual({
        supply: {
          max: '45000000000000000',
          total: '45000000000000000',
          circulating: '45000000000000000',
          locked: '0',
          treasury: '0',
          reserves: '0',
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

  describe('getAddressTransactions', () => {
    it('should fetch only up to the requested limit', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_txs')
        .reply(200, [
          { tx_hash: 'a'.repeat(64) },
          { tx_hash: 'b'.repeat(64) },
          { tx_hash: 'c'.repeat(64) },
        ]);

      const getTxSpy = jest.spyOn(backend, 'getTransaction')
        .mockResolvedValueOnce({ hash: 'a'.repeat(64) } as any)
        .mockResolvedValueOnce({ hash: 'b'.repeat(64) } as any);

      const result = await backend.getAddressTransactions(TEST_ADDR, 2);

      expect(result).toHaveLength(2);
      expect(getTxSpy).toHaveBeenCalledTimes(2);
      expect(getTxSpy).toHaveBeenNthCalledWith(1, 'a'.repeat(64));
      expect(getTxSpy).toHaveBeenNthCalledWith(2, 'b'.repeat(64));
    });
  });

  describe('not found and fallback branches', () => {
    it('should throw when getBlock receives empty results after retry', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/block_info')
        .times(2)
        .reply(200, []);

      await expect(backend.getBlock('a'.repeat(64))).rejects.toThrow();
    });

    it('should throw when /totals is empty and /genesis has no rows', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, []);

      nock(KOIOS_BASE_URL)
        .get('/api/v1/genesis')
        .reply(200, []);

      await expect(backend.getNetworkInformation()).rejects.toThrow();
    });

    it('should throw when latest block tip is empty after retry', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/tip')
        .times(2)
        .reply(200, []);

      await expect(backend.getLatestBlock()).rejects.toThrow();
    });

    it('should fallback to previous epoch when current epoch is unavailable', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/tip')
        .reply(200, [{ hash: 'tiphash', epoch_no: 100 }]);

      const epoch99 = {
        epoch: 99,
        start_time: 1700000000,
        end_time: 1700001000,
        first_block_time: 1700000001,
        last_block_time: 1700000999,
        block_count: 10,
        tx_count: 20,
        output: '1000',
        fees: '5',
        active_stake: '2000',
      };

      const epochSpy = jest.spyOn(backend, 'getEpoch')
        .mockRejectedValueOnce(new Error('current epoch not indexed yet'))
        .mockResolvedValueOnce(epoch99 as any);

      const result = await backend.getLatestEpoch();

      expect(result.epoch).toBe(99);
      expect(epochSpy).toHaveBeenNthCalledWith(1, 100);
      expect(epochSpy).toHaveBeenNthCalledWith(2, 99);
    });
  });

  describe('batch and datum helpers', () => {
    it('should return partial batch map when some transactions are missing', async () => {
      const txHash1 = 'a'.repeat(64);
      const txHash2 = 'b'.repeat(64);

      nock(KOIOS_BASE_URL)
        .post('/api/v1/tx_info')
        .reply(200, [
          {
            tx_hash: txHash1,
            block_hash: 'c'.repeat(64),
            block_height: 1,
            tx_timestamp: 1700000000,
            absolute_slot: 10,
            tx_index: 0,
            tx_fee: '170000',
            deposit: '0',
            tx_size: 300,
            inputs: [
              {
                payment_addr: { bech32: TEST_ADDR },
                tx_hash: 'd'.repeat(64),
                tx_index: 0,
                value: '5000000',
                datum_hash: null,
                inline_datum: null,
                reference_script: null,
                asset_list: [],
              },
            ],
            outputs: [
              {
                payment_addr: { bech32: TEST_ADDR },
                tx_index: 0,
                value: '4800000',
                datum_hash: null,
                inline_datum: null,
                reference_script: null,
                asset_list: [],
              },
            ],
            metadata: null,
          },
        ]);

      const result = await backend.getTransactionsBatch([txHash1, txHash2]);

      expect(result.size).toBe(1);
      expect(result.has(txHash1)).toBe(true);
      expect(result.has(txHash2)).toBe(false);
    });

    it('should sanitize inline datum variants', () => {
      const sanitize = (backend as any)._sanitizeInlineDatum.bind(backend);

      expect(sanitize(null)).toBeNull();
      expect(sanitize('inline-cbor')).toBe('inline-cbor');
      expect(sanitize({ bytes: null, value: null })).toBeNull();
      expect(sanitize({ constructor: 0, fields: [] })).toEqual({ constructor: 0, fields: [] });
    });
  });
});
