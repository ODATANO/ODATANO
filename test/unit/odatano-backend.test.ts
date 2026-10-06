/**
 * OdatanoBackend: another ODATANO (the public API behind the gateway) as a backend. HTTP is
 * mocked at axios.create; checks URLs, auth, JSON answers, batching and error mapping.
 */

const { post, created } = vi.hoisted(() => ({ post: vi.fn(), created: [] as Array<Record<string, unknown>> }));

vi.mock('axios', () => {
  const create = vi.fn((config: Record<string, unknown>) => { created.push(config); return { post }; });
  return { default: { create }, create };
});

vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
  return { default: cdsMock, ...cdsMock };
});

import { OdatanoBackend } from '../../srv/blockchain/backends/odatano-backend';
import { BackendInitError, NotFoundError, ProviderUnavailableError, RateLimitError, ScriptValidationError, TransactionValidationError } from '../../srv/utils/errors';

const ok = (value: string, headers: Record<string, string> = {}) => ({ data: { value }, headers });
const httpError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`status ${status}`), { isAxiosError: true, response: { status, headers, data: { error: { message } } } });

beforeEach(() => {
  post.mockReset();
  created.length = 0;
});

describe('OdatanoBackend', () => {
  it('targets the public API of the network with the key as bearer token', () => {
    new OdatanoBackend('preprod', 5000, undefined, 'oda_key');
    expect(created[0]).toMatchObject({
      baseURL: 'https://api.preprod.odatano.dev/odata/v4/cardano-backend',
      timeout: 5000,
      headers: { Authorization: 'Bearer oda_key' },
    });
  });

  it('needs an explicit URL on mainnet and refuses non-http URLs', () => {
    expect(() => new OdatanoBackend('mainnet', 5000, undefined, 'k')).toThrow(BackendInitError);
    expect(() => new OdatanoBackend('preview', 5000, 'ftp://x', 'k')).toThrow(BackendInitError);
    new OdatanoBackend('mainnet', 5000, 'https://gw.example/', 'k');
    expect(created[0].baseURL).toBe('https://gw.example/odata/v4/cardano-backend');
  });

  it('parses the JSON answer and keeps big integers', async () => {
    post.mockResolvedValue(ok('{"hash":"aa","fee":"170000","metadata":[{"label":"1","json":{"n":18446744073709551615}}]}', { 'x-access-units-left': '41' }));
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    const tx = await b.getTransaction('aa');
    expect(post).toHaveBeenCalledWith('/GetTransaction', { hash: 'aa' });
    expect(String((tx.metadata![0].json as { n: unknown }).n)).toBe('18446744073709551615');
    expect(b.unitsLeft).toBe(41);
  });

  it('pages pool resolution in batches of 200 ids', async () => {
    post.mockImplementation(async (_path: string, body: { ids: string }) =>
      ok(JSON.stringify((JSON.parse(body.ids) as string[]).map(poolId => ({ poolId })))));
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    const ids = Array.from({ length: 450 }, (_, i) => `pool${i}`);
    const pools = await b.getPools(ids);
    expect(pools).toHaveLength(450);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('turns a transaction batch answer back into a map', async () => {
    post.mockResolvedValue(ok('{"aa":{"hash":"aa"}}'));
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    const found = await b.getTransactionsBatch(['aa', 'bb']);
    expect([...found.keys()]).toEqual(['aa']);
  });

  it('maps 404, 429 and 5xx to the backend error classes', async () => {
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    post.mockRejectedValueOnce(httpError(404, 'Transaction aa (not in the crawled chain up to slot 5) not found'));
    await expect(b.getTransaction('aa')).rejects.toSatisfy((e: unknown) =>
      e instanceof NotFoundError && (e as Error).message === 'Transaction aa (not in the crawled chain up to slot 5) not found');
    post.mockRejectedValueOnce(httpError(429, 'units exhausted', { 'retry-after': '30' }));
    await expect(b.getLatestBlock()).rejects.toBeInstanceOf(RateLimitError);
    post.mockRejectedValueOnce(httpError(503, 'backend down'));
    await expect(b.getLatestBlock()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('keeps a remote script failure a ScriptValidationError and other 400s a TransactionValidationError', async () => {
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    post.mockRejectedValueOnce(httpError(400, '[ODATANO_SCRIPT_VALIDATION_FAILURE] EvaluateTransaction: Script validation failed (3010): x'));
    await expect(b.evaluateTransaction('84a0')).rejects.toBeInstanceOf(ScriptValidationError);
    post.mockRejectedValueOnce(httpError(400, '[ODATANO_TX_VALIDATION_FAILED] EvaluateTransaction: bad cbor'));
    await expect(b.evaluateTransaction('84a0')).rejects.toBeInstanceOf(TransactionValidationError);
  });

  it('passes the chain-point mismatch marker through verbatim, so the crawler recovers', async () => {
    post.mockRejectedValueOnce(httpError(503, 'CHAIN_POINT_MISMATCH: cursor block aa at height 9 is no longer canonical (canonical block: bb)'));
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    await expect(b.getNextBlocks('aa', 20, 9)).rejects.toThrow(/^CHAIN_POINT_MISMATCH:/);
    expect(post).toHaveBeenCalledWith('/GetNextBlocks', { afterHash: 'aa', count: 20, afterHeight: 9 });
  });

  it('looks up unspent outputs at the remote in batches of JSON refs', async () => {
    post.mockResolvedValue({ data: { value: JSON.stringify([{ txHash: 'aa', outputIndex: 0, scriptRefCbor: '4e4d' }]) }, headers: {} });
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    const out = await b.getUnspentOutputs([{ txHash: 'aa', outputIndex: 0 }]);
    expect(post).toHaveBeenCalledWith('/GetUnspentOutputs', { refs: JSON.stringify([{ txHash: 'aa', outputIndex: 0 }]) });
    expect(out[0].scriptRefCbor).toBe('4e4d');
  });

  it('strips the remote error prefix, so the marker starts the message', async () => {
    post.mockRejectedValueOnce(httpError(409, '[ODATANO_CHAIN_POINT_MISMATCH] GetNextBlocks: CHAIN_POINT_MISMATCH: cursor block aa is unknown to this instance'));
    const b = new OdatanoBackend('preview', 5000, undefined, 'k');
    await expect(b.getNextBlocks('aa', 20)).rejects.toThrow(/^CHAIN_POINT_MISMATCH: cursor block aa/);
  });
});
