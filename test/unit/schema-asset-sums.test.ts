/**
 * Asset sums per address need more room than one output: an output holds at most 2^64-1 of a
 * unit, an address with thousands of such outputs sums past Decimal(20,0). Checked on the
 * PostgreSQL DDL the model compiles to, since SQLite does not enforce the precision.
 */
import cds from '@sap/cds';
import path from 'node:path';

describe('asset quantity columns', () => {
  let ddl: string;
  beforeAll(async () => {
    const csn = await cds.load(path.join(__dirname, '../../db/schema.cds'));
    ddl = ([] as string[]).concat(cds.compile.to.sql(csn, { dialect: 'postgres' } as never) as unknown as string[]).join('\n');
  });

  const column = (table: string, col: string): string | undefined => {
    const create = ddl.split(/CREATE TABLE /).find(t => t.startsWith(`${table} (`));
    return create?.split('\n').find(l => l.trim().startsWith(`${col} `))?.trim();
  };

  it('sums per address take Decimal(38,0)', () => {
    expect(column('odatano_cardano_LedgerAddressAssets', 'asset_quantity')).toMatch(/DECIMAL\(38, 0\)/);
    expect(column('odatano_cardano_AddressAssets', 'asset_quantity')).toMatch(/DECIMAL\(38, 0\)/);
  });

  it('single outputs keep Decimal(20,0)', () => {
    expect(column('odatano_cardano_LedgerUTxOAssets', 'asset_quantity')).toMatch(/DECIMAL\(20, 0\)/);
    expect(column('odatano_cardano_TransactionOutputAssets', 'asset_quantity')).toMatch(/DECIMAL\(20, 0\)/);
  });
});
