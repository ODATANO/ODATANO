/**
 * NUL safety for PostgreSQL: decodeAssetName never yields U+0000, and the
 * db-level sanitiser strips it from anything else this plugin writes.
 */
import { sanitizeRows, stripNulStrings, sanitizeDbRequest, installDbSanitizer } from '../../srv/utils/db-sanitize';

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    utils: { uuid: () => 'uuid' },
  };
  return { default: cdsMock, ...cdsMock };
});

import { decodeAssetName, mapTransactionOutputAssets } from '../../srv/utils/mappers';

// preprod block 4281919, tx df10bd32…: 32-byte asset name whose last byte is 0x00
const NUL_NAME_HEX = '0f85874c3926e23a96d0b27be9256f4cbd5bcd1d99554788a0c6ca9cab5ac900';
const POLICY = '75869cf21a11b80988e55eac1babe24dfc6a99bfe0cdd01145800998';

describe('decodeAssetName', () => {
  it('decodes clean UTF-8 names', () => {
    expect(decodeAssetName('484f534b59')).toBe('HOSKY');
    expect(decodeAssetName('')).toBe('');
  });

  it('returns the hex form when the bytes contain U+0000', () => {
    expect(decodeAssetName('4142000043')).toBe('4142000043');
    expect(decodeAssetName(NUL_NAME_HEX)).toBe(NUL_NAME_HEX);
    expect(decodeAssetName(NUL_NAME_HEX)).not.toContain('\u0000');
  });

  it('returns the hex form when the bytes are not valid UTF-8', () => {
    expect(decodeAssetName('fffe')).toBe('fffe');
    expect(decodeAssetName('c328')).toBe('c328'); // truncated 2-byte sequence
  });

  it('keeps multi-byte text intact', () => {
    expect(decodeAssetName(Buffer.from('Käse ☃', 'utf8').toString('hex'))).toBe('Käse ☃');
  });

  it('keeps a leading BOM — it is part of the on-chain bytes', () => {
    expect(decodeAssetName('efbbbf48454c4c4f')).toBe('\uFEFFHELLO');
  });
});

describe('mapTransactionOutputAssets with a NUL asset name', () => {
  it('produces rows without U+0000 (hex fallback) while keeping assetNameHex exact', () => {
    const rows = mapTransactionOutputAssets(1, [
      { outputIndex: 0, address: 'addr_test1x', amount: [{ unit: `${POLICY}${NUL_NAME_HEX}`, quantity: '1' }] } as never,
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as unknown as Record<string, unknown>;
    expect(row.unit).toBe(`${POLICY}${NUL_NAME_HEX}`); // exact bytes stay in the unit
    expect(row.asset_assetName).toBe(NUL_NAME_HEX); // display name falls back to hex
    expect(JSON.stringify(rows)).not.toContain('\\u0000');
  });
});

describe('stripNulStrings / sanitizeRows', () => {
  it('removes U+0000 from strings, nested objects and arrays', () => {
    const row = { a: 'x\u0000y', n: { b: '\u0000', c: 5 }, arr: ['ok', 'no\u0000'], buf: Buffer.from([0]) };
    const out = stripNulStrings(row);
    expect(out.a).toBe('xy');
    expect(out.n.b).toBe('');
    expect(out.arr).toEqual(['ok', 'no']);
    expect(out.buf).toBe(row.buf); // buffers are bytes, not text – untouched
    expect(JSON.stringify(out)).not.toContain('\\u0000');
  });

  it('returns the identical array when nothing needs changing (cheap on the hot path)', () => {
    const rows = [{ a: 'clean', b: 1 }, { a: 'also', b: null }];
    expect(sanitizeRows(rows)).toBe(rows);
    expect(stripNulStrings(rows[0])).toBe(rows[0]);
  });

  it('copies only the rows that change', () => {
    const rows = [{ a: 'clean' }, { a: 'dirty\u0000' }];
    const out = sanitizeRows(rows);
    expect(out).not.toBe(rows);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toEqual({ a: 'dirty' });
  });
});

describe('db-level sanitizer hook', () => {
  const target = { name: 'odatano.cardano.TransactionOutputAssets' };

  it('strips NUL from INSERT/UPSERT entries and UPDATE data of plugin entities', () => {
    const ins = { INSERT: { entries: [{ a: 'x\u0000' }] } };
    sanitizeDbRequest({ query: ins, target });
    expect(ins.INSERT.entries).toEqual([{ a: 'x' }]);

    const ups = { UPSERT: { entries: [{ a: 'ok' }, { a: '\u0000y' }] } };
    sanitizeDbRequest({ query: ups, target });
    expect(ups.UPSERT.entries).toEqual([{ a: 'ok' }, { a: 'y' }]);

    const upd = { UPDATE: { data: { lastError: 'e\u0000' } } };
    sanitizeDbRequest({ query: upd, target: { name: 'odatano.cardano.CardanoSyncState' } });
    expect(upd.UPDATE.data).toEqual({ lastError: 'e' });
  });

  it("leaves a consumer's own entities and unknown query shapes alone", () => {
    const q = { INSERT: { entries: [{ a: 'x\u0000' }] } };
    sanitizeDbRequest({ query: q, target: { name: 'my.app.Orders' } });
    expect(q.INSERT.entries[0].a).toBe('x\u0000');
    expect(() => sanitizeDbRequest({ query: undefined, target })).not.toThrow();
    expect(() => sanitizeDbRequest({ query: { SELECT: {} }, target: null })).not.toThrow();
  });

  it('installs once per db service and covers CREATE, UPSERT and UPDATE', () => {
    const before = vi.fn();
    const db = { before };
    expect(installDbSanitizer(db)).toBe(true);
    expect(installDbSanitizer(db)).toBe(false); // idempotent
    expect(before).toHaveBeenCalledTimes(1);
    expect(before.mock.calls[0][0]).toEqual(['CREATE', 'UPSERT', 'UPDATE']);
    expect(before.mock.calls[0][1]).toBe(sanitizeDbRequest);
    expect(installDbSanitizer(undefined)).toBe(false); // no db connected yet → no-op
  });
});
