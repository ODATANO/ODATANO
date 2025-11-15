const axios = require('axios');
require('dotenv').config();

class Blockfrost {
 constructor() {
 this.api = axios.create({
 baseURL: 'https://cardano-preview.blockfrost.io/api/v0',
 headers: { project_id: process.env.BLOCKFROST_KEY },
 timeout: 5000
 });
 }

 async getTransaction(hash) {
 try {
 const { data } = await this.api.get(`/txs/${hash}`);
 return {
 hash: data.hash,
 block: data.block,
 blockTime: new Date(data.block_time * 1000),
 fee: parseInt(data.fee)
 };
 } catch (err) {
 if (err.response?.status === 404) throw new Error('NOT_FOUND');
 throw err;
 }
 }

 async getAddressBalance(address) {
 try {
 const { data } = await this.api.get(`/addresses/${address}`);
 const ada = data.amount.find(a => a.unit === 'lovelace')?.quantity || '0';
 return {
 address,
 balance: parseInt(ada) / 1_000_000
 };
 } catch (err) {
 if (err.response?.status === 404) throw new Error('NOT_FOUND');
 throw err;
 }
 }
}

module.exports = Blockfrost;