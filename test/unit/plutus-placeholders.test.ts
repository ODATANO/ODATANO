/**
 * Unit tests for the FR-3 PlutusData input-index placeholder helpers.
 *
 * These cover the pure walker, the regex contract, the Buildooor-equivalent
 * input sort, and the whole-tree placeholder detector.
 */

import {
  INPUT_IDX_REGEX,
  resolveIndexPlaceholders,
  sortInputsLikeBuildooor,
  type InputRef,
} from '../../srv/utils/plutus-placeholders';
import { TransactionValidationError } from '../../srv/utils/errors';

const ZERO_HASH = '00'.repeat(32);
const AA_HASH = 'aa'.repeat(32);
const FF_HASH = 'ff'.repeat(32);
const BB_HASH = 'bb'.repeat(32);

const mkRef = (txHash: string, outputIndex: number): InputRef => ({ txHash, outputIndex });

describe('INPUT_IDX_REGEX', () => {
  it('matches a 64-hex txHash + numeric index inside the canonical placeholder shape', () => {
    expect(INPUT_IDX_REGEX.test(`__INPUT_IDX:${AA_HASH}#0__`)).toBe(true);
    expect(INPUT_IDX_REGEX.test(`__INPUT_IDX:${AA_HASH}#42__`)).toBe(true);
  });

  it('accepts uppercase hex (case-insensitive; normalized to lowercase at the use site)', () => {
    expect(INPUT_IDX_REGEX.test(`__INPUT_IDX:${AA_HASH.toUpperCase()}#0__`)).toBe(true);
  });

  it('rejects missing trailing __ suffix', () => {
    expect(INPUT_IDX_REGEX.test(`__INPUT_IDX:${AA_HASH}#0`)).toBe(false);
  });

  it('rejects txHash shorter than 64 hex chars', () => {
    expect(INPUT_IDX_REGEX.test(`__INPUT_IDX:${'aa'.repeat(31)}#0__`)).toBe(false);
  });

  it('rejects non-digit outputIndex', () => {
    expect(INPUT_IDX_REGEX.test(`__INPUT_IDX:${AA_HASH}#abc__`)).toBe(false);
  });
});

describe('sortInputsLikeBuildooor', () => {
  it('sorts lexicographically on txHash bytes', () => {
    const refs = [mkRef(FF_HASH, 0), mkRef(ZERO_HASH, 0), mkRef(AA_HASH, 0)];
    const sorted = sortInputsLikeBuildooor(refs);
    expect(sorted.map(r => r.txHash)).toEqual([ZERO_HASH, AA_HASH, FF_HASH]);
  });

  it('breaks ties by outputIndex ascending', () => {
    const refs = [mkRef(AA_HASH, 5), mkRef(AA_HASH, 1), mkRef(AA_HASH, 3)];
    const sorted = sortInputsLikeBuildooor(refs);
    expect(sorted.map(r => r.outputIndex)).toEqual([1, 3, 5]);
  });

  it('is pure — returns a new array, leaves input untouched', () => {
    const refs = [mkRef(FF_HASH, 0), mkRef(ZERO_HASH, 0)];
    const sorted = sortInputsLikeBuildooor(refs);
    expect(sorted).not.toBe(refs);
    expect(refs.map(r => r.txHash)).toEqual([FF_HASH, ZERO_HASH]);
  });

  it('matches reference fixture of 4 mixed refs (lex bytes + tie-break)', () => {
    const refs = [mkRef(FF_HASH, 0), mkRef(AA_HASH, 2), mkRef(AA_HASH, 0), mkRef(BB_HASH, 1)];
    const sorted = sortInputsLikeBuildooor(refs);
    expect(sorted).toEqual([
      mkRef(AA_HASH, 0),
      mkRef(AA_HASH, 2),
      mkRef(BB_HASH, 1),
      mkRef(FF_HASH, 0),
    ]);
  });
});

describe('resolveIndexPlaceholders', () => {
  const sortedInputs = [mkRef(AA_HASH, 0), mkRef(BB_HASH, 0), mkRef(FF_HASH, 1)];
  const ctx = { sortedInputs };

  it('replaces an int leaf placeholder with the resolved numeric index', () => {
    const tree = { int: `__INPUT_IDX:${BB_HASH}#0__` };
    expect(resolveIndexPlaceholders(tree, ctx)).toEqual({ int: 1 });
  });

  it('resolves an UPPERCASE-hash placeholder against the lowercase input set', () => {
    const tree = { int: `__INPUT_IDX:${BB_HASH.toUpperCase()}#0__` };
    expect(resolveIndexPlaceholders(tree, ctx)).toEqual({ int: 1 });
  });

  it('leaves non-matching int string values unchanged', () => {
    const tree = { int: 'not-a-placeholder' };
    expect(resolveIndexPlaceholders(tree, ctx)).toEqual({ int: 'not-a-placeholder' });
  });

  it('leaves bytes-field string values untouched even if they contain the placeholder shape', () => {
    const tree = { bytes: `__INPUT_IDX:${AA_HASH}#0__` };
    expect(resolveIndexPlaceholders(tree, ctx)).toEqual({
      bytes: `__INPUT_IDX:${AA_HASH}#0__`,
    });
  });

  it('recursively resolves placeholders inside constructor/fields/list/map structures', () => {
    const tree: any = {
      constructor: 0,
      fields: [
        { int: `__INPUT_IDX:${AA_HASH}#0__` },
        {
          list: [
            { int: `__INPUT_IDX:${FF_HASH}#1__` },
            { bytes: 'cafe' },
          ],
        },
      ],
    };
    expect(resolveIndexPlaceholders(tree, ctx)).toEqual({
      constructor: 0,
      fields: [
        { int: 0 },
        {
          list: [{ int: 2 }, { bytes: 'cafe' }],
        },
      ],
    });
  });

  it('throws TransactionValidationError when a placeholder references an input absent from sortedInputs', () => {
    const missingHash = '11'.repeat(32);
    const tree = { int: `__INPUT_IDX:${missingHash}#0__` };
    expect(() => resolveIndexPlaceholders(tree, ctx)).toThrow(TransactionValidationError);
    expect(() => resolveIndexPlaceholders(tree, ctx)).toThrow(`__INPUT_IDX:${missingHash}#0__`);
  });

  it('throws TransactionValidationError when the tree exceeds MAX_WALK_DEPTH (64)', () => {
    let deepArray: any = { int: 1 };
    for (let i = 0; i < 100; i++) {
      deepArray = [deepArray];
    }
    expect(() => resolveIndexPlaceholders(deepArray, ctx)).toThrow(TransactionValidationError);
    expect(() => resolveIndexPlaceholders(deepArray, ctx)).toThrow(/exceeded max depth/);
  });

  it('returns primitive values unchanged (null, number, boolean leaves)', () => {
    expect(resolveIndexPlaceholders(null as any, ctx)).toBeNull();
    expect(resolveIndexPlaceholders(42 as any, ctx)).toBe(42);
    expect(resolveIndexPlaceholders(true as any, ctx)).toBe(true);
    expect(resolveIndexPlaceholders('plain-string' as any, ctx)).toBe('plain-string');
  });

  it('handles empty objects and empty arrays without mutation', () => {
    expect(resolveIndexPlaceholders({} as any, ctx)).toEqual({});
    expect(resolveIndexPlaceholders([] as any, ctx)).toEqual([]);
  });
});

