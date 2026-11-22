import path from 'node:path';
import { CardanoClient, type BackendName, type CardanoClientConfig } from '../../srv/blockchain/cardano-client';

const config = (backends: BackendName[]): CardanoClientConfig => ({
  network: 'preview',
  backends,
  blockfrostApiKey: 'preview_test',
  koiosApiKey: '',
  ogmiosUrl: 'ws://localhost:1337',
  primaryTimeoutMs: 1000,
  fallbackTimeoutMs: 1000,
  indexTtlMs: 1000,
});

const SDKS = ['@blockfrost/blockfrost-js', '@cardano-ogmios/client'];
const loadedSdks = (): string[] => SDKS.filter((sdk) =>
  Object.keys(require.cache).some((file) => file.split(path.sep).join('/').includes(`node_modules/${sdk}/`)));

describe('provider SDKs', () => {
  it('load with their backend, not before', () => {
    new CardanoClient(config(['koios', 'odatano']));
    expect(loadedSdks()).toEqual([]);

    new CardanoClient(config(['ogmios']));
    expect(loadedSdks()).toEqual(['@cardano-ogmios/client']);

    new CardanoClient(config(['blockfrost']));
    expect(loadedSdks()).toEqual(SDKS);
  });
});
