/**
 * Account snapshots (srv/blockchain/crawler/account-snapshots.ts) against the real model on an
 * in-memory SQLite, so the page queries, the withdrawal join and the marker run as SQL.
 * Decimal and Int64 columns read back as strings.
 */
import cds from '@sap/cds';
import path from 'path';
import {
  snapshotAccounts, dropAccountSnapshotsAfter, creditedAmount, accountPageQuery,
} from '../../srv/blockchain/crawler/account-snapshots';
import type { AskRewardAccounts, RewardAccountState, RewardAccountStateBackend } from '../../srv/blockchain/backends/cardano-backend';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PostgresService = require('@cap-js/postgres/lib/PostgresService');

const { SELECT, INSERT, DELETE } = cds.ql;
const NS = 'odatano.cardano';
const hash = (c: string) => c.repeat(64);
const account = (stakeAddress: string, withdrawableAmount: string, poolId = 'pool1x'): RewardAccountState =>
  ({ stakeAddress, withdrawableAmount, deposit: '2000000', poolId, drepId: null });

/** A node that reports the given accounts and records what it was asked. */
function node(reported: RewardAccountState[]) {
  const asked: string[][] = [];
  const points: Array<{ slot: number; hash: string }> = [];
  const backend = {
    rewardAccountsAt: async <T>(point: { slot: number; hash: string }, read: (ask: AskRewardAccounts) => Promise<T>) => {
      points.push(point);
      return read(async (stakeAddresses) => {
        asked.push(stakeAddresses);
        return reported.filter(a => stakeAddresses.includes(a.stakeAddress));
      });
    },
  } as unknown as RewardAccountStateBackend;
  return { backend, asked, points };
}

const rows = (epoch: number) => cds.run(
  SELECT.from(`${NS}.AccountEpochSnapshots`).where({ epoch }).orderBy('stakeAddress')
) as Promise<Array<Record<string, unknown>>>;
const marker = (epoch: number) => cds.run(
  SELECT.one.from(`${NS}.EpochLedgerSnapshots`).columns('accountCount', 'accountSnapshotSlot').where({ epoch })
) as Promise<{ accountCount: number | null; accountSnapshotSlot: number | null } | undefined>;

beforeAll(async () => {
  const csn = await cds.load(path.resolve(__dirname, '../../db'));
  cds.model = cds.compile.for.nodejs(csn) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  // cds.deploy is not part of the published typings
  await (cds as unknown as { deploy: (model: unknown) => { to: (db: unknown) => Promise<unknown> } }).deploy(csn).to(db);
});

beforeEach(async () => {
  for (const entity of ['AccountEpochSnapshots', 'EpochLedgerSnapshots', 'LedgerAccounts', 'TransactionCertificates', 'TransactionWithdrawals', 'Transactions', 'Blocks']) {
    await cds.run(DELETE.from(`${NS}.${entity}`));
  }
  // two snapshot blocks, one per epoch, and the pool snapshot rows the account snapshot follows
  await cds.run(INSERT.into(`${NS}.Blocks`).entries([{ hash: hash('a'), slot: 1000 }, { hash: hash('b'), slot: 2000 }]));
  await cds.run(INSERT.into(`${NS}.EpochLedgerSnapshots`).entries([{ epoch: 10, snapshotSlot: 1000 }, { epoch: 11, snapshotSlot: 2000 }]));
  await cds.run(INSERT.into(`${NS}.LedgerAccounts`).entries(['s1', 's2', 's3', 's4', 's5'].map(stakeAddress => ({ stakeAddress }))));
  // s5 is in both places, s6 is known from a certificate only
  await cds.run(INSERT.into(`${NS}.TransactionCertificates`).entries([
    { tx_hash: hash('1'), certIndex: 0, kind: 'pool_delegation', stakeAddress: 's5' },
    { tx_hash: hash('2'), certIndex: 0, kind: 'pool_delegation', stakeAddress: 's6' },
    { tx_hash: hash('3'), certIndex: 0, kind: 'pool_delegation', stakeAddress: 's6' },
    { tx_hash: hash('4'), certIndex: 0, kind: 'pool_registration', stakeAddress: null },
  ]));
});

const at10 = { slot: 1000, hash: hash('a') };
const at11 = { slot: 2000, hash: hash('b') };

describe('snapshotAccounts', () => {
  it('stores the accounts the node reports and asks every known account once', async () => {
    const n = node([account('s2', '500'), account('s5', '0', 'pool1y'), account('s6', '70')]);

    const result = await snapshotAccounts({ backend: n.backend, epoch: 10, at: at10, withdrawals: true, pageSize: 2 });

    expect(result).toEqual({ taken: true, asked: 6, accounts: 3 });
    expect(n.points).toEqual([{ slot: 1000, hash: hash('a') }]);
    // three pages from the UTxO set, then the one account only a certificate names
    expect(n.asked).toEqual([['s1', 's2'], ['s3', 's4'], ['s5'], ['s6']]);
    expect(await rows(10)).toMatchObject([
      { epoch: 10, stakeAddress: 's2', withdrawableAmount: '500', creditedAmount: null, deposit: '2000000', poolId: 'pool1x', drepId: null },
      { stakeAddress: 's5', withdrawableAmount: '0', poolId: 'pool1y' },
      { stakeAddress: 's6', withdrawableAmount: '70' },
    ]);
    expect(await marker(10)).toEqual({ accountCount: 3, accountSnapshotSlot: '1000' });
  });

  it('derives the credited amount from the balance difference and the withdrawals in between', async () => {
    await snapshotAccounts({ backend: node([account('s1', '100'), account('s2', '100'), account('s3', '100')]).backend, epoch: 10, at: at10, withdrawals: true });
    await cds.run(INSERT.into(`${NS}.Transactions`).entries([
      { hash: hash('5'), slot: 1000 }, { hash: hash('6'), slot: 1001 }, { hash: hash('7'), slot: 2000 }, { hash: hash('8'), slot: 2001 },
    ]));
    await cds.run(INSERT.into(`${NS}.TransactionWithdrawals`).entries([
      { tx_hash: hash('5'), stakeAddress: 's1', lovelace: 1000 }, // in the earlier snapshot block: already in its balance
      { tx_hash: hash('6'), stakeAddress: 's1', lovelace: 30 },
      { tx_hash: hash('7'), stakeAddress: 's1', lovelace: 5 },    // in the snapshot block itself: counted
      { tx_hash: hash('8'), stakeAddress: 's1', lovelace: 2000 }, // after it
    ]));

    await snapshotAccounts({
      backend: node([account('s1', '150'), account('s2', '100'), account('s3', '40'), account('s4', '9')]).backend,
      epoch: 11, at: at11, withdrawals: true,
    });

    expect((await rows(11)).map(r => [r.stakeAddress, r.creditedAmount])).toEqual([
      ['s1', '85'], // 150 - 100 + 30 + 5
      ['s2', '0'],
      ['s3', null], // fell without a stored withdrawal
      ['s4', null], // no row in the previous epoch
    ]);
  });

  it('stores an account whose balance the node does not report, and derives nothing from it', async () => {
    const open = { ...account('s1', '0'), withdrawableAmount: null, poolId: null, drepId: 'drep_always_abstain' };
    await snapshotAccounts({ backend: node([open, account('s2', '100')]).backend, epoch: 10, at: at10, withdrawals: true });
    // s1 has a pool by now, s2 lost its pool
    await snapshotAccounts({
      backend: node([account('s1', '50'), { ...account('s2', '0'), withdrawableAmount: null, poolId: null }]).backend,
      epoch: 11, at: at11, withdrawals: true,
    });

    expect((await rows(10))[0]).toMatchObject({ stakeAddress: 's1', withdrawableAmount: null, poolId: null, drepId: 'drep_always_abstain', deposit: '2000000' });
    expect((await rows(11)).map(r => [r.stakeAddress, r.withdrawableAmount, r.creditedAmount])).toEqual([['s1', '50', null], ['s2', null, null]]);
  });

  it('leaves the credited amount empty while withdrawals are not crawled', async () => {
    await snapshotAccounts({ backend: node([account('s1', '100')]).backend, epoch: 10, at: at10, withdrawals: true });
    await snapshotAccounts({ backend: node([account('s1', '150')]).backend, epoch: 11, at: at11, withdrawals: false });
    expect((await rows(11))[0]).toMatchObject({ withdrawableAmount: '150', creditedAmount: null });
  });

  it('takes one snapshot per epoch and none before the pool snapshot', async () => {
    const first = node([account('s1', '1')]);
    await snapshotAccounts({ backend: first.backend, epoch: 10, at: at10, withdrawals: true });
    const again = node([account('s2', '2')]);
    expect(await snapshotAccounts({ backend: again.backend, epoch: 10, at: at10, withdrawals: true })).toEqual({ taken: false, asked: 0, accounts: 1 });
    expect(await snapshotAccounts({ backend: again.backend, epoch: 12, at: at11, withdrawals: true })).toEqual({ taken: false, asked: 0, accounts: 0 });
    expect(again.points).toEqual([]);
    expect((await rows(10)).map(r => r.stakeAddress)).toEqual(['s1']);
  });

  it('replaces the rows of an attempt that did not finish', async () => {
    await cds.run(INSERT.into(`${NS}.AccountEpochSnapshots`).entries([{ epoch: 10, stakeAddress: 's4', withdrawableAmount: 7 }]));
    await snapshotAccounts({ backend: node([account('s1', '1')]).backend, epoch: 10, at: at10, withdrawals: true });
    expect((await rows(10)).map(r => r.stakeAddress)).toEqual(['s1']);
  });

  it('writes nothing lasting when its block left the stored chain', async () => {
    await cds.run(DELETE.from(`${NS}.Blocks`).where({ hash: hash('a') }));
    await expect(snapshotAccounts({ backend: node([account('s1', '1')]).backend, epoch: 10, at: at10, withdrawals: true }))
      .rejects.toThrow('no longer on the stored chain');
    expect(await rows(10)).toEqual([]);
    expect(await marker(10)).toEqual({ accountCount: null, accountSnapshotSlot: null });
  });

  it('stops between pages and leaves the epoch open', async () => {
    let pages = 0;
    await expect(snapshotAccounts({
      backend: node([account('s1', '1')]).backend, epoch: 10, at: at10, withdrawals: true, pageSize: 2, shouldStop: () => ++pages > 1,
    })).rejects.toThrow('stopped');
    expect(await marker(10)).toEqual({ accountCount: null, accountSnapshotSlot: null });
  });

  it('passes an error of the node on', async () => {
    const backend = { rewardAccountsAt: async () => { throw new Error('acquire failed'); } } as unknown as RewardAccountStateBackend;
    await expect(snapshotAccounts({ backend, epoch: 10, at: at10, withdrawals: true })).rejects.toThrow('acquire failed');
    expect(await marker(10)).toEqual({ accountCount: null, accountSnapshotSlot: null });
  });
});

describe('dropAccountSnapshotsAfter', () => {
  it('removes the snapshots read after the fork and keeps the earlier ones', async () => {
    await snapshotAccounts({ backend: node([account('s1', '1')]).backend, epoch: 10, at: at10, withdrawals: true });
    await snapshotAccounts({ backend: node([account('s1', '2')]).backend, epoch: 11, at: at11, withdrawals: true });

    await cds.tx((tx) => dropAccountSnapshotsAfter(tx, 1500));

    expect((await rows(10)).length).toBe(1);
    expect(await marker(10)).toEqual({ accountCount: 1, accountSnapshotSlot: '1000' });
    expect(await rows(11)).toEqual([]);
    expect(await marker(11)).toEqual({ accountCount: null, accountSnapshotSlot: null });
  });
});

describe('creditedAmount', () => {
  it('is the growth plus the withdrawals, or unknown', () => {
    expect(creditedAmount('150', 100n, 30n)).toBe('80');
    expect(creditedAmount('100', 100n, 0n)).toBe('0');
    expect(creditedAmount('40', 100n, 0n)).toBeNull();
    expect(creditedAmount('40', undefined, 0n)).toBeNull();
    expect(creditedAmount(null, 100n, 0n)).toBeNull();
    expect(creditedAmount('18446744073709551615', 1n, 0n)).toBe('18446744073709551614');
  });
});

describe('accountPageQuery on PostgreSQL', () => {
  it('orders in the direction of the plain index, so a page reads the index and sorts nothing', () => {
    const srv = new PostgresService('db', cds.model, { kind: 'postgres', credentials: {} });
    const sql = (q: unknown) => String(srv.cqn2sql(q).sql).replace(/^.*?FROM/, 'FROM');
    expect(sql(accountPageQuery('certificates', 'x', 2000)))
      .toBe('FROM odatano_cardano_TransactionCertificates as "$t" WHERE "$t".stakeAddress > $1 ORDER BY stakeAddress ASC NULLS LAST LIMIT $2');
    expect(sql(accountPageQuery('ledger', 'x', 2000)))
      .toBe('FROM odatano_cardano_LedgerAccounts as "$l" WHERE "$l".stakeAddress > $1 ORDER BY stakeAddress ASC NULLS LAST LIMIT $2');
  });
});
