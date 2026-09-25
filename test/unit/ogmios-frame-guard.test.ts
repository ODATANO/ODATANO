/**
 * The guard around the Ogmios client's JSON parser: a chain-sync frame nested deeper than
 * the recursive parser can handle must still be delivered, must keep integers that a double
 * cannot hold, and must never throw — a throw in that socket handler ends the process.
 */
vi.mock('@sap/cds', () => {
  const cdsMock = { log: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) };
  return { default: cdsMock, ...cdsMock };
});

import { safeJSON } from '@cardano-ogmios/client';
import {
  installOgmiosFrameGuard,
  resetOgmiosFrameGuardForTests,
  widenBigIntegers,
  type UnparseableFrame,
} from '../../srv/blockchain/backends/ogmios-frame-guard';

const pristineParse = safeJSON.parse.bind(safeJSON);

/** A nextBlock frame whose block carries a native script nested `depth` levels deep. */
function deepFrame(depth: number, extra = ''): string {
  const script = '{"clause":"all","from":['.repeat(depth)
    + '{"clause":"signature","from":"ba386209c0f81f9570b6feb45cedc2649144440157677c720bfd314a"}'
    + ']}'.repeat(depth);
  return '{"jsonrpc":"2.0","method":"nextBlock","result":{"direction":"forward",'
    + '"block":{"type":"praos","era":"conway","id":"' + 'b'.repeat(64) + '","height":5183974,'
    + '"slot":133883400' + extra + ',"script":' + script + '},'
    + '"tip":{"slot":134292084,"id":"' + 'c'.repeat(64) + '"}}}';
}

let reported: UnparseableFrame[];

beforeEach(() => {
  resetOgmiosFrameGuardForTests(pristineParse);
  reported = [];
  installOgmiosFrameGuard((f) => { reported.push(f); });
});

afterEach(() => resetOgmiosFrameGuardForTests(pristineParse));

describe('widenBigIntegers', () => {
  it('quotes only integers a double cannot hold exactly', () => {
    const out = widenBigIntegers('{"a":45000000000000000,"b":170000,"c":9007199254740991}');
    expect(out).toBe('{"a":"45000000000000000","b":170000,"c":9007199254740991}');
  });

  it('leaves digits inside strings alone', () => {
    // a 64-character id of nothing but digits is legal JSON and must not become a number
    const id = '1'.repeat(64);
    const text = `{"id":"${id}","lovelace":45000000000000000}`;
    expect(widenBigIntegers(text)).toBe(`{"id":"${id}","lovelace":"45000000000000000"}`);
  });

  it('leaves floats and exponents alone — they were never exact integers', () => {
    const text = '{"a":1.00000000000000009,"b":1e300,"c":-45000000000000000}';
    expect(widenBigIntegers(text)).toBe('{"a":1.00000000000000009,"b":1e300,"c":"-45000000000000000"}');
  });

  it('returns the very same string when nothing needs widening', () => {
    const text = '{"height":5183974,"slot":133883400}';
    expect(widenBigIntegers(text)).toBe(text);
  });

  it('survives a payload deeper than any recursive parser', () => {
    // the function itself must not recurse — that is the whole point
    expect(() => widenBigIntegers(deepFrame(20000))).not.toThrow();
  });
});

describe('installOgmiosFrameGuard', () => {
  it('leaves an ordinary frame to the client parser, BigInts included', () => {
    const parsed = safeJSON.parse(
      '{"result":{"block":{"height":42},"value":{"ada":{"lovelace":45000000000000000}}}}'
    ) as { result: { block: { height: number }; value: { ada: { lovelace: bigint } } } };

    expect(parsed.result.block.height).toBe(42);
    expect(parsed.result.value.ada.lovelace).toBe(45000000000000000n);
    expect(reported).toHaveLength(0);
  });

  it('still delivers a frame nested far beyond the parser limit', () => {
    const frame = deepFrame(12000);
    // the untouched client parser overflows on this frame
    expect(() => pristineParse(frame as never)).toThrow(RangeError);

    const parsed = safeJSON.parse(frame) as { result: { block: { height: number; slot: number } } };
    expect(parsed.result.block.height).toBe(5183974);
    expect(parsed.result.block.slot).toBe(133883400);
    expect(reported).toHaveLength(0);
  });

  it('keeps an unsafe integer exact on the deep path, as a string', () => {
    const parsed = safeJSON.parse(deepFrame(12000, ',"fee":{"ada":{"lovelace":45000000000000001}}')) as {
      result: { block: { fee: { ada: { lovelace: unknown } } } };
    };
    const lovelace = parsed.result.block.fee.ada.lovelace;
    // a plain JSON.parse would have rounded this to …000; the mapper stringifies it either way
    expect(lovelace).toBe('45000000000000001');
    expect(String(lovelace)).toBe('45000000000000001');
  });

  it('reports an unusable frame instead of throwing, naming the block', () => {
    // deep enough for the client parser to give up, then truncated so nothing can parse it
    const broken = deepFrame(12000).slice(0, -50);

    const out = safeJSON.parse(broken);

    expect(out).toEqual({}); // a throw here would take the process down with it
    expect(reported).toHaveLength(1);
    expect(reported[0].height).toBe(5183974);
    expect(reported[0].id).toBe('b'.repeat(64));
    expect(reported[0].bytes).toBe(broken.length);
  });

  it('lets a genuine syntax error through untouched', () => {
    // json-bigint throws its own object rather than a SyntaxError instance, so match the name
    let thrown: unknown;
    try { safeJSON.parse('{"a":'); } catch (e) { thrown = e; }

    expect((thrown as { name?: string })?.name).toBe('SyntaxError');
    expect(reported).toHaveLength(0); // only an overflow is the guard's business
  });

  it('installs once — a second stream adds its callback, it does not stack wrappers', () => {
    const wrapped = safeJSON.parse;
    const second: UnparseableFrame[] = [];
    installOgmiosFrameGuard((f) => { second.push(f); });

    expect(safeJSON.parse).toBe(wrapped);
    safeJSON.parse(deepFrame(12000).slice(0, -50));
    expect(second).toHaveLength(1);
    expect(reported).toHaveLength(1); // the first stream still gets the report
  });

  it('stops reporting to a callback once it is unregistered', () => {
    const second: UnparseableFrame[] = [];
    const unregister = installOgmiosFrameGuard((f) => { second.push(f); });
    unregister();

    safeJSON.parse(deepFrame(12000).slice(0, -50));
    expect(second).toHaveLength(0);
    expect(reported).toHaveLength(1);
  });

  it('keeps reporting to the others when one callback throws', () => {
    installOgmiosFrameGuard(() => { throw new Error('boom'); });
    const third: UnparseableFrame[] = [];
    installOgmiosFrameGuard((f) => { third.push(f); });

    expect(() => safeJSON.parse(deepFrame(12000).slice(0, -50))).not.toThrow();
    expect(reported).toHaveLength(1);
    expect(third).toHaveLength(1);
  });
});
