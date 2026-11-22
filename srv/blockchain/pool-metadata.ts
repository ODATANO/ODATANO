import cds from '@sap/cds';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { TextDecoder } from 'node:util';
import { blake2b_256 } from '@harmoniclabs/crypto';

const logger = cds.log('PoolMetadata');

/** A stake pool's metadata file is at most this many bytes. */
export const POOL_METADATA_MAX_BYTES = 512;
const MAX_REDIRECTS = 5;
/** For the whole fetch, redirects included. */
const FETCH_TIMEOUT_MS = 3_000;

/** The four fields of a stake pool's metadata file. */
export interface PoolMetadata {
  name: string;
  ticker: string;
  homepage: string;
  description: string;
}

const chars = (s: string): number => [...s].length;

// The limits cardano-db-sync applies: name up to 50 characters, description up to 255, ticker 3 to 5.
// Null when a field is missing, not a string or out of range.
export function validPoolMetadata(value: unknown): PoolMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { name, ticker, homepage, description } = value as Record<string, unknown>;
  if (typeof name !== 'string' || typeof ticker !== 'string' || typeof homepage !== 'string' || typeof description !== 'string') return null;
  if (chars(name) > 50 || chars(description) > 255 || chars(ticker) < 3 || chars(ticker) > 5) return null;
  if (Buffer.byteLength(homepage, 'utf8') > POOL_METADATA_MAX_BYTES) return null;
  return { name, ticker, homepage, description };
}

// Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges.
// A pool registers any URL it likes, so the fetch must not reach hosts behind this server.
const NON_PUBLIC = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) NON_PUBLIC.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NON_PUBLIC.addSubnet(prefix, bits, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  return family !== 0 && !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

// DNS lookup that refuses a name with any non-public address. The connection uses the checked
// addresses, so a second, different DNS answer cannot redirect it.
export const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    if (addresses.length === 0 || addresses.some(a => !isPublicAddress(a.address))) {
      return callback(new Error(`${hostname} resolves to a non-public address`), '', 4);
    }
    if ((options as dns.LookupOptions).all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
};

interface Reply {
  status: number;
  location?: string;
  /** Null when the body is longer than the limit. */
  body: Buffer | null;
}

function get(url: URL, signal: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { lookup: publicLookup, signal, headers: { accept: 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (body: Buffer | null) => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body });
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > POOL_METADATA_MAX_BYTES) {
          res.destroy();
          done(null);
        } else {
          chunks.push(chunk);
        }
      });
      res.on('end', () => done(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** The file behind `url`, following redirects; every hop must be http(s) on a public host. */
async function download(url: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let next = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`unsupported protocol ${next.protocol}`);
    // an address literal never reaches the DNS lookup
    const host = next.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublicAddress(host)) throw new Error(`${host} is not a public address`);
    const reply = await get(next, signal);
    if ([301, 302, 303, 307, 308].includes(reply.status) && reply.location) {
      next = new URL(reply.location, next);
      continue;
    }
    if (reply.status !== 200) throw new Error(`HTTP ${reply.status}`);
    if (!reply.body) throw new Error(`more than ${POOL_METADATA_MAX_BYTES} bytes`);
    return reply.body;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

// Loads a pool's metadata file and returns its fields when the bytes hash to `hash` (blake2b-256,
// as registered on chain). Null for any failure; never throws.
export async function fetchPoolMetadata(url: string, hash: string): Promise<PoolMetadata | null> {
  try {
    const bytes = await download(url);
    if (Buffer.from(blake2b_256(bytes)).toString('hex') !== hash.toLowerCase()) throw new Error('hash mismatch');
    const metadata = validPoolMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!metadata) throw new Error('not a valid pool metadata file');
    return metadata;
  } catch (err: unknown) {
    logger.debug(`Pool metadata ${url} not used: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
