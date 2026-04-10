import cds from '@sap/cds';
import { TestConfiguration, configureBackendForTest } from './test-fixtures';
import { shutdownAppContext } from '../../srv/server';

jest.setTimeout(20000);

export function createErrorBackendSuite(backendConfig: TestConfiguration) {
	// Configure environment BEFORE cds.test() - server uses these via cds.on('served')
	const originalBlockfrostKey = process.env.BLOCKFROST_API_KEY;
	configureBackendForTest(backendConfig, originalBlockfrostKey);

	describe(`Error Handling – Backend-Specific [${backendConfig.backendName.toUpperCase()}]`, () => {
		// cds.test() starts server which creates AppContext automatically
		const test = cds.test(__dirname + '/../../');
		const { GET, POST, expect } = test;

		// Only reset the database before each test
		beforeEach(async () => {
			await test.data.reset();
		});

		// Cleanup app context after all tests
		afterAll(async () => {
			await shutdownAppContext();
		});

		describe('ODATANO Milestone 1 - Error Handling Tests', () => {
			// Error 404 resource not found with valid-looking inputs
			describe('Resource Not Found (valid inputs)', () => {

				it('GET / single Transaction with nonexistent hash', async () => {
					const nonexistentHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
					const { status, data } = await GET(`/odata/v4/cardano-odata/Transactions(hash='${nonexistentHash}')`).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('GET / single Address with nonexistent data', async () => {
					const nonexistentAddr = 'addr_test1qqns7y665ffcmf8hs3qjjfwus7rasqgl9x9vtymzc595k9k4pmvf8elwh69vagtlrdalh7vcdpzd65ewayutac2tv0wqw85yzn';
					const { status, data } = await GET(`/odata/v4/cardano-odata/Addresses('${nonexistentAddr}')`).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / GetTransactionByHash with nonexistent transaction', async () => {
					const nonexistentHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: nonexistentHash }).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Transaction with no metadata: GetMetadataByTxHash returns 404', async () => {
					const txHashWithNoMetadata = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetMetadataByTxHash', { tx_hash: txHashWithNoMetadata }).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Address with no assets: GetAssetsByAddress returns 404', async () => {
					const addressWithNoAssets = 'addr_test1qqns7y665ffcmf8hs3qjjfwus7rasqgl9x9vtymzc595k9k4pmvf8elwh69vagtlrdalh7vcdpzd65ewayutac2tv0wqw85yzn';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: addressWithNoAssets }).catch(err => err.response);
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Address with no UTxOs: GetUTxOsByAddress returns 404 if no utxos exist on address', async () => {
					const addressWithNoUtxos = 'addr_test1qqns7y665ffcmf8hs3qjjfwus7rasqgl9x9vtymzc595k9k4pmvf8elwh69vagtlrdalh7vcdpzd65ewayutac2tv0wqw85yzn';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: addressWithNoUtxos }).catch(err => err.response);
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Valid but non-existent poolId with no pool data: GetPoolById returns 404', async () => {
					const nonexistentPoolId = 'pool1llllllllllllllllllllllllllllllllllllllllllll76pswtf';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetPoolById', { poolId: nonexistentPoolId }).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Valid but non-existent account: GetAccountByAddress returns 404', async () => {
					const nonexistentAccountAddr = 'stake_test1uz9ky2spwtvjp8v64vce6gv08ktw52npmnsmhlhs3pnvx2spyrgsx';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetAccountByStakeAddress', { stakeAddress: nonexistentAccountAddr }).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Valid but non-existent Drep Id: GetDrepById returns 404', async () => {
					const nonexistentDrepId = 'drep1ywqwac5q5d5vspmsvp2jjcy3vv9zwfc78yzpyfx25gd6r5cvfcf8h';
					const { status, data } = await POST('/odata/v4/cardano-odata/GetDrepById', { drepId: nonexistentDrepId }).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});

				it('POST / Valid but non-existent epoch number: GetEpochByNumber returns 404', async () => {
					const nonexistentEpochNumber = 9999;
					const { status, data } = await POST('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: nonexistentEpochNumber }).catch(err => err.response);
					expect(data.error).to.exist;
					expect(data.error.message).to.match(/not found/i);
					expect(status).to.equal(404);
				});
			});
		});
	});
}