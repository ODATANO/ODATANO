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
import { ProviderUnavailableError } from '../../srv/utils/errors';

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
    it('should sort newest-first, apply the limit, and fetch via batch', async () => {
      // Koios gives NO ordering guarantee — rows arrive out of order here
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_txs')
        .reply(200, [
          { tx_hash: 'a'.repeat(64), block_height: 100 },
          { tx_hash: 'c'.repeat(64), block_height: 300 },
          { tx_hash: 'b'.repeat(64), block_height: 200 },
        ]);

      const batchSpy = jest.spyOn(backend, 'getTransactionsBatch').mockResolvedValue(new Map([
        ['c'.repeat(64), { hash: 'c'.repeat(64) } as any],
        ['b'.repeat(64), { hash: 'b'.repeat(64) } as any],
      ]));

      const result = await backend.getAddressTransactions(TEST_ADDR, 2);

      // newest two (heights 300, 200) — previously slice(0,2) returned a,c (arbitrary)
      expect(batchSpy).toHaveBeenCalledWith(['c'.repeat(64), 'b'.repeat(64)]);
      expect(result.map(t => t.hash)).toEqual(['c'.repeat(64), 'b'.repeat(64)]);
    });
  });

  describe('getAddressTransactionHashes', () => {
    it('should return the newest hashes first regardless of response order', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_txs')
        .reply(200, [
          { tx_hash: 'a'.repeat(64), block_height: 100 },
          { tx_hash: 'c'.repeat(64), block_height: 300 },
          { tx_hash: 'b'.repeat(64), block_height: 200 },
        ]);

      const result = await backend.getAddressTransactionHashes(TEST_ADDR, 2);
      expect(result).toEqual(['c'.repeat(64), 'b'.repeat(64)]);
    });
  });

  describe('not found and fallback branches', () => {
    it('should throw when getBlock receives empty results after retry', async () => {
      // fetchWithRetryOnEmpty does 1 initial call + 3 retries = 4 attempts.
      // Previous .times(2) let the 3rd/4th attempts hit nock no-match and leak
      // unhandled async errors into later tests via their setTimeout callbacks.
      const blockInfoScope = nock(KOIOS_BASE_URL)
        .post('/api/v1/block_info')
        .times(4)
        .reply(200, []);

      await expect(backend.getBlock('a'.repeat(64))).rejects.toThrow();
      expect(blockInfoScope.isDone()).toBe(true);
    });

    it('should throw when /totals is empty and /genesis has no rows', async () => {
      const totalsScope = nock(KOIOS_BASE_URL)
        .get('/api/v1/totals')
        .query({ order: 'epoch_no.desc', limit: 1 })
        .reply(200, []);

      const genesisScope = nock(KOIOS_BASE_URL)
        .get('/api/v1/genesis')
        .reply(200, []);

      await expect(backend.getNetworkInformation()).rejects.toThrow();
      expect(totalsScope.isDone()).toBe(true);
      expect(genesisScope.isDone()).toBe(true);
    });

    it('should throw when latest block tip is empty after retry', async () => {
      // 1 initial + 3 retries. See note on getBlock test above re: leak into later tests.
      const tipScope = nock(KOIOS_BASE_URL)
        .get('/api/v1/tip')
        .times(4)
        .reply(200, []);

      await expect(backend.getLatestBlock()).rejects.toThrow();
      expect(tipScope.isDone()).toBe(true);
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

  describe('getDrep', () => {
    const DREP_ID = 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0';
    const DREP_HEX = 'bed9febc46ee63fa370bbc65446c067d61adcc46d8094e372694666b';

    // New Koios schema (observed 2026-07): drep_status/active/expires_epoch_no
    // replaced expired/retired/last_active_epoch.
    const newSchemaRow = {
      drep_id: DREP_ID,
      hex: DREP_HEX,
      has_script: false,
      drep_status: 'registered',
      deposit: '500000000',
      active: true,
      expires_epoch_no: 1369,
      amount: '9653730',
    };

    it('should map the new drep_info schema (registered + active)', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info', { _drep_ids: [DREP_ID] })
        .reply(200, [newSchemaRow]);

      const result = await backend.getDrep(DREP_ID);

      expect(result).toEqual({
        drepId: DREP_ID,
        hex: DREP_HEX,
        amount: '9653730',
        hasScript: false,
        lastActiveEpoch: 0,
        expired: false,
        retired: false,
      });
    });

    it('should derive retired from drep_status in the new schema', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info')
        .reply(200, [{ ...newSchemaRow, drep_status: 'retired', active: false }]);

      const result = await backend.getDrep(DREP_ID);

      expect(result.retired).toBe(true);
      expect(result.expired).toBe(false);
    });

    it('should derive expired from active=false (not retired) in the new schema', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info')
        .reply(200, [{ ...newSchemaRow, drep_status: 'registered', active: false }]);

      const result = await backend.getDrep(DREP_ID);

      expect(result.expired).toBe(true);
      expect(result.retired).toBe(false);
    });

    it('should prefer the old schema fields when present (mainnet/preprod lag)', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info')
        .reply(200, [{
          drep_id: DREP_ID,
          hex: DREP_HEX,
          has_script: false,
          amount: '9653730',
          last_active_epoch: 500,
          expired: true,
          retired: false,
        }]);

      const result = await backend.getDrep(DREP_ID);

      expect(result.lastActiveEpoch).toBe(500);
      expect(result.expired).toBe(true);
      expect(result.retired).toBe(false);
    });

    it('should retry an instance-specific PostgREST 400 (42703) and succeed', async () => {
      // Real-world case: one Koios LB instance serves a half-migrated SQL
      // function while the others are healthy — the retry lands on a healthy one.
      const scope = nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info')
        .reply(400, { code: '42703', details: null, hint: null, message: 'column dc.live_deleg_count does not exist' })
        .post('/api/v1/drep_info')
        .reply(200, [newSchemaRow]);

      const result = await backend.getDrep(DREP_ID);

      expect(result.drepId).toBe(DREP_ID);
      expect(scope.isDone()).toBe(true);
    });

    it('should surface ProviderUnavailableError (503) when PostgREST retries are exhausted', async () => {
      // 1 initial attempt + 2 interceptor retries = 3 requests.
      const scope = nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info')
        .times(3)
        .reply(400, { code: '42703', message: 'column dc.live_deleg_count does not exist' });

      const err = await backend.getDrep(DREP_ID).catch(e => e);
      expect(err).toBeInstanceOf(ProviderUnavailableError);
      expect(err.statusCode).toBe(503);
      expect(scope.isDone()).toBe(true);
    });

    it('should NOT retry PostgREST client-input errors (class 22)', async () => {
      const scope = nock(KOIOS_BASE_URL)
        .post('/api/v1/drep_info')
        .reply(400, { code: '22P02', message: 'invalid input syntax for type' });

      await expect(backend.getDrep(DREP_ID)).rejects.toThrow();
      expect(scope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });

  describe('getEpoch', () => {
    it('should return epoch data for a valid epoch number', async () => {
      const epochResponse = [{
        epoch_no: 100,
        start_time: 1700000000,
        end_time: 1700086400,
        first_block_time: 1700000010,
        last_block_time: 1700086390,
        block_count: 21600,
        tx_count: 5000,
        total_output: '50000000000000',
        total_fees: '25000000',
        active_stake: '15000000000000000',
      }];

      nock(KOIOS_BASE_URL)
        .get('/api/v1/epoch_info')
        .query({ _epoch_no: 100 })
        .reply(200, epochResponse);

      const result = await backend.getEpoch(100);

      expect(result).toEqual({
        epoch: 100,
        start_time: 1700000000,
        end_time: 1700086400,
        first_block_time: 1700000010,
        last_block_time: 1700086390,
        block_count: 21600,
        tx_count: 5000,
        output: '50000000000000',
        fees: '25000000',
        active_stake: '15000000000000000',
      });
    });

    it('should throw NotFoundError when epoch_info returns empty array after retries', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/epoch_info')
        .query({ _epoch_no: 99999 })
        .times(4) // 1 initial + 3 retries
        .reply(200, []);

      await expect(backend.getEpoch(99999)).rejects.toThrow('Epoch');
    });

    it('should throw on API error', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/epoch_info')
        .query({ _epoch_no: 100 })
        .reply(500, { error: 'Internal server error' });

      await expect(backend.getEpoch(100)).rejects.toThrow();
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

  });

  describe('getAddressUtxos', () => {
    it('extracts hex CBOR from Koios _extended inline_datum wrapper', async () => {
      const txHash = 'a'.repeat(64);
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_utxos')
        .reply(200, [
          {
            tx_hash: txHash,
            tx_index: 0,
            block_hash: 'c'.repeat(64),
            value: '10000000',
            datum_hash: null,
            inline_datum: { bytes: '19a6aa', value: { int: 42 } },
            reference_script: null,
            asset_list: [],
          },
        ]);

      const result = await backend.getAddressUtxos(TEST_ADDR);
      expect(result).toHaveLength(1);
      expect(result[0].inlineDatum).toBe('19a6aa');
    });

    it('returns null inlineDatum for empty Koios wrapper', async () => {
      const txHash = 'a'.repeat(64);
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_utxos')
        .reply(200, [
          {
            tx_hash: txHash,
            tx_index: 0,
            block_hash: 'c'.repeat(64),
            value: '10000000',
            datum_hash: null,
            inline_datum: { bytes: null, value: null },
            reference_script: null,
            asset_list: [],
          },
        ]);

      const result = await backend.getAddressUtxos(TEST_ADDR);
      expect(result).toHaveLength(1);
      expect(result[0].inlineDatum).toBeNull();
    });

    it('returns null inlineDatum when field is null', async () => {
      const txHash = 'a'.repeat(64);
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_utxos')
        .reply(200, [
          {
            tx_hash: txHash,
            tx_index: 0,
            block_hash: 'c'.repeat(64),
            value: '10000000',
            datum_hash: null,
            inline_datum: null,
            reference_script: null,
            asset_list: [],
          },
        ]);

      const result = await backend.getAddressUtxos(TEST_ADDR);
      expect(result).toHaveLength(1);
      expect(result[0].inlineDatum).toBeNull();
    });

    it('extracts script CBOR bytes from the extended reference_script OBJECT (v1.6.1 refScript)', async () => {
      const scriptBytes = '5876010100' + 'ab'.repeat(40); // full CBOR-wrapped script hex (>56 chars)
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_utxos')
        .reply(200, [
          {
            tx_hash: 'a'.repeat(64),
            tx_index: 0,
            block_hash: 'c'.repeat(64),
            value: '10000000',
            datum_hash: null,
            inline_datum: null,
            // _extended:true shape — the old `as string` cast handed this object downstream
            reference_script: {
              hash: 'd'.repeat(56),
              size: 42,
              type: 'plutusV3',
              bytes: scriptBytes,
              value: null,
            },
            asset_list: [],
          },
        ]);

      const result = await backend.getAddressUtxos(TEST_ADDR);
      expect(result).toHaveLength(1);
      expect(result[0].scriptRef).toBe(scriptBytes);
    });

    it('falls back to the script hash when the extended object carries no bytes', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/address_utxos')
        .reply(200, [
          {
            tx_hash: 'a'.repeat(64),
            tx_index: 0,
            block_hash: 'c'.repeat(64),
            value: '10000000',
            datum_hash: null,
            inline_datum: null,
            reference_script: { hash: 'd'.repeat(56), size: 42, type: 'plutusV3', bytes: null, value: null },
            asset_list: [],
          },
        ]);

      const result = await backend.getAddressUtxos(TEST_ADDR);
      expect(result[0].scriptRef).toBe('d'.repeat(56));
    });
  });

  describe('getCredentialUtxos', () => {
    const CRED_HASH = 'a'.repeat(56);
    const ADDR_WITH_STAKE = 'addr1z' + 'q'.repeat(98);
    const ADDR_NO_STAKE = 'addr1w' + 'q'.repeat(56);

    it('returns UTxOs across multiple bech32 forms with one POST', async () => {
      let capturedBody: any = null;
      nock(KOIOS_BASE_URL)
        .post('/api/v1/credential_utxos', (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, [
          {
            tx_hash: 'a'.repeat(64),
            tx_index: 0,
            address: ADDR_WITH_STAKE,
            block_hash: 'c'.repeat(64),
            value: '10000000',
            datum_hash: null,
            inline_datum: { bytes: 'd87980', value: { constructor: 0, fields: [] } },
            reference_script: null,
            asset_list: [],
          },
          {
            tx_hash: 'b'.repeat(64),
            tx_index: 1,
            address: ADDR_NO_STAKE,
            block_hash: 'c'.repeat(64),
            value: '5000000',
            datum_hash: null,
            inline_datum: null,
            reference_script: null,
            asset_list: [],
          },
        ]);

      const result = await backend.getCredentialUtxos(CRED_HASH);

      expect(capturedBody).toMatchObject({
        _payment_credentials: [CRED_HASH],
        _extended: true,
      });
      expect(result).toHaveLength(2);
      expect(result[0].address).toBe(ADDR_WITH_STAKE);
      expect(result[1].address).toBe(ADDR_NO_STAKE);
      expect(result[0].inlineDatum).toBe('d87980');
      expect(result[1].inlineDatum).toBeNull();
    });

    it('returns empty array when credential has no UTxOs', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/credential_utxos')
        .reply(200, []);

      const result = await backend.getCredentialUtxos(CRED_HASH);
      expect(result).toEqual([]);
    });

    it('throws on Koios 5xx error', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/credential_utxos')
        .reply(500, { error: 'Internal server error' });

      await expect(backend.getCredentialUtxos(CRED_HASH)).rejects.toThrow();
    });

    it('hydrates native assets per UTxO', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/credential_utxos')
        .reply(200, [
          {
            tx_hash: 'a'.repeat(64),
            tx_index: 0,
            address: ADDR_WITH_STAKE,
            block_hash: 'c'.repeat(64),
            value: '2000000',
            datum_hash: null,
            inline_datum: null,
            reference_script: null,
            asset_list: [
              { policy_id: 'a'.repeat(56), asset_name: '484f534b59', quantity: '100' },
            ],
          },
        ]);

      const result = await backend.getCredentialUtxos(CRED_HASH);
      expect(result[0].amount).toEqual([
        { unit: 'lovelace', quantity: '2000000' },
        { unit: 'a'.repeat(56) + '484f534b59', quantity: '100' },
      ]);
    });
  });

  describe('getAssetInfo', () => {
    const POLICY = 'a'.repeat(56);
    const ASSET_NAME_HEX = '484f534b59';
    const UNIT = POLICY + ASSET_NAME_HEX;

    it('combines mint_cnt + burn_cnt and extracts CIP-25 label 721', async () => {
      let captured: any = null;
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_info', (body) => { captured = body; return true; })
        .reply(200, [{
          policy_id: POLICY,
          asset_name: ASSET_NAME_HEX,
          asset_name_ascii: 'HOSKY',
          fingerprint: 'asset1xyz',
          minting_tx_hash: 'b'.repeat(64),
          total_supply: '1000000000',
          mint_cnt: 5,
          burn_cnt: 2,
          creation_time: 1700000000,
          minting_tx_metadata: {
            '721': { [POLICY]: { HOSKY: { name: 'Hosky' } } },
          },
          token_registry_metadata: {
            name: 'Hosky Token',
            ticker: 'HOSKY',
            decimals: 0,
            description: 'Wow such token',
            url: 'https://hosky.io',
            logo: 'data:image/png;base64,...',
          },
        }]);

      const result = await backend.getAssetInfo(UNIT);

      expect(captured).toMatchObject({
        _asset_list: [[POLICY, ASSET_NAME_HEX]],
      });
      expect(result.unit).toBe(UNIT);
      expect(result.policyId).toBe(POLICY);
      expect(result.assetNameHex).toBe(ASSET_NAME_HEX);
      expect(result.assetName).toBe('HOSKY');
      expect(result.totalSupply).toBe('1000000000');
      expect(result.mintOrBurnCount).toBe(7);
      expect(result.initialMintTxHash).toBe('b'.repeat(64));
      expect(result.initialMintTime).toBe(1700000000);
      expect(result.onchainMetadata).toEqual({ [POLICY]: { HOSKY: { name: 'Hosky' } } });
      expect(result.registryName).toBe('Hosky Token');
      expect(result.registryTicker).toBe('HOSKY');
      expect(result.registryDecimals).toBe(0);
    });

    it('returns null for missing metadata fields', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_info')
        .reply(200, [{
          policy_id: POLICY,
          asset_name: ASSET_NAME_HEX,
          fingerprint: 'asset1xyz',
          total_supply: '1',
          mint_cnt: 1,
          burn_cnt: 0,
        }]);

      const result = await backend.getAssetInfo(UNIT);

      expect(result.onchainMetadata).toBeNull();
      expect(result.registryName).toBeNull();
      expect(result.initialMintTime).toBeNull();
      expect(result.mintOrBurnCount).toBe(1);
    });

    it('throws NotFoundError for empty result', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_info')
        .reply(200, []);

      await expect(backend.getAssetInfo(UNIT)).rejects.toThrow(/not found/i);
    });

    it('throws NotFoundError for malformed unit', async () => {
      await expect(backend.getAssetInfo('not-hex-unit')).rejects.toThrow(/not found/i);
    });
  });

  describe('getAssetHistory', () => {
    const POLICY = 'a'.repeat(56);
    const ASSET_NAME_HEX = '484f534b59';
    const UNIT = POLICY + ASSET_NAME_HEX;

    it('derives action from sign and stores absolute quantity', async () => {
      let captured: any = null;
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_history', (body) => { captured = body; return true; })
        .reply(200, [{
          policy_id: POLICY,
          asset_name: ASSET_NAME_HEX,
          minting_txs: [
            { tx_hash: 'a'.repeat(64), block_time: 1700000200, block_height: 200, quantity: '1000' },
            { tx_hash: 'b'.repeat(64), block_time: 1700000100, block_height: 199, quantity: '-50' },
          ],
        }]);

      const result = await backend.getAssetHistory(UNIT);

      expect(captured).toMatchObject({
        _asset_list: [[POLICY, ASSET_NAME_HEX]],
      });
      expect(result).toEqual([
        { unit: UNIT, txHash: 'a'.repeat(64), action: 'mint', quantity: '1000', blockTime: 1700000200, blockHeight: 200 },
        { unit: UNIT, txHash: 'b'.repeat(64), action: 'burn', quantity: '50',   blockTime: 1700000100, blockHeight: 199 },
      ]);
    });

    it('sorts by block_time descending and applies limit', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_history')
        .reply(200, [{
          policy_id: POLICY,
          asset_name: ASSET_NAME_HEX,
          minting_txs: [
            // intentionally out of order
            { tx_hash: 'a'.repeat(64), block_time: 100, quantity: '1' },
            { tx_hash: 'b'.repeat(64), block_time: 300, quantity: '1' },
            { tx_hash: 'c'.repeat(64), block_time: 200, quantity: '1' },
          ],
        }]);

      const result = await backend.getAssetHistory(UNIT, 2);
      expect(result).toHaveLength(2);
      expect(result[0].txHash).toBe('b'.repeat(64));
      expect(result[1].txHash).toBe('c'.repeat(64));
    });

    it('returns empty array when asset has no minting_txs', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_history')
        .reply(200, [{ policy_id: POLICY, asset_name: ASSET_NAME_HEX, minting_txs: [] }]);

      const result = await backend.getAssetHistory(UNIT);
      expect(result).toEqual([]);
    });

    it('returns empty array when response is empty', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/asset_history')
        .reply(200, []);

      const result = await backend.getAssetHistory(UNIT);
      expect(result).toEqual([]);
    });

    it('throws NotFoundError for malformed unit', async () => {
      await expect(backend.getAssetHistory('garbage')).rejects.toThrow(/not found/i);
    });
  });

  describe('getCurrentSlot', () => {
    it('returns abs_slot directly from /tip', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/tip')
        .reply(200, [{ hash: 'tiphash', epoch_no: 100, abs_slot: 80_000_123 }]);

      expect(await backend.getCurrentSlot()).toBe(80_000_123);
    });

    it('throws NotFoundError when /tip returns empty array', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/tip')
        .times(4)
        .reply(200, []);

      await expect(backend.getCurrentSlot()).rejects.toThrow(/not found/i);
    });

    it('throws ProviderUnavailableError when /tip row has no abs_slot', async () => {
      nock(KOIOS_BASE_URL)
        .get('/api/v1/tip')
        .reply(200, [{ hash: 'tiphash', epoch_no: 100 }]);

      await expect(backend.getCurrentSlot()).rejects.toThrow(/abs_slot/);
    });
  });

  describe('isUtxoUnspent', () => {
    const TX = 'a'.repeat(64);

    it('returns true when /utxo_info reports is_spent=false', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/utxo_info', { _utxo_refs: [`${TX}#0`], _extended: false })
        .reply(200, [{ tx_hash: TX, tx_index: 0, is_spent: false }]);

      expect(await backend.isUtxoUnspent(TX, 0)).toBe(true);
    });

    it('returns false when /utxo_info reports is_spent=true', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/utxo_info', { _utxo_refs: [`${TX}#0`], _extended: false })
        .reply(200, [{ tx_hash: TX, tx_index: 0, is_spent: true }]);

      expect(await backend.isUtxoUnspent(TX, 0)).toBe(false);
    });

    it('returns false when /utxo_info returns an empty array (nonexistent)', async () => {
      nock(KOIOS_BASE_URL)
        .post('/api/v1/utxo_info', { _utxo_refs: [`${TX}#0`], _extended: false })
        .reply(200, []);

      expect(await backend.isUtxoUnspent(TX, 0)).toBe(false);
    });

    it('lowercases the txHash before building the utxo ref', async () => {
      const MIXED = 'A'.repeat(64);
      nock(KOIOS_BASE_URL)
        .post('/api/v1/utxo_info', { _utxo_refs: [`${'a'.repeat(64)}#3`], _extended: false })
        .reply(200, [{ is_spent: false }]);

      expect(await backend.isUtxoUnspent(MIXED, 3)).toBe(true);
    });

    it('returns false for negative outputIndex without hitting the network', async () => {
      // No nock interceptor set up — if the implementation calls out, nock throws.
      expect(await backend.isUtxoUnspent(TX, -1)).toBe(false);
    });

    it('returns false for non-integer outputIndex without hitting the network', async () => {
      expect(await backend.isUtxoUnspent(TX, 1.5)).toBe(false);
    });
  });
});
