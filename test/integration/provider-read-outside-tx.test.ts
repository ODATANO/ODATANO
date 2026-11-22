/**
 * A read that misses the index waits for the provider without holding the database connection.
 * SQLite has one connection, so a database-only read on the same instance shows whether it is free.
 */

import cds from '@sap/cds';
// Native require: must share the module graph of the cds.test()-booted CAP
// server, or the handlers never see the app context set by createTestContext.
const { createTestContext, resetAppContext, shutdownAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');
import { TEST_FIXTURES, mockUtxosAdaOnly } from './test-fixtures';
import { resetKoiosMocks, setupNocks, setupKoiosMocks, teardownKoiosMocks, nock } from './mock-helpers';

const { SELECT } = cds.ql;

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.BACKENDS = 'koios';

const SVC = '/odata/v4/cardano';
const ADDR = TEST_FIXTURES.addressWithFunds;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mocks the provider's address answer, delivered after `delayMs`. */
function mockAddressInfo(delayMs: number) {
  nock('https://preview.koios.rest')
    .post('/api/v1/address_info', (body: any) => Array.isArray(body._addresses) && body._addresses[0] === ADDR)
    .delay(delayMs)
    .reply(200, [{ address: ADDR, balance: '25000000', stake_address: null, script_address: false, is_script: false, address_type: 'enterprise', utxo_set: [] }])
    .persist();
}

describe('Provider read outside the request transaction', () => {
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
    nock('https://preview.koios.rest').post('/api/v1/address_txs').reply(200, []).persist();
  });

  afterEach(() => {
    resetKoiosMocks();
  });

  afterAll(async () => {
    teardownKoiosMocks();
    await shutdownAppContext();
  });

  it('answers a database-only read while an address read waits for the provider', async () => {
    const PROVIDER_MS = 1500;
    mockAddressInfo(PROVIDER_MS);

    const startedAt = Date.now();
    const slow = test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR });
    await sleep(200); // the address read is at the provider now

    const quick = await test.get(`${SVC}/Blocks?$top=1`);
    expect(quick.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(PROVIDER_MS);

    const answered = await slow;
    expect(answered.status).toBe(200);
    expect(answered.data.value).toHaveLength(mockUtxosAdaOnly.length);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PROVIDER_MS);
  });

  it('stores an address once when two first reads of it overlap', async () => {
    mockAddressInfo(300);

    const [first, second] = await Promise.all([
      test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR }),
      test.post(`${SVC}/GetUTxOsByAddress`, { address: ADDR }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.data.value).toHaveLength(first.data.value.length);
    expect(await cds.run(SELECT.from('odatano.cardano.Addresses').where({ address: ADDR }))).toHaveLength(1);
  });
});
