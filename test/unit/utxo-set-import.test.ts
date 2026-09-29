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
const lease = { acquire: true, renewFailAfter: null as number | null, acquired: [] as string[], released: [] as string[], renewCalls: 0, hang: false };
// answers to SELECT queries (row count of LedgerUTxOs, the anchor block) and a failing statement
const db = { utxoCount: 0, anchorBlock: null as Record<string, unknown> | null, failOn: null as RegExp | null, hold: null as Promise<void> | null };
const cursorResets: Array<Record<string, unknown>> = [];

vi.mock('@sap/cds', () => {
  const fakeTx = { run: vi.fn(async (q: Record<string, unknown> | string) => {
    if (typeof q === 'string' && db.failOn?.test(q)) throw new Error('numeric field overflow');
    if (typeof q === 'string' && db.hold) await db.hold;
    txRuns.push(q as Record<string, unknown>);
    if (typeof q === 'object' && q._op === 'SELECT') return q.entity === 'LedgerUTxOs' ? { n: String(db.utxoCount) } : db.anchorBlock;
    return undefined;
  }) };
  const cdsMock = {
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    tx: vi.fn(async (fn: (tx: unknown) => unknown) => fn(fakeTx)),
    db: { run: vi.fn(async (sql: string) => { rawSql.push(sql); return undefined; }) },
    ql: {
      UPSERT: { into: (entity: string) => ({ entries: (entries: unknown) => ({ _op: 'UPSERT', entity, entries }) }) },
      DELETE: { from: (entity: string) => ({ _op: 'DELETE', entity, where: (where: unknown) => ({ _op: 'DELETE', entity, where }) }) },
      SELECT: { one: { from: (entity: string) => ({ columns: () => {
        const q = { _op: 'SELECT', entity };
        return { ...q, where: (where: unknown) => ({ ...q, where }) };
      } }) } },
    },
  };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('#cds-models/odatano/cardano', () => ({
  LedgerUTxOs: 'LedgerUTxOs', LedgerUTxOAssets: 'LedgerUTxOAssets',
  LedgerAddresses: 'LedgerAddresses', LedgerAddressAssets: 'LedgerAddressAssets', LedgerAccounts: 'LedgerAccounts',
  Blocks: 'Blocks',
}));
vi.mock('../../srv/blockchain/crawler/sync-state', () => ({
  readCursor: vi.fn(async () => cursorState.cursor),
  isCrawlerLeaseActive: (cursor: { leaseUntil?: string } | null) => Boolean(cursor?.leaseUntil && Date.parse(cursor.leaseUntil) > Date.now()),
  setUtxoSetState: vi.fn(async (_tx: unknown, state: Record<string, unknown>) => { utxoSetStates.push(state); }),
  tryAcquireImportLease: vi.fn(async (_tx: unknown, owner: string) => { if (lease.acquire) lease.acquired.push(owner); return lease.acquire; }),
  renewImportLease: vi.fn(async () => {
    lease.renewCalls++;
    if (lease.hang) return new Promise<boolean>(() => undefined); // blocked on the cursor row lock
    txRuns.push({ _op: 'RENEW' });
    return lease.renewFailAfter == null || lease.renewCalls <= lease.renewFailAfter;
  }),
  releaseImportLease: vi.fn(async (_tx: unknown, owner: string) => { lease.released.push(owner); }),
  resetCursorTo: vi.fn(async (_tx: unknown, point: Record<string, unknown>) => { cursorResets.push(point); txRuns.push({ _op: 'RESET' }); }),
  CRAWLER_LEASE_TTL_MS: 15_000,
}));

import { parseCliUtxoEntry, readUtxoSetFile, aggregateStatements, importUtxoSet, rebuildUtxoSetAggregates, UtxoSetImportError, UtxoSetLeaseLostError, parseJsonLossless } from '../../srv/blockchain/crawler/utxo-set-import';

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
    expect(addresses).toMatch(/^INSERT INTO odatano_cardano_LedgerAddresses .* FROM odatano_cardano_LedgerUTxOs WHERE spentTxHash IS NULL GROUP BY address$/);
    expect(assets).toContain('WHERE u.spentTxHash IS NULL GROUP BY u.address, a.unit');
    expect(addresses).toContain('SUM(lovelace), COUNT(*)');
    expect(assets).toContain('JOIN odatano_cardano_LedgerUTxOs u ON a.utxo_txHash = u.txHash AND a.utxo_outputIndex = u.outputIndex');
    expect(accounts).toMatch(/WHERE stakeAddress IS NOT NULL GROUP BY stakeAddress$/);
    expect(aggregateStatements().join(' ')).not.toMatch(/"/); // unquoted identifiers, same as the index DDL
  });
});

describe('importUtxoSet preconditions', () => {
  const deps = () => ({
    client: { getLedgerStateBackend: () => null } as never,
    indexer: { setUtxoAnchor: vi.fn(), resetPaymentCredentials: vi.fn(), paymentCredentialsReady: vi.fn(async () => false) } as never,
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
    // the SQL aggregation leaves the credential column empty; the fill starts after activation
    const idx = d.indexer as unknown as { resetPaymentCredentials: ReturnType<typeof vi.fn>; paymentCredentialsReady: ReturnType<typeof vi.fn> };
    expect(idx.resetPaymentCredentials).toHaveBeenCalledTimes(1);
    expect(idx.paymentCredentialsReady).toHaveBeenCalledTimes(1);
    expect(lease.acquired).toHaveLength(1);
    expect(lease.acquired[0]).toMatch(/^import:/);
    expect(lease.released).toEqual(lease.acquired);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('rebuildUtxoSetAggregates', () => {
  const indexer = () => ({ setUtxoAnchor: vi.fn(), resetPaymentCredentials: vi.fn(), paymentCredentialsReady: vi.fn(async () => false) });
  const anchored = (over: Record<string, unknown> = {}) => ({
    lastSlot: 10, leaseUntil: null,
    utxoSet: { status: 'invalid', anchorSlot: 10, anchorHash: 'h', appliedSlot: null, importedAt: null, error: 'numeric field overflow' },
    ...over,
  });
  const statements = () => txRuns.filter((q): q is never => typeof q === 'string') as unknown as string[];
  beforeEach(() => {
    txRuns.length = 0; utxoSetStates.length = 0; cursorResets.length = 0;
    lease.acquire = true; lease.renewFailAfter = null; lease.renewCalls = 0; lease.acquired.length = 0; lease.released.length = 0;
    db.utxoCount = 22_995_892; db.anchorBlock = { height: '4000' }; db.failOn = null; db.hold = null; lease.hang = false;
  });

  it('rebuilds only the sums from the imported rows and activates the set at the stored anchor', async () => {
    cursorState.cursor = anchored();
    const ix = indexer();

    const result = await rebuildUtxoSetAggregates({ indexer: ix as never });

    expect(result).toEqual({ utxos: 22_995_892, anchor: { slot: 10, hash: 'h' } });
    // the raw rows stay, the three aggregate tables are emptied and refilled
    const deletes = txRuns.filter(q => typeof q === 'object' && q._op === 'DELETE').map(q => q.entity);
    expect(deletes).toEqual(['LedgerAddressAssets', 'LedgerAddresses', 'LedgerAccounts']);
    expect(statements()).toEqual(aggregateStatements());
    expect(utxoSetStates.at(-1)).toMatchObject({ status: 'active', anchorSlot: 10, anchorHash: 'h', error: null });
    expect(ix.setUtxoAnchor).toHaveBeenLastCalledWith({ slot: 10, hash: 'h' });
    expect(cursorResets).toHaveLength(0);
    expect(lease.released).toHaveLength(1);
  });

  it('sets a cursor that went past the anchor back to the anchor block in the same transaction', async () => {
    cursorState.cursor = anchored({ lastSlot: 900 });
    await rebuildUtxoSetAggregates({ indexer: indexer() as never });
    expect(cursorResets).toEqual([{ slot: 10, hash: 'h', height: 4000 }]);
  });

  it('touches the cursor row only after the sums: heartbeats never wait for the aggregation', async () => {
    cursorState.cursor = anchored({ lastSlot: 900 });
    await rebuildUtxoSetAggregates({ indexer: indexer() as never });
    const ops = txRuns.map(q => (typeof q === 'string' ? 'SQL' : String(q._op)));
    const firstDelete = ops.indexOf('DELETE');
    const tail = ops.slice(firstDelete);
    // deletes and the three statements first; cursor reset and lease re-take are the last statements
    expect(tail).toEqual(['DELETE', 'DELETE', 'DELETE', 'SQL', 'SQL', 'SQL', 'RESET', 'RENEW']);
    expect(utxoSetStates[0]).toEqual({ error: null }); // the old failure text is cleared at the start
    expect(utxoSetStates.at(-1)).toMatchObject({ status: 'active' });
  });

  it('starts no second heartbeat while one is still waiting, so a blocked renewal holds one connection', async () => {
    vi.useFakeTimers();
    try {
      cursorState.cursor = anchored();
      let release!: () => void;
      db.hold = new Promise<void>((r) => { release = r; });
      const run = rebuildUtxoSetAggregates({ indexer: indexer() as never });
      await vi.advanceTimersByTimeAsync(0); // the aggregation is now running (held)
      lease.hang = true;
      const before = lease.renewCalls;
      await vi.advanceTimersByTimeAsync(5_000 * 4); // four heartbeat ticks
      expect(lease.renewCalls - before).toBe(1);
      lease.hang = false;
      db.hold = null;
      release();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the set invalid with the reason when an aggregate statement fails', async () => {
    cursorState.cursor = anchored();
    db.failOn = /LedgerAddressAssets/;
    await expect(rebuildUtxoSetAggregates({ indexer: indexer() as never })).rejects.toThrow('numeric field overflow');
    expect(utxoSetStates.at(-1)).toMatchObject({ status: 'invalid', error: 'numeric field overflow' });
  });

  it.each([
    ['no imported set', () => anchored({ utxoSet: { status: 'none', anchorSlot: null, anchorHash: null, appliedSlot: null } }), /run importUtxoSet first/],
    ['blocks already applied', () => anchored({ utxoSet: { status: 'active', anchorSlot: 10, anchorHash: 'h', appliedSlot: 50 } }), /already applied/],
    ['import still loading', () => anchored({ utxoSet: { status: 'importing', anchorSlot: 10, anchorHash: 'h', appliedSlot: null } }), /still loading/],
    ['crawler running', () => anchored({ leaseUntil: '2999-01-01T00:00:00.000Z' }), /pause/],
  ])('refuses before any write: %s', async (_name, cursor, message) => {
    cursorState.cursor = cursor();
    await expect(rebuildUtxoSetAggregates({ indexer: indexer() as never })).rejects.toThrow(message);
    expect(txRuns.filter(q => typeof q === 'string' || q._op !== 'SELECT')).toHaveLength(0);
    expect(utxoSetStates).toHaveLength(0);
  });

  it('refuses without rows, and past the anchor without the anchor block', async () => {
    cursorState.cursor = anchored();
    db.utxoCount = 0;
    await expect(rebuildUtxoSetAggregates({ indexer: indexer() as never })).rejects.toThrow(/LedgerUTxOs is empty/);
    db.utxoCount = 5; db.anchorBlock = null;
    cursorState.cursor = anchored({ lastSlot: 900 });
    await expect(rebuildUtxoSetAggregates({ indexer: indexer() as never })).rejects.toThrow(/cannot set the cursor back/);
    expect(utxoSetStates).toHaveLength(0);
  });
});
