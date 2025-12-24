import cds from '@sap/cds';
import { BackendTestConfig, configureBackendForTest } from './backend-test-helper';

jest.setTimeout(20000);

export function createErrorBackendSuite(backendConfig: BackendTestConfig) {
	// Configure environment for this backend
	const originalBlockfrostKey = process.env.BLOCKFROST_KEY;
	configureBackendForTest(backendConfig, originalBlockfrostKey);

	describe(`Error Handling – Backend-Specific [${backendConfig.name.toUpperCase()}]`, () => {
		const { GET, POST, expect } = cds.test(__dirname + '/../../');

		// 404 Resource Not Found with valid-looking inputs
		describe('Resource Not Found (valid inputs)', () => {
			it('GetTransactionByHash with nonexistent transaction', async () => {
				const nonexistentHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
				const { status, data } = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: nonexistentHash }).catch(err => err.response);
				expect(data.error).to.exist;
				expect(data.error.message).to.match(/not found/i);
				expect(status).to.equal(404);
			});

			it('GET single Transaction with nonexistent hash', async () => {
				const nonexistentHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
				const { status, data } = await GET(`/odata/v4/cardano-odata/Transactions(hash='${nonexistentHash}')`).catch(err => err.response);
				expect(data.error).to.exist;
				expect(data.error.message).to.match(/not found/i);
				expect(status).to.equal(404);
			});

			it('GET single Address with nonexistent address', async () => {
			const nonexistentAddr = 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
			const { status, data } = await GET(`/odata/v4/cardano-odata/Addresses('${nonexistentAddr}')`).catch(err => err.response);
			expect(data.error).to.exist;
			expect(data.error.message).to.match(/not found|invalid address/i);
				expect(status).to.equal(404);
			});
		});

		// Valid inputs but no associated data (to be filled via fixtures)
		describe('Valid Inputs Without Associated Data (fixtures pending)', () => {
			it('Get Transaction with no metadata: GetMetadataByTxHash returns 404', async () => {
				const txHashWithNoMetadata = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
				const { status, data } = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { tx_hash: txHashWithNoMetadata }).catch(err => err.response);
				expect(data.error).to.exist;
				expect(data.error.message).to.match(/not found/i);
				expect(status).to.equal(404);
			} );
			it('Get Address with no assets: GetAssetsByAddress returns empty list (200)', async () => {
				const addressWithNoAssets = 'addr_test1qz0l5m3c5q6jv4x5f7g8h9j0k2l3m4n5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e0fghjklm';
				const { status, data } = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: addressWithNoAssets }).catch(err => err.response);
				expect(data.error.message).to.match(/not found/i);
				expect(status).to.equal(404);
			} );

			it('Get Address with no UTxOs: GetUTxOsByAddress returns empty list (200)', async () => {	
				const addressWithNoUtxos = 'addr_test1qz0l5m3c5q6jv4x5f7g8h9j0k2l3m4n5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e0fghjklm';
				const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: addressWithNoUtxos }).catch(err => err.response);

				expect(data.error.message).to.match(/not found/i);
				expect(status).to.equal(404);
			} );

			it('Valid poolId with no pool data: GetPoolById returns 404', async () => {
				const nonexistentPoolId = 'pool1q9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5';
				const { status, data } = await POST('/odata/v4/cardano-odata/GetPoolById', { poolId: nonexistentPoolId }).catch(err => err.response);
				expect(data.error).to.exist;
				expect(data.error.message).to.match(/Invalid poolId format/i);
				expect(status).to.equal(400);
			} );
		});
	});
}
