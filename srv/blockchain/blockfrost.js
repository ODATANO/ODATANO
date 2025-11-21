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

	// get transaction by hash (with full details: inputs, outputs, assets, metadata)
	async getTransaction(hash) {
 		try {
 			const tx = await this.api.getTransaction(hash);
 			
 			// Fetch full transaction details (inputs, outputs, etc.)
 			const txUtxos = await this.api.getTransactionUtxos(hash);
 			const metadata = await this.getTransactionMetadata(hash).catch(() => null);
 			
 			// Map inputs (with assets)
 			const inputs = (txUtxos?.inputs || []).map((inp, idx) => ({
 				index: idx,
 				sourceTxHash: inp.txHash,
 				sourceIndex: inp.outputIndex,
 				address: inp.address,
 				valueLovelace: parseInt(inp.amount?.[0]?.quantity || '0'),
 				assets: (inp.amount || [])
 					.filter(a => a.unit !== 'lovelace')
 					.map(a => ({
 						policyId: a.unit.slice(0, 56),
 						assetName: a.unit.slice(56),
 						quantity: parseInt(a.quantity || '0')
 					}))
 			}));
 			
 			// Map outputs
 			const outputs = (txUtxos?.outputs || []).map((out, idx) => ({
 				index: idx,
 				address: out.address,
 				valueLovelace: parseInt(out.amount?.[0]?.quantity || '0'),
 				datumHash: out.datumHash || null,
 				assets: (out.amount || [])
 					.filter(a => a.unit !== 'lovelace')
 					.map(a => ({
 						policyId: a.unit.slice(0, 56),
 						assetName: a.unit.slice(56),
 						quantity: parseInt(a.quantity || '0')
 					}))
 			}));
 			
 			return {
 				hash: tx.hash,
 				block: tx.block,
 				blockTime: new Date(tx.block_time * 1000),
 				fee: parseInt(tx.fee),
 				inputs,
 				outputs,
 				metadata
 			};
 		} 
		catch (err) {
 			if (err.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
 	}

	// get transaction metadata by hash
	async getTransactionMetadata(hash) {
		try {
			const data = await this.api.getTransactionMetadata(hash);
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

	// get address
	async getAddress(address) {
		try {
 			const data = await this.api.addresses(address);
			console.log('Blockfrost data.', data);
			return { data };
		} 
		catch (err) {
 			if (err.response?.status === 404) throw new Error('NOT_FOUND');
 			throw err;
 		}
	}
}

module.exports = BlockfrostConnector;