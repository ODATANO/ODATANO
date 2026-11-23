/**
 * Asset slice backfill against the real model on an in-memory SQLite: every stored asset row ends
 * with the columns assetSlice derives from its unit, and a second run changes nothing.
 */
import cds from '@sap/cds';
import path from 'path';
import { backfillAssetSlices, sliceFillStatement, ASSET_SLICE_TABLES } from '../../srv/blockchain/crawler/asset-slice-backfill';
import { assetSlice } from '../../srv/utils/mappers';

const { SELECT, INSERT, DELETE } = cds.ql;
const NS = 'odatano.cardano';
const F = 65536;
const POLICY = 'c'.repeat(56);
const UTF8 = POLICY + Buffer.from('Ünïcode', 'utf8').toString('hex');
const BINARY = POLICY + 'ff00';
const NAMELESS = POLICY;

beforeAll(async () => {
  const csn = await cds.load(path.resolve(__dirname, '../../db'));
  cds.model = cds.compile.for.nodejs(csn) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  // cds.deploy is not part of the published typings
  await (cds as unknown as { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } }).deploy(csn).to(db);
});

beforeEach(async () => {
  for (const entity of ['TransactionOutputAssets', 'TransactionOutputs', 'TransactionInputAssetCopies', 'TransactionInputs', 'LedgerUTxOAssets', 'LedgerAddressAssets', 'UTxOAssets', 'AddressAssets']) {
    await cds.run(DELETE.from(`${NS}.${entity}`));
  }
  // rows in the forms older writers left: no hex name, no fingerprint, the name decoded another way
  await cds.run(INSERT.into(`${NS}.TransactionOutputs`).entries([{ txSeq: 10 * F, outputIndex: 0 }, { txSeq: 30_000 * F, outputIndex: 0 }]));
  await cds.run(INSERT.into(`${NS}.TransactionOutputAssets`).entries([
    { output_txSeq: 10 * F, output_outputIndex: 0, unit: UTF8, asset_quantity: '1', asset_policyId: POLICY, asset_assetName: null },
    { output_txSeq: 30_000 * F, output_outputIndex: 0, unit: BINARY, asset_quantity: '2', asset_policyId: POLICY, asset_assetName: 'ff00' },
  ]));
  await cds.run(INSERT.into(`${NS}.TransactionInputs`).entries([{ txSeq: 20 * F, inputIndex: 0 }]));
  await cds.run(INSERT.into(`${NS}.TransactionInputAssetCopies`).entries([
    { input_txSeq: 20 * F, input_inputIndex: 0, unit: UTF8, asset_quantity: '1', asset_policyId: POLICY, asset_assetName: null },
  ]));
  await cds.run(INSERT.into(`${NS}.LedgerUTxOAssets`).entries([
    { utxo_txHash: 'a'.repeat(64), utxo_outputIndex: 0, unit: UTF8, asset_quantity: '1', asset_policyId: POLICY, asset_assetNameHex: UTF8.slice(56), asset_assetName: null },
  ]));
  await cds.run(INSERT.into(`${NS}.LedgerAddressAssets`).entries([
    { address_address: 'addr_test1a', unit: BINARY, asset_quantity: '2', asset_policyId: POLICY, asset_assetNameHex: 'ff00', asset_assetName: null },
  ]));
  // cached tables: two slices of one row, both in an old form, and a second address
  await cds.run(INSERT.into(`${NS}.AddressAssets`).entries([
    { validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-01-02T00:00:00.000Z', address_address: 'addr_test1a', unit: UTF8, asset_quantity: '1', asset_policyId: POLICY, asset_assetName: '' },
    { validFrom: '2026-02-01T00:00:00.000Z', validTo: '2026-02-02T00:00:00.000Z', address_address: 'addr_test1a', unit: UTF8, asset_quantity: '1', asset_policyId: POLICY, asset_assetName: '' },
    { validFrom: '2026-02-01T00:00:00.000Z', validTo: '2026-02-02T00:00:00.000Z', address_address: 'addr_test1b', unit: NAMELESS, asset_quantity: '3', asset_policyId: POLICY, asset_assetName: '' },
  ]));
  await cds.run(INSERT.into(`${NS}.UTxOAssets`).entries([
    { validFrom: '2026-02-01T00:00:00.000Z', validTo: '2026-02-02T00:00:00.000Z', utxo_validFrom: '2026-02-01T00:00:00.000Z', utxo_address_address: 'addr_test1a', utxo_hash: 'b'.repeat(64), utxo_index: 0, unit: BINARY, asset_quantity: '2', asset_policyId: POLICY, asset_assetName: 'ff00' },
  ]));
});

const sliceOf = (row: Record<string, unknown>) => ({
  asset_policyId: row.asset_policyId, asset_assetNameHex: row.asset_assetNameHex,
  asset_assetName: row.asset_assetName, asset_fingerprint: row.asset_fingerprint,
});
const expected = (unit: string) => {
  const s = assetSlice(unit, 0);
  return { asset_policyId: s.asset_policyId, asset_assetNameHex: s.asset_assetNameHex, asset_assetName: s.asset_assetName, asset_fingerprint: s.asset_fingerprint };
};

describe('backfillAssetSlices', () => {
  it('brings every stored asset row to the columns assetSlice derives from its unit', async () => {
    const progress = await backfillAssetSlices({ slotWindow: 1000, chunkSize: 1 });

    expect(progress).toEqual({ table: null, outputs: 2, inputs: 1, ledgerUtxos: 1, ledgerAddresses: 1, utxoSlices: 1, addressSlices: 3 });
    for (const entity of ['TransactionOutputAssets', 'TransactionInputAssetCopies', 'LedgerUTxOAssets', 'LedgerAddressAssets', 'UTxOAssets', 'AddressAssets']) {
      const rows = await cds.run(SELECT.from(`${NS}.${entity}`)) as Array<Record<string, unknown>>;
      for (const row of rows) expect(sliceOf(row)).toEqual(expected(String(row.unit)));
    }
    const [utf8] = await cds.run(SELECT.from(`${NS}.TransactionOutputAssets`).where({ unit: UTF8 })) as Array<Record<string, unknown>>;
    expect(utf8.asset_assetName).toBe('Ünïcode');
    const [nameless] = await cds.run(SELECT.from(`${NS}.AddressAssets`).where({ unit: NAMELESS })) as Array<Record<string, unknown>>;
    expect(nameless.asset_assetName).toBeNull();
  });

  it('changes nothing on a second run', async () => {
    await backfillAssetSlices();
    expect(await backfillAssetSlices()).toEqual({ table: null, outputs: 0, inputs: 0, ledgerUtxos: 0, ledgerAddresses: 0, utxoSlices: 0, addressSlices: 0 });
  });

  it('stops before the next window when asked to', async () => {
    const progress = await backfillAssetSlices({ shouldStop: () => true });
    expect(progress.table).toBe('TransactionOutputAssets');
    expect(progress.outputs).toBe(0);
  });
});

describe('the window walk of the transaction tables', () => {
  it('asks for an indexed hash join: key lookups take about 100 times longer for this fill on PostgreSQL', async () => {
    const plan = await import('../../srv/blockchain/crawler/window-plan');
    const walk = vi.spyOn(plan, 'walkSlotWindows');
    await backfillAssetSlices({ slotWindow: 1_000_000 });
    expect(walk.mock.calls.length).toBeGreaterThan(0);
    for (const [, opts] of walk.mock.calls) expect(opts).toMatchObject({ plan: 'join' });
    walk.mockRestore();
  });
});

describe('sliceFillStatement', () => {
  it('joins the units of a JSON array, touches only rows that differ and keeps to the window', () => {
    const outputs = ASSET_SLICE_TABLES[0];
    const pg = sliceFillStatement('postgres', outputs, [65536, 131072]);
    expect(pg).toContain('json_to_recordset($1::json)');
    expect(pg).toContain('t.output_txSeq >= 65536 AND t.output_txSeq < 131072');
    expect(pg).toContain('t.asset_fingerprint IS DISTINCT FROM v.asset_fingerprint');
    expect(sliceFillStatement('sqlite', ASSET_SLICE_TABLES[2])).toContain('json_each(?)');
  });

  it('matches a cached table on address and unit, so every slice of the row is set', () => {
    const cached = ASSET_SLICE_TABLES.find((t) => t.name === 'AddressAssets')!;
    expect(sliceFillStatement('postgres', cached)).toContain('t.address_address = v.address_address AND t.unit = v.unit');
  });
});
