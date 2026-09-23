/**
 * Secondary indexes (srv/utils/db-indexes.ts): the list answers real lookups,
 * the statements are plain SQL both databases accept, and a failing statement
 * never stops the others.
 */
import { DB_INDEXES, ensureDbIndexes, indexStatement } from '../../srv/utils/db-indexes';

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    db: undefined,
  };
  return { default: cdsMock, ...cdsMock };
});

describe('DB_INDEXES', () => {
  it('names are unique, lower case and prefixed with their table; tables and columns are plain identifiers', () => {
    const names = DB_INDEXES.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    for (const i of DB_INDEXES) {
      expect(i.name).toMatch(/^[a-z0-9_]+$/);
      expect(i.name.startsWith(i.table.toLowerCase())).toBe(true);
      expect(i.table).toMatch(/^odatano_cardano_[A-Za-z]+$/);
      expect(i.columns).toMatch(/^[A-Za-z_]+( DESC)?(, [A-Za-z_]+( DESC)?)*$/);
      if (i.postgres) expect(i.postgres).toMatch(/^[A-Za-z_]+( DESC NULLS LAST)?$/);
    }
  });

  it('covers the lookups that scanned on the box: latest block, metadata by tx, the temporal business keys', () => {
    const by = Object.fromEntries(DB_INDEXES.map((i) => [i.table + ':' + i.columns, i.name]));
    expect(by['odatano_cardano_Blocks:height']).toBeDefined();
    expect(by['odatano_cardano_TransactionMetadata:tx_hash']).toBeDefined();
    expect(by['odatano_cardano_Assets:unit']).toBeDefined();
    expect(by['odatano_cardano_Pools:poolId']).toBeDefined();
    expect(by['odatano_cardano_Accounts:stakeAddress']).toBeDefined();
    expect(by['odatano_cardano_CardanoAgentGrants:tokenHash']).toBeDefined();
  });

  it('renders CREATE INDEX IF NOT EXISTS with unquoted identifiers', () => {
    expect(indexStatement({ name: 'odatano_cardano_blocks_height', table: 'odatano_cardano_Blocks', columns: 'height' }))
      .toBe('CREATE INDEX IF NOT EXISTS odatano_cardano_blocks_height ON odatano_cardano_Blocks (height)');
  });

  it('uses the PostgreSQL spelling (NULLS LAST) only on postgres; SQLite gets the plain DESC', () => {
    const desc = DB_INDEXES.find((i) => i.name === 'odatano_cardano_blocks_height_desc')!;
    expect(indexStatement(desc, 'postgres')).toBe('CREATE INDEX IF NOT EXISTS odatano_cardano_blocks_height_desc ON odatano_cardano_Blocks (height DESC NULLS LAST)');
    expect(indexStatement(desc, 'sqlite')).toBe('CREATE INDEX IF NOT EXISTS odatano_cardano_blocks_height_desc ON odatano_cardano_Blocks (height DESC)');
    expect(indexStatement(desc)).not.toContain('NULLS');
  });
});

describe('ensureDbIndexes', () => {
  it('runs one statement per index and reports the names', async () => {
    const ran: string[] = [];
    const r = await ensureDbIndexes({ run: async (sql: string) => { ran.push(sql); return 0; } });
    expect(r.ensured).toHaveLength(DB_INDEXES.length);
    expect(r.failed).toEqual([]);
    expect(ran[0]).toMatch(/^CREATE INDEX IF NOT EXISTS odatano_cardano_blocks_height ON /);
  });

  it('skips a failing statement and keeps going', async () => {
    const r = await ensureDbIndexes({
      run: async (sql: string) => { if (sql.includes('odatano_cardano_Assets ')) throw new Error('relation does not exist'); return 0; },
    });
    expect(r.failed).toEqual(['odatano_cardano_assets_unit']);
    expect(r.ensured).toHaveLength(DB_INDEXES.length - 1);
  });

  it('runs nothing on HANA (no IF NOT EXISTS there, column store needs none)', async () => {
    const ran: string[] = [];
    const r = await ensureDbIndexes({ kind: 'hana', run: async (sql: string) => { ran.push(sql); return 0; } });
    expect(ran).toEqual([]);
    expect(r).toEqual({ ensured: [], failed: [] });
  });

  it('does nothing without a database service', async () => {
    expect(await ensureDbIndexes(undefined)).toEqual({ ensured: [], failed: [] });
  });
});
