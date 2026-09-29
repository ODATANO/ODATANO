/**
 * CardanoBackendService handlers: stored data first, the instance's resolvers and backends next,
 * JSON answers, validation, and the chain-point signal for a remote crawler.
 */
export {};

const { fakeDb, stored, client, indexer } = vi.hoisted(() => ({
  fakeDb: { run: vi.fn() },
  stored: {
    readBlock: vi.fn(),
    readBlockByHeight: vi.fn(),
    readNextBlocks: vi.fn(),
    readBlockTransactions: vi.fn(),
    readTransactionsByHash: vi.fn(),
    readTransactionMetadata: vi.fn(),
    lacksOutpoints: vi.fn((t: { inputs?: Array<{ txHash: unknown }> }) => (t.inputs ?? []).some(i => i.txHash == null)),
  },
  client: {
    getTransaction: vi.fn(),
    getTransactionsBatch: vi.fn(),
    hasBackendFor: vi.fn(() => true),
    getPaginatingBackend: vi.fn(() => null),
    getEnumeratingBackend: vi.fn(() => null),
    getEpochStateBackend: vi.fn(() => null),
    getLatestBlock: vi.fn(),
    getUnspentOutputs: vi.fn(),
    submitTransaction: vi.fn(),
  },
  indexer: {
    refuseOutsideCrawl: vi.fn(async () => undefined),
    resolveAddress: vi.fn(),
  },
}));

vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/backend-request-handler', () => ({
  handleRequest: vi.fn((_req: unknown, cb: (db: unknown) => unknown) => cb(fakeDb)),
}));
vi.mock('../../srv/server', () => ({ getCardanoClient: () => client, getCardanoIndexer: () => indexer }));
vi.mock('../../srv/blockchain/stored-chain', () => stored);

type Handler = (req: Record<string, unknown>) => Promise<unknown>;
let handlers: Record<string, Handler> = {};
beforeAll(async () => {
  const mod: any = await import('../../srv/cardano-backend-service');
  const register = mod.default ?? mod;
  register({ on: (event: string, h: Handler) => { handlers[event] = h; } });
});
beforeEach(() => {
  vi.clearAllMocks();
  client.hasBackendFor.mockReturnValue(true);
  client.getPaginatingBackend.mockReturnValue(null);
  client.getEnumeratingBackend.mockReturnValue(null);
  client.getEpochStateBackend.mockReturnValue(null);
});

const call = (event: string, data: Record<string, unknown> = {}) => handlers[event]({ event, data });
const TX = 'a'.repeat(64);
const BLK = 'b'.repeat(64);

describe('CardanoBackendService', () => {
  it('answers a stored transaction from the index, as JSON, without asking a backend', async () => {
    stored.readTransactionsByHash.mockResolvedValue(new Map([[TX, { hash: TX, fee: '1' }]]));
    expect(JSON.parse(String(await call('GetTransaction', { hash: TX })))).toEqual({ hash: TX, fee: '1' });
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('asks its backends for a transaction it does not hold, unless the crawled chain is authoritative', async () => {
    stored.readTransactionsByHash.mockResolvedValue(new Map());
    client.getTransaction.mockResolvedValue({ hash: TX });
    await call('GetTransaction', { hash: TX });
    expect(indexer.refuseOutsideCrawl).toHaveBeenCalledWith(fakeDb, 'getTransaction', `Transaction ${TX}`);
    expect(client.getTransaction).toHaveBeenCalledWith(TX);
  });

  it('answers a batch as an object keyed by hash, stored ones first', async () => {
    const other = 'c'.repeat(64);
    stored.readTransactionsByHash.mockResolvedValue(new Map([[TX, { hash: TX }]]));
    client.getTransactionsBatch.mockResolvedValue(new Map([[other, { hash: other }]]));
    const out = JSON.parse(String(await call('GetTransactionsBatch', { hashes: JSON.stringify([TX, other]) })));
    expect(Object.keys(out).sort()).toEqual([TX, other].sort());
    expect(client.getTransactionsBatch).toHaveBeenCalledWith([other]);
  });

  it('replaces a stored transaction without input outpoints by the backend copy, keeps it when none can serve', async () => {
    const old = { hash: TX, inputs: [{ txHash: null, outputIndex: null }] };
    const full = { hash: TX, inputs: [{ txHash: 'a'.repeat(64), outputIndex: 1 }] };
    stored.readTransactionsByHash.mockResolvedValue(new Map([[TX, old]]));
    client.getTransaction.mockResolvedValueOnce(full);
    expect(JSON.parse(String(await call('GetTransaction', { hash: TX })))).toEqual(full);

    client.getTransaction.mockRejectedValueOnce(new Error('backend down'));
    expect(JSON.parse(String(await call('GetTransaction', { hash: TX })))).toEqual(old);

    client.hasBackendFor.mockReturnValueOnce(false);
    client.getTransaction.mockClear();
    expect(JSON.parse(String(await call('GetTransaction', { hash: TX })))).toEqual(old);
    expect(client.getTransaction).not.toHaveBeenCalled();

    // batch: an unreachable backend keeps the stored copies
    client.getTransactionsBatch.mockRejectedValueOnce(new Error('backend down'));
    expect(JSON.parse(String(await call('GetTransactionsBatch', { hashes: JSON.stringify([TX]) })))).toEqual({ [TX]: old });
  });

  it('rejects missing and malformed parameters with 400', async () => {
    await expect(call('GetTransaction', {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(call('GetTransaction', { hash: 'xyz' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call('GetTransactionsBatch', { hashes: '["nope"]' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call('GetUnspentOutputs', { refs: '[{"txHash":"x","outputIndex":0}]' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('pages stored blocks after a known cursor block', async () => {
    stored.readBlock.mockResolvedValue({ hash: BLK, height: 9 });
    stored.readNextBlocks.mockResolvedValue([{ hash: 'n10', height: 10 }]);
    expect(JSON.parse(String(await call('GetNextBlocks', { afterHash: BLK, count: 5 })))).toEqual([{ hash: 'n10', height: 10 }]);
    expect(stored.readNextBlocks).toHaveBeenCalledWith(fakeDb, 9, 5);
  });

  it('signals an orphaned cursor with the chain-point mismatch prefix', async () => {
    stored.readBlock.mockResolvedValue(null);
    stored.readBlockByHeight.mockResolvedValue({ hash: 'canonical', height: 9 });
    await expect(call('GetNextBlocks', { afterHash: BLK, count: 5, afterHeight: 9 })).rejects.toThrow(/^CHAIN_POINT_MISMATCH:.*canonical/);
    // 409, not 5xx: production masks the message of a 5xx and the marker would never arrive
    await expect(call('GetNextBlocks', { afterHash: BLK, count: 5, afterHeight: 9 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('passes a provider reorg marker on as 409', async () => {
    stored.readBlock.mockResolvedValue(null);
    stored.readBlockByHeight.mockResolvedValue(null);
    const getNextBlocks = vi.fn(async () => { throw new Error('CHAIN_POINT_MISMATCH: cursor block x is unknown to koios'); });
    client.getPaginatingBackend.mockReturnValue({ getNextBlocks } as never);
    await expect(call('GetNextBlocks', { afterHash: BLK, count: 5, afterHeight: 9 })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^CHAIN_POINT_MISMATCH:.*koios/) });
  });

  it('answers an empty page at its own tip', async () => {
    stored.readBlock.mockResolvedValue({ hash: BLK, height: 9 });
    stored.readNextBlocks.mockResolvedValue([]);
    expect(JSON.parse(String(await call('GetNextBlocks', { afterHash: BLK, count: 5 })))).toEqual([]);
  });

  it('enumerates pools from the node ledger when no enumerating backend exists', async () => {
    const epochStateAt = vi.fn(async () => ({ pools: [{ poolId: 'pool1a' }, { poolId: 'pool1b' }], dreps: [] }));
    client.getEpochStateBackend.mockReturnValue({ epochStateAt } as never);
    client.getLatestBlock.mockResolvedValue({ slot: 100, hash: BLK });
    expect(JSON.parse(String(await call('GetPoolIds')))).toEqual(['pool1a', 'pool1b']);
    expect(epochStateAt).toHaveBeenCalledWith({ slot: 100, hash: BLK });
  });

  it('refuses output lookups without a ledger-state backend', async () => {
    client.getUnspentOutputs.mockResolvedValue(null);
    await expect(call('GetUnspentOutputs', { refs: JSON.stringify([{ txHash: TX, outputIndex: 0 }]) })).rejects.toMatchObject({ statusCode: 503 });
  });
});
