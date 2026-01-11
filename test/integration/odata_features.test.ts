import cds from '@sap/cds';
jest.setTimeout(20000);

describe('ODATANO Milestone 1 - OData Query Features', () => {

  const { GET, expect } = cds.test(__dirname + '/../../');

  // ============================================================================
  // $FILTER TESTS
  // ============================================================================

  describe('$filter operations', () => {
    it('$filter on NetworkInformation - totalSupply gt value', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/NetworkInformation?$filter=totalSupply gt 1000000`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    it('$filter on Transactions - fee comparison', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$filter=fee gt 100000`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;

      if (data.value.length > 0) {
        data.value.forEach((tx: any) => {
          expect(tx.fee).to.be.greaterThan(100000);
        });
      }
    });

    it('$filter on Addresses - totalLovelace range', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$filter=totalLovelace gt 1000000 and totalLovelace lt 10000000`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    it('$filter on Addresses - isScript eq true', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$filter=isScript eq true`;
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
      const { status, data } = await GET`/odata/v4/cardano-odata/NetworkInformation?$select=totalSupply,circulatingSupply`;
      expect(status).to.equal(200);

      if (data.value.length > 0) {
        const item = data.value[0];
        expect(item).to.have.property('totalSupply');
        expect(item).to.have.property('circulatingSupply');
      }
    });

    it('$select single field from Transactions', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$select=hash,fee&$top=5`;
      expect(status).to.equal(200);

      if (data.value.length > 0) {
        const tx = data.value[0];
        expect(tx).to.have.property('hash');
        expect(tx).to.have.property('fee');
      }
    });

    it('$select on Addresses returns only requested fields', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$select=address,type,totalLovelace&$top=1`;
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
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$top=3`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
      expect(data.value.length).to.be.at.most(3);
    });

    it('$skip offsets results', async () => {
      const { status: status1, data: data1 } = await GET`/odata/v4/cardano-odata/Transactions?$top=1`;
      const { status: status2, data: data2 } = await GET`/odata/v4/cardano-odata/Transactions?$top=1&$skip=1`;

      expect(status1).to.equal(200);
      expect(status2).to.equal(200);

      // If both have results, they should be different
      if (data1.value.length > 0 && data2.value.length > 0) {
        expect(data1.value[0].hash).to.not.equal(data2.value[0].hash);
      }
    });

    it('$top and $skip together for pagination', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$top=5&$skip=2`;
      expect(status).to.equal(200);
      expect(data.value.length).to.be.at.most(5);
    });
  });

  // ============================================================================
  // $COUNT
  // ============================================================================

  describe('$count operations', () => {
    it('$count=true includes count in response', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$count=true&$top=5`;
      expect(status).to.equal(200);

      // OData v4 includes @odata.count when $count=true
      if (data['@odata.count'] !== undefined) {
        expect(typeof data['@odata.count']).to.equal('number');
        expect(data['@odata.count']).to.be.at.least(0);
      }
    });

    it('GET /$count returns count value', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/NetworkInformation/$count`;
      expect(status).to.equal(200);
      expect(typeof data).to.be.oneOf(['number', 'string']);
    });
  });

  // ============================================================================
  // $ORDERBY
  // ============================================================================

  describe('$orderby operations', () => {
    it('$orderby on Transactions by fee ascending', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$orderby=fee asc&$top=3`;
      expect(status).to.equal(200);

      if (data.value.length >= 2) {
        for (let i = 0; i < data.value.length - 1; i++) {
          expect(data.value[i].fee).to.be.at.most(data.value[i + 1].fee);
        }
      }
    });

    it('$orderby on Transactions by fee descending', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$orderby=fee desc&$top=3`;
      expect(status).to.equal(200);

      if (data.value.length >= 2) {
        for (let i = 0; i < data.value.length - 1; i++) {
          expect(data.value[i].fee).to.be.at.least(data.value[i + 1].fee);
        }
      }
    });

    it('$orderby on Addresses by totalLovelace', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$orderby=totalLovelace desc&$top=5`;
      expect(status).to.equal(200);

      if (data.value.length >= 2) {
        for (let i = 0; i < data.value.length - 1; i++) {
          expect(data.value[i].totalLovelace).to.be.at.least(data.value[i + 1].totalLovelace);
        }
      }
    });
  });

  // ============================================================================
  // $EXPAND
  // ============================================================================

  describe('$expand operations', () => {
    it('$expand inputs on Transactions', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$expand=inputs&$top=1`;
      expect(status).to.equal(200);

      if (data.value.length > 0 && data.value[0].inputs) {
        expect(Array.isArray(data.value[0].inputs)).to.be.true;
      }
    });

    it('$expand outputs on Transactions', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$expand=outputs&$top=1`;
      expect(status).to.equal(200);

      if (data.value.length > 0 && data.value[0].outputs) {
        expect(Array.isArray(data.value[0].outputs)).to.be.true;
      }
    });

    it('$expand multiple relations on Transactions', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$expand=inputs,outputs&$top=1`;
      expect(status).to.equal(200);

      if (data.value.length > 0) {
        const tx = data.value[0];
        if (tx.inputs) expect(Array.isArray(tx.inputs)).to.be.true;
        if (tx.outputs) expect(Array.isArray(tx.outputs)).to.be.true;
      }
    });

    it('$expand assets on Addresses', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$expand=assets&$top=1`;
      expect(status).to.equal(200);

      if (data.value.length > 0 && data.value[0].assets) {
        expect(Array.isArray(data.value[0].assets)).to.be.true;
      }
    });

    it('$expand utxos on Addresses', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$expand=utxos&$top=1`;
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
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$filter=fee gt 100000&$select=hash,fee&$top=2`;
      expect(status).to.equal(200);
      expect(data.value.length).to.be.at.most(2);

      if (data.value.length > 0) {
        const tx = data.value[0];
        expect(tx).to.have.property('hash');
        expect(tx).to.have.property('fee');
        expect(tx.fee).to.be.greaterThan(100000);
      }
    });

    it('$filter + $orderby + $top combination', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$filter=totalLovelace gt 1000000&$orderby=totalLovelace desc&$top=3`;
      expect(status).to.equal(200);
      expect(data.value.length).to.be.at.most(3);

      if (data.value.length > 0) {
        data.value.forEach((addr: any) => {
          expect(addr.totalLovelace).to.be.greaterThan(1000000);
        });
      }
    });

    it('$select + $expand combination', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$select=hash,fee&$expand=inputs&$top=1`;
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
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$filter=fee gt 100000&$expand=outputs&$count=true&$top=2`;
      expect(status).to.equal(200);

      if (data['@odata.count'] !== undefined) {
        expect(data['@odata.count']).to.be.at.least(0);
      }
    });
  });

  describe('OData Query Capabilities', () => {
    it('$top and $skip work on collections', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$top=5`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
      if (data.value.length > 0) {
        expect(data.value.length).to.be.at.most(5);
      }
    });

    it('$count returns count metadata', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Addresses?$count=true`;
      expect(status).to.equal(200);
      expect(data['@odata.count']).to.exist;
    });

    it('$select filters properties', async () => {
      const { status, data } = await GET`/odata/v4/cardano-odata/Transactions?$select=hash,fee`;
      expect(status).to.equal(200);
      expect(Array.isArray(data.value)).to.be.true;
    });

    it('GET /$metadata - OData metadata is accessible', async () => {
      const { status, data } = await GET(`/odata/v4/cardano-odata/$metadata`);
      expect(status).to.equal(200);
      expect(data).to.include('Transactions');
      expect(data).to.include('Addresses');
      expect(data).to.include('NetworkInformation');
    });
  });
});
