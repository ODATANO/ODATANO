/**
 * `__INPUT_IDX__` PlutusData placeholder helpers: the pure walker, the regex contract
 * and the Buildooor-equivalent input sort.
 */

import {
  INPUT_IDX_REGEX,
  REF_IDX_REGEX,
  WDRL_IDX_REGEX,
  resolveIndexPlaceholders,
  sortInputsLikeBuildooor,
  sortWithdrawalsLikeLedger,
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


describe('__REF_IDX__ and __WDRL_IDX__', () => {
  const KEY = '0a'.repeat(28);
  const SCRIPT_CRED = 'f0'.repeat(28);
  const ctx = {
    sortedInputs: [mkRef(AA_HASH, 0)],
    sortedReferenceInputs: [mkRef(ZERO_HASH, 1), mkRef(BB_HASH, 0)],
    sortedWithdrawals: [SCRIPT_CRED, KEY],
  };

  it('match only their own shape', () => {
    expect(REF_IDX_REGEX.test(`__REF_IDX:${AA_HASH}#3__`)).toBe(true);
    expect(REF_IDX_REGEX.test(`__INPUT_IDX:${AA_HASH}#3__`)).toBe(false);
    expect(WDRL_IDX_REGEX.test(`__WDRL_IDX:${KEY}__`)).toBe(true);
    expect(WDRL_IDX_REGEX.test(`__WDRL_IDX:${AA_HASH}__`)).toBe(false);
  });

  it('resolve to the position in the reference inputs and the withdrawals', () => {
    const tree = { fields: [
      { int: `__REF_IDX:${BB_HASH.toUpperCase()}#0__` },
      { int: `__WDRL_IDX:${KEY}__` },
      { int: `__INPUT_IDX:${AA_HASH}#0__` },
    ] };
    expect(resolveIndexPlaceholders(tree, ctx)).toEqual({ fields: [{ int: 1 }, { int: 1 }, { int: 0 }] });
  });

  it('reject a ref that is not a reference input and a credential without a withdrawal', () => {
    expect(() => resolveIndexPlaceholders({ int: `__REF_IDX:${AA_HASH}#0__` }, ctx)).toThrow(/is not a reference input/);
    expect(() => resolveIndexPlaceholders({ int: `__WDRL_IDX:${'0b'.repeat(28)}__` }, ctx)).toThrow(/has no withdrawal/);
  });

  it('are refused by builds that do not provide those lists', () => {
    const inputsOnly = { sortedInputs: [mkRef(AA_HASH, 0)] };
    expect(() => resolveIndexPlaceholders({ int: `__REF_IDX:${ZERO_HASH}#1__` }, inputsOnly)).toThrow(/BuildPlutusTransaction only/);
    expect(() => resolveIndexPlaceholders({ int: `__WDRL_IDX:${KEY}__` }, inputsOnly)).toThrow(/BuildPlutusTransaction only/);
  });
});

describe('sortWithdrawalsLikeLedger', () => {
  it('puts script credentials before key credentials, each group by hash', () => {
    const sorted = sortWithdrawalsLikeLedger([
      { credentialHash: '01'.repeat(28), isScript: false },
      { credentialHash: 'ff'.repeat(28), isScript: true },
      { credentialHash: '02'.repeat(28), isScript: true },
    ]);
    expect(sorted.map(e => e.credentialHash)).toEqual(['02'.repeat(28), 'ff'.repeat(28), '01'.repeat(28)]);
  });
});
