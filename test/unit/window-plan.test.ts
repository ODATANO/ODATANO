/**
 * Planner settings of a slot window walk on PostgreSQL: key lookups by default, an indexed hash
 * join for a statement that matches window rows against a list (the asset slice fill).
 */
export {};

const { runs, state } = vi.hoisted(() => ({ runs: [] as string[], state: { kind: 'postgres' } }));

vi.mock('@sap/cds', () => {
  const tx = { run: vi.fn(async (sql: unknown) => { runs.push(String(sql)); return 0; }) };
  const cdsMock = {
    tx: async (fn: (t: typeof tx) => unknown) => fn(tx),
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    get db() { return { kind: state.kind }; },
    ql: { SELECT: { one: { from: () => ({ columns: () => ({}) }) } } },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/utils/mappers', () => ({ TX_SEQ_SLOT_FACTOR: 65536 }));

import { INDEXED_JOIN, KEY_LOOKUPS_ONLY, walkSlotWindows } from '../../srv/blockchain/crawler/window-plan';

beforeEach(() => { runs.length = 0; state.kind = 'postgres'; });

describe('walkSlotWindows', () => {
  it('finds rows by key in every window unless the walk asks for a join', async () => {
    await walkSlotWindows({ from: 0, to: 199 }, { slotWindow: 100 }, async (tx) => { await tx.run('STEP'); });
    expect(runs).toEqual([KEY_LOOKUPS_ONLY, 'STEP', KEY_LOOKUPS_ONLY, 'STEP']);
  });

  it('lets a join walk use a hash join, still never a scan of the whole table', async () => {
    await walkSlotWindows({ from: 0, to: 99 }, { slotWindow: 100, plan: 'join' }, async (tx) => { await tx.run('STEP'); });
    expect(runs).toEqual([INDEXED_JOIN, 'STEP']);
    expect(INDEXED_JOIN).toContain("'enable_seqscan', 'off'");
    expect(INDEXED_JOIN).not.toContain('enable_hashjoin');
  });

  it('sets nothing on SQLite', async () => {
    state.kind = 'sqlite';
    await walkSlotWindows({ from: 0, to: 99 }, { plan: 'join' }, async (tx) => { await tx.run('STEP'); });
    expect(runs).toEqual(['STEP']);
  });
});
