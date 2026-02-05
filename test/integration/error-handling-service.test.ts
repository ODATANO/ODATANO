import cds from '@sap/cds';
import { TEST_FIXTURES } from './test-fixtures';
import { shutdownAppContext } from '../../srv/server';

jest.setTimeout(20000);

// Configure environment BEFORE cds.test() - server uses these via cds.on('served')
process.env.BACKENDS = 'koios';

describe('Error Code 400 - Service-Level Tests for Invalid / Missing Input', () => {
	// cds.test() starts server which creates AppContext automatically
	const test = cds.test(__dirname + '/../../');
	const expect = test.expect;

	// Only reset the database before each test
	beforeEach(async () => {
		await test.data.reset();
	});

	afterAll(async () => {
		await shutdownAppContext();
	});

	describe('ODATANO Milestone 1 - Error Handling Tests', () => {

		// Transactions – invalid inputs handled by service
		describe('Transaction with Invalid Input', () => {
			it('READ / Transactions with invalid transaction hash', async () => {
				const response = await test.GET(`/odata/v4/cardano-odata/Transactions(hash='invalidhash')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid transaction hash format');
			});

			it('POST / GetTransactionByHash with invalid hash format', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: 'invalid_hash' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid transaction hash');
			});

			it('POST / GetTransactionByHash with short hash', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: 'abc123' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid transaction hash');
			});

			it('POST / GetTransactionByHash with hash containing invalid characters', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: 'ZZZZ23def456abc123def456abc123def456abc123def456abc123def456abc1' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid transaction hash');
			});

			it('POST / GetTransactionByHash without hash parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('hash is required');
			});

			it('POST / GetTransactionByHash with Empty string transaction hash', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: '' }).catch(err => err.response);
				expect(response.status).to.equal(400);
			});

			it('POST / GetTransactionByHash with Null transaction hash', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: null as any }).catch(err => err.response);
				expect(response.status).to.equal(400);
			});

			it('POST / GetTransactionByHash with transaction hash containing uppercase letters', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: 'ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC1' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error).to.exist;
			});

			it('POST / GetTransactionByHash with transaction hash with exactly 63 characters (should fail)', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: 'a'.repeat(63) }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid transaction hash');
			});

			it('POST / GetTransactionByHash with transaction hash with exactly 65 characters (should fail)', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetTransactionByHash`, { hash: 'a'.repeat(65) }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('valid');
			});

			it('READ / TransactionMetadata with invalid tx key', async () => {
				const response = await test.GET(`/odata/v4/cardano-odata/TransactionMetadata(id =1, tx_hash='invalidhash')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid transaction hash format');
			});

			it('POST / TransactionMetadata with tx key containing invalid characters', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetMetadataByTxHash`, { tx_hash: 'ZZZZ23def456abc123def456abc123def456abc123def456abc123def456abc1' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid');
			});

			it('POST / TransactionMetadata without tx key', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetMetadataByTxHash`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('tx_hash is required');
			});
		});

		// Blocks – invalid inputs handled by service
		describe('Blocks – Invalid Input', () => {
			it('POST / GetBlockByHash without blockHash parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetBlockByHash`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('hash is required');
			});

			it('POST / GetBlockByHash with invalid hash format', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetBlockByHash`, { hash: 'invalid_hash' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid|hash/i);
			});

			it('POST / GetBlockByHash with short hash', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetBlockByHash`, { hash: 'abc123' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid|hash/i);
			});

			it('READ / Blocks with invalid block hash', async () => {
				const response = await test.GET(`/odata/v4/cardano-odata/Blocks(hash='hash123')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid|hash/i);
			});
		});

		// Epochs – invalid inputs handled by service
		describe('Epochs – Invalid Input', () => {
			it('POST / GetEpochByNumber with non-numeric epochNumber', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetEpochByNumber`, { epochNumber: '22222222' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('epochNumber has invalid format');
			});

			it('POST / GetEpochByNumber without epochNumber parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetEpochByNumber`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('epochNumber');
			});

			it('POST / GetEpochByNumber with null epochNumber', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetEpochByNumber`, { epochNumber: null }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('epochNumber');
			});

			it('READ / Epochs with non-numeric epochNumber', async () => {
				const response = await test.GET(`/odata/v4/cardano-odata/Epochs(epoch='122222')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('epochNumber has invalid format');
			});
		});

		// Addresses – invalid inputs handled by service
		describe('Addresses – Invalid Input', () => {
			it('POST / GetAddressByBech32 without address parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAddressByBech32`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('address is required');
			});

			it('POST / GetUTxOsByAddress without address parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetUTxOsByAddress`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('address is required');
			});

			it('POST / GetAssetsByAddress without address parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAssetsByAddress`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('address is required');
			});

			it('POST / GetAddressByBech32 with invalid address format', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAddressByBech32`, { address: 'addr123456' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid bech32 address');
			});

			it('POST / GetAddressByBech32 with mainnet address on testnet', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAddressByBech32`, { address: 'addr1qxyz' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid bech32 address');
			});

			it('POST / GetAddressByBech32 with too short address', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAddressByBech32`, { address: 'addr_test1q' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid bech32 address');
			});

			it('POST / GetAddressByBech32 with too long address', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAddressByBech32`, { address: 'addr_test1q' + 'a'.repeat(105) }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('Invalid bech32 address');
			});

			it('POST / GetUTxOsByAddress with invalid bech32 address', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetUTxOsByAddress`, { address: 'invalid_address_format' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/pattern|bech32/i);
			});

			it('POST / GetAssetsByAddress with invalid bech32 address', async () => {
				const response = await test.POST(`/odata/v4/cardano-odata/GetAssetsByAddress`, { address: 'not_valid_bech32' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/pattern|bech32/i);
			});

			it('READ / Addresses with invalid bech32 address', async () => {
				const response = await test.GET(`/odata/v4/cardano-odata/Addresses(address='invalid_address')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid value|bech32/i);
			});
		});

		// GetLatestTransactionsByAddress - Invalid Input
		describe('GetLatestTransactionsByAddress - Invalid Input', () => {
			it('POST /GetLatestTransactionsByAddress - missing address parameter', async () => {
				const response = await test.POST('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', {})
					.catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('address is required');
			});

			it('POST /GetLatestTransactionsByAddress - invalid bech32 address', async () => {
				const response = await test.POST('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', {
					address: 'invalid_address_format'
				}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid|bech32/i);
			});

			it('POST /GetLatestTransactionsByAddress - empty address string', async () => {
				const response = await test.POST('/odata/v4/cardano-odata/GetLatestTransactionsByAddress', {
					address: ''
				}).catch(err => err.response);
				expect(response.status).to.equal(400);
			});
		});

		// Accounts – invalid inputs handled by service
		describe('Accounts – Invalid Input', () => {
			it('POST / GetAccountByStakeAddress with invalid stake address format', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetAccountByStakeAddress`, { stakeAddress: 'invalid_stake_addr' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/pattern|stake|bech32/i);
			});

			it('POST / GetAccountByStakeAddress without stakeAddress parameter', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetAccountByStakeAddress`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('stakeAddress is required');
			});

			it('READ / Accounts with invalid stake address', async () => {
				const response = await test.get(`/odata/v4/cardano-odata/Accounts(stakeAddress='invalid_stake_addr')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid value|stake|bech32/i);
			});
		});

		// Pools – invalid inputs handled by service
		describe('Pools – Invalid Input', () => {
			it('POST / GetPoolById with invalid poolId format (random string)', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetPoolById`, { poolId: 'invalid_pool' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid poolId format|Pools/i);
			});
			it('POST / Invalid bech32 pool id: GetPoolById returns 400', async () => {
				const nonexistentStakeAddr = 'pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
				const { status, data } = await test.post(`/odata/v4/cardano-odata/GetPoolById`, { poolId: nonexistentStakeAddr }).catch(err => err.response);
				expect(data.error).to.exist;
				expect(data.error.message).to.match(/Invalid poolId format/i);
				expect(status).to.equal(400);
			})
			it('POST / GetPoolById with invalid bech32-like poolId (wrong prefix)', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetPoolById`, { poolId: 'poolx' + 'a'.repeat(10) }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid poolId format|Pools/i);
			});

			it('POST / GetPoolById without poolId parameter', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetPoolById`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('poolId is required');
			});

			it('READ / Pools with invalid poolId', async () => {
				const response = await test.get(`/odata/v4/cardano-odata/Pools(poolId='invalid_pool')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid value|poolId/i);
			});
		});

		// Dreps – invalid inputs handled by service
		describe('Dreps – Invalid Input', () => {
			it('POST / GetDrepById with invalid drepId format', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetDrepById`, { drepId: 'invalid_drep' }).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid drepId format|Dreps/i);
			});

			it('POST / GetDrepById without drepId parameter', async () => {
				const response = await test.post(`/odata/v4/cardano-odata/GetDrepById`, {}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('drepId is required');
			});

			it('READ / Dreps with invalid drepId', async () => {
				const response = await test.get(`/odata/v4/cardano-odata/Dreps(drepId='invalid_drep')`).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid value|drepId/i);
			});
		});

		// Service availability checks
		describe('Service – Availability', () => {
			it('Invalid endpoint returns 404', async () => {
				try {
					await test.post(`/odata/v4/cardano-odata/NonExistentEntity`);
					expect.fail('Should have thrown 404');
				} catch (error: any) {
					expect(error.response.status).to.equal(404);
				}
			});

			it('Service metadata always available', async () => {
				const { status } = await test.get(`/odata/v4/cardano-odata/$metadata`);
				expect(status).to.equal(200);
			});

			it('Service root accessible', async () => {
				const { status } = await test.get(`/odata/v4/cardano-odata/`);
				expect(status).to.equal(200);
			});
		});
	});

	describe('ODATANO Milestone 2 - Error Handling Tests', () => {

		describe('SubmitTransaction Action - Parameter Validation', () => {
			it('POST /SubmitTransaction - missing buildId parameter', async () => {
				const response = await test.post(`/odata/v4/cardano-transaction/SubmitTransaction`, {
					signedTxCbor: '84a300...'
				}).catch(err => err.response);
				expect(response.data.error.message).to.include('buildId is required');
				expect(response.status).to.equal(400);
			});

			it('POST /SubmitTransaction - missing signedTxCbor parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/SubmitTransaction`, {
					buildId: '00000000-0000-0000-0000-000000000000'
				}).catch(err => err.response);
				expect(response.data.error.message).to.include('signedTxCbor is required');
				expect(response.status).to.equal(400);
			});

			it('POST /SubmitTransaction - non-existent buildId', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/SubmitTransaction`, {
					buildId: '00000000-0000-0000-0000-000000000000',
					signedTxCbor: '84a300818258200123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef00018182581d61b3b8c9d7e6f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e41a000f4240021a0002a095031a012d14e0'
				}).catch(err => err.response);
				expect(response.data.error.message).to.include('Build not found');
				expect(response.status).to.equal(400);
			});

			it('POST /SubmitTransaction - invalid signedTxCbor format', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/SubmitTransaction`, {
					buildId: '00000000-0000-0000-0000-000000000000',
					signedTxCbor: 'invalid_cbor_format'
				}).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid signedTxCbor format');
				expect(response.status).to.equal(400);
			});
		});

		describe('SubmitSignedTransaction Action - Parameter Validation', () => {
			it('POST /SubmitSignedTransaction - missing signedTxCbor parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/SubmitSignedTransaction`, {
				}).catch(err => err.response);
				expect(response.data.error.message).to.include('signedTxCbor is required');
				expect(response.status).to.equal(400);
			});

			it('POST /SubmitSignedTransaction - invalid signedTxCbor format', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/SubmitSignedTransaction`, {
					signedTxCbor: 'invalid_cbor_format'
				}).catch(err => err.response);
				expect(response.status).to.equal(400);
			});
		});

		describe('CheckSubmissionStatus Action - Parameter Validation', () => {

			it('POST /CheckSubmissionStatus - missing submissionId parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/CheckSubmissionStatus`, {}).catch(err => err.response);
				expect(response.data.error.message).to.include('submissionId is required');
				expect(response.status).to.equal(400);
			});

			it('POST /CheckSubmissionStatus - non-existent submissionId', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/CheckSubmissionStatus`, {
					submissionId: '1'
				}).catch(err => err.response);
				expect(response.data.error.message).to.include('Submission not found');
				expect(response.status).to.equal(400);
			});
		});

		describe('BuildSimpleAdaTransaction Action- Parameter Validation', () => {

			it('BuildSimpleAdaTransaction - missing senderAddress parameter', async () => {
				const requestBody = {
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('senderAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildSimpleAdaTransaction - missing recipientAddress parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('recipientAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildSimpleAdaTransaction - missing lovelaceAmount parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('lovelaceAmount is required');
				expect(response.status).to.equal(400);
			});

			it('BuildSimpleAdaTransaction - invalid senderAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.invalidAddress,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid sender address format');
				expect(response.status).to.equal(400);
			});

			it('BuildSimpleAdaTransaction - invalid recipientAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.invalidAddress,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid recipient address format');
				expect(response.status).to.equal(400);
			});
		});

		describe('BuildTransactionWithMetadata - Invalid Input Handling', () => {

			it('BuildTransactionWithMetadata - missing senderAddress parameter', async () => {
				const requestBody = {
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					metadataJson: TEST_FIXTURES.validMetadataJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('senderAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildTransactionWithMetadata - missing recipientAddress parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					metadataJson: TEST_FIXTURES.validMetadataJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('recipientAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildTransactionWithMetadata - missing lovelaceAmount parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					changeAddress: TEST_FIXTURES.validBech32Address,
					metadataJson: TEST_FIXTURES.validMetadataJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('lovelaceAmount is required');
				expect(response.status).to.equal(400);
			});

			it('BuildTransactionWithMetadata - missing metadata parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('metadataJson is required');
				expect(response.status).to.equal(400);
			});

			it('BuildTransactionWithMetadata - invalid senderAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.invalidAddress,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					metadataJson: TEST_FIXTURES.validMetadataJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid sender address format');
				expect(response.status).to.equal(400);
			});

			it('BuildTransactionWithMetadata - invalid recipientAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.invalidAddress,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					metadataJson: TEST_FIXTURES.validMetadataJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid recipient address format');
				expect(response.status).to.equal(400);
			});

			it('BuildTransactionWithMetadata - invalid metadataJson format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					metadataJson: TEST_FIXTURES.invalidMintActionsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildTransactionWithMetadata`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid JSON in metadataJson');
				expect(response.status).to.equal(400);
			});
		});

		describe('BuildMultiAssetTransaction - Invalid Input Handling', () => {

			it('BuildMultiAssetTransaction - missing senderAddress parameter', async () => {
				const requestBody = {
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					assetsJson: TEST_FIXTURES.validAssetsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('senderAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMultiAssetTransaction - missing recipientAddress parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					assetsJson: TEST_FIXTURES.validAssetsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('recipientAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMultiAssetTransaction - missing lovelaceAmount parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					changeAddress: TEST_FIXTURES.validBech32Address,
					assetsJson: TEST_FIXTURES.validAssetsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('lovelaceAmount is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMultiAssetTransaction - missing assetsJson parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('assetsJson is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMultiAssetTransaction - invalid senderAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.invalidAddress,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					assetsJson: TEST_FIXTURES.validAssetsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid sender address format');
				expect(response.status).to.equal(400);
			});

			it('BuildMultiAssetTransaction - invalid recipientAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.invalidAddress,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					assetsJson: TEST_FIXTURES.validAssetsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid recipient address format');
				expect(response.status).to.equal(400);
			});

			it('BuildMultiAssetTransaction - invalid assetsJson format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
					changeAddress: TEST_FIXTURES.validBech32Address,
					assetsJson: TEST_FIXTURES.invalidMintActionsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMultiAssetTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid JSON in assetsJson');
				expect(response.status).to.equal(400);
			});
		});

		describe('BuildMintTransaction - Invalid Input Handling', () => {

			it('BuildMintTransaction - missing senderAddress parameter', async () => {
				const requestBody = {
					recipientAddress: TEST_FIXTURES.validBech32Address,
					mintActionsJson: TEST_FIXTURES.validMintActionsJson,
					mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('senderAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - missing recipientAddress parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					mintActionsJson: TEST_FIXTURES.validMintActionsJson,
					mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('recipientAddress is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - missing mintActionJson parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('mintActionsJson is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - missing mintingPolicyScript parameter', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					mintActionsJson: TEST_FIXTURES.validMintActionsJson,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('mintingPolicyScript is required');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - invalid senderAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.invalidAddress,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					mintActionsJson: TEST_FIXTURES.validMintActionsJson,
					mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid sender address format');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - invalid recipientAddress format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.invalidAddress,
					mintActionsJson: TEST_FIXTURES.validMintActionsJson,
					mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid recipient address format');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - invalid mintActionsJson format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					mintActionsJson: TEST_FIXTURES.invalidMintActionsJson,
					mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid JSON in mintActionsJson');
				expect(response.status).to.equal(400);
			});

			it('BuildMintTransaction - invalid mintingPolicyScript format', async () => {
				const requestBody = {
					senderAddress: TEST_FIXTURES.validBech32Address,
					recipientAddress: TEST_FIXTURES.validBech32Address,
					mintActionsJson: TEST_FIXTURES.validMintActionsJson,
					mintingPolicyScript: TEST_FIXTURES.invalidMintingPolicyScript,
				};
				const response = await test.POST(`/odata/v4/cardano-transaction/BuildMintTransaction`, requestBody).catch(err => err.response);
				expect(response.data.error.message).to.include('Invalid mintingPolicyScript format');
				expect(response.status).to.equal(400);
			});
		});

		describe('GetBuildDetails – Invalid Input Handling', () => {
			it('GetBuildDetails - missing buildId parameter', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/GetBuildDetails`, {}).catch(err => err.response);
				expect(response.data.error.message).to.include('buildId is required');
				expect(response.status).to.equal(400);
			});

			it('GetBuildDetails - non-existent buildId', async () => {
				const response = await test.POST(`/odata/v4/cardano-transaction/GetBuildDetails`, {
					buildId: '00000000-0000-0000-0000-000000000000'
				}).catch(err => err.response);

				expect(response.data.error.message).to.include('Build not found');
				expect(response.status).to.equal(400);
			});
		});

		describe('GetTransactionBuildsByAddress - Parameter Validation', () => {
			it('POST /GetTransactionBuildsByAddress - missing address parameter', async () => {
				const response = await test.POST('/odata/v4/cardano-transaction/GetTransactionBuildsByAddress', {})
					.catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.include('address is required');
			});

			it('POST /GetTransactionBuildsByAddress - invalid bech32 address', async () => {
				const response = await test.POST('/odata/v4/cardano-transaction/GetTransactionBuildsByAddress', {
					address: 'invalid_address'
				}).catch(err => err.response);
				expect(response.status).to.equal(400);
				expect(response.data.error.message).to.match(/Invalid|bech32/i);
			});
		});
	});
});
