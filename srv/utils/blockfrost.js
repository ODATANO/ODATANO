require('dotenv').config();
const Blockfrost = require("@blockfrost/blockfrost-js");

class BlockfrostConnector {
	constructor() {
 	this.api = new Blockfrost.BlockFrostAPI({
   		projectId: process.env.BLOCKFROST_KEY, }); }

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

	// get transaction
	async getTransaction(hash) {
 		try {
 			const tx = await this.api.txs(hash);

			console.log("TX:",tx);
 			
 			// Fetch full transaction details (inputs, outputs, etc.)
 			const txUtxos = await this.api.txsUtxos(hash);
			console.log("UTXOS:",txUtxos);
 			const txMetadata = await this.api.txsMetadata(hash);
 			console.log("META:",txMetadata);
 		
 			return {
				tx,
 				txUtxos,
				//txMetadata
 			};
 		} 
		catch (err) {
 			if (err.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
 	}

	// get address
	async getAddress(address) {
		try {
 			const data = await this.api.addresses(address);
			return { data };
		} 
		catch (err) {
 			if (err.response?.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
	}
}

module.exports = BlockfrostConnector;