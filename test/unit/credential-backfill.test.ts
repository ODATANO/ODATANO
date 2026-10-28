/**
 * Payment-credential backfill (srv/blockchain/crawler/credential-backfill.ts) against a tiny
 * in-memory store that interprets the module's CQL: every table is walked once in key order,
 * only rows without a credential are written, a second run writes nothing.
 */

type Row = Record<string, unknown>;

const tables = new Map<string, Row[]>();
const table = (e: string): Row[] => { if (!tables.has(e)) tables.set(e, []); return tables.get(e)!; };
const cmp = (a: unknown, b: unknown): number => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1);
const matches = (r: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v === null) return r[k] == null;
    if (v && typeof v === 'object' && '>' in (v as Row)) return cmp(r[k], (v as Row)['>']) > 0;
    return r[k] === v;
  });

const updates: Array<{ entity: string; set: Row; where: Row }> = [];
const fakeTx = {
  run: vi.fn(async (q: Row) => {
    const e = q.entity as string;
    if (q._op === 'SELECT') {
      const order = q.orderBy as string[];
      const found = table(e).filter(r => matches(r, q.where as Row))
        .sort((a, b) => cmp(a[order[0]], b[order[0]]) || cmp(a[order[1]], b[order[1]]))
        .map(r => ({ ...r }));
      return found.slice(0, q.limit as number);
    }
    if (q._op === 'UPDATE') {
      updates.push({ entity: e, set: q.set as Row, where: q.where as Row });
      let n = 0;
      for (const r of table(e)) if (matches(r, q.where as Row)) { Object.assign(r, q.set); n++; }
      return n;
    }
    return undefined;
  }),
};

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    tx: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
    db: undefined,
    ql: {
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: (where: unknown) => ({ _op: 'UPDATE', entity, set, where }) }) }) },
      SELECT: {
        from: (entity: string) => ({
          columns: () => ({
            where: (where: unknown) => ({
              orderBy: (...orderBy: string[]) => ({
                limit: (limit: number) => ({ _op: 'SELECT', entity, where, orderBy, limit }),
              }),
            }),
          }),
        }),
      },
    },
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({
  TransactionOutputs: 'TransactionOutputs', TransactionInputs: 'TransactionInputs', LedgerUTxOs: 'LedgerUTxOs',
}));

import { backfillUtxoCredentials, credentialFillStatement, CREDENTIAL_TABLES } from '../../srv/blockchain/crawler/credential-backfill';

const BASE = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const ENTERPRISE = 'addr_test1vqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxgntxrh0';
const BYRON = 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi';
const PAYMENT = '32b3270fd1561cec0aa24b4aec6850cd0196486033e3dd849945c319';

const out = (txSeq: number, outputIndex: number, address: string | null, utxo_paymentCredential: string | null = null): Row =>
  ({ txSeq, outputIndex, address_address: address, utxo_paymentCredential });

beforeEach(() => { tables.clear(); updates.length = 0; fakeTx.run.mockClear(); });

describe('backfillUtxoCredentials', () => {
  it('fills every table once in key order, skips rows with a credential, Byron and unresolved addresses', async () => {
    tables.set('TransactionOutputs', [
      out(2, 0, ENTERPRISE), out(1, 1, BYRON), out(1, 0, BASE), out(3, 0, BASE, 'already'), out(4, 0, null),
    ]);
    tables.set('TransactionInputs', [{ txSeq: 9, inputIndex: 0, address_address: '', utxoData_paymentCredential: null }, { txSeq: 9, inputIndex: 1, address_address: BASE, utxoData_paymentCredential: null }]);
    tables.set('LedgerUTxOs', [{ txHash: 'b'.repeat(64), outputIndex: 0, address: ENTERPRISE, utxo_paymentCredential: null }, { txHash: 'a'.repeat(64), outputIndex: 1, address: BASE, utxo_paymentCredential: null }]);
    const seen: unknown[] = [];

    const r = await backfillUtxoCredentials({ chunkSize: 2, onProgress: (p) => seen.push(p) });

    expect(r).toEqual({ table: null, outputs: 2, inputs: 1, ledgerUtxos: 2 });
    expect(table('TransactionOutputs').map(x => [x.txSeq, x.outputIndex, x.utxo_paymentCredential])).toEqual([
      [2, 0, PAYMENT], [1, 1, null], [1, 0, PAYMENT], [3, 0, 'already'], [4, 0, null],
    ]);
    expect(table('TransactionInputs').map(x => x.utxoData_paymentCredential)).toEqual([null, PAYMENT]);
    expect(table('LedgerUTxOs').map(x => x.utxo_paymentCredential)).toEqual([PAYMENT, PAYMENT]);
    // walked in key order: txSeq 1 before 2; LedgerUTxOs by txHash
    expect(updates.filter(u => u.entity === 'TransactionOutputs').map(u => u.where.txSeq)).toEqual([1, 2]);
    expect(updates.filter(u => u.entity === 'LedgerUTxOs').map(u => u.where.txHash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    // only rows still without a credential are written
    expect(updates[0].where).toEqual({ txSeq: 1, outputIndex: 0, utxo_paymentCredential: null });
    expect(seen[0]).toEqual({ table: 'TransactionOutputs', outputs: 0, inputs: 0, ledgerUtxos: 0 });
    expect(seen.at(-1)).toEqual({ table: 'LedgerUTxOs', outputs: 2, inputs: 1, ledgerUtxos: 2 });

    updates.length = 0;
    expect(await backfillUtxoCredentials({ chunkSize: 2 })).toEqual({ table: null, outputs: 0, inputs: 0, ledgerUtxos: 0 });
    expect(updates).toEqual([]);
  });

  it('never loses the rows of a key that spans a batch boundary', async () => {
    // txSeq 1 has three outputs, the chunk holds two: the key is walked by its second key
    tables.set('TransactionOutputs', [out(1, 0, BASE), out(1, 1, BASE), out(1, 2, ENTERPRISE), out(2, 0, BASE), out(2, 1, BYRON), out(3, 0, BASE)]);

    const r = await backfillUtxoCredentials({ chunkSize: 2 });

    expect(r.outputs).toBe(5);
    expect(table('TransactionOutputs').map(x => x.utxo_paymentCredential)).toEqual([PAYMENT, PAYMENT, PAYMENT, PAYMENT, null, PAYMENT]);
  });
});

describe('credentialFillStatement', () => {
  const outputs = CREDENTIAL_TABLES[0];
  const ledger = CREDENTIAL_TABLES[2];

  it('joins the JSON fills on the key and touches only rows without a credential (Postgres, SQLite)', () => {
    expect(credentialFillStatement('postgres', outputs)).toBe(
      'UPDATE odatano_cardano_TransactionOutputs AS t SET utxo_paymentCredential = v.credential ' +
      'FROM json_to_recordset($1::json) AS v(txseq bigint, outputindex integer, credential text) ' +
      'WHERE t.txSeq = v.txseq AND t.outputIndex = v.outputindex AND t.utxo_paymentCredential IS NULL'
    );
    expect(credentialFillStatement('postgres', ledger)).toContain('v(txhash text, outputindex integer, credential text)');
    expect(credentialFillStatement('sqlite', outputs)).toBe(
      'UPDATE odatano_cardano_TransactionOutputs AS t SET utxo_paymentCredential = v.credential FROM (SELECT ' +
      "json_extract(value, '$.txseq') AS txSeq, json_extract(value, '$.outputindex') AS outputIndex, json_extract(value, '$.credential') AS credential " +
      'FROM json_each(?)) AS v WHERE t.txSeq = v.txSeq AND t.outputIndex = v.outputIndex AND t.utxo_paymentCredential IS NULL'
    );
    expect(credentialFillStatement('hana', outputs)).toBeNull();
  });
});
