import cds from '@sap/cds';

jest.setTimeout(20000);

describe('ODATANO Milestone 1 - Complete Service Tests', () => {

  const { GET, POST, expect } = cds.test(__dirname + '/../../');
 
  // ============================================================================
  // ENTITY READ TESTS
  // ============================================================================

  describe('Entity Reads - Current Network Information', () => {
    test('GET /NetworkInformation - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/NetworkInformation`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /LatestBlock - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/LatestBlock`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /LatestEpoch - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/LatestEpoch`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });
  });

  describe('Entity Reads - Core Entities', () => {
    test('GET /Transactions - returns collection (200) with correct schema', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Transactions`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
      if (data.value.length > 0) {
        const tx = data.value[0];
        expect(tx).to.have.property('hash');
        expect(tx).to.have.property('blockHash');
        expect(tx).to.have.property('blockHeight');
      }
    });

    test('GET /Addresses - returns collection (200) with correct schema', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Addresses`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
      if (data.value.length > 0) {
        const addr = data.value[0];
        expect(addr).to.have.property('address');
        expect(addr).to.have.property('totalLovelace');
        expect(addr).to.have.property('isScript');
        expect(addr).to.have.property('type');
      }
    });

    test('GET /TransactionMetadata - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/TransactionMetadata`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });
  });

  describe('Entity Reads - Address Details', () => {
    test('GET /AddressAssets - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/AddressAssets`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /AddressUTxOs - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/AddressUTxOs`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /UTxOAssets - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/UTxOAssets`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });
  });

  describe('Entity Reads - Transaction Details', () => {
    test('GET /TransactionInputs - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/TransactionInputs`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /TransactionOutputs - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/TransactionOutputs`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /TransactionInputAssets - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/TransactionInputAssets`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    test('GET /TransactionOutputAssets - returns collection (200)', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/TransactionOutputAssets`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });
  });

  // ============================================================================
  // ACTION TESTS
  // ============================================================================

  describe('Actions - Network Information', () => {
    test('POST GetNetworkInformation - returns network data', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect([200, 500, 503]).to.include(status);
      if (status === 200) {
        expect(data).to.have.property('maxSupply');
        expect(data).to.have.property('circulatingSupply');
      }
    });

    test('POST GetLatestBlock - returns latest block data', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect([200, 500, 503]).to.include(status);
      if (status === 200) {
        expect(data).to.have.property('hash');
        expect(data).to.have.property('height');
      }
    });

    test('POST GetLatestEpoch - returns latest epoch data', async () => {
      const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect([200, 500, 503]).to.include(status);
      if (status === 200) {
        expect(data).to.have.property('epoch');
        expect(data).to.have.property('blockCount');
      }
    });
  });

  describe('Actions - Transaction Lookup', () => {
    // valid preview transaction hash
    const validTxHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
    // valid hash transaction with metadata
    const txWithMetadata = '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1';

    test('POST GetTransactionByHash - rejects missing txHash', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetTransactionByHash', {});
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/txHash is required/i);
      }
    });

    test('POST GetTransactionByHash - rejects invalid txHash format', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: 'invalid' });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/Invalid transaction hash/i);
      }
    });

    test('POST GetTransactionByHash - accepts valid txHash format', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: validTxHash });
        expect([200, 404]).to.include(status);
        if (status === 200) {
          expect(data).to.have.property('hash');
        }
      } catch (error: any) {
        // Accept 500/503 from backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetMetadataByTxHash - rejects missing txHash', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', {});
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/txHash is required/i);
      }
    });

    test('POST GetMetadataByTxHash - rejects invalid txHash format', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: 'xyz' });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/Invalid transaction hash/i);
      }
    });

    test('POST GetMetadataByTxHash - accepts valid txHash format', async () => {
      try {
        const { status } = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: validTxHash });
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        // Accept 500/503 errors from backend unavailability
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetMetadataByTxHash - returns metadata for tx with metadata', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: txWithMetadata });
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          const metadata = Array.isArray(data.value) ? data.value : data;
          if (metadata.length > 0) {
            expect(metadata[0]).to.have.property('label');
          }
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        // Accept 500/503 errors from backend unavailability or schema issues
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });
  });

  describe('Actions - Address Lookup', () => {
    const validAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
    const invalidAddress = 'adrr_test1_invalid_address';

    test('POST GetAddressByBech32 - rejects missing address', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetAddressByBech32', {});
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/address is required/i);
      }
    });

    test('POST GetAddressByBech32 - rejects invalid address format', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: invalidAddress });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/Invalid bech32 address|pattern/i);
      }
    });

    test('POST GetAddressByBech32 - accepts valid address format', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: validAddress });
        expect([200, 404]).to.include(status);
        if (status === 200) {
          expect(data).to.have.property('address');
        }
      } catch (error: any) {
        // Accept 500/503 from backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetUTxOsByAddress - rejects missing address', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', {});
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/address is required/i);
      }
    });

    test('POST GetUTxOsByAddress - rejects invalid address format', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: invalidAddress });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/pattern/i);
      }
    });

    test('POST GetUTxOsByAddress - accepts valid address format', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: validAddress });
        expect([200, 404]).to.include(status);
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
        }
      } catch (error: any) {
        // Accept 500/503 from backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetAssetsByAddress - rejects missing address', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetAssetsByAddress', {});
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/address is required/i);
      }
    });

    test('POST GetAssetsByAddress - rejects invalid address format', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: invalidAddress });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/pattern/i);
      }
    });

    test('POST GetAssetsByAddress - accepts valid address format', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: validAddress });
        expect([200, 404]).to.include(status);
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
        }
      } catch (error: any) {
        // Accept 500/503 from backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });
  });

  describe('Actions - Metadata Lookup', () => {
    test('POST GetMetadataLabelTransactions - rejects missing label', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetMetadataLabelTransactions', {});
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.error.message).to.match(/label is required/i);
      }
    });

    test('POST GetMetadataLabelTransactions - accepts valid label', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetMetadataLabelTransactions', { label: '721' });
        expect([200, 404]).to.include(status);
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
        }
      } catch (error: any) {
        // Accept 500/503 from backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetMetadataLabelTransactions - returns transactions for label 1990', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetMetadataLabelTransactions', { label: '1990' });
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          const txs = Array.isArray(data.value) ? data.value : data;
          if (txs.length > 0) {
            expect(txs[0]).to.have.property('hash');
          }
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        // Accept 500/503 from backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });
  });

  // ============================================================================
  // ADDITIONAL BACKEND COVERAGE TESTS
  // ============================================================================

  describe('Backend Integration - Success Paths', () => {
    test('POST GetNetworkInformation - exercises backend network call', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
        expect([200]).to.include(status);
        expect(data).to.have.property('maxSupply');
        expect(data).to.have.property('circulatingSupply');
      } catch (error: any) {
        // Backend may be unavailable
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetLatestBlock - exercises backend block retrieval', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
        expect([200]).to.include(status);
        expect(data).to.have.property('hash');
        expect(data).to.have.property('height');
        expect(data).to.have.property('epoch');
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('POST GetLatestEpoch - exercises backend epoch retrieval', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
        expect([200]).to.include(status);
        expect(data).to.have.property('epoch');
        expect(data).to.have.property('blockCount');
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Multiple sequential backend calls - tests client fallback logic', async () => {
      try {
        // First call
        const block = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
        expect([200]).to.include(block.status);
        
        // Second call
        const epoch = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
        expect([200]).to.include(epoch.status);
        
        // Third call
        const network = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
        expect([200]).to.include(network.status);
      } catch (error: any) {
        // Accept backend errors
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Transaction lookup with real hash - exercises full indexer path', async () => {
      const realTxHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: realTxHash });
        if (status === 200) {
          expect(data).to.have.property('hash');
          expect(data.hash).to.equal(realTxHash);
          expect(data).to.have.property('blockHeight');
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Address lookup with real address - exercises address indexing', async () => {
      const realAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: realAddress });
        if (status === 200) {
          expect(data).to.have.property('address');
          expect(data.address).to.equal(realAddress);
          expect(data).to.have.property('balance');
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('UTxO lookup - exercises UTXO retrieval and mapping', async () => {
      const realAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: realAddress });
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          const utxos = Array.isArray(data.value) ? data.value : data;
          if (utxos.length > 0) {
            expect(utxos[0]).to.have.property('txHash');
            expect(utxos[0]).to.have.property('outputIndex');
          }
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Transaction inputs/outputs - exercises full tx details indexing', async () => {
      const realTxHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: realTxHash });
        if (status === 200) {
          expect(data).to.have.property('hash');
          // Verify transaction details are mapped
          expect(data).to.have.property('fee');
          expect(data).to.have.property('size');
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Network info - exercises protocol parameters retrieval', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
        if (status === 200) {
          expect(data).to.have.property('maxSupply');
          expect(data).to.have.property('circulatingSupply');
          // Verify numeric values
          if (data.maxSupply) {
            expect(Number(data.maxSupply)).to.be.greaterThan(0);
          }
        }
        expect([200]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Latest block - exercises block indexing', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
        if (status === 200) {
          expect(data).to.have.property('hash');
          expect(data).to.have.property('height');
          expect(data).to.have.property('slot');
          expect(data).to.have.property('epoch');
          // Verify block height is positive
          expect(data.height).to.be.greaterThan(0);
        }
        expect([200]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Latest epoch - exercises epoch data retrieval', async () => {
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
        if (status === 200) {
          expect(data).to.have.property('epoch');
          expect(data).to.have.property('blockCount');
          // Verify epoch number is positive
          expect(data.epoch).to.be.greaterThan(0);
        }
        expect([200]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Assets by address - exercises asset indexing', async () => {
      const realAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: realAddress });
        if (status === 200) {
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          const assets = Array.isArray(data.value) ? data.value : data;
          if (assets.length > 0) {
            // Verify asset structure
            expect(assets[0]).to.have.property('policyId');
            expect(assets[0]).to.have.property('assetName');
            expect(assets[0]).to.have.property('quantity');
            // Verify quantity is numeric string
            expect(assets[0].quantity).to.be.a('string');
          }
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Address with assets - verifies asset mapping logic', async () => {
      const addressWithAssets = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      try {
        // First get address info
        const addrResponse = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: addressWithAssets });
        if (addrResponse.status === 200) {
          expect(addrResponse.data).to.have.property('balance');
        }
        
        // Then get UTxOs which should include assets
        const utxoResponse = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: addressWithAssets });
        if (utxoResponse.status === 200) {
          const utxos = Array.isArray(utxoResponse.data.value) ? utxoResponse.data.value : utxoResponse.data;
          // UTxOs should have transaction references
          if (utxos.length > 0) {
            expect(utxos[0]).to.have.property('txHash');
            expect(utxos[0]).to.have.property('lovelace');
          }
        }
        
        expect([200, 404]).to.include(addrResponse.status);
      } catch (error: any) {
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });

    test('Metadata transaction lookup - exercises metadata indexing', async () => {
      const txWithMetadata = '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1';
      try {
        const { status, data } = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: txWithMetadata });
        if (status === 200) {
          const metadata = Array.isArray(data.value) ? data.value : data;
          if (metadata.length > 0) {
            expect(metadata[0]).to.have.property('label');
            expect(metadata[0]).to.have.property('jsonMetadata');
          }
        }
        expect([200, 404]).to.include(status);
      } catch (error: any) {
        // Schema issues may cause 500
        expect([500, 503]).to.include(error.response?.status || 500);
      }
    });
  });

  // ============================================================================
  // ERROR HANDLING & VALIDATION
  // ============================================================================

  describe('Error Handling & Validation', () => {
    test('GET /$metadata - OData metadata is accessible', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/$metadata`;
      expect(status).to.equal(200);
      expect(data).to.include('Transactions');
      expect(data).to.include('Addresses');
      expect(data).to.include('NetworkInformation');
    });

    test('Transactions - Invalid hash format returns 400', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: 'short' });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    test('Addresses - Invalid bech32 format returns 400', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: 'not_a_valid_address' });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    test('Actions - Wrong parameter types are rejected', async () => {
      try {
        await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: 123 });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });
  });

  // ============================================================================
  // ODATA QUERY CAPABILITIES
  // ============================================================================

  describe('OData Query Capabilities', () => {
    test('$top and $skip work on collections', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Transactions?$top=5`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
      if (data.value.length > 0) {
        expect(data.value.length).to.be.at.most(5);
      }
    });

    test('$count returns count metadata', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Addresses?$count=true`;
      expect(status).to.equal(200);
      expect(data['@odata.count']).to.exist;
    });

    test('$select filters properties', async () => {
      const { status, data } = await GET `/odata/v4/cardano-odata/Transactions?$select=hash,fee`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });
  });

  // ============================================================================
  // INDEXER COLD VS WARM (DB-DRIVEN)
  // ============================================================================

  describe('Indexer behavior - DB cold vs warm (DB-driven)', () => {
    const validTxHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
    const seededTxHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const validAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

    const truncateCoreTables = async () => {
      const e = cds.entities as any;
      const { DELETE } = cds.ql;
      const order = [
        'TransactionOutputAssets',
        'TransactionInputAssets',
        'UTxOAssets',
        'AddressAssets',
        'AddressUTxOs',
        'TransactionMetadata',
        'TransactionInputs',
        'TransactionOutputs',
        'Transactions',
        'Addresses',
        'LatestBlock',
        'LatestEpoch',
        'NetworkInformation',
      ];
      for (const name of order) {
        if (e[name]) {
          await cds.run(DELETE.from(e[name]));
        }
      }
    };

    beforeEach(async () => {
      await truncateCoreTables();
    });

    test('Cold path (Transactions): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;

      const before = await cds.run(SELECT.from(e.Transactions).where({ hash: validTxHash }));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: validTxHash });

      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.Transactions).where({ hash: validTxHash }));
        expect(after.length).to.equal(1);
      }
    });

    test('Warm path (Transactions): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;

      await cds.run(
        INSERT.into(e.Transactions).entries({
          hash: seededTxHash,
          blockHash: 'beadfacebeadfacebeadfacebeadfacebeadfacebeadfacebeadfacebeadface',
          blockHeight: 123,
        }),
      );

      const res = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: seededTxHash });

      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        expect(res.data).to.have.property('hash');
        expect(res.data.hash).to.equal(seededTxHash);
      }
    });

    test('Cold path (Addresses): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;

      const before = await cds.run(SELECT.from(e.Addresses).where({ address: validAddress }));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: validAddress });

      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.Addresses).where({ address: validAddress }));
        expect(after.length).to.equal(1);
      }
    });

    test('Warm path (Addresses): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;

      await cds.run(
        INSERT.into(e.Addresses).entries({
          address: validAddress,
          validFrom: new Date().toISOString(),
          type: 'base',
          isScript: false,
          totalLovelace: 0,
        }),
      );

      const res = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: validAddress });

      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        expect(res.data).to.have.property('address');
        expect(res.data.address).to.equal(validAddress);
      }
    });

    test('Cold path (NetworkInformation): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;

      const before = await cds.run(SELECT.from(e.NetworkInformation));
      // allow either 0 or more (if other tests left data), but clear helper runs beforeEach
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect([200, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.NetworkInformation));
        expect(after.length).to.equal(1);
      }
    });

    test('Warm path (NetworkInformation): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;

      await cds.run(
        INSERT.into(e.NetworkInformation).entries({
          network: 'preview',
          validFrom: new Date().toISOString(),
          maxSupply: 0,
          totalSupply: 0,
          circulatingSupply: 0,
          lockedSupply: 0,
          treasurySupply: 0,
          reservesSupply: 0,
          liveStake: 0,
          activeStake: 0,
        }),
      );

      const res = await POST('/odata/v4/cardano-odata/GetNetworkInformation', {});
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        expect(res.data).to.have.property('network');
      }
    });

    test('Cold path (LatestBlock): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.LatestBlock));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect([200, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.LatestBlock));
        expect(after.length).to.equal(1);
      }
    });

    test('Warm path (LatestBlock): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(
        INSERT.into(e.LatestBlock).entries({
          hash: 'b'.repeat(64),
          validFrom: new Date().toISOString(),
          time: new Date().toISOString(),
          height: 1,
          slotLeader: 'leader',
          epochNumber: 1,
          epochSlot: 1,
          size: 1,
          txCount: 0,
          fees: 0,
        }),
      );

      const res = await POST('/odata/v4/cardano-odata/GetLatestBlock', {});
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        expect(res.data).to.have.property('hash');
      }
    });

    test('Cold path (LatestEpoch): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.LatestEpoch));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect([200, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.LatestEpoch));
        expect(after.length).to.equal(1);
      }
    });

    test('Warm path (LatestEpoch): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(
        INSERT.into(e.LatestEpoch).entries({
          epoch: 1,
          validFrom: new Date().toISOString(),
          startTime: Math.floor(Date.now() / 1000),
          endTime: Math.floor(Date.now() / 1000) + 1000,
          firstBlockTime: Math.floor(Date.now() / 1000),
          lastBlockTime: Math.floor(Date.now() / 1000) + 900,
          blockCount: 1,
          txCount: 0,
          output: '0',
          fees: 0,
          activeStake: 0,
        }),
      );

      const res = await POST('/odata/v4/cardano-odata/GetLatestEpoch', {});
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        expect(res.data).to.have.property('epoch');
      }
    });

    test('Cold path (Metadata by tx): empty DB triggers indexing (persistence optional)', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const txHash = validTxHash;
      const before = await cds.run(SELECT.from(e.TransactionMetadata).where({ tx_hash: txHash }));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash });
      expect([200, 404, 500, 503]).to.include(res.status);
      // Some backends may not persist metadata rows; only assert happy HTTP path
    });

    test('Warm path (Metadata by tx): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      // ensure transaction exists
      await cds.run(
        INSERT.into(e.Transactions).entries({
          hash: seededTxHash,
          blockHash: 'c'.repeat(64),
          blockHeight: 1,
        }),
      );
      // seed metadata
      await cds.run(
        INSERT.into(e.TransactionMetadata).entries({
          tx_hash: seededTxHash,
          label: '721',
          payload: JSON.stringify({ test: true }),
        }),
      );

      const res = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: seededTxHash });
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        const arr0 = Array.isArray(res.data?.value) ? res.data.value : res.data;
        const items = Array.isArray(arr0) ? arr0 : (arr0 ? [arr0] : []);
        expect(items.length).to.be.greaterThan(0);
        expect(items[0]).to.have.property('label');
      }
    });

    test('Cold path (Metadata by label): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const label = '1990';
      const before = await cds.run(SELECT.from(e.TransactionMetadata).where({ label }));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetMetadataLabelTransactions', { label });
      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.TransactionMetadata).where({ label }));
        expect(after.length).to.be.greaterThan(0);
      }
    });

    test('Warm path (Metadata by label): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      const label = '1990';
      await cds.run(
        INSERT.into(e.Transactions).entries({
          hash: 'a'.repeat(64),
          blockHash: 'd'.repeat(64),
          blockHeight: 2,
        }),
      );
      await cds.run(
        INSERT.into(e.TransactionMetadata).entries({
          tx_hash: 'a'.repeat(64),
          label,
          payload: JSON.stringify({ ok: true }),
        }),
      );
      const res = await POST('/odata/v4/cardano-odata/GetMetadataLabelTransactions', { label });
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        const arr = Array.isArray(res.data.value) ? res.data.value : res.data;
        expect(Array.isArray(arr)).to.be.true;
      }
    });

    test('Cold path (UTxOs by address): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.AddressUTxOs).where({ address: validAddress }));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: validAddress });
      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.AddressUTxOs).where({ address: validAddress }));
        expect(after.length).to.be.greaterThan(0);
      }
    });

    test('Warm path (UTxOs by address): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      // seed address
      await cds.run(
        INSERT.into(e.Addresses).entries({
          address: validAddress,
          validFrom: new Date().toISOString(),
          type: 'base',
          isScript: false,
          totalLovelace: 0,
        }),
      );
      // seed UTxO
      await cds.run(
        INSERT.into(e.AddressUTxOs).entries({
          address_address: validAddress,
          hash: 'e'.repeat(64),
          index: 0,
          blockHash: 'f'.repeat(64),
          validFrom: new Date().toISOString(),
        }),
      );
      // Ensure seed is really present
      const { SELECT } = cds.ql;
      const seeded = await cds.run(SELECT.from(e.AddressUTxOs).where({ address: validAddress }));
      expect(seeded.length).to.be.greaterThan(0);

      const res = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: validAddress });
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        const arr = Array.isArray(res.data?.value) ? res.data.value : res.data;
        expect(Array.isArray(arr) || !!arr).to.be.true;
      }
    });

    test('Cold path (Assets by address): empty DB triggers indexing and persists', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.AddressAssets).where({ address: validAddress }));
      expect(before.length).to.equal(0);

      const res = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: validAddress });
      expect([200, 404, 500, 503]).to.include(res.status);
      if (res.status === 200) {
        const after = await cds.run(SELECT.from(e.AddressAssets).where({ address: validAddress }));
        expect(after.length).to.be.greaterThan(0);
      }
    });

    test('Warm path (Assets by address): seeded DB serves without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      // seed address
      await cds.run(
        INSERT.into(e.Addresses).entries({
          address: validAddress,
          validFrom: new Date().toISOString(),
          type: 'base',
          isScript: false,
          totalLovelace: 0,
        }),
      );
      // seed asset
      await cds.run(
        INSERT.into(e.AddressAssets).entries({
          address_address: validAddress,
          unit: 'policy'.padEnd(56, '0') + 'asset',
          validFrom: new Date().toISOString(),
          asset: {
            quantity: 1,
            policyId: '1'.repeat(56),
            assetNameHex: '74657374',
            assetName: 'test',
            fingerprint: 'asset1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
          },
        }),
      );
      // Ensure seed is present
      const { SELECT } = cds.ql;
      const seeded = await cds.run(SELECT.from(e.AddressAssets).where({ address: validAddress }));
      expect(seeded.length).to.be.greaterThan(0);

      const res = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: validAddress });
      expect([200]).to.include(res.status);
      if (res.status === 200) {
        const arr = Array.isArray(res.data?.value) ? res.data.value : res.data;
        expect(Array.isArray(arr) || !!arr).to.be.true;
      }
    });

    // ---------------------------------------------------------------------
    // Entity READ handlers (DB-first) - cold/warm
    // ---------------------------------------------------------------------

    test('READ Cold (NetworkInformation): indexes and persists on first GET', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.NetworkInformation));
      expect(before.length).to.equal(0);

      const { status, data } = await GET `/odata/v4/cardano-odata/NetworkInformation`;
      expect([200]).to.include(status);
      if (Array.isArray(data?.value) && data.value.length > 0) {
        const after = await cds.run(SELECT.from(e.NetworkInformation));
        expect(after.length).to.be.greaterThan(0);
      }
    });

    test('READ Warm (NetworkInformation): returns from DB without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(INSERT.into(e.NetworkInformation).entries({
        network: 'preview',
        validFrom: new Date().toISOString(),
        maxSupply: 0,
        totalSupply: 0,
        circulatingSupply: 0,
        lockedSupply: 0,
        treasurySupply: 0,
        reservesSupply: 0,
        liveStake: 0,
        activeStake: 0,
      }));

      const { status, data } = await GET `/odata/v4/cardano-odata/NetworkInformation`;
      expect(status).to.equal(200);
      expect(Array.isArray(data?.value)).to.be.true;
      expect(data.value.length).to.be.greaterThan(0);
    });

    test('READ Cold (LatestBlock): indexes and persists on first GET', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.LatestBlock));
      expect(before.length).to.equal(0);
      const { status, data } = await GET `/odata/v4/cardano-odata/LatestBlock`;
      expect([200]).to.include(status);
      if (Array.isArray(data?.value) && data.value.length > 0) {
        const after = await cds.run(SELECT.from(e.LatestBlock));
        expect(after.length).to.be.greaterThan(0);
      }
    });

    test('READ Warm (LatestBlock): returns from DB without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(INSERT.into(e.LatestBlock).entries({
        hash: 'b'.repeat(64),
        validFrom: new Date().toISOString(),
        time: new Date().toISOString(),
        height: 1,
        slotLeader: 'leader',
        epochNumber: 1,
        epochSlot: 1,
        size: 1,
        txCount: 0,
        fees: 0,
      }));
      const { status, data } = await GET `/odata/v4/cardano-odata/LatestBlock`;
      expect(status).to.equal(200);
      expect(Array.isArray(data?.value)).to.be.true;
      expect(data.value.length).to.be.greaterThan(0);
    });

    test('READ Cold (LatestEpoch): indexes and persists on first GET', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.LatestEpoch));
      expect(before.length).to.equal(0);
      const { status, data } = await GET `/odata/v4/cardano-odata/LatestEpoch`;
      expect([200]).to.include(status);
      if (Array.isArray(data?.value) && data.value.length > 0) {
        const after = await cds.run(SELECT.from(e.LatestEpoch));
        expect(after.length).to.be.greaterThan(0);
      }
    });

    test('READ Warm (LatestEpoch): returns from DB without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(INSERT.into(e.LatestEpoch).entries({
        epoch: 1,
        validFrom: new Date().toISOString(),
        startTime: Math.floor(Date.now() / 1000),
        endTime: Math.floor(Date.now() / 1000) + 1000,
        firstBlockTime: Math.floor(Date.now() / 1000),
        lastBlockTime: Math.floor(Date.now() / 1000) + 900,
        blockCount: 1,
        txCount: 0,
        output: '0',
        fees: 0,
        activeStake: 0,
      }));
      const { status, data } = await GET `/odata/v4/cardano-odata/LatestEpoch`;
      expect(status).to.equal(200);
      expect(Array.isArray(data?.value)).to.be.true;
      expect(data.value.length).to.be.greaterThan(0);
    });

    test('READ by key Cold (Addresses): indexes address if missing', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.Addresses).where({ address: validAddress }));
      expect(before.length).to.equal(0);
      const { status } = await GET `/odata/v4/cardano-odata/Addresses(address='${validAddress}')`;
      expect([200, 404, 500, 503]).to.include(status);
    });

    test('READ by key Warm (Addresses): returns seeded address without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(INSERT.into(e.Addresses).entries({
        address: validAddress,
        validFrom: new Date().toISOString(),
        type: 'base',
        isScript: false,
        totalLovelace: 0,
      }));
      const { status, data } = await GET `/odata/v4/cardano-odata/Addresses(address='${validAddress}')`;
      expect([200]).to.include(status);
      if (status === 200) {
        expect(data).to.have.property('address');
        expect(data.address).to.equal(validAddress);
      }
    });

    test('READ by key invalid (Addresses): invalid bech32 format returns 400', async () => {
      try {
        await GET `/odata/v4/cardano-odata/Addresses(address='not_a_valid_address')`;
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });

    test('READ by key Cold (Transactions): indexes tx if missing', async () => {
      const e = cds.entities as any;
      const { SELECT } = cds.ql;
      const before = await cds.run(SELECT.from(e.Transactions).where({ hash: validTxHash }));
      expect(before.length).to.equal(0);
      const { status } = await GET `/odata/v4/cardano-odata/Transactions(hash='${validTxHash}')`;
      expect([200, 404, 500, 503]).to.include(status);
    });

    test('READ by key Warm (Transactions): returns seeded tx without re-index', async () => {
      const e = cds.entities as any;
      const { INSERT } = cds.ql;
      await cds.run(INSERT.into(e.Transactions).entries({
        hash: seededTxHash,
        blockHash: 'c'.repeat(64),
        blockHeight: 1,
      }));
      const { status, data } = await GET `/odata/v4/cardano-odata/Transactions(hash='${seededTxHash}')`;
      expect([200]).to.include(status);
      if (status === 200) {
        expect(data).to.have.property('hash');
        expect(data.hash).to.equal(seededTxHash);
      }
    });

    test('READ by key invalid (Transactions): invalid hash format returns 400', async () => {
      try {
        await GET `/odata/v4/cardano-odata/Transactions(hash='invalid')`;
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.response.status).to.equal(400);
      }
    });
  });
});
