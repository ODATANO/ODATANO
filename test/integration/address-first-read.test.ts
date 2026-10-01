/**
 * First read of an address the index does not hold yet: GetUTxOsByAddress and GetAssetsByAddress
 * return what the same request indexed, from the backend and from the crawled UTxO set.
 *
 * SQLite evaluates the temporal window per statement, so it shows the fresh slices either way;
 * a database that fixes the window when the transaction begins hides them. The request's own
 * window is therefore asserted too.
 */

import cds from '@sap/cds';
// Native require: must share the module graph of the cds.test()-booted CAP
// server, or the handlers never see the app context set by createTestContext.
const { createTestContext, resetAppContext, shutdownAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
import { TEST_FIXTURES, mockUtxosAdaOnly } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, teardownKoiosMocks, nock } from './mock-helpers';

const { INSERT, SELECT } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';
process.env.TX_BUILDERS = 'buildooor';

const SVC = '/odata/v4/cardano-odata';
const UTXOS = 'odatano.cardano.AddressUTxOs';
const ASSETS = 'odatano.cardano.AddressAssets';
/** The temporal window of the request must reach at least this far past its start. */
const MIN_WINDOW_MS = 60_000;

describe('First read of an unindexed address', () => {
  const test = cds.test(__dirname + '/../../');
  /** Upper bound of the temporal window the last address action ran with. */
  let windowEnd: string | undefined;

  beforeAll(async () => {
    setupNocks();
    setupKoiosMocks();
    const testContext = await createTestContext(['koios']);
    resetAppContext(testContext);

    const srv = await cds.connect.to('CardanoODataService');
    srv.after(['GetUTxOsByAddress', 'GetAssetsByAddress'], (_result: unknown, req: any) => {
      windowEnd = req._?.['VALID-TO'] ?? req.context?._?.['VALID-TO'];
    });
  });

  /** The request widened its temporal window past the moment it started. */
  function expectWidenedWindow(startedAt: number) {
    expect(windowEnd).toBeDefined();
    expect(Date.parse(windowEnd!)).toBeGreaterThan(startedAt + MIN_WINDOW_MS);
  }

  beforeEach(async () => {
    await test.data.reset();
    windowEnd = undefined;
    setupNocks();
    setupKoiosMocks();
    // indexAddress also pulls recent txs (best-effort) — keep it quiet and empty
    nock('https://preview.koios.rest').post('/api/v1/address_txs').reply(200, []).persist();
  });

  afterEach(() => {
    resetKoiosMocks();
  });

  afterAll(async () => {
    teardownKoiosMocks();
    await shutdownAppContext();
  });

  describe('address known to the backend only', () => {
    const ADDR = TEST_FIXTURES.addressWithFunds;

    beforeEach(() => {
      nock('https://preview.koios.rest')
        .post('/api/v1/address_info', (body: any) => Array.isArray(body._addresses) && body._addresses[0] === ADDR)
        .reply(200, [{ address: ADDR, balance: '25000000', stake_address: null, script_address: false, is_script: false, address_type: 'enterprise', utxo_set: [] }])
        .persist();
      // /address_utxos is mocked by setupKoiosMocks() with mockUtxosAdaOnly
    });

    it('GetUTxOsByAddress returns the UTxOs on the first call', async () => {
      expect(await cds.run(SELECT.from(UTXOS).where({ address_address: ADDR }))).toHaveLength(0);

      const startedAt = Date.now();
      const first = await test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR });
      expect(first.status).toBe(200);
      expectWidenedWindow(startedAt);
      expect(first.data.value).toHaveLength(mockUtxosAdaOnly.length);

      const second = await test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR });
      expect(second.data.value).toHaveLength(first.data.value.length);
    });
  });

  describe('address only in the crawled UTxO set', () => {
    // no /address_info mock for this address: a backend read would fail the request
    const ADDR = TEST_FIXTURES.emptyAddress;
    const POLICY = 'b2'.repeat(28);
    const UNIT_A = POLICY + Buffer.from('ALPHA').toString('hex');
    const UNIT_B = POLICY + Buffer.from('BETA').toString('hex');
    const TX = (n: number) => String(n).repeat(64);

    beforeEach(async () => {
      // live crawler at the tip with an active UTxO set
      await cds.run(
        INSERT.into('odatano.cardano.CardanoSyncState').entries({
          ID: 'SINGLETON',
          network: 'preview',
          startSlot: 0,
          startBlockHash: 'a'.repeat(64),
          lastSlot: 50000000,
          lastBlockHash: 'b'.repeat(64),
          lastHeight: 2000000,
          syncStatus: 'synced',
          desiredRunning: true,
          leaseOwner: 'address-first-read-test',
          leaseUntil: new Date(Date.now() + 3600_000).toISOString(),
          utxoSetStatus: 'active',
          utxoAnchorSlot: 40000000,
          utxoAnchorHash: 'c'.repeat(64),
        })
      );
      // three outputs, so the result cannot come from the two mocked backend UTxOs
      await cds.run(
        INSERT.into('odatano.cardano.LedgerUTxOs').entries([
          { txHash: TX(1), outputIndex: 0, address: ADDR, addressType: 'enterprise', isScript: false, lovelace: '5000000', createdSlot: 41000000, hasAssets: false },
          { txHash: TX(2), outputIndex: 1, address: ADDR, addressType: 'enterprise', isScript: false, lovelace: '7000000', createdSlot: 42000000, hasAssets: true },
          { txHash: TX(3), outputIndex: 0, address: ADDR, addressType: 'enterprise', isScript: false, lovelace: '9000000', createdSlot: 43000000, hasAssets: true },
          // spent output: not part of the set
          { txHash: TX(4), outputIndex: 0, address: ADDR, addressType: 'enterprise', isScript: false, lovelace: '1000000', createdSlot: 41000000, spentTxHash: TX(5), spentSlot: 44000000, hasAssets: false },
        ])
      );
      await cds.run(
        INSERT.into('odatano.cardano.LedgerUTxOAssets').entries([
          { utxo_txHash: TX(2), utxo_outputIndex: 1, unit: UNIT_A, asset_quantity: '10', asset_policyId: POLICY },
          { utxo_txHash: TX(3), utxo_outputIndex: 0, unit: UNIT_A, asset_quantity: '5', asset_policyId: POLICY },
          { utxo_txHash: TX(3), utxo_outputIndex: 0, unit: UNIT_B, asset_quantity: '1', asset_policyId: POLICY },
        ])
      );
    });

    it('GetUTxOsByAddress returns the unspent outputs of the set on the first call', async () => {
      expect(await cds.run(SELECT.from(UTXOS).where({ address_address: ADDR }))).toHaveLength(0);

      const startedAt = Date.now();
      const first = await test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR });
      expect(first.status).toBe(200);
      expectWidenedWindow(startedAt);
      expect(first.data.value.map((u: any) => `${u.hash}#${u.index}`).sort())
        .toEqual([`${TX(1)}#0`, `${TX(2)}#1`, `${TX(3)}#0`]);

      const second = await test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR });
      expect(second.data.value).toHaveLength(3);
    });

    it('GetAssetsByAddress returns the units of the set on the first call', async () => {
      expect(await cds.run(SELECT.from(ASSETS).where({ address_address: ADDR }))).toHaveLength(0);

      const startedAt = Date.now();
      const first = await test.post(`${SVC}/GetAssetsByAddress`, { address: ADDR });
      expect(first.status).toBe(200);
      expectWidenedWindow(startedAt);
      expect(first.data.value.map((a: any) => a.unit).sort()).toEqual([UNIT_A, UNIT_B].sort());

      const second = await test.post(`${SVC}/GetAssetsByAddress`, { address: ADDR });
      expect(second.data.value).toHaveLength(2);
    });
  });
});
