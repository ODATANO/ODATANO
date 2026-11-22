/**
 * The restore of input asset copies names the asset columns in plain SQL. They must be the
 * columns the model gives both asset tables.
 */
import cds from '@sap/cds';
import path from 'path';
import { ASSET_COLUMNS } from '../../srv/blockchain/crawler/input-asset-copies';

describe('asset columns of the copy restore', () => {
  it('are the asset columns of the stored copies and of the output assets', async () => {
    const csn = await cds.load(path.resolve(__dirname, '../../db/schema.cds'));
    const sql = cds.compile.to.sql(csn, { dialect: 'postgres' } as never) as unknown as string[];
    const assetColumnsOf = (table: string) => {
      const ddl = sql.find(s => new RegExp(`^CREATE TABLE ${table} \\(`, 'i').test(s.trim()))!;
      return [...ddl.matchAll(/\b(asset_[A-Za-z]+)\b/g)].map(m => m[1]);
    };

    expect(assetColumnsOf('odatano_cardano_TransactionInputAssetCopies')).toEqual(ASSET_COLUMNS);
    expect(assetColumnsOf('odatano_cardano_TransactionOutputAssets')).toEqual(ASSET_COLUMNS);
  });
});
