import 'dotenv/config';

export type Network = 'mainnet' | 'preview' | 'preprod';
export type BackendName = 'blockfrost' | 'koios';

const NETWORK: Network = (process.env.NETWORK ?? 'preview') as Network;

const BLOCKFROST_URLS: Record<Network, string> = {
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
};

const KOIOS_URLS: Record<Network, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
};

const HRP = {
  mainnet: { addr: /^addr1[0-9a-z]{50,100}$/, stake: /^stake1[0-9a-z]{53,}$/ },
  preview: { addr: /^addr_test1[0-9a-z]{50,100}$/, stake: /^stake_test1[0-9a-z]{53,}$/ },
  preprod: { addr: /^addr1[0-9a-z]{50,100}$/, stake: /^stake1[0-9a-z]{53,}$/ },
};

/**
 * Parse available backends from BACKENDS environment variable
 * Format: "blockfrost,koios" or "koios" or single backend
 */
function parseAvailableBackends(): BackendName[] {
  const backendsEnv = process.env.BACKENDS || 'blockfrost,koios';
  const available = backendsEnv
    .split(',')
    .map(b => b.trim().toLowerCase() as BackendName)
    .filter((b): b is BackendName => ['blockfrost', 'koios'].includes(b));
  
  return available.length > 0 ? available : ['blockfrost', 'koios'];
}

export const CONFIG = {
  network: NETWORK,
  hrp: HRP[NETWORK],
  blockfrostApiKey: process.env.BLOCKFROST_KEY ?? '',
  blockfrostApiUrl: BLOCKFROST_URLS[NETWORK],
  koiosApiUrl: KOIOS_URLS[NETWORK],
  koiosApiKey: process.env.KOIOS_API_KEY ?? '',
  primaryTimeoutMs: Number(process.env.PRIMARY_TIMEOUT_MS ?? 8000),
  fallbackTimeoutMs: Number(process.env.FALLBACK_TIMEOUT_MS ?? 10000),
  indexTtlMs: Number(process.env.INDEX_TTL_MS ?? 600000),
  logLevel: process.env.LOG_LEVEL || 'info',
  // Backend configuration
  backends: parseAvailableBackends(),
};

