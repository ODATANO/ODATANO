require('dotenv').config();
const Blockfrost = require("@blockfrost/blockfrost-js");

class Blockfrost {
	constructor() {
 	this.api = new Blockfrost.BlockFrostAPI({
   		projectId: process.env.BLOCKFROST_KEY,
   		network: Blockfrost.Networks.PREVIEW }); 
	}

	// get basic network info
	async get_networkInfo() {
		try {
			const latestBlock = await this.api.blocksLatest();
			const networkInfo = await this.api.network();
			const latestEpoch = await this.api.epochsLatest();
			
			return {
				latestBlock: latestBlock.height,
				network: networkInfo.network,
				latestEpoch: latestEpoch.epoch
			};
		}
		catch (err) {
			throw err;
		}
	}

	// get blockfrost api health
	async get_apiHealth() {
		try {
			const health = await this.api.health();
			return health;
		}
		catch (err) { 
			throw err; 
		}		
	}

	// get transaction by hash
	async getTransaction(hash) {
 		try {
 			const { data } = await this.api.getTransaction(hash);
 			return {
 				hash: data.hash,
 				block: data.block,
 				blockTime: new Date(data.block_time * 1000),
 				fee: parseInt(data.fee) };
 			} 
		catch (err) {
 			if (err.response?.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
 	}

	// get transaction metadata by hash
	async getTransactionMetadata(hash) {
		try {
			const { data } = await this.api.getTransactionMetadata(hash);
			if (!Array.isArray(data) || data.length === 0) throw new Error('NOT_FOUND');
			const result = {};
	
			data.forEach(item => {
			const label = item.label || 'unknown';
			result[label] = item.json_metadata ?? item.metadata ?? item;
			});
			return result;
		
		} catch (err) {
			if (err.response?.status === 404) throw new Error('NOT_FOUND');
			throw err;
		}
	}

	// get address balance
	async getAddressBalance(address) {
		try {
 			const { data } = await this.api.getAddress(address);
 			const ada = data.amount.find(a => a.unit === 'lovelace')?.quantity || '0';
 		
			return {
 				address,
 				balance: parseInt(ada) / 1_000_000
 			};
		} 
		catch (err) {
 			if (err.response?.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
	}
}

module.exports = Blockfrost;