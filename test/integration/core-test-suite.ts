// Backend-specific environment is configured in the backend entry tests.
import cds from '@sap/cds';
import {
  TestConfiguration,
  configureBackendForTest,
  TEST_FIXTURES,
} from './test-fixtures';
const { SELECT, INSERT } = cds.ql;

// Helper function to create test suite for a specific backend
export function createBackendTestSuite(backendConfig: TestConfiguration) {

  // Configure environment BEFORE cds.test() - server will use these automatically via cds.on('served')
  configureBackendForTest(backendConfig);

  describe(`Complete Service Tests Cardano Service [${backendConfig.backendName.toUpperCase()}]`, () => {
    // 200s — covers slow live-network reads (Koios pool/account lookups can take 10-30s).
    // Set inside the describe so the value is snapshotted when these tests are registered;
    // the sibling error-handling suite reverts to a tighter 20s for its own tests.
    vi.setConfig({ testTimeout: 200000, hookTimeout: 200000 });

    // cds.test() starts server which triggers cds.on('served') → creates AppContext automatically
    const test = cds.test(__dirname + '/../../');
    const expect = test.expect;

    // Only reset the database before each test - AppContext already created by server
    beforeEach(async () => {
      await test.data.reset();
    });

    // Note: shutdownAppContext is NOT called here. core.{blockfrost,koios}.test.ts
    // registers createErrorBackendSuite as a sibling suite right after this one in
    // the same file. Calling shutdownAppContext here would null appContext while
    // the same cds.test() server keeps running — every handler call in the next
    // suite would then throw "Application not initialized". The error-handling
    // suite owns the file-level teardown.

    describe('ODATANO Milestone 1 - CardanoService Tests', () => {
      // ============================================================================
      // NetworkInformation
      // ============================================================================
      describe('NetworkInformation Entity Tests', () => {

        describe('READ NetworkInformation Entity', () => {

          it('GET /NetworkInformation – read NetworkInformation collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/NetworkInformation`);
            expect(data.value[0]).to.have.property('maxSupply');
            expect(data.value[0]).to.have.property('circulatingSupply');
            expect(status).to.equal(200);
          });

          it('POST /GetNetworkInformation – read current NetworkInformation via action', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {});
            expect(data).to.have.property('maxSupply');
            expect(data).to.have.property('circulatingSupply');
            expect(status).to.equal(200);
          });
        });

        describe('NetworkInformation Entity Cold Indexing', () => {

          it('GET /NetworkInformation – cold read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { NetworkInformation } = CardanoService.entities
            // make sure DB is empty
            const before = await cds.run(SELECT.from(NetworkInformation));
            expect(before.length).to.equal(0);
            // call the GET endpoint
            const { status, data } = await test.get(`/odata/v4/cardano-odata/NetworkInformation`);
            expect(status).to.equal(200);
            // verify data persisted
            const after = await cds.run(SELECT.from(NetworkInformation));
            expect(after.length).to.be.equal(1);
            // verify response data
            expect(data.value[0]).to.have.property('circulatingSupply');
          });

          it('POST /GetNetworkInformation – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { NetworkInformation } = CardanoService.entities
            // make sure DB is empty
            const before = await cds.run(SELECT.from(NetworkInformation));
            expect(before.length).to.equal(0);
            // call the POST endpoint
            const { status } = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {});
            expect(status).to.equal(200);
            // verify data persisted
            const after = await cds.run(SELECT.from(NetworkInformation));
            expect(after.length).to.be.equal(1);
          });
        });

        describe('NetworkInformation Entity Warm Reads', () => {

          it('GET /NetworkInformation – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { NetworkInformation } = CardanoService.entities;
            await cds.run(INSERT.into(NetworkInformation).entries({
              network: 'preview',
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 120000).toISOString(),
              maxSupply: 4500000000000000,
              totalSupply: 4500000000000000,
              circulatingSupply: 4500000000000000,
              lockedSupply: 5000000000000000,
              treasurySupply: 5000000000000000,
              reservesSupply: 5000000000000000,
              liveStake: 5000000000000000,
              activeStake: 5000000000000000,
            }));

            const { status, data } = await test.get(`/odata/v4/cardano-odata/NetworkInformation`);
            // verify response data served from DB Not re-indexed
            // CAP 10: Decimal(20,0) (Lovelace) serializes as string — normalize before compare
            expect(Number(data.value[0].maxSupply)).to.equal(4500000000000000);
            expect(Number(data.value[0].circulatingSupply)).to.equal(4500000000000000);
            expect(status).to.equal(200);
          });

          it('POST /GetNetworkInformation – warm action read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { NetworkInformation } = CardanoService.entities;
            const now = Date.now();

            await cds.run(INSERT.into(NetworkInformation).entries({
              network: 'preview',
              validFrom: new Date(now).toISOString(),
              validTo: new Date(now + 120000).toISOString(),
              maxSupply: 4500000000000000,
              totalSupply: 4500000000000000,
              circulatingSupply: 4500000000000000,
              lockedSupply: 5000000000000000,
              treasurySupply: 5000000000000000,
              reservesSupply: 5000000000000000,
              liveStake: 5000000000000000,
              activeStake: 5000000000000000,
            }));

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetNetworkInformation', {});
            // verify response data served from DB Not re-indexed
            // CAP 10: Decimal(20,0) (Lovelace) serializes as string — normalize before compare
            expect(Number(data.maxSupply)).to.equal(4500000000000000);
            expect(Number(data.circulatingSupply)).to.equal(4500000000000000);
            expect(status).to.equal(200);
          });
        });
      });
      // ============================================================================
      // Blocks
      // ============================================================================
      describe('Blocks Entity Tests', () => {

        describe('READ Blocks Entity', () => {
          it('GET /Blocks – read Blocks collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Blocks`);
            expect(Array.isArray(data.value)).to.be.true;
            expect(status).to.equal(200);
          });

          it('POST /GetBlockByHash – read Block by hash', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetBlockByHash', { hash: TEST_FIXTURES.validBlockHash });
            expect(data).to.have.property('height');
            expect(data).to.have.property('hash');
            expect(status).to.equal(200);
          });
        });

        describe('Blocks Entity Cold Indexing', () => {
          it('GET /Blocks – cold read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Blocks } = CardanoService.entities;
            // make sure DB is empty
            const before = await cds.run(SELECT.from(Blocks).where({ hash: TEST_FIXTURES.validBlockHash }));
            expect(before.length).to.equal(0);
            // call the GET endpoint
            const { status } = await test.get(`/odata/v4/cardano-odata/Blocks(hash='${TEST_FIXTURES.validBlockHash}')`);
            expect(status).to.equal(200);
            // verify data persisted
            const after = await cds.run(SELECT.from(Blocks).where({ hash: TEST_FIXTURES.validBlockHash }));
            expect(after.length).to.be.equal(1);
          });

          it('POST /GetBlockByHash – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Blocks } = CardanoService.entities;
            // make sure DB is empty
            const before = await cds.run(SELECT.from(Blocks).where({ hash: TEST_FIXTURES.validBlockHash }));
            expect(before.length).to.equal(0);
            // call the POST endpoint
            const { status } = await test.post('/odata/v4/cardano-odata/GetBlockByHash', { hash: TEST_FIXTURES.validBlockHash });
            expect(status).to.equal(200);
            // verify data persisted
            const after = await cds.run(SELECT.from(Blocks).where({ hash: TEST_FIXTURES.validBlockHash }));
            expect(after.length).to.be.equal(1);
          });
        });

        describe('Blocks Entity Warm Reads', () => {
          it('GET /Blocks – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Blocks } = CardanoService.entities;
            await cds.run(INSERT.into(Blocks).entries({
              hash: TEST_FIXTURES.validBlockHash,
              height: 123456,
              slot: 78901234,
              epochNumber: 290,
              epochSlot: 12345,
              time: Math.floor(Date.now() / 1000),
              slotLeader: 'slot_leader_example',
              size: 123456,
              txCount: 10,
            }));
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Blocks(hash='${TEST_FIXTURES.validBlockHash}')`);
            // verify response data served from DB Not re-indexed
            expect(data.hash).to.equal(TEST_FIXTURES.validBlockHash);
            expect(data.height).to.equal(123456);
            expect(status).to.equal(200);
          });

          it('POST /GetBlockByHash – warm action read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Blocks } = CardanoService.entities;
            await cds.run(INSERT.into(Blocks).entries({
              hash: TEST_FIXTURES.validBlockHash,
              height: 123456,
              slot: 78901234,
              epochNumber: 290,
              epochSlot: 12345,
              time: Math.floor(Date.now() / 1000),
              slotLeader: 'slot_leader_example',
              size: 123456,
              txCount: 10,
            }));
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetBlockByHash', { hash: TEST_FIXTURES.validBlockHash });
            // verify response data served from DB Not re-indexed
            expect(data.hash).to.equal(TEST_FIXTURES.validBlockHash);
            expect(data.height).to.equal(123456);
            expect(status).to.equal(200);
          });
        });
      });
      // ============================================================================
      // Epochs
      // ============================================================================
      describe('Epochs Entity Tests', () => {
        // Dynamically resolve epoch numbers from the live network to avoid flaky tests
        let recentEpoch: number;
        let coldEpoch: number;
        // Koios returns empty arrays intermittently for historical epochs — skip cold indexing

        beforeAll(async () => {
          const { data: latest } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
          recentEpoch = latest.epoch - 5;
          coldEpoch = latest.epoch - 10;
        });

        describe('READ Epochs Entity', () => {
          it('GET /Epochs – read Epochs collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Epochs`);

            expect(Array.isArray(data.value)).to.be.true;
            expect(status).to.equal(200);
          });

          it('POST /GetEpochByNumber – read Epoch by number', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: recentEpoch });
            expect(data).to.have.property('epoch');
            expect(status).to.equal(200);
          });
        });

        describe('Epochs Entity Cold Indexing', () => {
          it('GET /Epochs – cold read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Epochs } = CardanoService.entities;
            // make sure DB is empty
            const before = await cds.run(SELECT.from(Epochs).where({ epoch: recentEpoch }));
            expect(before.length).to.equal(0);
            // call the GET endpoint
            const { status } = await test.get(`/odata/v4/cardano-odata/Epochs(epoch=${recentEpoch})`);
            const after = await cds.run(SELECT.from(Epochs).where({ epoch: recentEpoch }));
            expect(after.length).to.equal(1);
            expect(status).to.equal(200);
          });

          it('POST /GetEpochByNumber – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Epochs } = CardanoService.entities;
            // make sure DB is empty
            const before = await cds.run(SELECT.from(Epochs).where({ epoch: coldEpoch }));
            expect(before.length).to.equal(0);
            // call the POST endpoint
            const { status } = await test.post('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: coldEpoch });
            const after = await cds.run(SELECT.from(Epochs).where({ epoch: coldEpoch }));
            expect(after.length).to.equal(1);
            expect(status).to.equal(200);
          });
        });

        describe('Epochs Entity Warm Reads', () => {
          it('GET /Epochs – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Epochs } = CardanoService.entities;

            await cds.run(INSERT.into(Epochs).entries({
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

            const { status, data } = await test.get(`/odata/v4/cardano-odata/Epochs(epoch=1)`);

            expect(data.epoch).to.equal(1);
            expect(status).to.equal(200);
          });

          it('POST /GetEpochByNumber – warm action read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Epochs } = CardanoService.entities;
            await cds.run(INSERT.into(Epochs).entries({
              epoch: 2,
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
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: 2 });
            expect(data.epoch).to.equal(2);
            expect(status).to.equal(200);
          });
        });
      });
      // ============================================================================
      // Transactions
      // ============================================================================
      describe('Transactions Entity Tests', () => {
        describe('READ Transactions Entity', () => {
          it('GET /Transactions – read Transactions collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions`);
            expect(Array.isArray(data.value)).to.be.true;
            expect(status).to.equal(200);
          });

          it('POST /GetTransactionByHash – read Transaction by hash', async () => {

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetTransactionByHash', { hash: TEST_FIXTURES.validTxHash });

            expect(data).to.have.property('hash');
            expect(data.hash).to.equal(TEST_FIXTURES.validTxHash);
            expect(data).to.have.property('blockHeight');
            expect(status).to.equal(200);
          });
          it('POST /GetTransactionByHash – transaction with metadata', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetTransactionByHash', { hash: TEST_FIXTURES.txWithMetadata });
            expect(data).to.have.property('hash');
            expect(data.hash).to.equal(TEST_FIXTURES.txWithMetadata);
            expect(data).to.have.property('blockHeight');
            expect(status).to.equal(200);
          });

        });

        describe('Transactions Entity Cold Indexing', () => {
          it('POST /GetTransactionByHash – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Transactions } = CardanoService.entities;

            const before = await cds.run(SELECT.from(Transactions).where({ hash: TEST_FIXTURES.validTxHash }));
            expect(before.length).to.equal(0);
            const { status } = await test.post('/odata/v4/cardano-odata/GetTransactionByHash', { hash: TEST_FIXTURES.validTxHash });
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Transactions).where({ hash: TEST_FIXTURES.validTxHash }));
            expect(after.length).to.equal(1);
          });

          it('GET /Transactions(hash=…) – cold key read triggers indexing', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Transactions } = CardanoService.entities as any;

            const before = await cds.run(SELECT.from(Transactions).where({ hash: TEST_FIXTURES.validTxHash }));
            expect(before.length).to.equal(0);
            const { status } = await test.get(`/odata/v4/cardano-odata/Transactions(hash='${TEST_FIXTURES.validTxHash}')`);
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Transactions).where({ hash: TEST_FIXTURES.validTxHash }));
            expect(after.length).to.equal(1);
          });
        });

        describe('Transactions Entity Warm Reads', () => {

          it('POST /GetTransactionByHash – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Transactions } = CardanoService.entities;

            await cds.run(
              INSERT.into(Transactions).entries({
                hash: TEST_FIXTURES.validTxHash,
                blockHash: 'beadfacebeadfacebeadfacebeadfacebeadfacebeadfacebeadfacebeadface',
                blockHeight: 123,
              }),
            );

            const { data, status } = await test.post('/odata/v4/cardano-odata/GetTransactionByHash', { hash: TEST_FIXTURES.validTxHash });

            expect(data).to.have.property('hash');
            expect(data.hash).to.equal(TEST_FIXTURES.validTxHash);
            expect(status).to.equal(200);
          });

          it('GET /Transactions(hash=…) – warm key read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Transactions } = CardanoService.entities as any;

            await cds.run(INSERT.into(Transactions).entries({
              hash: TEST_FIXTURES.validTxHash,
              blockHash: 'c'.repeat(64),
              blockHeight: 1,
            }));

            const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions(hash='${TEST_FIXTURES.validTxHash}')`);

            expect(data).to.have.property('hash');
            expect(data.hash).to.equal(TEST_FIXTURES.validTxHash);
            expect(status).to.equal(200);
          });
        });

        describe('Transactions Sub-Entities Reads', () => {

          it('GET /TransactionInputs – read TransactionInputs collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/TransactionInputs`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('GET /TransactionOutputs – read TransactionOutputs collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/TransactionOutputs`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('GET /TransactionInputAssets – read TransactionInputAssets collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/TransactionInputAssets`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('GET /TransactionOutputAssets – read TransactionOutputAssets collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/TransactionOutputAssets`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });
        });
      });

      // ============================================================================ 
      // Metadata
      // ============================================================================
      describe('TransactionMetadata Entity Tests', () => {

        describe('READ TransactionMetadata Entity', () => {

          it('POST /GetMetadataByTxHash – read TransactionMetadata by transaction hash', async () => {
            const { status } = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: TEST_FIXTURES.txWithMetadata });
            expect(status).to.equal(200);
          });

          it('POST /GetMetadataByTxHash – read TransactionMetadata (transaction with metadata)', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: TEST_FIXTURES.txWithMetadata });

            expect(data.value[0]).to.have.property('label');
            expect(status).to.equal(200);
          });

          it('GET /TransactionMetadata – read TransactionMetadata collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/TransactionMetadata`);

            expect(Array.isArray(data.value)).to.be.true;
            expect(status).to.equal(200);
          });

          it('GET /TransactionMetadata(key) – read TransactionMetadata by composite key', async () => {
            const { status, data } = await test.get(
              `/odata/v4/cardano-odata/TransactionMetadata(tx_hash='${TEST_FIXTURES.txWithMetadata}',id=0)`
            );

            expect(data).to.have.property('label');
            expect(data).to.have.property('payload');
            expect(status).to.equal(200);
          });

          it('POST /GetMetadataByTxHash – read TransactionMetadata via indexing path', async () => {

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: TEST_FIXTURES.txWithMetadata });

            expect(data.value[0]).to.have.property('label');
            expect(data.value[0]).to.have.property('payload');
            expect(status).to.equal(200);
          });
        });

        describe('TransactionMetadata Entity Cold Indexing', () => {

          it('POST /GetMetadataByTxHash – cold read by transaction triggers indexing', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { TransactionMetadata } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(TransactionMetadata).where({ tx_hash: TEST_FIXTURES.txWithMetadata }));
            expect(before.length).to.equal(0);

            const { status } = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: TEST_FIXTURES.txWithMetadata });
            expect(status).to.equal(200);
          });
        });

        describe('TransactionMetadata Entity Warm Reads', () => {
          it('POST /GetMetadataByTxHash – warm read by transaction without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Transactions, TransactionMetadata } = CardanoService.entities as any;

            // ensure transaction exists
            await cds.run(
              INSERT.into(Transactions).entries({
                hash: TEST_FIXTURES.validTxHash,
                blockHash: 'c'.repeat(64),
                blockHeight: 1,
              }),
            );
            // seed metadata
            await cds.run(
              INSERT.into(TransactionMetadata).entries({
                id: 0,
                tx_hash: TEST_FIXTURES.validTxHash,
                label: '721',
                payload: JSON.stringify({ test: true }),
              }),
            );

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetMetadataByTxHash', { txHash: TEST_FIXTURES.validTxHash });
            // get first row 
            const firstrow = data.value[0];

            expect(status).to.equal(200);
            expect(firstrow).to.have.property('tx_hash');
            expect(firstrow.tx_hash).to.equal(TEST_FIXTURES.validTxHash);
            expect(firstrow).to.have.property('label');
            expect(firstrow.label).to.equal('721');
          });

          it('READ /TransactionMetadata(key) – warm key read without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Transactions, TransactionMetadata } = CardanoService.entities as any;
            // ensure transaction exists
            await cds.run(
              INSERT.into(Transactions).entries({
                hash: TEST_FIXTURES.validTxHash,
                blockHash: 'c'.repeat(64),
                blockHeight: 1,
              }),
            );
            // seed metadata
            await cds.run(
              INSERT.into(TransactionMetadata).entries({
                id: 1,
                tx_hash: TEST_FIXTURES.validTxHash,
                label: '1990',
                payload: JSON.stringify({ test: true }),
              }),
            );
            const { status, data } = await test.get(
              `/odata/v4/cardano-odata/TransactionMetadata(tx_hash='${TEST_FIXTURES.validTxHash}',id=1)`
            );
            expect(status).to.equal(200);
            expect(data).to.have.property('tx_hash');
            expect(data.tx_hash).to.equal(TEST_FIXTURES.validTxHash);
            expect(data).to.have.property('label');
            expect(data.label).to.equal('1990');
          });
        });
      });

      // ============================================================================
      // Addresses
      // ============================================================================
      describe('Addresses Entity Tests', () => {

        describe('READ Addresses Entity', () => {

          it('GET /Addresses – read Addresses collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses`);

            // For initial empty DB, expect empty collection
            expect(Array.isArray(data.value)).to.be.true;
            expect(data.value.length).to.be.equal(0);
            expect(status).to.equal(200);
          });

          it('POST /GetAddressByBech32 – read Address by bech32', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithFunds });
            expect([200]).to.include(status);
            expect(data).to.have.property('address');
          });

          it('POST /GetUTxOsByAddress – read UTxOs by Address', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });

            expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
            expect(status).to.be.equal(200);
          });

          it('POST /GetAddressByBech32 – read Address with indexing', async () => {

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithFunds });

            expect(data).to.have.property('address');
            expect(data.address).to.equal(TEST_FIXTURES.addressWithFunds);
            expect(data).to.have.property('type');
            expect(data).to.have.property('isScript');
            expect(status).to.equal(200);
          });
        });

        describe('Addresses Entity Cold Indexing', () => {

          it('POST /GetUTxOsByAddress – cold read triggers UTxO indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { AddressUTxOs } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(AddressUTxOs).where({ address_address: TEST_FIXTURES.addressWithFunds }));
            expect(before.length).to.equal(0);
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });
            const after = await cds.run(SELECT.from(AddressUTxOs).where({ address_address: TEST_FIXTURES.addressWithFunds }));
            expect(after.length).to.be.greaterThan(0);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          });

          it('POST /GetAssetsByAddress – cold read triggers Asset indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { AddressAssets } = CardanoService.entities as any;

            const before = await cds.run(SELECT.from(AddressAssets).where({ address_address: TEST_FIXTURES.addressWithFunds }));
            expect(before.length).to.equal(0);

            const { status } = await test.post('/odata/v4/cardano-odata/GetAssetsByAddress', { address: TEST_FIXTURES.addressWithFunds });

            const after = await cds.run(SELECT.from(AddressAssets).where({ address_address: TEST_FIXTURES.addressWithFunds }));
            expect(after.length).to.be.greaterThan(0);
            expect(status).to.equal(200);
          });

          it('POST /GetAddressByBech32 – cold read triggers Address indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Addresses } = CardanoService.entities as any;


            const before = await cds.run(SELECT.from(Addresses).where({ address: TEST_FIXTURES.addressWithFunds }));
            expect(before.length).to.equal(0);

            const { status } = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithFunds });
            expect(status).to.equal(200);

            const after = await cds.run(SELECT.from(Addresses).where({ address: TEST_FIXTURES.addressWithFunds }));
            expect(after.length).to.equal(1);
          });
        });

        describe('Addresses Entity Warm Reads', () => {

          it('POST /GetUTxOsByAddress – warm read serves seeded DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { AddressUTxOs, Addresses } = CardanoService.entities as any;

            // seed address
            await cds.run(
              INSERT.into(Addresses).entries({
                address: TEST_FIXTURES.addressWithFunds,
                validFrom: new Date().toISOString(),
                validTo: new Date(Date.now() + 60000).toISOString(),
                type: 'base',
                isScript: false,
                totalLovelace: 0,
              }),
            );
            // seed UTxO
            await cds.run(
              INSERT.into(AddressUTxOs).entries({
                address_address: TEST_FIXTURES.addressWithFunds,
                hash: 'e'.repeat(64),
                index: 0,
                blockHash: 'f'.repeat(64),
                validFrom: new Date().toISOString(),
                validTo: new Date(Date.now() + 60000).toISOString(),
              }),
            );
            // Ensure seed is really present
            const seeded = await cds.run(SELECT.from(AddressUTxOs).where({ address_address: TEST_FIXTURES.addressWithFunds }));
            expect(seeded.length).to.be.greaterThan(0);

            const { data, status } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });

            expect(Array.isArray(data.value)).to.be.true;
            expect(status).to.equal(200);
          });

          it('POST /GetAssetsByAddress – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { AddressAssets, Addresses } = CardanoService.entities as any;

            // seed address
            await cds.run(
              INSERT.into(Addresses).entries({
                address: TEST_FIXTURES.addressWithFunds,
                type: 'base',
                isScript: false,
                totalLovelace: 1000000,
                validFrom: new Date().toISOString(),
                validTo: new Date(Date.now() + 60000).toISOString(),
              }),
            );
            // seed asset
            await cds.run(
              INSERT.into(AddressAssets).entries({
                address_address: TEST_FIXTURES.addressWithFunds,
                unit: 'policy'.padEnd(56, '0') + 'asset',
                validFrom: new Date().toISOString(),
                validTo: new Date(Date.now() + 60000).toISOString(),
                asset: {
                  quantity: 1,
                  policyId: '1'.repeat(56),
                  assetNameHex: '74657374',
                  assetName: 'test',
                  fingerprint: 'asset1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
                },
              }),
            );
            // Ensure seed is really present
            const seeded = await cds.run(SELECT.from(AddressAssets).where({ address_address: TEST_FIXTURES.addressWithFunds }));
            expect(seeded.length).to.be.greaterThan(0);

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAssetsByAddress', { address: TEST_FIXTURES.addressWithFunds });

            expect(Array.isArray(data.value)).to.be.true;
            expect(data.value[0]).to.have.property('unit');
            expect(status).to.equal(200);
          });

          it('POST /GetAddressByBech32 – warm read of Address without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Addresses } = CardanoService.entities as any;

            await cds.run(
              INSERT.into(Addresses).entries({
                address: TEST_FIXTURES.addressWithFunds,
                type: 'base',
                isScript: false,
                totalLovelace: 0,
                validFrom: new Date().toISOString(),
                validTo: new Date(Date.now() + 60000).toISOString(),
              }),
            );

            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithFunds });
            expect(data).to.have.property('address');
            expect(data.address).to.equal(TEST_FIXTURES.addressWithFunds);
            expect(status).to.equal(200);
          });

          it('GET /Addresses – warm read serves seeded DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Addresses } = CardanoService.entities as any;
            await cds.run(
              INSERT.into(Addresses).entries({
                address: TEST_FIXTURES.addressWithFunds,
                type: 'base',
                isScript: false,
                totalLovelace: 0,
                validFrom: new Date().toISOString(),
                validTo: new Date(Date.now() + 60000).toISOString(),
              }),
            );
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses(address='${TEST_FIXTURES.addressWithFunds}')`);
            expect(data).to.have.property('address');
            expect(data.address).to.equal(TEST_FIXTURES.addressWithFunds);
            expect(status).to.equal(200);
          });
        });

        describe('Addresses Sub-Entities Reads', () => {
          it('GET /AddressAssets – read AddressAssets collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/AddressAssets`);
            // For initial empty DB, expect empty collection
            expect(Array.isArray(data.value)).to.be.true;
            expect(data.value.length).to.be.equal(0);
            expect(status).to.equal(200);
          });

          it('POST /GetAddressByBech32 – read Address with assets', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAddressByBech32', { address: TEST_FIXTURES.addressWithFunds });

            expect(data.address).to.equal(TEST_FIXTURES.addressWithFunds);
            expect(data).to.have.property('totalLovelace');
            expect(status).to.equal(200);

            const { status: utxoStatus, data: utxoData } = await test.post('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: TEST_FIXTURES.addressWithFunds });

            const utxos = Array.isArray(utxoData.value) ? utxoData.value : utxoData;

            expect(utxos.length).to.be.greaterThan(0);
            //expect(utxos[0]).to.have.property('hash');
            //expect(utxos[0]).to.have.property('index');
            expect(utxoStatus).to.equal(200);
          });

          it('GET /AddressUTxOs – read AddressUTxOs collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/AddressUTxOs`);
            // For initial empty DB, expect empty collection
            expect(Array.isArray(data.value)).to.be.true;
            expect(data.value.length).to.be.equal(0);
            expect(status).to.equal(200);
          });

          it('GET /UTxOAssets – read UTxOAssets collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/UTxOAssets`);
            // For initial empty DB, expect empty collection
            expect(Array.isArray(data.value)).to.be.true;
            expect(data.value.length).to.be.equal(0);
            expect(status).to.equal(200);
          });

          it('POST /GetAssetsByAddress – read Assets by Address', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAssetsByAddress', { address: TEST_FIXTURES.addressWithFunds });
            expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
            expect(status).to.be.equal(200);
          });
        });
      });

      // ============================================================================
      // Account Entities
      // ============================================================================
      describe('Accounts Entity Tests', () => {

        describe('READ Accounts Entity', () => {
          it('GET /Accounts – read Accounts collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Accounts`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('POST /GetAccountByStakeAddress – read Account by stake address', async () => {
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAccountByStakeAddress', { stakeAddress: TEST_FIXTURES.validStakeAddress });

            expect(data).to.have.property('stakeAddress');
            expect(data.stakeAddress).to.equal(TEST_FIXTURES.validStakeAddress);
            expect(data).to.have.property('active');
            expect(status).to.equal(200);
          });
        });

        describe('Accounts Entity Cold Indexing', () => {
          it('POST /GetAccountByStakeAddress – cold read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Accounts } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(Accounts).where({ stakeAddress: TEST_FIXTURES.validStakeAddress }));
            expect(before.length).to.equal(0);
            const { status } = await test.post('/odata/v4/cardano-odata/GetAccountByStakeAddress', { stakeAddress: TEST_FIXTURES.validStakeAddress });
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Accounts).where({ stakeAddress: TEST_FIXTURES.validStakeAddress }));
            expect(after.length).to.equal(1);
          });

          it('GET /Accounts(stakeAddress=…) – cold key read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Accounts } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(Accounts).where({ stakeAddress: TEST_FIXTURES.validStakeAddress }));
            expect(before.length).to.equal(0);

            const { status } = await test.get(`/odata/v4/cardano-odata/Accounts(stakeAddress='${TEST_FIXTURES.validStakeAddress}')`);

            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Accounts).where({ stakeAddress: TEST_FIXTURES.validStakeAddress }));
            expect(after.length).to.equal(1);
          });
        });

        describe('Accounts Entity Warm Reads', () => {
          it('POST /GetAccountByStakeAddress – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Accounts } = CardanoService.entities as any;
            await cds.run(INSERT.into(Accounts).entries({
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 60000).toISOString(),
              stakeAddress: TEST_FIXTURES.validStakeAddress,
              active: true,
              activeEpoch: 300,
              controlledAmount: 1000000,
              rewardsSum: 500000,
            }));
            const { status, data } = await test.post('/odata/v4/cardano-odata/GetAccountByStakeAddress', { stakeAddress: TEST_FIXTURES.validStakeAddress });

            expect(data).to.have.property('stakeAddress');
            expect(data.stakeAddress).to.equal(TEST_FIXTURES.validStakeAddress);
            expect(data).to.have.property('active');
            expect(data.active).to.be.true;
            expect(data).to.have.property('controlledAmount');
            expect(Number(data.controlledAmount)).to.equal(1000000); // CAP 10: Lovelace → string
            expect(status).to.equal(200);
          });

          it('GET /Accounts(stakeAddress=…) – warm key read from DB without re-index', async () => {

            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Accounts } = CardanoService.entities as any;


            await cds.run(INSERT.into(Accounts).entries({
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 60000).toISOString(),
              stakeAddress: TEST_FIXTURES.validStakeAddress,
              active: true,
              activeEpoch: 300,
              controlledAmount: '1000000',
              rewardsSum: '500000',
            }));

            const { status, data } = await test.get(`/odata/v4/cardano-odata/Accounts(stakeAddress='${TEST_FIXTURES.validStakeAddress}')`);

            expect(data).to.have.property('stakeAddress');
            expect(data.stakeAddress).to.equal(TEST_FIXTURES.validStakeAddress);
            expect(data).to.have.property('active');
            expect(data.active).to.be.true;
            expect(data).to.have.property('rewardsSum');
            expect(Number(data.rewardsSum)).to.equal(500000); // CAP 10: Lovelace → string
            expect(status).to.equal(200);
          });
        });
      });

      // ============================================================================
      // Pool Entities
      // ============================================================================
      describe('Pools Entity Tests', () => {

        describe('READ Pools Entity', () => {
          it('GET /Pools – read Pools collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Pools`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('GET /Pools(poolId=…) – read Pool by poolId', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Pools(poolId='${TEST_FIXTURES.validPoolId}')`);
            expect(status).to.equal(200);
            expect(data).to.have.property('poolId');
            expect(data.poolId).to.equal(TEST_FIXTURES.validPoolId);
          });

          it('POST /GetPoolById – read Pool by poolId via action', async () => {
            const { status, data } = await test.post(`/odata/v4/cardano-odata/GetPoolById`, { poolId: TEST_FIXTURES.validPoolId });
            expect(status).to.equal(200);
            expect(data).to.have.property('poolId');
            expect(data.poolId).to.equal(TEST_FIXTURES.validPoolId);
          });
        });

        describe('Pools Entity Cold Indexing', () => {
          it('GET /Pools(poolId=…) – cold key read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Pools } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(Pools).where({ poolId: TEST_FIXTURES.validPoolId }));
            expect(before.length).to.equal(0);

            const { status } = await test.get(`/odata/v4/cardano-odata/Pools(poolId='${TEST_FIXTURES.validPoolId}')`);
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Pools).where({ poolId: TEST_FIXTURES.validPoolId }));
            expect(after.length).to.equal(1);
          });

          it('POST /GetPoolById – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Pools } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(Pools).where({ poolId: TEST_FIXTURES.validPoolId }));
            expect(before.length).to.equal(0);
            const { status } = await test.post(`/odata/v4/cardano-odata/GetPoolById`, { poolId: TEST_FIXTURES.validPoolId });
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Pools).where({ poolId: TEST_FIXTURES.validPoolId }));
            expect(after.length).to.equal(1);
          });
        });

        describe('Pools Entity Warm Reads', () => {
          it('GET /Pools(poolId=…) – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Pools } = CardanoService.entities as any;
            await cds.run(INSERT.into(Pools).entries({
              poolId: TEST_FIXTURES.validPoolId,
              vrfKeyHash: 'a'.repeat(64),
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 60000).toISOString(),
            }));

            const { status, data } = await test.get(`/odata/v4/cardano-odata/Pools(poolId='${TEST_FIXTURES.validPoolId}')`);
            expect(status).to.equal(200);
            expect(data).to.have.property('poolId');
            expect(data.poolId).to.equal(TEST_FIXTURES.validPoolId);
          });

          it('POST /GetPoolById – warm action read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Pools } = CardanoService.entities as any;

            await cds.run(INSERT.into(Pools).entries({
              poolId: TEST_FIXTURES.validPoolId,
              vrfKeyHash: 'c'.repeat(64),
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 60000).toISOString(),
            }));

            const { status, data } = await test.post(`/odata/v4/cardano-odata/GetPoolById`, { poolId: TEST_FIXTURES.validPoolId });

            expect(status).to.equal(200);
            expect(data).to.have.property('poolId');
            expect(data.poolId).to.equal(TEST_FIXTURES.validPoolId);
          });
        });
      });

      // ============================================================================
      // Drep Entities
      // ============================================================================
      describe('Dreps Entity Tests', () => {
        describe('Dreps Entity', () => {
          it('GET /Dreps – read Dreps collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Dreps`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('GET /Dreps(drepId=…) – read Drep by drepId', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Dreps(drepId='${TEST_FIXTURES.validDrepId}')`);
            expect(status).to.equal(200);
            expect(data).to.have.property('drepId');
            expect(data.drepId).to.equal(TEST_FIXTURES.validDrepId);
          });

          it('POST /GetDrepById – read Drep by drepId via action', async () => {
            const { status, data } = await test.post(`/odata/v4/cardano-odata/GetDrepById`, { drepId: TEST_FIXTURES.validDrepId });
            expect(status).to.equal(200);
            expect(data).to.have.property('drepId');
            expect(data.drepId).to.equal(TEST_FIXTURES.validDrepId);
          });
        });

        describe('Dreps Entity Cold Indexing', () => {
          it('GET /Dreps(drepId=…) – cold key read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Dreps } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(Dreps).where({ drepId: TEST_FIXTURES.validDrepId }));
            expect(before.length).to.equal(0);
            const { status } = await test.get(`/odata/v4/cardano-odata/Dreps(drepId='${TEST_FIXTURES.validDrepId}')`);
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Dreps).where({ drepId: TEST_FIXTURES.validDrepId }));
            expect(after.length).to.equal(1);
          });
          it('POST /GetDrepById – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Dreps } = CardanoService.entities as any;
            const before = await cds.run(SELECT.from(Dreps).where({ drepId: TEST_FIXTURES.validDrepId }));
            expect(before.length).to.equal(0);
            const { status } = await test.post(`/odata/v4/cardano-odata/GetDrepById`, { drepId: TEST_FIXTURES.validDrepId });
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.from(Dreps).where({ drepId: TEST_FIXTURES.validDrepId }));
            expect(after.length).to.equal(1);
          });
        });

        describe('Dreps Entity Warm Reads', () => {
          it('GET /Dreps(drepId=…) – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Dreps } = CardanoService.entities as any;

            await cds.run(INSERT.into(Dreps).entries({
              drepId: TEST_FIXTURES.validDrepId,
              rewardAddress: 'addr1' + 'e'.repeat(94),
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 60000).toISOString(),
            }));
            const { status, data } = await test.get(`/odata/v4/cardano-odata/Dreps(drepId='${TEST_FIXTURES.validDrepId}')`);
            expect(status).to.equal(200);
            expect(data).to.have.property('drepId');
            expect(data.drepId).to.equal(TEST_FIXTURES.validDrepId);
          });

          it('POST /GetDrepById – warm action read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { Dreps } = CardanoService.entities as any;
            await cds.run(INSERT.into(Dreps).entries({
              drepId: TEST_FIXTURES.validDrepId,
              rewardAddress: 'addr1' + 'f'.repeat(94),
              validFrom: new Date().toISOString(),
              validTo: new Date(Date.now() + 60000).toISOString(),
            }));

            const { status, data } = await test.post(`/odata/v4/cardano-odata/GetDrepById`, { drepId: TEST_FIXTURES.validDrepId });
            expect(status).to.equal(200);
            expect(data).to.have.property('drepId');
            expect(data.drepId).to.equal(TEST_FIXTURES.validDrepId);
          });
        });
      });
    });

    describe('ODATANO Milestone 2 - CardanoService Tests', () => {

      describe('LedgerProtocolParameters Entity Tests', () => {

        describe('LedgerProtocolParameters Entity', () => {
          it('GET /LedgerProtocolParameters – read ProtocolParameter collection', async () => {
            const { status, data } = await test.get(`/odata/v4/cardano-odata/LedgerProtocolParameters`);
            expect(status).to.equal(200);
            expect(Array.isArray(data.value)).to.be.true;
          });

          it('POST /LedgerProtocolParameters– get ProtocolParameter data', async () => {
            const { status } = await test.post(`/odata/v4/cardano-odata/GetLedgerProtocolParameters`, {});
            expect(status).to.equal(200);
          });
        });

        describe('ProtocolParameters Entity Cold Indexing', () => {
          it('GET /LedgerProtocolParameters – cold read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { LedgerProtocolParameters } = CardanoService.entities as any;
            const before = await cds.run(SELECT.one.from(LedgerProtocolParameters));
            expect(before).to.be.undefined;
            const { status } = await test.get(`/odata/v4/cardano-odata/LedgerProtocolParameters`);
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.one.from(LedgerProtocolParameters));
            expect(after).to.not.be.undefined;
          });

          it('POST /GetLedgerProtocolParameters – cold action read triggers indexing and persists', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { LedgerProtocolParameters } = CardanoService.entities as any;
            const before = await cds.run(SELECT.one.from(LedgerProtocolParameters));
            expect(before).to.be.undefined;
            const { status } = await test.post(`/odata/v4/cardano-odata/GetLedgerProtocolParameters`, {});
            expect(status).to.equal(200);
            const after = await cds.run(SELECT.one.from(LedgerProtocolParameters));
            expect(after).to.not.be.undefined;
          });
        });

        describe('LedgerProtocolParameters Entity Warm Reads', () => {
          it('GET /LedgerProtocolParameters – warm read from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { LedgerProtocolParameters } = CardanoService.entities as any;
            await cds.run(INSERT.into(LedgerProtocolParameters).entries({
              network: 'preview',
              epoch: 200,
              minFeeA: 44,
              minFeeB: 155381,
            }));
            const { status, data } = await test.get(`/odata/v4/cardano-odata/LedgerProtocolParameters`);
            expect(status).to.equal(200);
            expect(data.value).to.be.an('array');
            expect(data.value[0]).to.have.property('epoch');
          });

          it('POST /GetLedgerProtocolParameters – warm action get from DB without re-index', async () => {
            const CardanoService = await cds.connect.to('CardanoODataService');
            const { LedgerProtocolParameters } = CardanoService.entities as any;
            await cds.run(INSERT.into(LedgerProtocolParameters).entries({
              network: 'preview',
              epoch: 200,
              minFeeA: 44,
              minFeeB: 155381,
            }));
            const { status, data } = await test.post(`/odata/v4/cardano-odata/GetLedgerProtocolParameters`, {});
            expect(status).to.equal(200);
            expect(data).to.have.property('epoch');
            expect(data.epoch).to.equal(200);
          });
        });

      });

      describe('LatestBlock and LatestEpoch Actions Tests', () => {

        it('POST /GetLatestBlock – get latest Block data', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestBlock', {});
          expect(data).to.have.property('hash');
          expect(data).to.have.property('height');
          expect(data).to.have.property('size');
          expect(status).to.equal(200);
        });

        it('POST /GetLatestEpoch – get latest Epoch data', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestEpoch', {});
          expect(data).to.have.property('epoch');
          expect(status).to.equal(200);
        });
      });
    });

    describe('ODATANO Milestone 3 - CardanoService Tests', () => {
      describe('Address Transactions Tests', () => {

        it('GET /AddressTransactions – read AddressTransactions collection', async () => {
          const { status, data } = await test.get(`/odata/v4/cardano-odata/AddressTransactions`);
          // For initial empty DB, expect empty collection
          expect(Array.isArray(data.value)).to.be.true;
          expect(data.value.length).to.be.equal(0);
          expect(status).to.equal(200);
        });

        it('POST /GetLatestTransactionsByAddress – read Transactions by Address', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', { address: TEST_FIXTURES.addressWithFunds });
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          expect(status).to.be.equal(200);
        });

        it('POST /GetLatestTransactionsByAddress – with custom limit', async () => {
          const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', { address: TEST_FIXTURES.addressWithFunds, limit: 5 });
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          expect(status).to.be.equal(200);
        });

        it('POST /GetLatestTransactionsByAddress – return existing from cache', async () => {
          // First call indexes data from backend
          await test.post('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', { address: TEST_FIXTURES.addressWithFunds });
          // Second call should return existing from DB (cache hit)
          const { status, data } = await test.post('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', { address: TEST_FIXTURES.addressWithFunds });
          expect(Array.isArray(data.value) || Array.isArray(data)).to.be.true;
          expect(status).to.be.equal(200);
        });
      });
    });
  });

}


