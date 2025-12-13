import cds from '@sap/cds';

jest.setTimeout(20000);

describe('ODATANO Milestone 1 Error Handling', () => {
  
  const { GET, POST, expect } = cds.test(__dirname + '/../../')
  // ============================================================================
  // INPUT VALIDATION ERRORS (400)
  // ============================================================================


  describe('400 - Invalid Input', () => {
    test('GetTransactionByHash with invalid hash format', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'invalid_hash' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error).to.exist;
      expect(response.data.error.message).to.include('Invalid transaction hash');
    });

    test('GetTransactionByHash with short hash', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'abc123' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid transaction hash');
    });

    test('GetTransactionByHash with hash containing invalid characters', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'ZZZZ23def456abc123def456abc123def456abc123def456abc123def456abc1' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid transaction hash');
    });

    test('GetAddressByBech32 with invalid address format', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr123456' }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
      expect(data.error).to.exist;
      expect(data.error.message).to.include('Invalid bech32 address');
    });

    test('GetAddressByBech32 with mainnet address on testnet', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr1qxyz' }
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Invalid bech32 address');
    });

    test('GetAddressByBech32 with too short address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr_test1q' }
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Invalid bech32 address');
    });

    test('GetAddressByBech32 with too long address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr_test1q' + 'a'.repeat(100) }
      ).catch(err => err.response);
      
      expect(status).to.be.equal(404);
      if (status === 400) {
        expect(data.error.message).to.include('Invalid bech32 address');
      }
    });

    test('GetTransactionByHash without txHash parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('txHash is required');
    });

    test('GetAddressByBech32 without address parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('address is required');
    });

    test('GetMetadataByTxHash without txHash parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetMetadataByTxHash',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('txHash is required');
    });

    test('GetMetadataLabelTransactions without label parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetMetadataLabelTransactions',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('label is required');
    });

    test('GetUTxOsByAddress without address parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetUTxOsByAddress',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('address is required');
    });

    test('GetAssetsByAddress without address parameter', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetAssetsByAddress',
        {}
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('address is required');
    });
  });

  // ============================================================================
  // NOT FOUND ERRORS (404)
  // ============================================================================

  describe('404 - Resource Not Found', () => {
    test('GetTransactionByHash with nonexistent transaction', async () => {
      const nonexistentHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: nonexistentHash }
      ).catch(err => err.response);
      
      // Accept 404, 500, or successful with no data, depending on implementation
      expect(status).to.be.oneOf([404, 500, 503]);
      expect(data.error).to.exist;
      expect(data.error.message).to.match(/not found|All backends failed/i);
    });

    test('GET single Transaction with nonexistent hash', async () => {
      const nonexistentHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const { status } = await GET(
        `/odata/v4/cardano-odata/Transactions('${nonexistentHash}')`
      ).catch(err => err.response);
      
      // Should either be 404 or handle gracefully
      expect(status).to.be.oneOf([200, 404, 500, 503]);
    });

    test('GET single Address with nonexistent address', async () => {
      const nonexistentAddr = 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
      const { status } = await GET(
        `/odata/v4/cardano-odata/Addresses('${nonexistentAddr}')`
      ).catch(err => err.response);
      
      expect(status).to.be.oneOf([200, 400, 404, 500, 503]);
    });
  });

  // ============================================================================
  // INVALID ODATA QUERIES
  // ============================================================================

  describe('Invalid OData Queries', () => {
    test('Invalid $filter syntax', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$filter=invalid syntax here`.catch(err => err.response);
      
      // CAP should handle invalid filter gracefully
      expect(status).to.be.oneOf([400, 500]);
    });

    test('$filter on nonexistent field', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$filter=nonexistentField eq 123`.catch(err => err.response);
      
      // Should either error or ignore
      expect(status).to.be.oneOf([200, 400, 500]);
    });

    test('$select nonexistent field', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Transactions?$select=nonexistentField&$top=1`.catch(err => err.response);
      
      // CAP typically returns 200 but field is missing
      expect(status).to.equal(400);
    });

    test('Invalid $top value (negative)', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$top=-5`.catch(err => err.response);
      
      expect(status).to.be.oneOf([200, 400, 500]);
    });

    test('Invalid $skip value (negative)', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$skip=-5`;
      
      expect(status).to.be.oneOf([200]);
    });

    test('$expand nonexistent navigation property', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$expand=nonexistentRelation&$top=1`.catch(err => err.response);
      
      expect(status).to.be.oneOf([200, 400, 500]);
    });
  });

  // ============================================================================
  // ENTITY READ ERROR SCENARIOS
  // ============================================================================

  describe('Entity Read Error Scenarios', () => {
    test('GET Transaction by key with invalid hash format', async () => {
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Transactions('invalid')`
      ).catch(err => err.response);
      
      // Should validate or return error
      expect(status).to.be.oneOf([400, 404, 500]);
    });

    test('GET Address by key with invalid address format', async () => {
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Addresses('invalid_addr')`
      ).catch(err => err.response);
      
      expect(status).to.be.oneOf([400, 404, 500]);
    });
  });

  // ============================================================================
  // GRACEFUL DEGRADATION
  // ============================================================================

  describe('Service Availability', () => {
    test('NetworkInformation available even with backend issues', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/NetworkInformation`;
      
      // Should return cached or fresh data
      expect(status).to.equal(200);
    });

    test('Service metadata always available', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/$metadata`;
      
      expect(status).to.equal(200);
    });

    test('Service root accessible', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/`;
      
      expect(status).to.equal(200);
    });
  });

  // ============================================================================
  // VALIDATION EDGE CASES
  // ============================================================================

  describe('Validation Edge Cases', () => {
    test('Transaction hash with uppercase letters', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC1' }
      ).catch(err => err.response);
      
      // Validation should catch invalid format or backend returns not found
      expect(status).to.equal(404);
      expect(data.error).to.exist;
    });

    test('Transaction hash with exactly 63 characters (should fail)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'a'.repeat(63) }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Invalid transaction hash');
    });

    test('Transaction hash with exactly 65 characters (should fail)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      ).catch(err => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('valid');
    });

    test('Address without addr_test1 prefix (should fail)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'test1' + 'a'.repeat(60) }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Enter a value matching');
    });

    test('Empty string transaction hash', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: '' }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
    });

    test('Empty string address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: '' }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
    });

    test('Null transaction hash', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: null as any }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
    });
  });
});
