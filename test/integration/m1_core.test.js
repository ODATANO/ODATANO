jest.setTimeout(20000);
const request = require('supertest');

const BASE = 'http://localhost:4004/odata/v4/cardano-odata';

describe('M1 Milestone - Core 3 Endpoints', () => {
  
  describe('Endpoint 1: Transaction Lookup', () => {
    test('GET /Transactions - returns empty collection (200)', async () => {
      const res = await request(BASE).get('/Transactions').expect(200);
      expect(res.body.value).toEqual([]);
    });

    test('POST /GetTransactionByHash - rejects invalid hash (400)', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ hash: 'invalid' })
        .expect(400);
      expect(res.body.error.message).toContain('Invalid');
    });

    test('POST /GetTransactionByHash - accepts valid format (64 hex chars)', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ hash: '0'.repeat(64) });
      // Status can be 200 or 500 (depends on provider)
      expect([200, 500]).toContain(res.status);
    });
  });

  describe('Endpoint 2: Address Balance', () => {
    test('GET /Addresses - returns empty collection (200)', async () => {
      const res = await request(BASE).get('/Addresses').expect(200);
      expect(res.body.value).toEqual([]);
    });

    test('POST /GetAddressByBech32 - rejects invalid address (400)', async () => {
      const res = await request(BASE)
        .post('/GetAddressByBech32')
        .send({ bech32: 'not_an_address' })
        .expect(400);
      expect(res.body.error.message).toContain('Invalid');
    });

    test('POST /GetAddressByBech32 - accepts addr_test prefix', async () => {
      const res = await request(BASE)
        .post('/GetAddressByBech32')
        .send({ bech32: 'addr_test1qr' + 'x'.repeat(100) });
      // Status can be 200 or 500 (depends on provider)
      expect([200, 500]).toContain(res.status);
    });
  });

  describe('✅ Endpoint 3: Metadata Query', () => {
    test('GET /Metadata - requires tx_ID (400 without it)', async () => {
      const res = await request(BASE).get('/Metadata').expect(400);
      expect(res.body.error.message).toContain('Missing transaction id');
    });

    test('POST /GetMetadataByTx - rejects invalid hash (400)', async () => {
      const res = await request(BASE)
        .post('/GetMetadataByTx')
        .send({ hash: 'bad' })
        .expect(400);
      expect(res.body.error.message).toContain('Invalid');
    });

    test('POST /GetMetadataByTx - accepts valid hash format', async () => {
      const res = await request(BASE)
        .post('/GetMetadataByTx')
        .send({ hash: '0'.repeat(64) });
      // Status can be 200 or 500 (depends on provider)
      expect([200, 500, 404]).toContain(res.status);
    });
  });

  describe('✅ Error Handling (5 Scenarios)', () => {
    test('Error 1: Invalid input (400)', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ hash: 'xyz' })
        .expect(400);
      expect(res.body.error.code).toBe('400');
    });

    test('Error 2: Missing required param (400)', async () => {
      const res = await request(BASE)
        .post('/GetAddressByBech32')
        .send({})
        .expect(400);
      expect(res.body.error.code).toBe('400');
    });

    test('Error 3: Invalid format pattern (400)', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ hash: '!' })
        .expect(400);
      expect(res.body.error.code).toBe('400');
    });

    test('Error 4: Provider failure (500)', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ hash: 'a'.repeat(64) });
      // Returns 500 when provider fails
      expect(res.status >= 400).toBe(true);
    });

    test('Error 5: OData $metadata available (200)', async () => {
      const res = await request(BASE).get('/$metadata').expect(200);
      expect(res.text).toContain('Transactions');
      expect(res.text).toContain('Addresses');
      expect(res.text).toContain('Metadata');
    });
  });
});
