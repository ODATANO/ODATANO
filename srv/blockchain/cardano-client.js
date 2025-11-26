const PRIMARY_TIMEOUT_MS  = Number(process.env.PRIMARY_TIMEOUT_MS  || 8000); // 8s
const FALLBACK_TIMEOUT_MS = Number(process.env.FALLBACK_TIMEOUT_MS || 8000); // 8s

class CardanoClient {
  constructor() {
    this.primary  = null;
    this.fallback = null;
  }

  _ensureInitialized() {
    if (!this.primary) {
      try {
        this.primary = new (require('../utils/blockfrost'))();
      } catch (e) {
        console.error('[CardanoClient] Failed to initialize Blockfrost:', e.message);
      }
    }
    if (!this.fallback) {
      try {
        this.fallback = new (require('../utils/koios'))();
      } catch (e) {
        console.error('[CardanoClient] Failed to initialize Koios:', e.message);
      }
    }
  }

  _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  async request(method, ...args) {
    this._ensureInitialized();
    // try primary
    try {
      if (this.primary) {
        console.log('[CardanoClient] Calling primary.', method);
        let result = await this._withTimeout(this.primary[method](...args), PRIMARY_TIMEOUT_MS, `Primary ${method}`);
        console.log(result);
        return result;
      }
    } catch (errPrimary) {
      console.warn(`Primary ${method} failed → ${errPrimary.message} → trying fallback`);
    }
    // try fallback
    try {
      if (this.fallback) {
        return await this._withTimeout(this.fallback[method](...args), FALLBACK_TIMEOUT_MS, `Fallback ${method}`);
      }
    } catch (errFallback) {
      console.error(`Fallback ${method} also failed:`, errFallback.message);
    }
    throw new Error(`All providers failed for ${method}`);
  }

  // convenience wrappers
  async getTransaction(hash) {
    const tx = await this.request('getTransaction', hash);
    return tx; }

  async getAddress(address)  { 
    return this.request('getAddress', address); }

  async getAddress(address)  { 
    return this.request('getAddressesUtxos', address); }

}
module.exports = new CardanoClient();
