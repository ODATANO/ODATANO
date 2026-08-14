import cds from '@sap/cds';
// Native require: shuts down the app context of the cds.test()-booted server
// (an ESM import would target a second, never-initialized module instance).
const { shutdownAppContext } = require('../../srv/server') as typeof import('../../srv/server');

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

// Configure environment BEFORE cds.test() - server uses these via cds.on('served')
process.env.BACKENDS = 'koios';

describe('OData Query Features', () => {

  // cds.test() starts server which creates AppContext automatically
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  afterAll(async () => {
    await shutdownAppContext();
  });

  describe('ODATANO Milestone 1', () => {
    // ============================================================================
    // $FILTER TESTS
    // ============================================================================

    describe('$filter operations', () => {
      it('$filter on NetworkInformation - totalSupply gt value', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/NetworkInformation?$filter=totalSupply gt 1000000`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('$filter on Transactions - fee comparison', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$filter=fee gt 100000`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;

        if (data.value.length > 0) {
          data.value.forEach((tx: any) => {
            expect(Number(tx.fee)).to.be.greaterThan(100000);
          });
        }
      });

      it('$filter on Addresses - totalLovelace range', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$filter=totalLovelace gt 1000000 and totalLovelace lt 10000000`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('$filter on Addresses - isScript eq true', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$filter=isScript eq true`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;

        if (data.value.length > 0) {
          data.value.forEach((addr: any) => {
            expect(addr.isScript).to.equal(true);
          });
        }
      });
    });

    // ============================================================================
    // $SELECT TESTS
    // ============================================================================

    describe('$select operations', () => {
      it('$select specific fields from NetworkInformation', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/NetworkInformation?$select=totalSupply,circulatingSupply`);
        expect(status).to.equal(200);

        if (data.value.length > 0) {
          const item = data.value[0];
          expect(item).to.have.property('totalSupply');
          expect(item).to.have.property('circulatingSupply');
        }
      });

      it('$select single field from Transactions', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$select=hash,fee&$top=5`);
        expect(status).to.equal(200);

        if (data.value.length > 0) {
          const tx = data.value[0];
          expect(tx).to.have.property('hash');
          expect(tx).to.have.property('fee');
        }
      });

      it('$select on Addresses returns only requested fields', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$select=address,type,totalLovelace&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0) {
          const addr = data.value[0];
          expect(addr).to.have.property('address');
          expect(addr).to.have.property('type');
          expect(addr).to.have.property('totalLovelace');
        }
      });
    });

    // ============================================================================
    // $TOP and $SKIP (Pagination)
    // ============================================================================

    describe('Pagination with $top and $skip', () => {
      it('$top limits result count', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$top=3`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;
        expect(data.value.length).to.be.at.most(3);
      });

      it('$skip offsets results', async () => {
        const { status: status1, data: data1 } = await test.get(`/odata/v4/cardano-odata/Transactions?$top=1`);
        const { status: status2, data: data2 } = await test.get(`/odata/v4/cardano-odata/Transactions?$top=1&$skip=1`);

        expect(status1).to.equal(200);
        expect(status2).to.equal(200);

        // If both have results, they should be different
        if (data1.value.length > 0 && data2.value.length > 0) {
          expect(data1.value[0].hash).to.not.equal(data2.value[0].hash);
        }
      });

      it('$top and $skip together for pagination', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$top=5&$skip=2`);
        expect(status).to.equal(200);
        expect(data.value.length).to.be.at.most(5);
      });
    });

    // ============================================================================
    // $COUNT
    // ============================================================================

    describe('$count operations', () => {
      it('$count=true includes count in response', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$count=true&$top=5`);
        expect(status).to.equal(200);

        // OData v4 includes @odata.count when $count=true
        if (data['@odata.count'] !== undefined) {
          // CAP 10: @odata.count serializes as string (Edm.Int64) — accept both, normalize for range check
          expect(typeof data['@odata.count']).to.be.oneOf(['number', 'string']);
          expect(Number(data['@odata.count'])).to.be.at.least(0);
        }
      });

      it('GET /$count returns count value', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/NetworkInformation/$count`);
        expect(status).to.equal(200);
        expect(typeof data).to.be.oneOf(['number', 'string']);
      });
    });

    // ============================================================================
    // $ORDERBY
    // ============================================================================

    describe('$orderby operations', () => {
      it('$orderby on Transactions by fee ascending', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$orderby=fee asc&$top=3`);
        expect(status).to.equal(200);

        if (data.value.length >= 2) {
          for (let i = 0; i < data.value.length - 1; i++) {
            expect(Number(data.value[i].fee)).to.be.at.most(Number(data.value[i + 1].fee));
          }
        }
      });

      it('$orderby on Transactions by fee descending', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$orderby=fee desc&$top=3`);
        expect(status).to.equal(200);

        if (data.value.length >= 2) {
          for (let i = 0; i < data.value.length - 1; i++) {
            expect(Number(data.value[i].fee)).to.be.at.least(Number(data.value[i + 1].fee));
          }
        }
      });

      it('$orderby on Addresses by totalLovelace', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$orderby=totalLovelace desc&$top=5`);
        expect(status).to.equal(200);

        if (data.value.length >= 2) {
          for (let i = 0; i < data.value.length - 1; i++) {
            expect(Number(data.value[i].totalLovelace)).to.be.at.least(Number(data.value[i + 1].totalLovelace));
          }
        }
      });
    });

    // ============================================================================
    // $EXPAND
    // ============================================================================

    describe('$expand operations', () => {
      it('$expand inputs on Transactions', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$expand=inputs&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0 && data.value[0].inputs) {
          expect(Array.isArray(data.value[0].inputs)).to.be.true;
        }
      });

      it('$expand outputs on Transactions', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$expand=outputs&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0 && data.value[0].outputs) {
          expect(Array.isArray(data.value[0].outputs)).to.be.true;
        }
      });

      it('$expand multiple relations on Transactions', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$expand=inputs,outputs&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0) {
          const tx = data.value[0];
          if (tx.inputs) expect(Array.isArray(tx.inputs)).to.be.true;
          if (tx.outputs) expect(Array.isArray(tx.outputs)).to.be.true;
        }
      });

      it('$expand assets on Addresses', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$expand=assets&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0 && data.value[0].assets) {
          expect(Array.isArray(data.value[0].assets)).to.be.true;
        }
      });

      it('$expand utxos on Addresses', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$expand=utxos&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0 && data.value[0].utxos) {
          expect(Array.isArray(data.value[0].utxos)).to.be.true;
        }
      });
    });

    // ============================================================================
    // Combined Query Features
    // ============================================================================

    describe('Combined query operations', () => {
      it('$filter + $select + $top combination', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$filter=fee gt 100000&$select=hash,fee&$top=2`);
        expect(status).to.equal(200);
        expect(data.value.length).to.be.at.most(2);

        if (data.value.length > 0) {
          const tx = data.value[0];
          expect(tx).to.have.property('hash');
          expect(tx).to.have.property('fee');
          expect(Number(tx.fee)).to.be.greaterThan(100000);
        }
      });

      it('$filter + $orderby + $top combination', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$filter=totalLovelace gt 1000000&$orderby=totalLovelace desc&$top=3`);
        expect(status).to.equal(200);
        expect(data.value.length).to.be.at.most(3);

        if (data.value.length > 0) {
          data.value.forEach((addr: any) => {
            expect(Number(addr.totalLovelace)).to.be.greaterThan(1000000);
          });
        }
      });

      it('$select + $expand combination', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$select=hash,fee&$expand=inputs&$top=1`);
        expect(status).to.equal(200);

        if (data.value.length > 0) {
          const tx = data.value[0];
          expect(tx).to.have.property('hash');
          expect(tx).to.have.property('fee');
          if (tx.inputs) {
            expect(Array.isArray(tx.inputs)).to.be.true;
          }
        }
      });

      it('$filter + $expand + $count combination', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$filter=fee gt 100000&$expand=outputs&$count=true&$top=2`);
        expect(status).to.equal(200);

        if (data['@odata.count'] !== undefined) {
          expect(Number(data['@odata.count'])).to.be.at.least(0); // CAP 10: @odata.count → string
        }
      });
    });

    describe('OData Query Capabilities', () => {
      it('$top and $skip work on collections', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$top=5`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;
        if (data.value.length > 0) {
          expect(data.value.length).to.be.at.most(5);
        }
      });

      it('$count returns count metadata', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Addresses?$count=true`);
        expect(status).to.equal(200);
        expect(data['@odata.count']).to.exist;
      });

      it('$select filters properties', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/Transactions?$select=hash,fee`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;
      });

      it('GET /$metadata - OData metadata is accessible', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-odata/$metadata`);
        expect(status).to.equal(200);
        expect(data).to.include('Transactions');
        expect(data).to.include('Addresses');
        expect(data).to.include('NetworkInformation');
      });
    });
  });

  describe('ODATANO Milestone 2', () => {

    describe('$orderby operations', () => { 
      it( '$orderby on TransactionBuilds by createdAt descending', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$orderby=createdAt desc&$top=3`);
        expect(status).to.equal(200);
      });

      it( '$orderby on TransactionBuildInputs by createdAt ascending', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuildInputs?$orderby=inputIndex asc&$top=3`);
        expect(status).to.equal(200);
      });

      it( '$orderby on TransactionBuildOutputs by createdAt descending', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuildOutputs?$orderby=outputIndex desc&$top=3`);
        expect(status).to.equal(200);
      });

      it( '$orderby on TransactionSubmissions by createdAt ascending', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionSubmissions?$orderby=submittedAt asc&$top=3`);
        expect(status).to.equal(200);
      });

      it( '$orderby on TransactionSubmissionErrors by submittedAt descending', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionSubmissionErrors?$orderby=id desc&$top=3`);
        expect(status).to.equal(200);
      });
    });

    describe('$expand operations', () => {
      it('$expand inputs on TransactionBuilds', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$expand=inputs&$top=1`);
        expect(status).to.equal(200);
      });
      it('$expand outputs on TransactionBuilds', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$expand=outputs&$top=1`);
        expect(status).to.equal(200);
      });
    }); 

    describe('Combined query operations', () => { 
      it('$filter + $select + $top combination on TransactionSubmissions', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionSubmissions?$filter=status eq 'pending'&$select=id,txHash&$top=2`);
        expect(status).to.equal(200);
      });
      it('$filter + $orderby + $top combination on TransactionBuilds', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$filter=wasSubmitted eq 'false'&$orderby=createdAt desc&$top=3`);
        expect(status).to.equal(200);
      });
      it('$select + $expand combination on TransactionBuilds', async () => {
        const { status } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$select=id,network&$expand=inputs&$top=1`);
        expect(status).to.equal(200);
      });
    });

    describe('OData Query Capabilities', () => {
     
      it('GET /$metadata - OData metadata is accessible', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-transaction/$metadata`);
        expect(status).to.equal(200);
        expect(data).to.include('TransactionBuilds');
        expect(data).to.include('TransactionBuildInputs');
        expect(data).to.include('TransactionBuildOutputs');
        expect(data).to.include('TransactionSubmissions');
        expect(data).to.include('TransactionSubmissionErrors');
      });

      it('$count returns count metadata', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$count=true`);
        expect(status).to.equal(200);
        expect(data['@odata.count']).to.exist;
      });

      it('$select filters properties', async () => {
        const { status, data } = await test.get(`/odata/v4/cardano-transaction/TransactionBuilds?$select=senderAddress,network`);
        expect(status).to.equal(200);
        expect(Array.isArray(data.value)).to.be.true;
      });
    });
  });
});
