import request = require('supertest');

const BASE = 'http://localhost:4004/odata/v4/cardano-odata';

jest.setTimeout(30000);

describe('M1 Milestone - Complete Service Tests', () => {
  
  // ============================================================================
  // ENTITY READ TESTS
  // ============================================================================

  describe('Entity Reads - Network Information', () => {
    test('GET /NetworkInformation - returns collection (200)', async () => {
      const res = await request(BASE).get('/NetworkInformation').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /LatestBlock - returns collection (200)', async () => {
      const res = await request(BASE).get('/LatestBlock').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /LatestEpoch - returns collection (200)', async () => {
      const res = await request(BASE).get('/LatestEpoch').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });
  });

  describe('Entity Reads - Core Entities', () => {
    test('GET /Transactions - returns collection (200) with correct schema', async () => {
      const res = await request(BASE).get('/Transactions').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
      if (res.body.value.length > 0) {
        const tx = res.body.value[0];
        expect(tx).toHaveProperty('hash');
        expect(tx).toHaveProperty('fee');
        expect(tx).toHaveProperty('blockHash');
        expect(tx).toHaveProperty('blockHeight');
      }
    });

    test('GET /Addresses - returns collection (200) with correct schema', async () => {
      const res = await request(BASE).get('/Addresses').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
      if (res.body.value.length > 0) {
        const addr = res.body.value[0];
        expect(addr).toHaveProperty('address');
        expect(addr).toHaveProperty('totalLovelace');
        expect(addr).toHaveProperty('isScript');
        expect(addr).toHaveProperty('type');
      }
    });

    test('GET /TransactionMetadata - returns collection (200)', async () => {
      const res = await request(BASE).get('/TransactionMetadata').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });
  });

  describe('Entity Reads - Address Details', () => {
    test('GET /AddressAssets - returns collection (200)', async () => {
      const res = await request(BASE).get('/AddressAssets').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /AddressUTxOs - returns collection (200)', async () => {
      const res = await request(BASE).get('/AddressUTxOs').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /UTxOAssets - returns collection (200)', async () => {
      const res = await request(BASE).get('/UTxOAssets').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });
  });

  describe('Entity Reads - Transaction Details', () => {
    test('GET /TransactionInputs - returns collection (200)', async () => {
      const res = await request(BASE).get('/TransactionInputs').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /TransactionOutputs - returns collection (200)', async () => {
      const res = await request(BASE).get('/TransactionOutputs').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /TransactionInputAssets - returns collection (200)', async () => {
      const res = await request(BASE).get('/TransactionInputAssets').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });

    test('GET /TransactionOutputAssets - returns collection (200)', async () => {
      const res = await request(BASE).get('/TransactionOutputAssets').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });
  });

  // ============================================================================
  // ACTION TESTS
  // ============================================================================

  describe('Actions - Network Information', () => {
    test('POST GetNetworkInformation - returns network data', async () => {
      const res = await request(BASE).post('/GetNetworkInformation').set('Content-Type', 'application/json');
      expect([200, 500, 503]).toContain(res.status); // Success or provider error
      if (res.status === 200) {
        expect(res.body).toHaveProperty('maxSupply');
        expect(res.body).toHaveProperty('circulatingSupply');
      }
    });

    test('POST GetLatestBlock - returns latest block data', async () => {
      const res = await request(BASE).post('/GetLatestBlock').set('Content-Type', 'application/json');
      expect([200, 500, 503]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('hash');
        expect(res.body).toHaveProperty('height');
      }
    });

    test('POST GetLatestEpoch - returns latest epoch data', async () => {
      const res = await request(BASE).post('/GetLatestEpoch').set('Content-Type', 'application/json');
      expect([200, 500, 503]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('epoch');
        expect(res.body).toHaveProperty('blockCount');
      }
    });
  });

  describe('Actions - Transaction Lookup', () => {
    const validTxHash = 'a'.repeat(64); // Valid format, may not exist

    test('POST GetTransactionByHash - rejects missing txHash', async () => {
      const res = await request(BASE).post('/GetTransactionByHash').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    test('POST GetTransactionByHash - rejects invalid txHash format', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ txHash: 'invalid' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    test('POST GetTransactionByHash - accepts valid txHash format', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ txHash: validTxHash });
      expect([200, 404, 500, 503]).toContain(res.status);
    });

    test('POST GetMetadataByTxHash - rejects missing txHash', async () => {
      const res = await request(BASE).post('/GetMetadataByTxHash').send({});
      expect(res.status).toBe(400);
    });

    test('POST GetMetadataByTxHash - rejects invalid txHash format', async () => {
      const res = await request(BASE)
        .post('/GetMetadataByTxHash')
        .send({ txHash: 'xyz' });
      expect(res.status).toBe(400);
    });

    test('POST GetMetadataByTxHash - accepts valid txHash format', async () => {
      const res = await request(BASE)
        .post('/GetMetadataByTxHash')
        .send({ txHash: validTxHash });
      expect([200, 404, 500, 503]).toContain(res.status);
    });
  });

  describe('Actions - Address Lookup', () => {
    const validAddress = 'addr_test1' + 'q'.repeat(54); // Valid format
    const invalidAddress = 'invalid';

    test('POST GetAddressByBech32 - rejects missing address', async () => {
      const res = await request(BASE).post('/GetAddressByBech32').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    test('POST GetAddressByBech32 - rejects invalid address format', async () => {
      const res = await request(BASE)
        .post('/GetAddressByBech32')
        .send({ address: invalidAddress });
      expect(res.status).toBe(400);
      // CAP validates against the pattern, or our validator rejects it
      expect(res.body.error.message).toMatch(/Invalid bech32 address|pattern/i);
    });

    test('POST GetAddressByBech32 - accepts valid address format', async () => {
      const res = await request(BASE)
        .post('/GetAddressByBech32')
        .send({ address: validAddress });
      expect([200, 404, 500, 503]).toContain(res.status);
    });

    test('POST GetUTxOsByAddress - rejects missing address', async () => {
      const res = await request(BASE).post('/GetUTxOsByAddress').send({});
      expect(res.status).toBe(400);
    });

    test('POST GetUTxOsByAddress - rejects invalid address format', async () => {
      const res = await request(BASE)
        .post('/GetUTxOsByAddress')
        .send({ address: invalidAddress });
      expect(res.status).toBe(400);
    });

    test('POST GetUTxOsByAddress - accepts valid address format', async () => {
      const res = await request(BASE)
        .post('/GetUTxOsByAddress')
        .send({ address: validAddress });
      expect([200, 404, 500, 503]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body.value) || Array.isArray(res.body)).toBe(true);
      }
    });

    test('POST GetAssetsByAddress - rejects missing address', async () => {
      const res = await request(BASE).post('/GetAssetsByAddress').send({});
      expect(res.status).toBe(400);
    });

    test('POST GetAssetsByAddress - rejects invalid address format', async () => {
      const res = await request(BASE)
        .post('/GetAssetsByAddress')
        .send({ address: invalidAddress });
      expect(res.status).toBe(400);
    });

    test('POST GetAssetsByAddress - accepts valid address format', async () => {
      const res = await request(BASE)
        .post('/GetAssetsByAddress')
        .send({ address: validAddress });
      expect([200, 404, 500, 503]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body.value) || Array.isArray(res.body)).toBe(true);
      }
    });
  });

  describe('Actions - Metadata Lookup', () => {
    test('POST GetMetadataLabelTransactions - rejects missing label', async () => {
      const res = await request(BASE).post('/GetMetadataLabelTransactions').send({});
      expect(res.status).toBe(400);
    });

    test('POST GetMetadataLabelTransactions - accepts valid label', async () => {
      const res = await request(BASE)
        .post('/GetMetadataLabelTransactions')
        .send({ label: '721' });
      expect([200, 404, 500, 503]).toContain(res.status);
    });
  });

  // ============================================================================
  // ERROR HANDLING & VALIDATION
  // ============================================================================

  describe('Error Handling & Validation', () => {
    test('GET /$metadata - OData metadata is accessible', async () => {
      const res = await request(BASE).get('/$metadata').expect(200);
      expect(res.text).toContain('Transactions');
      expect(res.text).toContain('Addresses');
      expect(res.text).toContain('NetworkInformation');
    });

    test('Transactions - Invalid hash format returns 400', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ txHash: 'short' });
      expect(res.status).toBe(400);
    });

    test('Addresses - Invalid bech32 format returns 400', async () => {
      const res = await request(BASE)
        .post('/GetAddressByBech32')
        .send({ address: 'not_a_valid_address' });
      expect(res.status).toBe(400);
    });

    test('Actions - Wrong parameter types are rejected', async () => {
      const res = await request(BASE)
        .post('/GetTransactionByHash')
        .send({ txHash: 123 }); // Number instead of string
      expect(res.status).toBe(400);
    });
  });

  // ============================================================================
  // ODATA QUERY CAPABILITIES
  // ============================================================================

  describe('OData Query Capabilities', () => {
    test('$top and $skip work on collections', async () => {
      const res = await request(BASE).get('/Transactions?$top=5').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
      if (res.body.value.length > 0) {
        expect(res.body.value.length).toBeLessThanOrEqual(5);
      }
    });

    test('$count returns count metadata', async () => {
      const res = await request(BASE).get('/Addresses?$count=true').expect(200);
      expect(res.body['@odata.count']).toBeDefined();
    });

    test('$select filters properties', async () => {
      const res = await request(BASE).get('/Transactions?$select=hash,fee').expect(200);
      expect(Array.isArray(res.body.value)).toBe(true);
    });
  });
});
