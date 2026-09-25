/**
 * Keyed reads on index-on-miss entities honour the client's `$expand` / `$select`:
 * the keyed branch indexes on a miss and then runs `req.query`, like the collection form.
 */

import cds from '@sap/cds';
// Native require: must share the module graph of the cds.test()-booted CAP
// server, or the handlers never see the app context set by createTestContext.
const { createTestContext, resetAppContext, shutdownAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
import { TEST_FIXTURES, SCRIPT_UTXO_TX_HASH, SCRIPT_UTXO_OUTPUT_INDEX, mockScriptTxInfo, mockUtxosAdaOnly } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, setupTxInfoMock, teardownKoiosMocks, nock } from './mock-helpers';
import { mapBareAsset } from '../../srv/utils/mappers';

const { INSERT } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';

const SVC = '/odata/v4/cardano-odata';

/** Seeded (cache-hit) transaction — never touches the backend. */
const SEEDED_TX_HASH = '1111222233334444555566667777888899990000111122223333444455556666';

describe('Keyed reads honour $expand / $select', () => {
  const test = cds.test(__dirname + '/../../');

  beforeAll(async () => {
    setupNocks();
    setupKoiosMocks();
    const testContext = await createTestContext(['koios']);
    resetAppContext(testContext);
  });

  beforeEach(async () => {
    await test.data.reset();
    setupNocks();
    setupKoiosMocks();

    // Seed a fully materialised transaction (row + 2 inputs + 2 outputs) so
    // the keyed read is a cache HIT and no backend call is involved.
    await cds.run(
      INSERT.into('odatano.cardano.Transactions').entries({
        hash: SEEDED_TX_HASH,
        blockHash: TEST_FIXTURES.validBlockHash,
        blockHeight: 4242,
        blockTime: 1704067200,
        slot: 50000000,
        txIndex: 0,
        fee: 200000,
        deposit: 0,
        size: 300,
        hasMetadata: false,
        hasInputs: true,
        hasOutputs: true,
      })
    );
    await cds.run(
      INSERT.into('odatano.cardano.TransactionInputs').entries([
        { tx_hash: SEEDED_TX_HASH, inputIndex: 0, address_address: TEST_FIXTURES.addressWithFunds, isCollateral: false, isReference: false, hasAddresses: true, hasAssets: false },
        { tx_hash: SEEDED_TX_HASH, inputIndex: 1, address_address: TEST_FIXTURES.addressWithFunds, isCollateral: false, isReference: false, hasAddresses: true, hasAssets: false },
      ])
    );
    await cds.run(
      INSERT.into('odatano.cardano.TransactionOutputs').entries([
        { tx_hash: SEEDED_TX_HASH, outputIndex: 0, address_address: TEST_FIXTURES.emptyAddress, hasAddresses: true, hasAssets: false },
        { tx_hash: SEEDED_TX_HASH, outputIndex: 1, address_address: TEST_FIXTURES.addressWithFunds, hasAddresses: true, hasAssets: false },
      ])
    );
  });

  afterEach(() => {
    resetKoiosMocks();
  });

  afterAll(async () => {
    teardownKoiosMocks();
    await shutdownAppContext();
  });

  // ==========================================================================
  // Cache HIT — seeded row
  // ==========================================================================

  it('keyed read without query options still returns the bare row', async () => {
    const { status, data } = await test.get(`${SVC}/Transactions('${SEEDED_TX_HASH}')`);
    expect(status).toBe(200);
    expect(data.hash).toBe(SEEDED_TX_HASH);
    expect(data.hasInputs).toBe(true);
    // no $expand → compositions are not inlined
    expect(data.inputs).toBeUndefined();
    expect(data.outputs).toBeUndefined();
  });

  it('keyed read with $expand=inputs,outputs inlines both compositions', async () => {
    const { status, data } = await test.get(`${SVC}/Transactions('${SEEDED_TX_HASH}')?$expand=inputs,outputs`);
    expect(status).toBe(200);
    expect(data.hash).toBe(SEEDED_TX_HASH);

    expect(Array.isArray(data.inputs)).toBe(true);
    expect(data.inputs).toHaveLength(2);
    expect(data.inputs.map((i: any) => i.inputIndex).sort()).toEqual([0, 1]);

    expect(Array.isArray(data.outputs)).toBe(true);
    expect(data.outputs).toHaveLength(2);
    expect(data.outputs.map((o: any) => o.outputIndex).sort()).toEqual([0, 1]);
    expect(data.outputs.find((o: any) => o.outputIndex === 0).address_address).toBe(TEST_FIXTURES.emptyAddress);
    // CAP 10 renders `@odata.context` as `$metadata#Transactions/$entity` for keyed
    // reads regardless of $expand, so the context is deliberately not asserted.
  });

  it('keyed read with nested $select inside $expand applies it', async () => {
    const { status, data } = await test.get(`${SVC}/Transactions('${SEEDED_TX_HASH}')?$expand=outputs($select=outputIndex,address_address)`);
    expect(status).toBe(200);
    expect(data.outputs).toHaveLength(2);
    const out = data.outputs.find((o: any) => o.outputIndex === 1);
    expect(out.address_address).toBe(TEST_FIXTURES.addressWithFunds);
    expect(out.hasAssets).toBeUndefined();
  });

  it('keyed read with $select returns only the selected fields', async () => {
    const { status, data } = await test.get(`${SVC}/Transactions('${SEEDED_TX_HASH}')?$select=hash,fee`);
    expect(status).toBe(200);
    expect(data.hash).toBe(SEEDED_TX_HASH);
    expect(data.fee).toBeDefined();
    // not selected → not returned
    expect(data.blockHash).toBeUndefined();
    expect(data.size).toBeUndefined();
  });

  it('keyed read result matches the collection form with $filter + $expand', async () => {
    const keyed = await test.get(`${SVC}/Transactions('${SEEDED_TX_HASH}')?$expand=inputs,outputs`);
    const coll = await test.get(`${SVC}/Transactions?$filter=hash eq '${SEEDED_TX_HASH}'&$expand=inputs,outputs`);
    expect(keyed.status).toBe(200);
    expect(coll.status).toBe(200);
    expect(coll.data.value).toHaveLength(1);

    const strip = (o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== '@odata.context'));
    expect(strip(keyed.data)).toEqual(strip(coll.data.value[0]));
  });

  // ==========================================================================
  // Cache MISS — indexed from the (mocked) backend, then expanded
  // ==========================================================================

  it('keyed read on a cache miss indexes the tx and honours $expand in the same request', async () => {
    setupTxInfoMock(mockScriptTxInfo);

    const { status, data } = await test.get(`${SVC}/Transactions('${SCRIPT_UTXO_TX_HASH}')?$expand=inputs,outputs`);
    expect(status).toBe(200);
    expect(data.hash).toBe(SCRIPT_UTXO_TX_HASH);

    expect(Array.isArray(data.inputs)).toBe(true);
    expect(data.inputs).toHaveLength(mockScriptTxInfo[0].inputs.length);

    expect(Array.isArray(data.outputs)).toBe(true);
    expect(data.outputs).toHaveLength(mockScriptTxInfo[0].outputs.length);
    expect(data.outputs[0].outputIndex).toBe(SCRIPT_UTXO_OUTPUT_INDEX);
  });

  it('keyed read on a cache miss with $select returns only the selected fields', async () => {
    setupTxInfoMock(mockScriptTxInfo);

    const { status, data } = await test.get(`${SVC}/Transactions('${SCRIPT_UTXO_TX_HASH}')?$select=hash,blockHeight`);
    expect(status).toBe(200);
    expect(data.hash).toBe(SCRIPT_UTXO_TX_HASH);
    expect(String(data.blockHeight)).toBe(String(mockScriptTxInfo[0].block_height));
    expect(data.fee).toBeUndefined();
  });

  it('keyed read on an unknown tx still yields 404', async () => {
    setupTxInfoMock([]);

    const res = await test
      .get(`${SVC}/Transactions('deadbeef00000000000000000000000000000000000000000000000000000000')`)
      .catch((err: any) => err.response ?? { status: err.status ?? 500 });
    expect(res.status).toBe(404);
  });

  // ==========================================================================
  // COMPOSITE key (TransactionMetadata: id + tx_hash) — both keys must filter.
  // ==========================================================================

  describe('composite key: TransactionMetadata(id, tx_hash)', () => {
    const LABEL_A = 674;
    const LABEL_B = 1990;

    beforeEach(async () => {
      await cds.run(
        INSERT.into('odatano.cardano.TransactionMetadata').entries([
          { id: LABEL_A, tx_hash: SEEDED_TX_HASH, label: String(LABEL_A), payload: JSON.stringify({ msg: ['a'] }) },
          { id: LABEL_B, tx_hash: SEEDED_TX_HASH, label: String(LABEL_B), payload: JSON.stringify({ msg: ['b'] }) },
        ])
      );
    });

    it('returns the row addressed by BOTH keys, not the first row of the tx', async () => {
      const a = await test.get(`${SVC}/TransactionMetadata(id=${LABEL_A},tx_hash='${SEEDED_TX_HASH}')`);
      expect(a.status).toBe(200);
      expect(String(a.data.id)).toBe(String(LABEL_A));
      expect(JSON.parse(a.data.payload).msg).toEqual(['a']);

      const b = await test.get(`${SVC}/TransactionMetadata(id=${LABEL_B},tx_hash='${SEEDED_TX_HASH}')`);
      expect(b.status).toBe(200);
      expect(String(b.data.id)).toBe(String(LABEL_B));
      expect(JSON.parse(b.data.payload).msg).toEqual(['b']);
    });

    it('honours $select on a composite-key read', async () => {
      const { status, data } = await test.get(`${SVC}/TransactionMetadata(id=${LABEL_B},tx_hash='${SEEDED_TX_HASH}')?$select=id,label`);
      expect(status).toBe(200);
      expect(String(data.label)).toBe(String(LABEL_B));
      expect(data.payload).toBeUndefined();
    });

    // A label the tx does not carry must be a 404: the client's query is the only
    // authority, there is no fallback row.
    it('a label that does not exist on this tx yields 404, not a sibling row', async () => {
      setupTxInfoMock([]);
      const res = await test
        .get(`${SVC}/TransactionMetadata(id=721,tx_hash='${SEEDED_TX_HASH}')`)
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(res.status).toBe(404);
    });

    // Same root cause on a single-key entity: a $filter that excludes the row
    // must not be overridden by a fallback.
    it('keyed read with a non-matching $filter yields 404, not the row', async () => {
      const res = await test
        .get(`${SVC}/Transactions('${SEEDED_TX_HASH}')?$filter=fee gt 999999999999`)
        .catch((err: any) => err.response ?? { status: err.status ?? 500 });
      expect(res.status).toBe(404);
    });
  });

  describe('temporal entity: Addresses', () => {
    const ADDR = TEST_FIXTURES.addressWithFunds;

    function setupAddressMocks() {
      nock('https://preview.koios.rest')
        .post('/api/v1/address_info', (body: any) => Array.isArray(body._addresses) && body._addresses[0] === ADDR)
        .reply(200, [{ address: ADDR, balance: '25000000', stake_address: null, script_address: false, is_script: false, address_type: 'enterprise', utxo_set: [] }])
        .persist();
      // indexAddress also pulls recent txs (best-effort) — keep it quiet and empty
      nock('https://preview.koios.rest')
        .post('/api/v1/address_txs')
        .reply(200, [])
        .persist();
      // /address_utxos is already mocked by setupKoiosMocks() with mockUtxosAdaOnly
    }

    it('keyed read on a cache MISS honours $expand=utxos (fresh temporal slice is visible)', async () => {
      setupAddressMocks();

      const { status, data } = await test.get(`${SVC}/Addresses('${ADDR}')?$expand=utxos`);
      expect(status).toBe(200);
      expect(data.address).toBe(ADDR);
      // Without the temporal-window widening the fresh slice falls outside the session's
      // [now, now+1ms) window and the handler would degrade to the bare row.
      expect(Array.isArray(data.utxos)).toBe(true);
      expect(data.utxos).toHaveLength(mockUtxosAdaOnly.length);
    });

    it('keyed read on a cache HIT honours $expand=utxos and $select', async () => {
      setupAddressMocks();
      // first call indexes …
      await test.get(`${SVC}/Addresses('${ADDR}')`);
      // … second call is served from the cache
      const { status, data } = await test.get(`${SVC}/Addresses('${ADDR}')?$select=address,utxoCount&$expand=utxos`);
      expect(status).toBe(200);
      expect(data.address).toBe(ADDR);
      expect(String(data.utxoCount)).toBe(String(mockUtxosAdaOnly.length));
      expect(data.utxos).toHaveLength(mockUtxosAdaOnly.length);
      expect(data.totalLovelace).toBeUndefined(); // not selected
    });

    it('expired slices stay hidden — an expired address is re-indexed, not served stale', async () => {
      setupAddressMocks();
      const past = new Date(Date.now() - 7200_000).toISOString();
      const pastTo = new Date(Date.now() - 3600_000).toISOString();
      await cds.run(
        INSERT.into('odatano.cardano.Addresses').entries({
          address: ADDR, type: 'enterprise', isScript: false, totalLovelace: '1', utxoCount: 99,
          validFrom: past, validTo: pastTo,
        })
      );

      const { status, data } = await test.get(`${SVC}/Addresses('${ADDR}')?$expand=utxos`);
      expect(status).toBe(200);
      // re-indexed from the (mocked) backend, not the stale row (utxoCount 99)
      expect(String(data.utxoCount)).toBe(String(mockUtxosAdaOnly.length));
      expect(data.utxos).toHaveLength(mockUtxosAdaOnly.length);
    });
  });
  describe('temporal entity: Assets — the crawler\'s bare catalogue row', () => {
    // A bare crawler row is stamped validFrom === validTo, so a keyed read never serves
    // it as is and the lazy path enriches it.
    const POLICY = 'a1'.repeat(28);
    const NAME_HEX = Buffer.from('SUNDAE').toString('hex');
    const UNIT = POLICY + NAME_HEX;

    function setupAssetMocks() {
      nock('https://preview.koios.rest')
        .post('/api/v1/asset_info')
        .reply(200, [{
          policy_id: POLICY,
          asset_name: NAME_HEX,
          asset_name_ascii: 'SUNDAE',
          fingerprint: 'asset1enriched000000000000000000000000000',
          total_supply: '2000000000',
          mint_cnt: 3,
          burn_cnt: 1,
          minting_tx_hash: 'e'.repeat(64),
          creation_time: 1700000000,
          token_registry_metadata: { name: 'Sundae', ticker: 'SUNDAE', decimals: 6 },
        }])
        .persist();
    }

    it('a born-expired bare row is enriched on the first keyed read, not served as is', async () => {
      setupAssetMocks();
      await cds.run(
        // exactly what mapBareAsset writes: born expired at the fixed epoch-zero sentinel
        INSERT.into('odatano.cardano.Assets').entries(mapBareAsset(UNIT)!)
      );

      const { status, data } = await test.get(`${SVC}/Assets('${UNIT}')`);

      expect(status).toBe(200);
      // the registry fields the bare row could not know are now filled in
      expect(data.registryTicker).toBe('SUNDAE');
      expect(String(data.totalSupply)).toBe('2000000000');
    });
  });
});
