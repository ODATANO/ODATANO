jest.setTimeout(20000);
const request = require('supertest');

// Integration tests assume a local CAP server is running at http://localhost:4004
const BASE = 'http://localhost:4004/odata/v4/cardano-odata';

describe('Provider error handling input validation against running server', () => {
  test('Invalid transaction hash -> 400', async () => {
    await request(BASE)
      .get("/Transactions(ID='INVALID_HASH')")
      .expect(400);
  });

  test('Invalid address format -> 400', async () => {
    await request(BASE)
      .get("/Addresses(address='not_an_addr')")
      .expect(400);
  });

  test('Metadata missing tx -> 400', async () => {
    // call the Metadata entity without tx param to provoke 400 response
    await request(BASE)
      .get('/Metadata')
      .expect(400);
  });
});
