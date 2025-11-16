jest.setTimeout(20000);

const path = require('path');
// Mock the cardano-client before loading the CDS app so service uses mocked client
jest.mock('../../srv/blockchain/cardano-client', () => ({
  getTransaction: jest.fn(),
  getAddressBalance: jest.fn()
}));

const cardano = require('../../srv/blockchain/cardano-client');
const request = require('supertest');
const cds = require('@sap/cds');

let app;
beforeAll(async () => {
  // load the CDS app from the project root (resolved absolute path)
  await cds.load(path.resolve(__dirname, '../../'));
  app = await cds.connect.to('CardanoODataService');
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('Provider error handling (integration)', () => {
  test('Transaction not found -> 404', async () => {
    cardano.getTransaction.mockRejectedValueOnce(new Error('NOT_FOUND'));
    const res = await request(app)
      .get("/odata/v4/CardanoODataService/Transactions(ID='" + 'a'.repeat(64) + "')")
      .expect(404);
    expect(res.text).toMatch(/Transactions: Not found|not found/i);
  });

  test('Transaction provider unauthorized -> 401', async () => {
    const err = new Error('Unauthorized');
    err.response = { status: 401, data: { message: 'invalid project id' } };
    cardano.getTransaction.mockRejectedValueOnce(err);
    await request(app)
      .get("/odata/v4/CardanoODataService/Transactions(ID='" + 'a'.repeat(64) + "')")
      .expect(401);
  });

  test('Transaction provider timeout -> 503', async () => {
    cardano.getTransaction.mockRejectedValueOnce(new Error('Primary getTransaction timed out after 8000ms'));
    await request(app)
      .get("/odata/v4/CardanoODataService/Transactions(ID='" + 'a'.repeat(64) + "')")
      .expect(503);
  });

  test('Address provider not found -> 404', async () => {
    cardano.getAddressBalance.mockRejectedValueOnce(new Error('NOT_FOUND'));
    const addr = 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    await request(app)
      .get(`/odata/v4/CardanoODataService/Addresses(address='${addr}')`)
      .expect(404);
  });
});
