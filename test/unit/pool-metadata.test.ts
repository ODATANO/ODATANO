/**
 * Pool metadata files: field limits, the hash check, the size limit, redirects, and the block on
 * hosts that are not public.
 */
import nock from 'nock';
import { blake2b_256 } from '@harmoniclabs/crypto';
import {
  POOL_METADATA_MAX_BYTES, fetchPoolMetadata, isPublicAddress, publicLookup, validPoolMetadata,
} from '../../srv/blockchain/pool-metadata';

vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
  return { default: cdsMock, ...cdsMock };
});

const FILE = { name: 'Stake Nuts', ticker: 'NUTS', homepage: 'https://stakenuts.example', description: 'The best pool ever' };
const body = (value: unknown = FILE): string => JSON.stringify(value);
const hashOf = (text: string): string => Buffer.from(blake2b_256(Buffer.from(text, 'utf8'))).toString('hex');
const HOST = 'https://pool.example';

beforeEach(() => nock.cleanAll());
afterAll(() => nock.cleanAll());

describe('validPoolMetadata', () => {
  it('takes a file with the four fields', () => {
    expect(validPoolMetadata({ ...FILE, extended: 'https://x' })).toEqual(FILE);
  });

  it('refuses a missing field, a field of another type and anything that is no object', () => {
    expect(validPoolMetadata({ ...FILE, homepage: undefined })).toBeNull();
    expect(validPoolMetadata({ ...FILE, name: 7 })).toBeNull();
    expect(validPoolMetadata({ ...FILE, ticker: null })).toBeNull();
    expect(validPoolMetadata([FILE])).toBeNull();
    expect(validPoolMetadata(null)).toBeNull();
  });

  it('applies the length limits in characters', () => {
    expect(validPoolMetadata({ ...FILE, name: 'ä'.repeat(50) })).not.toBeNull();
    expect(validPoolMetadata({ ...FILE, name: 'n'.repeat(51) })).toBeNull();
    expect(validPoolMetadata({ ...FILE, description: 'd'.repeat(256) })).toBeNull();
    expect(validPoolMetadata({ ...FILE, ticker: 'AB' })).toBeNull();
    expect(validPoolMetadata({ ...FILE, ticker: 'ABCDEF' })).toBeNull();
    expect(validPoolMetadata({ ...FILE, ticker: 'ABCDE' })).not.toBeNull();
  });
});

describe('isPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('takes %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('refuses what is not an address', () => {
    expect(isPublicAddress('pool.example')).toBe(false);
  });
});

describe('publicLookup', () => {
  it('refuses a name that resolves to this machine', async () => {
    const err = await new Promise<Error | null>((resolve) => publicLookup('localhost', {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/non-public address/);
  });
});

describe('fetchPoolMetadata', () => {
  it('returns the fields of a file that hashes to the registered hash', async () => {
    nock(HOST).get('/pool.json').reply(200, body());
    expect(await fetchPoolMetadata(`${HOST}/pool.json`, hashOf(body()))).toEqual(FILE);
  });

  it('takes the registered hash in upper case', async () => {
    nock(HOST).get('/pool.json').reply(200, body());
    expect(await fetchPoolMetadata(`${HOST}/pool.json`, hashOf(body()).toUpperCase())).toEqual(FILE);
  });

  it('refuses a file that does not hash to the registered hash', async () => {
    nock(HOST).get('/pool.json').reply(200, body({ ...FILE, name: 'Someone else' }));
    expect(await fetchPoolMetadata(`${HOST}/pool.json`, hashOf(body()))).toBeNull();
  });

  it('refuses a file above the size limit, whatever its hash', async () => {
    const big = body({ ...FILE, extra: 'x'.repeat(POOL_METADATA_MAX_BYTES) });
    nock(HOST).get('/pool.json').reply(200, big);
    expect(await fetchPoolMetadata(`${HOST}/pool.json`, hashOf(big))).toBeNull();
  });

  it('refuses a file whose fields break the limits, and one that is no JSON', async () => {
    const badTicker = body({ ...FILE, ticker: 'TOOLONG' });
    nock(HOST).get('/a.json').reply(200, badTicker);
    expect(await fetchPoolMetadata(`${HOST}/a.json`, hashOf(badTicker))).toBeNull();
    nock(HOST).get('/b.json').reply(200, '<html></html>');
    expect(await fetchPoolMetadata(`${HOST}/b.json`, hashOf('<html></html>'))).toBeNull();
  });

  it('follows a redirect to another public host', async () => {
    nock('http://short.example').get('/p').reply(302, undefined, { location: `${HOST}/pool.json` });
    nock(HOST).get('/pool.json').reply(200, body());
    expect(await fetchPoolMetadata('http://short.example/p', hashOf(body()))).toEqual(FILE);
  });

  it('does not follow a redirect to an address that is not public', async () => {
    const internal = nock('http://169.254.169.254').get('/latest/meta-data').reply(200, body());
    nock(HOST).get('/pool.json').reply(302, undefined, { location: 'http://169.254.169.254/latest/meta-data' });
    expect(await fetchPoolMetadata(`${HOST}/pool.json`, hashOf(body()))).toBeNull();
    expect(internal.isDone()).toBe(false);
  });

  it('gives up after five redirects', async () => {
    nock(HOST).get('/loop').times(6).reply(301, undefined, { location: `${HOST}/loop` });
    expect(await fetchPoolMetadata(`${HOST}/loop`, hashOf(body()))).toBeNull();
  });

  it('sends no request to an address literal that is not public, or over another protocol', async () => {
    const local = nock('http://127.0.0.1:8080').get('/pool.json').reply(200, body());
    expect(await fetchPoolMetadata('http://127.0.0.1:8080/pool.json', hashOf(body()))).toBeNull();
    expect(await fetchPoolMetadata('http://[::1]/pool.json', hashOf(body()))).toBeNull();
    expect(await fetchPoolMetadata('file:///etc/passwd', hashOf(body()))).toBeNull();
    expect(await fetchPoolMetadata('not a url', hashOf(body()))).toBeNull();
    expect(local.isDone()).toBe(false);
  });

  it('refuses an answer that is not 200', async () => {
    nock(HOST).get('/pool.json').reply(404, 'gone');
    expect(await fetchPoolMetadata(`${HOST}/pool.json`, hashOf('gone'))).toBeNull();
  });
});
