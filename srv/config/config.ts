import 'dotenv/config';

export type Network = 'mainnet' | 'preview' | 'preprod' | 'testnet';

export const CONFIG = {
  network: (process.env.ODATANO_NETWORK ?? 'preview') as Network,

  blockfrostApiKey: process.env.BLOCKFROST_KEY ?? '',
  blockfrostApiUrl:
    process.env.BLOCKFROST_API_URL ??
    'https://cardano-preview.blockfrost.io/api/v0',

  koiosApiUrl:
    process.env.KOIOS_API_URL ??
    'https://preview.koios.rest/api/v1',

  primaryTimeoutMs: Number(process.env.PRIMARY_TIMEOUT_MS ?? 5000),
  fallbackTimeoutMs: Number(process.env.FALLBACK_TIMEOUT_MS ?? 10000),
};