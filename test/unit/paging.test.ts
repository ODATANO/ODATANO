/**
 * Shared paging helpers: defaults, stable order, and the window over a provider's newest rows.
 */

import { pageOf, pageRows, byOutRef, sortAssetHistory, latestWindowPage } from '../../srv/utils/paging';

const req = (data: Record<string, unknown>) => ({ data }) as never;

describe('paging', () => {
  it('sets the default limit and skip 0 only when none is given', () => {
    expect(pageOf({}, 10)).toEqual({ limit: 10, skip: 0 });
    expect(pageOf({ limit: 3, skip: 4 }, 10)).toEqual({ limit: 3, skip: 4 });
  });

  it('cuts one page out of an ordered list', () => {
    expect(pageRows([1, 2, 3, 4, 5], { limit: 2, skip: 1 })).toEqual([2, 3]);
    expect(pageRows([1, 2], { limit: 5, skip: 4 })).toEqual([]);
  });

  it('orders UTxOs by hash, then index', () => {
    const rows = [{ hash: 'b', index: 0 }, { hash: 'a', index: 2 }, { hash: 'a', index: 0 }];
    expect(byOutRef(rows)).toEqual([{ hash: 'a', index: 0 }, { hash: 'a', index: 2 }, { hash: 'b', index: 0 }]);
  });

  it('orders asset events newest first with the tx hash as tiebreaker', () => {
    const rows = [
      { txHash: 'a', blockHeight: 10 }, { txHash: 'c', blockHeight: 12 }, { txHash: 'b', blockHeight: 12 },
    ];
    expect(sortAssetHistory(rows).map(r => r.txHash)).toEqual(['c', 'b', 'a']);
    // Koios rows: time only
    expect(sortAssetHistory([{ txHash: 'x', blockTime: 1 }, { txHash: 'y', blockTime: 2 }]).map(r => r.txHash)).toEqual(['y', 'x']);
  });

  it('allows pages inside the newest 100 rows and rejects one that reaches past them', () => {
    expect(latestWindowPage(req({ limit: 50, skip: 50 }), 'Op', 10)).toEqual({ limit: 50, skip: 50 });
    expect(latestWindowPage(req({}), 'Op', 10)).toEqual({ limit: 10, skip: 0 });
    expect(() => latestWindowPage(req({ limit: 50, skip: 51 }), 'Op', 10)).toThrow(expect.objectContaining({ statusCode: 400, target: 'skip' }));
  });
});
