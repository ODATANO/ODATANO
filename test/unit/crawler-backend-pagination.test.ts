/**
 * Chain crawler — PaginatingBackend forward-iteration (C2a/C2b/C7) + CardanoClient
 * capability getters. Blockfrost via SDK mock, Koios via nock (repo conventions);
 * asserts the calls, BlockData mapping, block ordering and init-aware getter selection.
 */
import nock from 'nock';

jest.mock('@blockfrost/blockfrost-js', () => ({
  BlockFrostAPI: jest.fn().mockImplementation(() => ({
    blocks: jest.fn(),
    blocksNext: jest.fn(),
    blocksTxsAll: jest.fn(),
    txs: jest.fn(),
    txsUtxos: jest.fn(),
    txsMetadata: jest.fn(),
    options: { requestTimeout: 0 },
  })),
}));

import { BlockfrostBackend } from '../../srv/blockchain/backends/blockfrost-backend';

const NETWORK = 'preview' as const;

const blockSummary = (over: Partial<Record<string, unknown>> = {}) => ({
  time: 1700000000, height: 100, hash: 'blockhash', slot: 5000, slot_leader: 'leader',
  epoch: 3, epoch_slot: 200, size: 1234, tx_count: 2, fees: '170000', ...over,
});

describe('BlockfrostBackend.getBlockByHeight', () => {
  let backend: BlockfrostBackend;
  let api: { blocks: jest.Mock };

  beforeEach(() => {
    backend = new BlockfrostBackend(NETWORK, 5000, 'test-key');
    api = (backend as unknown as { api: { blocks: jest.Mock } }).api;
  });

  it('queries the SDK by height and maps to BlockData', async () => {
    api.blocks.mockResolvedValue(blockSummary());
    const b = await backend.getBlockByHeight(100);
    expect(api.blocks).toHaveBeenCalledWith(100);
    expect(b).toMatchObject({
      height: 100, hash: 'blockhash', slot: 5000, slotLeader: 'leader',
      epoch: 3, epochSlot: 200, size: 1234, txCount: 2, fees: '170000',
    });
  });
});

describe('BlockfrostBackend.getNextBlocks', () => {
  let backend: BlockfrostBackend;
  let api: { blocksNext: jest.Mock };

  beforeEach(() => {
    backend = new BlockfrostBackend(NETWORK, 5000, 'test-key');
    api = (backend as unknown as { api: { blocksNext: jest.Mock } }).api;
  });

  it('passes the count and maps each returned block in order', async () => {
    api.blocksNext.mockResolvedValue([
      blockSummary({ hash: 'b1', height: 101 }),
      blockSummary({ hash: 'b2', height: 102 }),
    ]);
    const blocks = await backend.getNextBlocks('afterHash', 10);
    expect(api.blocksNext).toHaveBeenCalledWith('afterHash', { count: 10 });
    expect(blocks.map(b => b.hash)).toEqual(['b1', 'b2']);
    expect(blocks[1].height).toBe(102);
  });

  it('returns an empty array when there are no further blocks', async () => {
    api.blocksNext.mockResolvedValue([]);
    expect(await backend.getNextBlocks('tipHash', 10)).toEqual([]);
  });
});

describe('BlockfrostBackend.getBlockTransactions', () => {
  let backend: BlockfrostBackend;
  let api: { blocksTxsAll: jest.Mock };

  beforeEach(() => {
    backend = new BlockfrostBackend(NETWORK, 5000, 'test-key');
    api = (backend as unknown as { api: { blocksTxsAll: jest.Mock } }).api;
  });

  it('resolves tx hashes to full transactions preserving block order', async () => {
    api.blocksTxsAll.mockResolvedValue(['tx1', 'tx2']);
    jest.spyOn(backend, 'getTransaction').mockImplementation(async (h: string) => ({ hash: h } as never));

    const txs = await backend.getBlockTransactions('blk');
    expect(api.blocksTxsAll).toHaveBeenCalledWith('blk');
    expect(txs.map(t => t.hash)).toEqual(['tx1', 'tx2']);
  });

  it('drops hashes the batch could not resolve', async () => {
    api.blocksTxsAll.mockResolvedValue(['tx1', 'missing']);
    jest.spyOn(backend, 'getTransactionsBatch').mockResolvedValue(
      new Map([['tx1', { hash: 'tx1' } as never]]),
    );
    const txs = await backend.getBlockTransactions('blk');
    expect(txs.map(t => t.hash)).toEqual(['tx1']);
  });

  it('returns [] for an empty block', async () => {
    api.blocksTxsAll.mockResolvedValue([]);
    expect(await backend.getBlockTransactions('blk')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Koios PaginatingBackend (C2b) — nock against the real REST shapes
// ---------------------------------------------------------------------------

import { KoiosBackend } from '../../srv/blockchain/backends/koios-backend';

const KOIOS_BASE = 'https://api.koios.rest';

const koiosBlockInfo = (over: Partial<Record<string, unknown>> = {}) => ({
  block_time: 1700000000, block_height: 100, hash: 'k'.repeat(64), abs_slot: 5000,
  epoch_no: 3, epoch_slot: 200, vrf_key: 'vrf', block_size: 1234, tx_count: 1,
  total_fees: '170000', ...over,
});

describe('KoiosBackend pagination (forward iteration)', () => {
  let backend: KoiosBackend;

  beforeEach(() => {
    backend = new KoiosBackend('mainnet', 5000);
    nock.cleanAll();
  });
  afterEach(() => nock.cleanAll());

  it('getBlockByHeight resolves the hash via PostgREST filter then loads /block_info', async () => {
    nock(KOIOS_BASE)
      .get('/api/v1/blocks')
      .query({ block_height: 'eq.100', limit: '1' })
      .reply(200, [{ hash: 'k'.repeat(64) }]);
    nock(KOIOS_BASE)
      .post('/api/v1/block_info', (body) => (body as { _block_hashes: string[] })._block_hashes[0] === 'k'.repeat(64))
      .reply(200, [koiosBlockInfo()]);

    const block = await backend.getBlockByHeight(100);

    expect(block).toMatchObject({
      hash: 'k'.repeat(64), height: 100, slot: 5000, epoch: 3, epochSlot: 200,
      slotLeader: 'vrf', size: 1234, txCount: 1, fees: '170000',
    });
  });

  it('getNextBlocks resolves the anchor height, lists ascending blocks above it and batch-loads their info', async () => {
    const afterHash = 'a'.repeat(64);
    // 1) anchor height
    nock(KOIOS_BASE)
      .post('/api/v1/block_info', (body) => (body as { _block_hashes: string[] })._block_hashes[0] === afterHash)
      .reply(200, [koiosBlockInfo({ hash: afterHash, block_height: 100 })]);
    // 2) PostgREST forward listing
    nock(KOIOS_BASE)
      .get('/api/v1/blocks')
      .query({ block_height: 'gt.100', order: 'block_height.asc', limit: '2' })
      .reply(200, [{ hash: 'b'.repeat(64) }, { hash: 'c'.repeat(64) }]);
    // 3) batch info (returned out of order → method must sort by height)
    nock(KOIOS_BASE)
      .post('/api/v1/block_info', (body) => (body as { _block_hashes: string[] })._block_hashes.length === 2)
      .reply(200, [
        koiosBlockInfo({ hash: 'c'.repeat(64), block_height: 102 }),
        koiosBlockInfo({ hash: 'b'.repeat(64), block_height: 101 }),
      ]);

    const blocks = await backend.getNextBlocks(afterHash, 2);

    expect(blocks.map(b => [b.hash, b.height])).toEqual([
      ['b'.repeat(64), 101],
      ['c'.repeat(64), 102],
    ]);
  });

  it('getNextBlocks validates a supplied height against the canonical anchor without resolving the hash via /block_info', async () => {
    const afterHash = 'a'.repeat(64);
    // The hint avoids /block_info, but still requires a canonical hash check at H.
    nock(KOIOS_BASE)
      .get('/api/v1/blocks')
      .query({ block_height: 'eq.100', limit: '1' })
      .reply(200, [{ hash: afterHash }]);
    nock(KOIOS_BASE)
      .get('/api/v1/blocks')
      .query({ block_height: 'gt.100', order: 'block_height.asc', limit: '1' })
      .reply(200, [{ hash: 'd'.repeat(64) }]);
    nock(KOIOS_BASE)
      .post('/api/v1/block_info')
      .reply(200, [koiosBlockInfo({ hash: 'd'.repeat(64), block_height: 101 })]);

    const blocks = await backend.getNextBlocks(afterHash, 1, 100);
    expect(blocks.map(b => b.height)).toEqual([101]);
  });

  it('getNextBlocks raises the stable reorg marker when the hinted cursor hash is no longer canonical', async () => {
    const orphanHash = 'a'.repeat(64);
    const canonicalHash = 'f'.repeat(64);
    nock(KOIOS_BASE)
      .get('/api/v1/blocks')
      .query({ block_height: 'eq.100', limit: '1' })
      .reply(200, [{ hash: canonicalHash }]);

    await expect(backend.getNextBlocks(orphanHash, 2, 100)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      statusCode: 503,
      message: expect.stringMatching(/^CHAIN_POINT_MISMATCH:/),
    });
  });

  it('getBlockTransactions maps the flattened /block_txs shape through the /tx_info batch', async () => {
    nock(KOIOS_BASE)
      .post('/api/v1/block_txs')
      .reply(200, [{ tx_hash: 't1'.padEnd(64, '0') }, { tx_hash: 't2'.padEnd(64, '0') }]);
    const batch = jest.spyOn(backend, 'getTransactionsBatch').mockResolvedValue(new Map([
      ['t1'.padEnd(64, '0'), { hash: 't1'.padEnd(64, '0') } as never],
      ['t2'.padEnd(64, '0'), { hash: 't2'.padEnd(64, '0') } as never],
    ]));

    const txs = await backend.getBlockTransactions('blk'.padEnd(64, '0'));

    expect(batch).toHaveBeenCalledWith(['t1'.padEnd(64, '0'), 't2'.padEnd(64, '0')]);
    expect(txs.map(t => t.hash)).toEqual(['t1'.padEnd(64, '0'), 't2'.padEnd(64, '0')]);
  });

  it('getBlockTransactions also handles the legacy tx_hashes-array shape', async () => {
    nock(KOIOS_BASE)
      .post('/api/v1/block_txs')
      .reply(200, [{ block_hash: 'blk', tx_hashes: ['t3'.padEnd(64, '0')] }]);
    jest.spyOn(backend, 'getTransactionsBatch').mockResolvedValue(new Map([
      ['t3'.padEnd(64, '0'), { hash: 't3'.padEnd(64, '0') } as never],
    ]));

    const txs = await backend.getBlockTransactions('blk'.padEnd(64, '0'));
    expect(txs.map(t => t.hash)).toEqual(['t3'.padEnd(64, '0')]);
  });

  it('getBlockTransactions rejects a partial /tx_info batch instead of advancing the block', async () => {
    const tx1 = 't1'.padEnd(64, '0');
    const tx2 = 't2'.padEnd(64, '0');
    nock(KOIOS_BASE)
      .post('/api/v1/block_txs')
      .reply(200, [{ tx_hash: tx1 }, { tx_hash: tx2 }]);
    jest.spyOn(backend, 'getTransactionsBatch').mockResolvedValue(new Map([
      [tx1, { hash: tx1 } as never],
    ]));

    await expect(backend.getBlockTransactions('blk'.padEnd(64, '0'))).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      statusCode: 503,
      message: expect.stringContaining('1/2 transaction(s) missing'),
    });
  });
});

// ---------------------------------------------------------------------------
// CardanoClient capability getters (crawler source selection)
// ---------------------------------------------------------------------------

import { CardanoClient } from '../../srv/blockchain/cardano-client';
import type { CardanoBackend } from '../../srv/blockchain/backends/cardano-backend';

function makeClient(backends: Array<'blockfrost' | 'koios' | 'ogmios'>) {
  return new CardanoClient({
    network: 'preview',
    backends,
    blockfrostApiKey: 'test-key',
    koiosApiKey: '',
    ogmiosUrl: 'ws://localhost:1337',
    transactionBuilders: ['buildooor'],
    primaryTimeoutMs: 1000,
    fallbackTimeoutMs: 1000,
    indexTtlMs: 1000,
  });
}

const uninit = (client: CardanoClient) =>
  (client as unknown as { uninitializedBackends: Set<CardanoBackend> }).uninitializedBackends;
const live = (client: CardanoClient) =>
  (client as unknown as { liveBackend?: CardanoBackend }).liveBackend;
const historical = (client: CardanoClient) =>
  (client as unknown as { historicalBackends: CardanoBackend[] }).historicalBackends;

describe('CardanoClient.getChainSyncBackend / getPaginatingBackend', () => {
  it('returns the Ogmios backend for chain-sync when configured', () => {
    const client = makeClient(['blockfrost', 'ogmios']);
    expect(client.getChainSyncBackend()?.name).toBe('ogmios');
  });

  it('returns null for chain-sync when no Ogmios backend is configured', () => {
    const client = makeClient(['blockfrost', 'koios']);
    expect(client.getChainSyncBackend()).toBeNull();
  });

  it('skips an Ogmios backend whose init failed (crawler must not get a dead stream source)', () => {
    const client = makeClient(['blockfrost', 'ogmios']);
    uninit(client).add(live(client)!);
    expect(client.getChainSyncBackend()).toBeNull();
  });

  it('prefers Koios for pagination (batched /tx_info) over Blockfrost (N+1 per tx)', () => {
    const client = makeClient(['blockfrost', 'koios']);
    expect(client.getPaginatingBackend()?.name).toBe('koios');

    uninit(client).add(historical(client)[1]); // koios init failed → fall back
    expect(client.getPaginatingBackend()?.name).toBe('blockfrost');

    uninit(client).add(historical(client)[0]); // blockfrost too
    expect(client.getPaginatingBackend()).toBeNull(); // ogmios not configured / not paginating
  });
});
