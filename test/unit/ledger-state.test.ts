/**
 * Crawler-fed ledger state (apply / undo / recount) against a tiny in-memory table store
 * that interprets the module's CQL. Checks the running sums, and that a reorg undo
 * yields the same numbers as a fresh recount.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

const KEYS: Record<string, string[]> = {
  LedgerUTxOs: ['txHash', 'outputIndex'],
  LedgerUTxOAssets: ['utxo_txHash', 'utxo_outputIndex', 'unit'],
  LedgerAddresses: ['address'],
  LedgerAddressAssets: ['address_address', 'unit'],
  LedgerAccounts: ['stakeAddress'],
};
const tables = new Map<string, Row[]>();
const table = (e: string): Row[] => { if (!tables.has(e)) tables.set(e, []); return tables.get(e)!; };
const keyOf = (e: string, r: Row): string => KEYS[e].map(k => String(r[k])).join('|');
const matches = (r: Row, where: Where): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return r[k] == null;
    if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as Row).in as unknown[]).map(String).includes(String(r[k]));
    if (v && typeof v === 'object' && '<=' in (v as Row)) return r[k] != null && Number(r[k]) <= Number((v as Row)['<=']);
    return String(r[k]) === String(v);
  });
};
/** `max(column) as slot` over the matching rows, the one aggregate the undo reads. */
const aggregate = (found: Row[], columns: unknown[] | undefined): Row[] | undefined => {
  const max = (columns ?? []).map(String).map(c => /^max\((\w+)\) as (\w+)$/.exec(c)).find(Boolean);
  if (!max) return undefined;
  const values = found.map(r => r[max[1]]).filter(v => v != null).map(Number);
  return [{ [max[2]]: values.length ? Math.max(...values) : null }];
};

const fakeTx = {
  run: vi.fn(async (q: Row) => {
    const e = q.entity as string;
    switch (q._op) {
      case 'UPSERT': {
        const t = table(e);
        const entries = (Array.isArray(q.entries) ? q.entries : [q.entries]) as Row[];
        for (const entry of entries) {
          const idx = t.findIndex(r => keyOf(e, r) === keyOf(e, entry));
          if (idx >= 0) t[idx] = { ...t[idx], ...entry }; else t.push({ ...entry });
        }
        return entries.length;
      }
      case 'SELECT.many': {
        const found = table(e).filter(r => matches(r, q.where as Where)).map(r => ({ ...r }));
        return typeof q.limit === 'number' ? found.slice(0, q.limit) : found;
      }
      case 'SELECT.one': {
        const found = table(e).filter(r => matches(r, q.where as Where));
        const agg = aggregate(found, q.columns as unknown[] | undefined);
        if (agg) return agg[0];
        return found[0] ? { ...found[0] } : undefined;
      }
      case 'DELETE': { const t = table(e); const keep = t.filter(r => !matches(r, q.where as Where)); const n = t.length - keep.length; tables.set(e, keep); return n; }
      case 'UPDATE': { let n = 0; for (const r of table(e)) if (matches(r, q.where as Where)) { Object.assign(r, q.set); n++; } return n; }
      default: return undefined;
    }
  }),
};

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    tx: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
    ql: {
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      DELETE: { from: (entity: string) => ({ where: (where: unknown) => ({ _op: 'DELETE', entity, where }), _op: 'DELETE', entity }) },
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: (where: unknown) => ({ _op: 'UPDATE', entity, set, where }) }) }) },
      SELECT: {
        one: {
          from: (entity: string) => ({
            where: (where: unknown) => ({ _op: 'SELECT.one', entity, where }),
            columns: (...columns: unknown[]) => ({ where: (where: unknown) => ({ _op: 'SELECT.one', entity, where, columns }) }),
          }),
        },
        from: (entity: string) => ({
          where: (where: unknown) => ({ _op: 'SELECT.many', entity, where }),
          columns: () => ({
            where: (where: unknown) => {
              const q = { _op: 'SELECT.many', entity, where };
              return { ...q, limit: (limit: number) => ({ ...q, limit }) };
            },
          }),
        }),
      },
    },
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  LedgerUTxOs: 'LedgerUTxOs', LedgerUTxOAssets: 'LedgerUTxOAssets',
  LedgerAddresses: 'LedgerAddresses', LedgerAddressAssets: 'LedgerAddressAssets', LedgerAccounts: 'LedgerAccounts',
}));

import { applyBlockToLedger, undoLedgerForTransactions, recountLedgerAddresses, buildLedgerUtxoRows, backfillPaymentCredentials, readLedgerOutputs, ledgerRowAmount } from '../../srv/blockchain/ledger-state';
import type { BlockData, Transaction } from '../../srv/utils/types';
import { computeCip14Fingerprint } from '../../srv/utils/mappers';

// base address (preview) + its reward account; a second base address on the SAME stake key
const ADDR_A = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const STAKE_A = 'stake_test1uzkwsx05zawfcpyj8x53e8q8an3qhal8fpwhe4q5uus6tlq5k9vsh';
const ADDR_E = 'addr_test1vqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxgntxrh0'; // enterprise, no stake
const POLICY = 'c'.repeat(56);
const UNIT = `${POLICY}746f6b656e`;
// payment key hash of ADDR_A and ADDR_E
const PAYMENT = '32b3270fd1561cec0aa24b4aec6850cd0196486033e3dd849945c319';

const block = (slot: number): BlockData => ({
  time: 1700000000 + slot, height: slot / 10, hash: `b${slot}`.padEnd(64, '0'), slot, slotLeader: 'sl',
  epoch: 7, epochSlot: 1, size: 1, txCount: 1, fees: '0',
});
const tx = (hash: string, over: Partial<Transaction> = {}): Transaction => ({
  hash, blockHash: 'b', blockHeight: 1, slot: 1, index: 0, fee: '0', deposit: '0', size: 0, blockTime: 0,
  inputs: [], outputs: [], ...over,
});
const out = (txHash: string, i: number, address: string, lovelace: string, assets: Array<{ unit: string; quantity: string }> = []) => ({
  txHash, outputIndex: i, address, amount: [{ unit: 'lovelace', quantity: lovelace }, ...assets],
  dataHash: null, inlineDatum: null, isCollateral: false,
});
const inp = (txHash: string, outputIndex: number, flags: Partial<{ isCollateral: boolean; isReference: boolean }> = {}) => ({
  txHash, outputIndex, address: '', amount: [], ...flags,
});
const T1 = 't1'.padEnd(64, '0'); const T2 = 't2'.padEnd(64, '0'); const T3 = 't3'.padEnd(64, '0');
const rows = (e: string) => table(e);
const addr = (a: string) => rows('LedgerAddresses').find(r => r.address === a);
const account = (s: string) => rows('LedgerAccounts').find(r => r.stakeAddress === s);
const openUtxos = (a: string) => rows('LedgerUTxOs').filter(r => r.address === a && r.spentTxHash == null);

beforeEach(() => { tables.clear(); fakeTx.run.mockClear(); });

describe('buildLedgerUtxoRows', () => {
  it('derives stake address, type and script flag from the address itself', () => {
    const { row, assets } = buildLedgerUtxoRows(out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }]), 100);
    expect(row).toMatchObject({ txHash: T1, outputIndex: 0, address: ADDR_A, stakeAddress: STAKE_A, addressType: 'base', isScript: false, lovelace: '5000000', createdSlot: 100, spentTxHash: null, hasAssets: true, utxo_paymentCredential: PAYMENT });
    expect(assets).toEqual([{ utxo_txHash: T1, utxo_outputIndex: 0, unit: UNIT, asset_quantity: '3', asset_policyId: POLICY, asset_assetNameHex: '746f6b656e', asset_assetName: 'token', asset_fingerprint: computeCip14Fingerprint(POLICY, '746f6b656e') }]);
    expect(buildLedgerUtxoRows(out(T1, 1, ADDR_E, '1'), null).row).toMatchObject({ stakeAddress: null, addressType: 'enterprise', createdSlot: null, hasAssets: false, utxo_paymentCredential: PAYMENT });
  });
});

describe('applyBlockToLedger', () => {
  it('creates rows for produced outputs and maintains address + account sums', async () => {
    const r = await applyBlockToLedger(fakeTx as never, block(100), [
      tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }]), out(T1, 1, ADDR_E, '2000000')] }),
    ]);
    expect(r).toEqual({ created: 2, spent: 0, missing: 0, addresses: 2 });
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '5000000', utxoCount: 1, stakeAddress: STAKE_A, paymentCredential: PAYMENT, firstSeenSlot: 100, lastActiveSlot: 100 });
    expect(addr(ADDR_E)).toMatchObject({ totalLovelace: '2000000', utxoCount: 1, stakeAddress: null, paymentCredential: PAYMENT });
    expect(rows('LedgerAddressAssets')).toEqual([expect.objectContaining({ address_address: ADDR_A, unit: UNIT, asset_quantity: '3' })]);
    expect(account(STAKE_A)).toMatchObject({ controlledAmount: '5000000', addressCount: 1, utxoCount: 1 });
    expect(rows('LedgerAccounts')).toHaveLength(1); // the enterprise address has no stake key
  });

  it('closes consumed rows from earlier blocks and subtracts them from the sums', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }])] })]);
    const r = await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T1, 0)], outputs: [out(T2, 0, ADDR_E, '4800000', [{ unit: UNIT, quantity: '3' }])] }),
    ]);
    expect(r).toEqual({ created: 1, spent: 1, missing: 0, addresses: 2 });
    const spent = rows('LedgerUTxOs').find(u => u.txHash === T1)!;
    expect(spent).toMatchObject({ spentTxHash: T2, spentSlot: 110 });
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '0', utxoCount: 0, lastActiveSlot: 110, firstSeenSlot: 100 });
    expect(rows('LedgerAddressAssets').filter(a => a.address_address === ADDR_A)).toHaveLength(0); // zero rows are removed
    expect(rows('LedgerAddressAssets').find(a => a.address_address === ADDR_E)).toMatchObject({ asset_quantity: '3' });
    expect(account(STAKE_A)).toMatchObject({ controlledAmount: '0', utxoCount: 0, addressCount: 1 });
  });

  it('handles an output created and spent in the same block without a DB read', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [
      tx(T1, { outputs: [out(T1, 0, ADDR_A, '1000000')] }),
      tx(T2, { inputs: [inp(T1, 0)], outputs: [out(T2, 0, ADDR_E, '900000')] }),
    ]);
    expect(rows('LedgerUTxOs').find(u => u.txHash === T1)).toMatchObject({ spentTxHash: T2 });
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '0', utxoCount: 0 });
    expect(addr(ADDR_E)).toMatchObject({ totalLovelace: '900000', utxoCount: 1 });
  });

  it('ignores reference inputs and, on a successful tx, declared collateral', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '1000000'), out(T1, 1, ADDR_A, '7000000')] })]);
    await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T1, 0, { isReference: true }), inp(T1, 1, { isCollateral: true })], outputs: [] }),
    ]);
    expect(openUtxos(ADDR_A)).toHaveLength(2);
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '8000000', utxoCount: 2 });
  });

  it('on a phase-2 failure consumes the collateral and produces only the collateral return', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '1000000'), out(T1, 1, ADDR_A, '7000000')] })]);
    await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, {
        spendsCollaterals: true,
        inputs: [inp(T1, 0), inp(T1, 1, { isCollateral: true })],
        outputs: [out(T2, 0, ADDR_E, '999'), { ...out(T2, 1, ADDR_A, '6000000'), isCollateral: true }],
      }),
    ]);
    expect(rows('LedgerUTxOs').find(u => u.txHash === T1 && u.outputIndex === 0)).toMatchObject({ spentTxHash: null }); // regular input NOT consumed
    expect(rows('LedgerUTxOs').find(u => u.txHash === T1 && u.outputIndex === 1)).toMatchObject({ spentTxHash: T2 });
    expect(rows('LedgerUTxOs').find(u => u.txHash === T2 && u.outputIndex === 0)).toBeUndefined(); // regular output never produced
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '7000000', utxoCount: 2 }); // 1000000 + 6000000 return
  });

  it('counts a consumed outpoint with no open row as missing and keeps going', async () => {
    const r = await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T3, 0)], outputs: [out(T2, 0, ADDR_E, '1')] }),
    ]);
    expect(r).toMatchObject({ missing: 1, created: 1, spent: 0 });
    expect(addr(ADDR_E)).toMatchObject({ totalLovelace: '1' });
  });
});

describe('readLedgerOutputs (shared lookup)', () => {
  const selects = (e: string) => fakeTx.run.mock.calls.filter(([q]) => q._op === 'SELECT.many' && q.entity === e);

  it('skips the asset SELECT when no row of the source transactions carries assets', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000')] })]);
    fakeTx.run.mockClear();

    const lookup = await readLedgerOutputs(fakeTx as never, [T1]);

    expect(lookup.rows.get(`${T1}#0`)).toMatchObject({ address: ADDR_A });
    expect(selects('LedgerUTxOs')).toHaveLength(1);
    expect(selects('LedgerUTxOAssets')).toHaveLength(0);
  });

  it('lets the apply reuse a lookup: the consumed outpoints are not read again', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }])] })]);
    const lookup = await readLedgerOutputs(fakeTx as never, [T1]);
    expect(ledgerRowAmount(lookup.rows.get(`${T1}#0`)!, lookup.assets.get(`${T1}#0`)))
      .toEqual([{ unit: 'lovelace', quantity: '5000000' }, { unit: UNIT, quantity: '3' }]);
    fakeTx.run.mockClear();

    const r = await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T1, 0)], outputs: [out(T2, 0, ADDR_E, '4800000', [{ unit: UNIT, quantity: '3' }])] }),
    ], lookup);

    expect(r).toEqual({ created: 1, spent: 1, missing: 0, addresses: 2 });
    expect(selects('LedgerUTxOs')).toHaveLength(0);
    expect(selects('LedgerUTxOAssets')).toHaveLength(0);
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '0', utxoCount: 0 });
  });
});

describe('undoLedgerForTransactions (reorg)', () => {
  it('drops what the rolled-back txs created, reopens what they spent, and takes their sums back', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }])] })]);
    const before = { a: { ...addr(ADDR_A)! }, acc: { ...account(STAKE_A)! }, assets: rows('LedgerAddressAssets').map(r => ({ ...r })) };
    await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T1, 0)], outputs: [out(T2, 0, ADDR_E, '4800000', [{ unit: UNIT, quantity: '3' }])] }),
    ]);

    const touched = await undoLedgerForTransactions(fakeTx as never, [T2], 100);

    expect(touched.sort()).toEqual([ADDR_A, ADDR_E].sort());
    expect(rows('LedgerUTxOs').find(u => u.txHash === T2)).toBeUndefined();
    expect(rows('LedgerUTxOAssets').find(u => u.utxo_txHash === T2)).toBeUndefined();
    expect(rows('LedgerUTxOs').find(u => u.txHash === T1)).toMatchObject({ spentTxHash: null, spentSlot: null });
    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: before.a.totalLovelace, utxoCount: before.a.utxoCount, stakeAddress: STAKE_A, lastActiveSlot: 100 });
    // ADDR_E first appeared in the rolled-back block, so it is gone
    expect(addr(ADDR_E)).toBeUndefined();
    expect(rows('LedgerAddressAssets').filter(r => r.address_address === ADDR_A)).toEqual([expect.objectContaining({ unit: UNIT, asset_quantity: '3' })]);
    expect(rows('LedgerAddressAssets').filter(r => r.address_address === ADDR_E)).toHaveLength(0);
    expect(account(STAKE_A)).toMatchObject({ controlledAmount: before.acc.controlledAmount, utxoCount: before.acc.utxoCount });
  });

  it('is a no-op for an empty set', async () => {
    expect(await undoLedgerForTransactions(fakeTx as never, [], 0)).toEqual([]);
    expect(fakeTx.run).not.toHaveBeenCalled();
  });

  it('gives the same sums as a recount, and reads no address beyond the touched rows', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [
      out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }]), out(T1, 1, ADDR_A, '1000000'), out(T1, 2, ADDR_E, '700'),
    ] })]);
    // the rolled-back blocks: one spends an old output, the next spends an output of the first
    await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T1, 0)], outputs: [out(T2, 0, ADDR_A, '4000000', [{ unit: UNIT, quantity: '1' }]), out(T2, 1, ADDR_E, '900000', [{ unit: UNIT, quantity: '2' }])] }),
    ]);
    await applyBlockToLedger(fakeTx as never, block(120), [
      tx(T3, { inputs: [inp(T2, 0), inp(T1, 1)], outputs: [out(T3, 0, ADDR_E, '4900000', [{ unit: UNIT, quantity: '1' }])] }),
    ]);
    fakeTx.run.mockClear();

    await undoLedgerForTransactions(fakeTx as never, [T2, T3], 100);

    // no read of all open rows of an address (that is the recount)
    const openReads = fakeTx.run.mock.calls.filter(([q]) => q._op === 'SELECT.many' && q.entity === 'LedgerUTxOs'
      && (q.where as Row | undefined)?.address !== undefined);
    expect(openReads).toHaveLength(0);
    const undone = { a: { ...addr(ADDR_A)! }, e: { ...addr(ADDR_E)! }, acc: { ...account(STAKE_A)! }, assets: rows('LedgerAddressAssets').map(r => ({ ...r })) };

    await recountLedgerAddresses(fakeTx as never, [ADDR_A, ADDR_E]);
    expect(undone.a).toMatchObject({ totalLovelace: addr(ADDR_A)!.totalLovelace, utxoCount: addr(ADDR_A)!.utxoCount, lastActiveSlot: 100 });
    expect(undone.e).toMatchObject({ totalLovelace: addr(ADDR_E)!.totalLovelace, utxoCount: addr(ADDR_E)!.utxoCount });
    expect(undone.acc).toMatchObject({ controlledAmount: account(STAKE_A)!.controlledAmount, utxoCount: account(STAKE_A)!.utxoCount });
    expect(undone.a).toMatchObject({ totalLovelace: '6000000', utxoCount: 2 });
    expect(undone.assets.map(r => [r.address_address, r.asset_quantity]).sort()).toEqual([[ADDR_A, '3']]);
  });

  // More than one chunk of 500: the creator of an output and its spender land in different chunks.
  it.each([['spender first', true], ['creator first', false]])('matches a recount when creator and spender sit in different chunks (%s)', async (_label, spenderFirst) => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000', [{ unit: UNIT, quantity: '3' }]), out(T1, 1, ADDR_A, '1000000')] })]);
    await applyBlockToLedger(fakeTx as never, block(110), [
      tx(T2, { inputs: [inp(T1, 0)], outputs: [out(T2, 0, ADDR_A, '4000000', [{ unit: UNIT, quantity: '3' }])] }),
    ]);
    const fillers = Array.from({ length: 600 }, (_, i) => i.toString(16).padStart(4, '0').padEnd(64, 'c'));
    await applyBlockToLedger(fakeTx as never, block(115), fillers.map((h, i) => tx(h, { index: i, outputs: [out(h, 0, ADDR_A, '1')] })));
    await applyBlockToLedger(fakeTx as never, block(120), [
      tx(T3, { inputs: [inp(T2, 0)], outputs: [out(T3, 0, ADDR_A, '3900000', [{ unit: UNIT, quantity: '3' }])] }),
    ]);

    const order = spenderFirst ? [T3, ...fillers, T2] : [T2, ...fillers, T3];
    await undoLedgerForTransactions(fakeTx as never, order, 100);
    const undone = { a: { ...addr(ADDR_A)! }, acc: { ...account(STAKE_A)! }, assets: rows('LedgerAddressAssets').map(r => ({ ...r })) };

    await recountLedgerAddresses(fakeTx as never, [ADDR_A]);
    expect(undone.a).toMatchObject({ totalLovelace: '6000000', utxoCount: 2 });
    expect(undone.a).toMatchObject({ totalLovelace: addr(ADDR_A)!.totalLovelace, utxoCount: addr(ADDR_A)!.utxoCount });
    expect(undone.acc).toMatchObject({ controlledAmount: account(STAKE_A)!.controlledAmount, utxoCount: account(STAKE_A)!.utxoCount });
    expect(undone.assets.map(r => [r.address_address, r.asset_quantity])).toEqual([[ADDR_A, '3']]);
  });
});

describe('recountLedgerAddresses (repair path)', () => {
  it('rebuilds a drifted sum from the open rows', async () => {
    await applyBlockToLedger(fakeTx as never, block(100), [tx(T1, { outputs: [out(T1, 0, ADDR_A, '5000000'), out(T1, 1, ADDR_A, '1')] })]);
    addr(ADDR_A)!.totalLovelace = '999'; addr(ADDR_A)!.utxoCount = 42; account(STAKE_A)!.controlledAmount = '1';

    await recountLedgerAddresses(fakeTx as never, [ADDR_A]);

    expect(addr(ADDR_A)).toMatchObject({ totalLovelace: '5000001', utxoCount: 2, firstSeenSlot: 100 });
    expect(account(STAKE_A)).toMatchObject({ controlledAmount: '5000001', addressCount: 1, utxoCount: 2 });
  });
});

describe('backfillPaymentCredentials', () => {
  it('fills the credential of Shelley payment addresses in chunks and leaves the rest alone', async () => {
    table('LedgerAddresses').push(
      { address: ADDR_A, addressType: 'base', paymentCredential: null },
      { address: ADDR_E, addressType: 'enterprise', paymentCredential: null },
      { address: 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi', addressType: 'byron', paymentCredential: null },
      { address: STAKE_A, addressType: 'reward', paymentCredential: null },
    );

    expect(await backfillPaymentCredentials(1)).toBe(2);

    expect(addr(ADDR_A)?.paymentCredential).toBe(PAYMENT);
    expect(addr(ADDR_E)?.paymentCredential).toBe(PAYMENT);
    expect(rows('LedgerAddresses').filter(r => r.paymentCredential == null)).toHaveLength(2);
    // idempotent: nothing left to fill
    expect(await backfillPaymentCredentials(1)).toBe(0);
  });
});
