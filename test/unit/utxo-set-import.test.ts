/**
 * UTxO set snapshot import: cardano-cli dump parsing (whole .json
 * and streamed .ndjson), the aggregate statements, and the preconditions that must refuse
 * an import before anything is written.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const txRuns: Array<Record<string, unknown>> = [];
const rawSql: string[] = [];
const cursorState: { cursor: Record<string, unknown> | null } = { cursor: null };
const utxoSetStates: Array<Record<string, unknown>> = [];
const lease = { acquire: true, renewFailAfter: null as number | null, acquired: [] as string[], released: [] as string[], renewCalls: 0 };

vi.mock('@sap/cds', () => {
  const fakeTx = { run: vi.fn(async (q: Record<string, unknown>) => { txRuns.push(q); return undefined; }) };
  const cdsMock = {
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    tx: vi.fn(async (fn: (tx: unknown) => unknown) => fn(fakeTx)),
    db: { run: vi.fn(async (sql: string) => { rawSql.push(sql); return undefined; }) },
    ql: {
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      DELETE: { from: (entity: string) => ({ _op: 'DELETE', entity, where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({
  LedgerUTxOs: 'LedgerUTxOs', LedgerUTxOAssets: 'LedgerUTxOAssets',
  LedgerAddresses: 'LedgerAddresses', LedgerAddressAssets: 'LedgerAddressAssets', LedgerAccounts: 'LedgerAccounts',
}));
vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  readCursor: vi.fn(async () => cursorState.cursor),
  isCrawlerLeaseActive: (cursor: { leaseUntil?: string } | null) => Boolean(cursor?.leaseUntil && Date.parse(cursor.leaseUntil) > Date.now()),
  setUtxoSetState: vi.fn(async (_tx: unknown, state: Record<string, unknown>) => { utxoSetStates.push(state); }),
  tryAcquireImportLease: vi.fn(async (_tx: unknown, owner: string) => { if (lease.acquire) lease.acquired.push(owner); return lease.acquire; }),
  renewImportLease: vi.fn(async () => { lease.renewCalls++; return lease.renewFailAfter == null || lease.renewCalls <= lease.renewFailAfter; }),
  releaseImportLease: vi.fn(async (_tx: unknown, owner: string) => { lease.released.push(owner); }),
  CRAWLER_LEASE_TTL_MS: 15_000,
}));

import { parseCliUtxoEntry, readUtxoSetFile, aggregateStatements, importUtxoSet, UtxoSetImportError, UtxoSetLeaseLostError, parseJsonLossless } from '../../srv/blockchain/crawler/utxo-set-import';

const TX = 'a'.repeat(64);
const ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const POLICY = 'p'.repeat(56);

describe('parseCliUtxoEntry', () => {
  it('maps a cardano-cli entry incl. native assets, datum hash and inline datum raw', () => {
    const entry = parseCliUtxoEntry(`${TX.toUpperCase()}#3`, {
      address: ADDR,
      value: { lovelace: 5000000, [POLICY]: { '746f6b656e': 7, '': '1' } },
      datumhash: 'd'.repeat(64),
      inlineDatumRaw: 'd87980',
      referenceScript: null,
    });
    expect(entry).toEqual({
      txHash: TX, outputIndex: 3, address: ADDR,
      amount: [{ unit: 'lovelace', quantity: '5000000' }, { unit: `${POLICY}746f6b656e`, quantity: '7' }, { unit: POLICY, quantity: '1' }],
      dataHash: 'd'.repeat(64), inlineDatum: 'd87980', referenceScriptHash: null,
    });
  });

  it('adds a zero lovelace line when the value has none and rejects malformed keys', () => {
    expect(parseCliUtxoEntry(`${TX}#0`, { address: ADDR, value: {} })!.amount).toEqual([{ unit: 'lovelace', quantity: '0' }]);
    expect(parseCliUtxoEntry('nonsense', { address: ADDR, value: {} })).toBeNull();
    expect(parseCliUtxoEntry(`${TX}#0`, null)).toBeNull();
    expect(parseCliUtxoEntry(`${TX}#0`, { value: {} } as never)).toBeNull();
  });
});

describe('parseJsonLossless', () => {
  it('keeps integers above 2^53 exact (JSON.parse would round them)', () => {
    const text = `{"${TX}#0": {"address": "${ADDR}", "value": {"lovelace": 9007199254740993, "${POLICY}": {"746f6b656e": 18446744073709551615, "": -5}}, "datumhash": null}}`;
    expect(JSON.parse(text)[`${TX}#0`].value.lovelace).toBe(9007199254740992); // the problem
    const parsed = parseJsonLossless<Record<string, { value: Record<string, unknown> }>>(text);
    expect(parsed[`${TX}#0`].value.lovelace).toBe('9007199254740993');
    const entry = parseCliUtxoEntry(`${TX}#0`, parsed[`${TX}#0`] as never)!;
    expect(entry.amount).toEqual([
      { unit: 'lovelace', quantity: '9007199254740993' },
      { unit: `${POLICY}746f6b656e`, quantity: '18446744073709551615' },
      { unit: POLICY, quantity: '-5' },
    ]);
  });

  it('never touches string contents (colons, digits, escapes) and keeps floats, null and booleans', () => {
    expect(parseJsonLossless('{"a": "x:1, \\"q\\" 2", "b": [1, 2], "c": {"d": 1.5e3, "n": -7}, "e": null, "f": true, "12": "0"}'))
      .toEqual({ a: 'x:1, "q" 2', b: ['1', '2'], c: { d: 1500, n: '-7' }, e: null, f: true, '12': '0' });
  });
});

describe('readUtxoSetFile', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'odatano-utxo-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const collect = async (path: string) => { const out = []; for await (const e of readUtxoSetFile(path)) out.push(e); return out; };

  it('parses a whole .json dump, losslessly', async () => {
    const p = join(dir, 'utxo.json');
    writeFileSync(p, `{"${TX}#0": {"address": "${ADDR}", "value": {"lovelace": 1}}, "${TX}#1": {"address": "${ADDR}", "value": {"lovelace": 9007199254740993}}}`);
    const entries = await collect(p);
    expect(entries.map(e => [e.outputIndex, e.amount[0].quantity])).toEqual([[0, '1'], [1, '9007199254740993']]);
  });

  it('streams an .ndjson dump in both line layouts (jq to_entries and one-key objects), skipping blank lines', async () => {
    const p = join(dir, 'utxo.ndjson');
    writeFileSync(p, [
      JSON.stringify({ key: `${TX}#0`, value: { address: ADDR, value: { lovelace: 1 } } }),
      '',
      JSON.stringify({ [`${TX}#1`]: { address: ADDR, value: { lovelace: 2 } } }),
      '   ',
    ].join('\n'));
    const entries = await collect(p);
    expect(entries.map(e => e.outputIndex)).toEqual([0, 1]);
  });
});

describe('aggregateStatements', () => {
  it('derives addresses, address assets and accounts from the imported rows with portable SQL', () => {
    const [addresses, assets, accounts] = aggregateStatements();
    expect(addresses).toMatch(/^INSERT INTO odatano_cardano_LedgerAddresses .* FROM odatano_cardano_LedgerUTxOs GROUP BY address$/);
    expect(addresses).toContain('SUM(lovelace), COUNT(*)');
    expect(assets).toContain('JOIN odatano_cardano_LedgerUTxOs u ON a.utxo_txHash = u.txHash AND a.utxo_outputIndex = u.outputIndex');
    expect(accounts).toMatch(/WHERE stakeAddress IS NOT NULL GROUP BY stakeAddress$/);
    expect(aggregateStatements().join(' ')).not.toMatch(/"/); // unquoted identifiers, same as the index DDL
  });
});

describe('importUtxoSet preconditions', () => {
  const deps = () => ({
    client: { getLedgerStateBackend: () => null } as never,
    indexer: { setUtxoAnchor: vi.fn() } as never,
  });
  beforeEach(() => { txRuns.length = 0; rawSql.length = 0; utxoSetStates.length = 0; lease.acquire = true; lease.renewFailAfter = null; lease.renewCalls = 0; lease.acquired.length = 0; lease.released.length = 0; });

  it('re-takes the lease inside every write transaction and stops writing the moment a successor owns it', async () => {
    cursorState.cursor = { lastSlot: 5, leaseUntil: null };
    const dir = mkdtempSync(join(tmpdir(), 'odatano-utxo-'));
    const p = join(dir, 'set.json');
    writeFileSync(p, JSON.stringify(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`${TX}#${i}`, { address: ADDR, value: { lovelace: 1 } }]))));
    const d = deps();
    // the state write + first batch renew fine, then the lease is gone
    lease.renewFailAfter = 2;

    await expect(importUtxoSet({ source: 'file', filePath: p, anchor: { slot: 10, hash: 'h' }, batchSize: 2, ...d })).rejects.toBeInstanceOf(UtxoSetLeaseLostError);

    // one batch committed, the second refused before its UPSERTs, no aggregates, no activation,
    // and NO `invalid` write either — the row belongs to the successor now
    expect(txRuns.filter(q => q._op === 'UPSERT' && q.entity === 'LedgerUTxOs')).toHaveLength(1);
    expect(rawSql).toHaveLength(0);
    expect(utxoSetStates.map(s => s.status)).toEqual(['importing']);
    expect((d.indexer as { setUtxoAnchor: ReturnType<typeof vi.fn> }).setUtxoAnchor).not.toHaveBeenCalledWith({ slot: 10, hash: 'h' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when the cursor lease cannot be taken (crawler or another import holds it) — before any write', async () => {
    cursorState.cursor = { lastSlot: 5, leaseUntil: null };
    lease.acquire = false;
    await expect(importUtxoSet({ source: 'file', filePath: 'x.json', anchor: { slot: 10, hash: 'h' }, ...deps() })).rejects.toThrow(/lease/);
    expect(txRuns).toHaveLength(0);
    expect(utxoSetStates).toHaveLength(0);
    expect(lease.released).toHaveLength(0);
  });

  it('refuses without a cursor, with an active lease, and with a cursor past the anchor — before any write', async () => {
    cursorState.cursor = null;
    await expect(importUtxoSet({ source: 'file', filePath: 'x.json', anchor: { slot: 10, hash: 'h' }, ...deps() })).rejects.toBeInstanceOf(UtxoSetImportError);
    cursorState.cursor = { lastSlot: 5, leaseUntil: '2999-01-01T00:00:00.000Z' };
    await expect(importUtxoSet({ source: 'file', filePath: 'x.json', anchor: { slot: 10, hash: 'h' }, ...deps() })).rejects.toThrow(/pause/);
    cursorState.cursor = { lastSlot: 50, leaseUntil: null };
    await expect(importUtxoSet({ source: 'file', filePath: 'x.json', anchor: { slot: 10, hash: 'h' }, ...deps() })).rejects.toThrow(/past the anchor/);
    expect(txRuns).toHaveLength(0);
    expect(utxoSetStates).toHaveLength(0);
  });

  it('marks the set invalid (never active) when the source fails mid-way', async () => {
    cursorState.cursor = { lastSlot: 5, leaseUntil: null };
    const d = deps();
    await expect(importUtxoSet({ source: 'ogmios', anchor: { slot: 10, hash: 'h' }, ...d })).rejects.toThrow(/No Ogmios backend/);
    // the tables were truncated and the state went importing → invalid, anchor cleared
    expect(txRuns.filter(q => q._op === 'DELETE').map(q => q.entity)).toEqual(['LedgerUTxOAssets', 'LedgerUTxOs', 'LedgerAddressAssets', 'LedgerAddresses', 'LedgerAccounts']);
    expect(utxoSetStates.map(s => s.status)).toEqual(['importing', 'invalid']);
    expect((d.indexer as { setUtxoAnchor: ReturnType<typeof vi.fn> }).setUtxoAnchor).toHaveBeenCalledWith(null);
    expect(rawSql).toHaveLength(0);
    // the lease is released even on failure
    expect(lease.released).toEqual(lease.acquired);
  });

  it('loads a file in batches, runs the aggregates and activates the anchor', async () => {
    cursorState.cursor = { lastSlot: 5, leaseUntil: null };
    const dir = mkdtempSync(join(tmpdir(), 'odatano-utxo-'));
    const p = join(dir, 'set.json');
    writeFileSync(p, JSON.stringify(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${TX}#${i}`, { address: ADDR, value: { lovelace: i + 1 } }]))));
    const d = deps();

    const r = await importUtxoSet({ source: 'file', filePath: p, anchor: { slot: 10, hash: 'h' }, batchSize: 2, ...d });

    expect(r).toEqual({ utxos: 5, anchor: { slot: 10, hash: 'h' } });
    const upserts = txRuns.filter(q => q._op === 'UPSERT' && q.entity === 'LedgerUTxOs');
    expect(upserts.map(q => (q.entries as unknown[]).length)).toEqual([2, 2, 1]);
    // aggregates run through the lease-checked transaction, not the bare db service
    expect(rawSql).toHaveLength(0);
    expect(txRuns.filter(q => typeof q === 'string')).toHaveLength(3);
    // state write + 3 batches + aggregates/activation = 5 lease-checked transactions
    expect(lease.renewCalls).toBe(5);
    expect(utxoSetStates.map(s => s.status)).toEqual(['importing', 'active']);
    expect(utxoSetStates[1]).toMatchObject({ anchorSlot: 10, anchorHash: 'h' });
    expect((d.indexer as { setUtxoAnchor: ReturnType<typeof vi.fn> }).setUtxoAnchor).toHaveBeenLastCalledWith({ slot: 10, hash: 'h' });
    expect(lease.acquired).toHaveLength(1);
    expect(lease.acquired[0]).toMatch(/^import:/);
    expect(lease.released).toEqual(lease.acquired);
    rmSync(dir, { recursive: true, force: true });
  });
});
