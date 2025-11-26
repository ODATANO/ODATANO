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
			const health = await this.api.health();
			
			return {
				latestBlock: latestBlock.height,
				network: networkInfo.network,
				latestEpoch: latestEpoch.epoch,
				health: health,
			};
		}
		catch (err) {
			throw err;
		}
	}

	// get transaction
	async getTransaction(hash) {
 		try {
 			const tx = await this.api.txs(hash);
 			const txUtxos = await this.api.txsUtxos(hash);
 			const txMetadata = await this.api.txsMetadata(hash);
 			return {
				tx,
 				txUtxos,
				txMetadata
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

	// get address
	async getAddressUtxos(address) {
		try {
 			const data = await this.api.addressesUtxosAll(address);
			return { data };
		} 
		catch (err) {
 			if (err.response?.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
	}
}

module.exports = BlockfrostConnector;