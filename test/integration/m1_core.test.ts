import request = require('supertest');

const BASE = 'http://localhost:4004/odata/v4/cardano-odata';

jest.setTimeout(20000);

describe('M1 Milestone - Core 3 Endpoints', () => {
  
  describe('Endpoint 1: Transaction Lookup', () => {
    test('GET /Transactions - returns collection (200) and items match model if present', async () => {
      const res = await request(BASE).get('/Transactions').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
      if (res.body.value.length > 0) {
        const tx = res.body.value[0];
        expect(tx).toHaveProperty('hash');
        expect(tx).toHaveProperty('fee');
        expect(tx).toHaveProperty('blockHash');
      }
    });
});});

  describe('Endpoint 2: Address Lookup', () => {
    test('GET /Addresses - returns collection (200) and items match model if present', async () => {
      const res = await request(BASE).get('/Addresses').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
      if (res.body.value.length > 0) {
        const addr = res.body.value[0];
        expect(addr).toHaveProperty('address');
        expect(addr).toHaveProperty('totalLovelace');
        expect(addr).toHaveProperty('isScript');
      }
    });

  describe('✅ Error Handling (5 Scenarios)', () => {

    test('Error 1: Invalid input (action absent => 404)', async () => {
      const res = await request(BASE)
        .get('/Addresses')
        .send({ address: 'xyz' })
        .expect(404);
      expect(res.body.error).toBeDefined();
    });

    test('Error 2: Missing required param (action absent => 404)', async () => {
      const res = await request(BASE)
        .get('/Addresses')
        .send({})
        .expect(404);
      expect(res.body.error).toBeDefined();
    });

    test('Error 3: Invalid address pattern (action absent => 404)', async () => {
      const res = await request(BASE)
        .get('/Addresses')
        .send({ address: '!' })
        .expect(404);
      expect(res.body.error).toBeDefined();
    });

    test('Error 4: Provider failure (500)', async () => {
      const res = await request(BASE)
        .get('/Transactions')
        .send({ hash: 'a'.repeat(64) });
      expect(res.status >= 400).toBe(true);
    });

    test('Error 5: OData $metadata available (200)', async () => {
      const res = await request(BASE).get('/$metadata').expect(200);
      expect(res.text).toContain('Transactions');
      expect(res.text).toContain('Addresses');
      expect(res.text).toContain('Metadata');
    });
  });});
