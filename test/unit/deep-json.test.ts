/**
 * JSON with exact big integers at any nesting depth. Preview tx ede279c9… (block 4821137) carries
 * label-1 metadata nested 16,053 lists deep, which overflowed the recursive writers.
 */
vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    utils: { uuid: () => 'uuid' },
  };
  return { default: cdsMock, ...cdsMock };
});

import { safeJSON } from '@cardano-ogmios/client';
import { parseJson, stringifyJson } from '../../srv/utils/deep-json';
import { mapAsset, mapTransactionMetadata } from '../../srv/utils/mappers';

const DEPTH = 16_053;

/** `[[[…inner…]]]` nested `depth` lists deep, built without recursion. */
function nested(depth: number, inner: unknown): unknown {
  let v: unknown = inner;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

function depthOf(v: unknown): { depth: number; inner: unknown } {
  let depth = 0;
  while (Array.isArray(v)) { v = v[0]; depth++; }
  return { depth, inner: v };
}

const huge = 123_456_789_012_345_678_901n;

describe('stringifyJson', () => {
  it('writes what JSON.stringify writes for ordinary values', () => {
    const samples: unknown[] = [
      null, true, false, 0, -1.5, 1e21, Number.NaN, Infinity, '', 'a"b\\c\n\u0001é',
      [], {}, [1, 'x', null, undefined, () => 1], { a: 1, b: undefined, c: () => 1, d: [{}], e: { f: [] } },
      { toJSON: () => ({ z: 1 }) }, new Date(0), { '__proto__': 1, constructor: 2 },
    ];
    for (const s of samples) expect(stringifyJson(s)).toBe(JSON.stringify(s));
    expect(() => stringifyJson(undefined)).toThrow(TypeError);
  });

  it('writes big integers as plain digits, like safeJSON', () => {
    const v = { int: huge, nested: [1n, { negative: -huge }] };
    expect(stringifyJson(v)).toBe(safeJSON.stringify(v));
  });

  it('writes a boxed primitive as the primitive, on both the native and the loop path', () => {
    const boxed = [new Number(1), new String('x'), new Boolean(false), Object(7n)];
    expect(stringifyJson(boxed)).toBe('[1,"x",false,7]');
    expect(stringifyJson(nested(DEPTH, boxed))).toBe('['.repeat(DEPTH) + '[1,"x",false,7]' + ']'.repeat(DEPTH));
  });

  it('writes a bigint as digits even when a toJSON polyfill is installed', () => {
    const proto = BigInt.prototype as unknown as { toJSON?: () => string };
    proto.toJSON = function (this: bigint) { return this.toString(); };
    try {
      expect(stringifyJson({ n: huge })).toBe(`{"n":${huge}}`);
    } finally {
      delete proto.toJSON;
    }
  });

  it('refuses a cycle', () => {
    const a: unknown[] = [];
    a.push(a);
    expect(() => stringifyJson(a)).toThrow(TypeError);
  });

  it('writes 16,053 levels', () => {
    const text = stringifyJson(nested(DEPTH, huge));
    expect(text).toBe('['.repeat(DEPTH) + huge.toString() + ']'.repeat(DEPTH));
  });
});

describe('parseJson', () => {
  it('reads what safeJSON reads for ordinary text', () => {
    const samples = [
      'null', 'true', ' false ', '0', '-1.5', '1e21', '"a\\"b\\\\c\\n\\u0041"', '[]', '{}',
      '[1,"x",null,[{}]]', '{"a":1,"b":{"c":[2,3]},"d":"e"}', ' [ 1 , { "k" : [ ] } ] ',
      `{"int":${huge},"neg":-${huge},"small":9007199254740991,"frac":12345678901234.5}`,
    ];
    for (const s of samples) expect(parseJson(s)).toEqual(safeJSON.parse(s));
  });

  it('keeps "__proto__" as an own property, as JSON.parse does, on both paths', () => {
    const text = '{"a":1,"__proto__":{"polluted":1}}';
    for (const v of [parseJson(text), depthOf(parseJson('['.repeat(DEPTH) + text + ']'.repeat(DEPTH))).inner]) {
      const o = v as Record<string, unknown>;
      expect(o.a).toBe(1);
      expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(o, '__proto__')).toBe(true);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('applies the same integer rule on both paths', () => {
    const text = `{"v":[${huge},-123456789012345,123456789012345,12345678901234.5,1e21]}`;
    const expected = { v: [huge, -123456789012345n, 123456789012345, 12345678901234.5, 1e21] };
    expect(parseJson(text)).toEqual(expected);
    expect(depthOf(parseJson('['.repeat(DEPTH) + text + ']'.repeat(DEPTH))).inner).toEqual(expected);
  });

  it('rejects malformed text', () => {
    for (const s of ['', '[', '[1,]', '{"a"}', '{"a":1,}', '[1 2]', 'tru', '"\u0001"', '01', '[]x', '{a:1}']) {
      expect(() => parseJson(s)).toThrow(SyntaxError);
    }
  });

  it('reads 16,053 levels with the big integer intact', () => {
    const { depth, inner } = depthOf(parseJson('['.repeat(DEPTH) + huge.toString() + ']'.repeat(DEPTH)));
    expect(depth).toBe(DEPTH);
    expect(inner).toBe(huge);
  });
});

describe('round trip', () => {
  it('carry deep metadata the recursive safeJSON cannot', () => {
    const value = nested(DEPTH, 0);
    expect(() => safeJSON.stringify(value)).toThrow(RangeError);
    const text = stringifyJson(value);
    expect(depthOf(parseJson(text))).toEqual({ depth: DEPTH, inner: 0 });
  });

  it('match safeJSON for ordinary values', () => {
    const v = { a: [1n, huge], b: 'x' };
    expect(stringifyJson(v)).toBe(safeJSON.stringify(v));
    expect(parseJson(stringifyJson(v))).toEqual(safeJSON.parse(safeJSON.stringify(v)));
  });
});

describe('mapAsset on deep on-chain metadata', () => {
  it('stores CIP-25 metadata nested 16,053 lists deep, big integers exact', () => {
    const row = mapAsset({
      unit: 'a'.repeat(56), policyId: 'a'.repeat(56), assetNameHex: '', assetName: null, fingerprint: 'asset1xyz',
      totalSupply: '1', mintOrBurnCount: 1, initialMintTxHash: null, initialMintTime: null,
      onchainMetadata: nested(DEPTH, huge) as never,
      registryName: null, registryTicker: null, registryDecimals: null, registryDescription: null, registryUrl: null, registryLogo: null,
    }, 3600000);
    expect(row.onchainMetadata).toBe('['.repeat(DEPTH) + huge.toString() + ']'.repeat(DEPTH));
  });
});

describe('mapTransactionMetadata on deep metadata', () => {
  it('stores label 1 nested 16,053 lists deep', () => {
    const [row] = mapTransactionMetadata([{
      txHash: 'ede279c9cf7f9d4bb909f03ae06af5afedada6aaa9ca305c2cd6df3a4fd179e5',
      label: '1',
      json: nested(DEPTH, 0) as never,
    }]);
    expect(row.payload).toBe('['.repeat(DEPTH) + '0' + ']'.repeat(DEPTH));
  });
});
