import cds from '@sap/cds';

jest.setTimeout(20000);

describe('Service-Level Invalid Input & OData Errors', () => {
	const { GET, POST, expect } = cds.test(__dirname + '/../../');

	// Transactions – invalid inputs handled by service
	describe('Transactions – Invalid Input', () => {
		it('GetTransactionByHash with invalid hash format', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'invalid_hash' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid transaction hash');
		});

		it('GetTransactionByHash with short hash', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'abc123' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid transaction hash');
		});

		it('GetTransactionByHash with hash containing invalid characters', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'ZZZZ23def456abc123def456abc123def456abc123def456abc123def456abc1' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid transaction hash');
		});

		it('GetTransactionByHash without hash parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('hash is required');
		});

		it('Empty string transaction hash', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: '' }).catch(err => err.response);
			expect(response.status).to.equal(400);
		});

		it('Null transaction hash', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { txHash: null as any }).catch(err => err.response);
			expect(response.status).to.equal(400);
		});

		it('Transaction hash with uppercase letters', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC123DEF456ABC1' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error).to.exist;
		});

		it('Transaction hash with exactly 63 characters (should fail)', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'a'.repeat(63) }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid transaction hash');
		});

		it('Transaction hash with exactly 65 characters (should fail)', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetTransactionByHash', { hash: 'a'.repeat(65) }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('valid');
		});

		it('READ TransactionMetadata with invalid tx key', async () => {
			const response = await GET('/odata/v4/cardano-odata/TransactionMetadata(tx=invalid_hash)').catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid value');
		});

		it('READ TransactionMetadata with short tx key', async () => {
			const response = await GET('/odata/v4/cardano-odata/TransactionMetadata(tx_hash=abc123)').catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid value');
		});
	});

	// Blocks – invalid inputs handled by service
	describe('Blocks – Invalid Input', () => {
		it('GetBlockByHash without blockHash parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetBlockByHash', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('hash is required');
		});

		it('GetBlockByHash with invalid hash format', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetBlockByHash', { blockHash: 'invalid_hash' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/Invalid|blockHash/i);
		});

		it('GetBlockByHash with short hash', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetBlockByHash', { blockHash: 'abc123' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/Invalid|blockHash/i);
		});
	});

	// Epochs – invalid inputs handled by service
	describe('Epochs – Invalid Input', () => {
		it('GetEpochByNumber with non-numeric epochNumber', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: 'not_a_number' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Value not_a_number is not a valid Integer');
		});

		it('GetEpochByNumber without epochNumber parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetEpochByNumber', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('epochNumber');
		});

		it('GetEpochByNumber with null epochNumber', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetEpochByNumber', { epochNumber: null }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('epochNumber');
		});
	});

	// Addresses – invalid inputs handled by service
	describe('Addresses – Invalid Input', () => {
		it('GetAddressByBech32 without address parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAddressByBech32', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('address is required');
		});

		it('GetUTxOsByAddress without address parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('address is required');
		});

		it('GetAssetsByAddress without address parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('address is required');
		});

		it('GetAddressByBech32 with invalid address format', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: 'addr123456' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid bech32 address');
		});

		it('GetAddressByBech32 with mainnet address on testnet', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: 'addr1qxyz' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid bech32 address');
		});

		it('GetAddressByBech32 with too short address', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: 'addr_test1q' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid bech32 address');
		});

		it('GetAddressByBech32 with too long address', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAddressByBech32', { address: 'addr_test1q' + 'a'.repeat(105) }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('Invalid bech32 address');
		});

		it('GetUTxOsByAddress with invalid bech32 address', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetUTxOsByAddress', { address: 'invalid_address_format' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/pattern|bech32/i);
		});

		it('GetAssetsByAddress with invalid bech32 address', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAssetsByAddress', { address: 'not_valid_bech32' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/pattern|bech32/i);
		});
	});

	// Accounts – invalid inputs handled by service
	describe('Accounts – Invalid Input', () => {
		it('GetAccountByStakeAddress with invalid stake address format', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAccountByStakeAddress', { stakeAddress: 'invalid_stake_addr' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/pattern|stake|bech32/i);
		});

		it('GetAccountByStakeAddress without stakeAddress parameter', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetAccountByStakeAddress', {}).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.include('stakeAddress is required');
		});
	});

	// Pools – invalid inputs handled by service
	describe('Pools – Invalid Input', () => {
		it('GetPoolById with invalid poolId format (random string)', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetPoolById', { poolId: 'invalid_pool' }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/Invalid poolId format|Pools/i);
		});
		it('Ivallid bech32 pool id: GetPoolById returns 400', async () => {
				const nonexistentStakeAddr = 'pool1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
				const { status, data } = await POST('/odata/v4/cardano-odata/GetPoolById', { poolId: nonexistentStakeAddr }).catch(err => err.response);
				expect(data.error).to.exist;
				expect(data.error.message).to.match(/Invalid poolId format/i);
				expect(status).to.equal(400);
			} )
		it('GetPoolById with invalid bech32-like poolId (wrong prefix)', async () => {
			const response = await POST('/odata/v4/cardano-odata/GetPoolById', { poolId: 'poolx' + 'a'.repeat(10) }).catch(err => err.response);
			expect(response.status).to.equal(400);
			expect(response.data.error.message).to.match(/Invalid poolId format|Pools/i);
		});
	});

    // Service availability checks
	describe('Service – Availability', () => {
		it('Invalid endpoint returns 404', async () => {
			try {
				await POST(`/odata/v4/cardano-odata/NonExistentEntity`);
				expect.fail('Should have thrown 404');
			} catch (error: any) {
				expect(error.response.status).to.equal(404);
			}
		});

		it('Service metadata always available', async () => {
			const { status } = await GET`/odata/v4/cardano-odata/$metadata`;
			expect(status).to.equal(200);
		});

		it('Service root accessible', async () => {
			const { status } = await GET`/odata/v4/cardano-odata/`;
			expect(status).to.equal(200);
		});
	});
});
