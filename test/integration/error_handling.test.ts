import cds from '@sap/cds';

jest.setTimeout(20000);

describe('ODATANO Milestone 1 Error Handling', () => {
  
  const { GET, POST, expect } = cds.test(__dirname + '/../../')
  // ============================================================================
  // INPUT VALIDATION ERRORS (400)
  // ============================================================================
  
  describe('400 - Invalid Input', () => {
    it('GetTransactionByHash with invalid hash format', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'invalid_hash' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error).to.exist;
      expect(response.data.error.message).to.include('Invalid transaction hash');
    });

    it('Invalid endpoint returns 404', async () => {
      try {
        await POST(`/odata/v4/cardano-odata/NonExistentEntity`);
        expect.fail('Should have thrown 404');
      } catch (error: any) {
        expect(error.response.status).to.equal(404);
      }
    });

    it('GetTransactionByHash with short hash', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'abc123' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid transaction hash');
    });

    it('GetTransactionByHash with hash containing invalid characters', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'ZZZZ23def456abc123def456abc123def456abc123def456abc123def456abc1' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid transaction hash');
    });

    it('GetBlockByHash without blockHash parameter', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetBlockByHash',
        {}
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('blockHash');
    });

    it('GetBlockByHash with invalid hash format', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetBlockByHash',
        { blockHash: 'invalid_hash' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.match(/Invalid|blockHash/i);
    });

    it('GetBlockByHash with short hash', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetBlockByHash',
        { blockHash: 'abc123' }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.match(/Invalid|blockHash/i);
    });

    it('GetEpochByNumber without epochNumber parameter', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetEpochByNumber',
        {}
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('epochNumber');
    });

    it('GetEpochByNumber with null epochNumber', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetEpochByNumber',
        { epochNumber: null }
      ).catch(err => err.response);
      
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('epochNumber');
    });

    it('GetAddressByBech32 with invalid address format', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr123456' }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
      expect(data.error).to.exist;
      expect(data.error.message).to.include('Invalid bech32 address');
    });

    it('GetAddressByBech32 with mainnet address on testnet', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr1qxyz' }
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Invalid bech32 address');
    });

    it('GetAddressByBech32 with too short address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr_test1q' }
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Invalid bech32 address');
    });

    it('GetAddressByBech32 with too long address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'addr_test1q' + 'a'.repeat(105) }
      ).catch(err => err.response);
      
      expect(data.error.message).to.include('Invalid bech32 address');    
      expect(status).to.be.equal(400);
      }
    );

    it('GetTransactionByHash without txHash parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('txHash is required');
    });

    it('GetAddressByBech32 without address parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('address is required');
    });

    it('GetMetadataByTxHash without txHash parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetMetadataByTxHash',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('txHash is required');
    });

    it('GetMetadataLabelTransactions without label parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetMetadataLabelTransactions',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('label is required');
    });

    it('GetMetadataLabelTransactions with empty label (whitespace only)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetMetadataLabelTransactions',
        { label: '   ' }
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Label cannot be empty');
    });

    it('GetUTxOsByAddress without address parameter', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetUTxOsByAddress',
        {}
      ).catch(err => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include('address is required');
    });

    it('GetUTxOsByAddress with invalid bech32 address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetUTxOsByAddress',
        { address: 'invalid_address_format' }
      ).catch(err => err.response);
      expect(status).to.equal(400);
        // CDS validates pattern before our service code runs
        expect(data.error.message).to.match(/pattern|bech32/i);
    });

    it('GetAssetsByAddress without address parameter', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetAssetsByAddress',
        {}
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('address is required');
    });

    it('GetAssetsByAddress with invalid bech32 address', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetAssetsByAddress',
        { address: 'not_valid_bech32' }
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
        // CDS validates pattern before our service code runs  
        expect(response.data.error.message).to.match(/pattern|bech32/i);
    });

    it('GetAccountByStakeAddress with invalid stake address', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetAccountByStakeAddress',
        { stakeAddress: 'invalid_stake_addr' }
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.match(/pattern|stake|bech32/i);
    });

    it('GetAccountByStakeAddress without stakeAddress parameter', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetAccountByStakeAddress',
        {}
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('stakeAddress is required');
    });

    it('GetPoolById with invalid poolId format (random string)', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetPoolById',
        { poolId: 'invalid_pool' }
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error).to.exist;
      expect(response.data.error.message).to.match(/Invalid poolId format|Pools/i);
    });

    it('GetPoolById with invalid bech32-like poolId (wrong prefix)', async () => {
      const response = await POST(
        '/odata/v4/cardano-odata/GetPoolById',
        { poolId: 'poolx' + 'a'.repeat(10) }
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.match(/Invalid poolId format|Pools/i);
    });

    it('READ TransactionMetadata with invalid txHash format', async () => {
      const response = await GET(
        '/odata/v4/cardano-odata/TransactionMetadata(tx=invalid_hash)'
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid value');
    });

    it('READ TransactionMetadata with short txHash', async () => {
      const response = await GET(
        '/odata/v4/cardano-odata/TransactionMetadata?hash=abc123'
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid transaction hash format');
    });

    it('READ TransactionMetadata with wrong label', async () => {
      const response = await GET(
        '/odata/v4/cardano-odata/TransactionMetadata(label=%20%20%20)'
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid value: label');
    });

    it('READ TransactionMetadata with empty string label', async () => {
      const response = await GET(
        '/odata/v4/cardano-odata/TransactionMetadata(label=)'
      ).catch(err => err.response);
      expect(response.status).to.equal(400);
      expect(response.data.error.message).to.include('Invalid value: label');
    });
  });

  // ============================================================================
  // NOT FOUND ERRORS (404)
  // ============================================================================

  describe('404 - Resource Not Found', () => {
    it('GetTransactionByHash with nonexistent transaction', async () => {
      const nonexistentHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: nonexistentHash }
      ).catch(err => err.response);
      
      // Accept 502 for all backends fail
      expect(data.error).to.exist;
      expect(data.error.message).to.match(/not found|All backends failed/i);
      expect(status).to.be.equal(502);
    });

    it('GET single Transaction with nonexistent hash', async () => {
      const nonexistentHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Transactions('${nonexistentHash}')`
      ).catch(err => err.response);
      
     // Accept 502 for all backends fail
      expect(data.error).to.exist;
      expect(data.error.message).to.match(/not found|All backends failed/i);
      expect(status).to.be.equal(502);
    });

    it('GET single Address with nonexistent address', async () => {
      const nonexistentAddr = 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Addresses('${nonexistentAddr}')`
      ).catch(err => err.response);
      
      // Accept 502 for all backends fail
      expect(data.error).to.exist;
      expect(data.error.message).to.match(/not found|All backends failed/i);
      expect(status).to.be.equal(502);
    });
  });

  // ============================================================================
  // INVALID ODATA QUERIES
  // ============================================================================

  describe('Invalid OData Queries', () => {
    it('Invalid $filter syntax', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$filter=invalid syntax here`.catch(err => err.response);
      
      // CAP should handle invalid filter gracefully
      expect(status).to.be.oneOf([400, 500]);
    });

    it('$filter on nonexistent field', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$filter=nonexistentField eq 123`.catch(err => err.response);
      
      // Should either error or ignore
      expect(status).to.be.oneOf([200, 400, 500]);
    });

    it('$select nonexistent field', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Transactions?$select=nonexistentField&$top=1`.catch(err => err.response);
      
      // CAP typically returns 200 but field is missing
      expect(status).to.equal(400);
    });

    it('Invalid $top value (negative)', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$top=-5`.catch(err => err.response);
      
      expect(status).to.be.oneOf([200, 400, 500]);
    });

    it('Invalid $skip value (negative)', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$skip=-5`;
      
      expect(status).to.be.oneOf([200]);
    });

    it('$expand nonexistent navigation property', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/Transactions?$expand=nonexistentRelation&$top=1`.catch(err => err.response);
      
      expect(status).to.be.oneOf([200, 400, 500]);
    });
  });

  // ============================================================================
  // ENTITY READ ERROR SCENARIOS
  // ============================================================================

  describe('Entity Read Error Scenarios', () => {
    it('GET Transaction by key with invalid hash format', async () => {
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Transactions('invalid')`
      ).catch(err => err.response);
      
      // Should validate or return error
      expect(status).to.be.oneOf([400, 404, 500]);
    });

    it('GET Address by key with invalid address format', async () => {
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Addresses('invalid_addr')`
      ).catch(err => err.response);
      
      expect(status).to.be.oneOf([400, 404, 500]);
    });

    it('GET Pool by key with invalid poolId format', async () => {
      const { status, data } = await GET(
        `/odata/v4/cardano-odata/Pools(poolId='invalid_pool')`
      ).catch(err => err.response);
      // Service should reject invalid input
      expect(status).to.equal(400);
      expect(data.error).to.exist;
      expect(data.error.message).to.match(/Invalid poolId format|Pools/i);
    });
  });

  // ============================================================================
  // GRACEFUL DEGRADATION
  // ============================================================================

  describe('Service Availability', () => {
    it('NetworkInformation available even with backend issues', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/NetworkInformation`;
      
      // Should return cached or fresh data
      expect(status).to.equal(200);
    });

    it('Service metadata always available', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/$metadata`;
      
      expect(status).to.equal(200);
    });

    it('Service root accessible', async () => {
      const { status } = await GET `/odata/v4/cardano-odata/`;
      
      expect(status).to.equal(200);
    });
  });

  // ============================================================================
  // VALIDATION EDGE CASES
  // ============================================================================

  describe('Validation Edge Cases', () => {
    it('Transaction hash with uppercase letters', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC1' }
      ).catch(err => err.response);
      
      // Validation should catch invalid format or backend returns not found
      expect(status).to.equal(502);
      expect(data.error).to.exist;
    });

    it('Transaction hash with exactly 63 characters (should fail)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: 'a'.repeat(63) }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Invalid transaction hash');
    });

    it('Transaction hash with exactly 65 characters (should fail)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      ).catch(err => err.response);

      expect(status).to.equal(400);
      expect(data.error.message).to.include('valid');
    });

    it('Address without addr_test1 prefix (should fail)', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: 'test1' + 'a'.repeat(60) }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
      expect(data.error.message).to.include('Enter a value matching');
    });

    it('Empty string transaction hash', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: '' }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
    });

    it('Empty string address', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetAddressByBech32',
        { address: '' }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
    });

    it('Null transaction hash', async () => {
      const { status, data } = await POST(
        '/odata/v4/cardano-odata/GetTransactionByHash',
        { txHash: null as any }
      ).catch(err => err.response);
      
      expect(status).to.equal(400);
    });
  });
});
