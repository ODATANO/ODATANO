import 'dotenv/config';

export type Network = 'mainnet' | 'preview' | 'preprod';
export type BackendName = 'blockfrost' | 'koios' | 'ogmios' | 'hybrid';

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

const VALIDITY_VARIANTS = {
  BECH32_MAX_LENGTH: 2000, // maximum bech32 string length to prevent DoS
  MAX_EPOCH: 100_000, // maximum reasonable epoch number
  POOL_ID_BYTES: 28, // standard pool ID payload length
}
/**
 * Parse available backends from BACKENDS environment variable
 * 
 * Supported configurations:
 * - "koios" (default): Only Koios
 * - "ogmios": Only Ogmios (historical queries may fail)
 * - "blockfrost": Only Blockfrost
 * - "koios": Only Koios  
 * - "ogmios,blockfrost": Ogmios + Blockfrost with fallback
 * - "blockfrost,koios": Blockfrost + Koios with fallback
 */
function parseAvailableBackends(): BackendName[] {
  const backendsEnv = process.env.BACKENDS || 'koios';
  const available = backendsEnv
    .split(',')
    .map(b => b.trim().toLowerCase() as BackendName)
    .filter((b): b is BackendName => ['ogmios','blockfrost', 'koios'].includes(b));
  
  // default to hybrid (Ogmios + historical fallback) if no valid backends found
  return available.length > 0 ? available : ['koios'];
}

function parseAvailableTransactionBuilders(): string[] {
  const buildersEnv = process.env.TX_BUILDERS || 'csl';
  const available = buildersEnv
    .split(',')
    .map(b => b.trim().toLowerCase())
    .filter(b => ['csl', 'buildooor'].includes(b));
  return available.length > 0 ? available : ['csl'];
}

export const CONFIG = {
  network: NETWORK,
  hrp: HRP[NETWORK],
  VALIDITY_VARIANTS: VALIDITY_VARIANTS,
  blockfrostApiKey: process.env.BLOCKFROST_KEY ?? '',
  blockfrostApiUrl: BLOCKFROST_URLS[NETWORK],
  koiosApiUrl: KOIOS_URLS[NETWORK],
  koiosApiKey: process.env.KOIOS_API_KEY ?? '',
  ogmiosUrl: process.env.OGMIOS_URL || 'ws://localhost:1337',
  primaryTimeoutMs: Number(process.env.PRIMARY_TIMEOUT_MS ?? 118000),
  fallbackTimeoutMs: Number(process.env.FALLBACK_TIMEOUT_MS ?? 10000),
  indexTtlMs: Number(process.env.INDEX_TTL_MS ?? 600000), // 10 minutes default
  logLevel: process.env.LOG_LEVEL || 'info',
  // backend configuration
  backends: parseAvailableBackends(),
  // transaction builders
  transactionBuilders: parseAvailableTransactionBuilders(),
};

