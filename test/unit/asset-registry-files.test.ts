/**
 * Token registry import from entry files (srv/blockchain/crawler/asset-registry-backfill.ts): the
 * file shapes of the registry repositories, written to the real model on an in-memory SQLite.
 */
import cds from '@sap/cds';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  backfillAssetRegistryFromFiles, parseRegistryEntry, registryEntryFiles,
} from '../../srv/blockchain/crawler/asset-registry-backfill';

const { SELECT, INSERT, DELETE } = cds.ql;
const ASSETS = 'odatano.cardano.Assets';
const POLICY = '00000000000410c2d9e01e8ec78ab1dc6bbc383fae76cbe2689beb02';
const MIDAS = `${POLICY}4d49444153`;
const OTHER = `${POLICY}4f54484552`;
const signed = (value: unknown) => ({ value, sequenceNumber: 0, signatures: [{ signature: 'ab', publicKey: 'cd' }] });

/** An asset entry as cardano-token-registry holds it. */
const assetEntry = (subject: string, over: Record<string, unknown> = {}) => JSON.stringify({
  subject, name: signed('MIDAS Synthetic'), description: signed('A synthetic asset'), ticker: signed('MIDAS'),
  url: signed('https://example.org/midas'), logo: signed('iVBORw0KGgo='), decimals: signed(9), ...over,
});
/** A script entry of the testnet registry: a 56-character subject with its preimage, no asset. */
const scriptEntry = JSON.stringify({
  subject: '01fb761b09aec85a63fb742c4dab2b72499bca6a6006b7594de6cb95', preImage: { value: '3832', hashFn: 'blake2b-224' },
  name: { value: 'NiceCoin', anSignatures: [] }, description: { value: 'NiceCoin is Nice', anSignatures: [] },
});

let directory: string;
const write = (name: string, content: string) => fs.writeFileSync(path.join(directory, name), content);
const slices = (unit: string) => cds.run(
  SELECT.from(ASSETS).columns('validFrom', 'registryName', 'registryTicker', 'registryDecimals', 'registryUrl', 'registryLogo', 'decimals')
    .where({ unit }).orderBy('validFrom')
) as Promise<Array<Record<string, unknown>>>;

beforeAll(async () => {
  const csn = await cds.load(path.resolve(__dirname, '../../db'));
  cds.model = cds.compile.for.nodejs(csn) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  // cds.deploy is not part of the published typings
  await (cds as unknown as { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } }).deploy(csn).to(db);
});

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  await cds.run(DELETE.from(ASSETS));
});

afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe('parseRegistryEntry', () => {
  it('reads the six values of an asset entry', () => {
    expect(parseRegistryEntry(assetEntry(MIDAS))).toEqual({
      unit: MIDAS, registryName: 'MIDAS Synthetic', registryTicker: 'MIDAS', registryDecimals: 9,
      registryDescription: 'A synthetic asset', registryUrl: 'https://example.org/midas', registryLogo: 'iVBORw0KGgo=',
    });
  });

  it('leaves out what the entry does not carry, an empty text and a value that fits no column', () => {
    const entry = parseRegistryEntry(JSON.stringify({
      subject: MIDAS.toUpperCase(), name: signed('M'), ticker: signed(''), url: signed('u'.repeat(257)), decimals: signed(1.5),
    }));
    expect(entry).toEqual({
      unit: MIDAS, registryName: 'M', registryTicker: null, registryDecimals: null,
      registryDescription: null, registryUrl: null, registryLogo: null,
    });
  });

  it('answers null for an entry that describes no native asset', () => {
    expect(parseRegistryEntry(scriptEntry)).toBeNull();
    expect(parseRegistryEntry(JSON.stringify({ subject: 'abc', name: signed('x') }))).toBeNull();
    expect(parseRegistryEntry(JSON.stringify({ name: signed('x') }))).toBeNull();
  });
});

describe('backfillAssetRegistryFromFiles', () => {
  it('writes every slice of a unit that has rows, and counts the rest', async () => {
    await cds.run(INSERT.into(ASSETS).entries([
      { unit: MIDAS, policyId: POLICY, validFrom: '1970-01-01T00:00:00.000Z', validTo: '1970-01-01T00:00:00.000Z', decimals: null },
      { unit: MIDAS, policyId: POLICY, validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-01-01T01:00:00.000Z', decimals: 6, registryName: 'old name' },
    ]));
    write(`${MIDAS}.json`, assetEntry(MIDAS));
    write(`${OTHER}.json`, assetEntry(OTHER));
    write('01fb761b09aec85a63fb742c4dab2b72499bca6a6006b7594de6cb95.json', scriptEntry);
    write('broken.json', '{ not json');
    write('README.md', 'not an entry');
    const seen: number[] = [];

    const result = await backfillAssetRegistryFromFiles({ directory, onProgress: (p) => seen.push(p.processed) });

    expect(result).toEqual({ units: 4, processed: 4, filled: 1, failed: 1, absent: 1, skipped: 1 });
    expect(seen).toEqual([4]);
    expect(await slices(MIDAS)).toMatchObject([
      // the catalogue row had no decimals: it takes the registry's
      { registryName: 'MIDAS Synthetic', registryTicker: 'MIDAS', registryDecimals: 9, registryUrl: 'https://example.org/midas', registryLogo: 'iVBORw0KGgo=', decimals: 9 },
      // decimals from a datum stay
      { registryName: 'MIDAS Synthetic', registryDecimals: 9, decimals: 6 },
    ]);
    // no row is created for a unit the database does not know
    expect(await slices(OTHER)).toEqual([]);
  });

  it('clears a value the registry no longer carries', async () => {
    await cds.run(INSERT.into(ASSETS).entries([
      { unit: MIDAS, policyId: POLICY, validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-01-01T01:00:00.000Z', registryTicker: 'OLD', registryUrl: 'https://old' },
    ]));
    write(`${MIDAS}.json`, JSON.stringify({ subject: MIDAS, name: signed('MIDAS Synthetic') }));
    await backfillAssetRegistryFromFiles({ directory });
    expect((await slices(MIDAS))[0]).toMatchObject({ registryName: 'MIDAS Synthetic', registryTicker: null, registryUrl: null });
  });
});

describe('registryEntryFiles', () => {
  it('lists the entry files in name order and refuses a folder without any', async () => {
    await expect(registryEntryFiles(directory)).rejects.toThrow('holds no entry files');
    await expect(registryEntryFiles(path.join(directory, 'missing'))).rejects.toThrow('not a readable folder');
    write('b.json', '{}');
    write('a.json', '{}');
    write('notes.txt', '');
    expect(await registryEntryFiles(directory)).toEqual(['a.json', 'b.json']);
  });
});
