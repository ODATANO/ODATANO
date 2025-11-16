const axios = require('axios');

class Koios {
 constructor() {
 this.api = axios.create({
 baseURL: 'https://testnet.koios.rest/api/v0',
 timeout: 5000
 });
 }

 async getTransaction(hash) {
 const { data } = await this.api.get(`/tx_info?tx_hash=${hash}`);
 if (!data.length) throw new Error('NOT_FOUND');
 const tx = data[0];
 return {
 hash: tx.tx_hash,
 block: tx.block_no,
 blockTime: new Date(tx.tx_validity_start * 1000), // Approx
 fee: parseInt(tx.tx_fee || 0)
 };
 }

	async getTransactionMetadata(hash) {
		const { data } = await this.api.get(`/tx_info?tx_hash=${hash}`);
		if (!data.length) throw new Error('NOT_FOUND');
		const tx = data[0];
		// Koios may provide json_metadata or metadata fields
		const meta = tx.json_metadata || tx.metadata || tx.tx_metadata || null;
		if (!meta) throw new Error('NOT_FOUND');
		return meta;
	}

 async getAddressBalance(address) {
 const { data } = await this.api.get(`/address_info?address=${address}`);
 if (!data.length) throw new Error('NOT_FOUND');
 const bal = data[0];
 return {
 address,
 balance: parseInt(bal.balance_utxo.lovelace || '0') / 1_000_000
 };
 }
}

module.exports = Koios;