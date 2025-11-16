// cardano-client.js (no cache)

const PRIMARY_TIMEOUT_MS  = Number(process.env.PRIMARY_TIMEOUT_MS  || 8000); // 8s
const FALLBACK_TIMEOUT_MS = Number(process.env.FALLBACK_TIMEOUT_MS || 8000); // 8s

class CardanoClient {
  constructor() {
    this.primary  = new (require('./blockfrost'))();
    this.fallback = new (require('./koios'))();
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
    // 1) Try primary
    try {
      return await this._withTimeout(this.primary[method](...args), PRIMARY_TIMEOUT_MS, `Primary ${method}`);
    } catch (errPrimary) {
      console.warn(`Primary ${method} failed → ${errPrimary.message} → trying fallback`);
      // 2) Try fallback
      try {
        return await this._withTimeout(this.fallback[method](...args), FALLBACK_TIMEOUT_MS, `Fallback ${method}`);
      } catch (errFallback) {
        // 3) Bubble up a combined error
        const e = new Error(`Both providers failed for ${method}. Primary: ${errPrimary.message}. Fallback: ${errFallback.message}`);
        e.cause = { primary: errPrimary, fallback: errFallback };
        throw e;
      }
    }
  }

  // convenience wrappers
  async getTransaction(hash) {
    // get basic tx info (with primary/fallback)
    const tx = await this.request('getTransaction', hash);
    // try to fetch metadata (best-effort)
    try {
      const meta = await this.request('getTransactionMetadata', hash);
      tx.metadata = meta;
    } catch (err) {
      // if metadata not found, ignore; otherwise bubble up if providers both fail
      if (err.message && err.message.includes('Both providers failed')) throw err;
    }
    return tx;
  }
  getAddressBalance(address)  { return this.request('getAddressBalance', address); }
}

module.exports = new CardanoClient();
