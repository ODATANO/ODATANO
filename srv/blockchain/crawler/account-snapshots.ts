// Reward account snapshot of one epoch. Asks the node, at the snapshot block, about every
// account the crawl knows and stores the ones it reports. Runs after the pool snapshot.
import cds from '@sap/cds';
import {
  AccountEpochSnapshots, Blocks, EpochLedgerSnapshots, LedgerAccounts, TransactionCertificates, TransactionWithdrawals,
} from '#cds-models/odatano/cardano';
import type { RewardAccountState, RewardAccountStateBackend } from '../backends/cardano-backend';
import { chunk, IN_CHUNK } from '../../utils/collections';

const logger = cds.log('AccountSnapshots');
const { SELECT, UPSERT, UPDATE, DELETE } = cds.ql;

export interface AccountSnapshotOptions {
  backend: RewardAccountStateBackend;
  epoch: number;
  at: { slot: number; hash: string }; // block the ledger is read at
  withdrawals: boolean; // true = withdrawals are crawled, so the credited amount can be derived
  pageSize?: number;    // default 2000; accounts per node request
  shouldStop?: () => boolean;
}

export interface AccountSnapshotResult {
  taken: boolean;   // false = the epoch has its snapshot, or has no pool snapshot yet
  asked: number;    // accounts the node was asked about
  accounts: number; // accounts stored
}

/** Where the crawl learns which accounts exist: the UTxO set and the crawled certificates. */
const SOURCES = ['ledger', 'certificates'] as const;
type Source = (typeof SOURCES)[number];

const lovelace = (value: unknown): bigint => {
  if (value === null || value === undefined || value === '') return 0n;
  return BigInt(typeof value === 'number' ? Math.trunc(value) : String(value).split('.')[0]);
};

/** Page query of one source: stake addresses after `after`, in the order of the column's index. */
function pageQuery(source: Source, after: string, limit: number) {
  const q = source === 'ledger'
    ? SELECT.from(LedgerAccounts).columns('stakeAddress').where({ stakeAddress: { '>': after } }).limit(limit)
    : SELECT.distinct.from(TransactionCertificates).columns('stakeAddress').where({ stakeAddress: { '>': after } }).limit(limit);
  // nulls last is the order of a plain index; without it PostgreSQL sorts the range on every page
  q.SELECT.orderBy = [{ ref: ['stakeAddress'], sort: 'asc', nulls: 'last' }];
  return q;
}

/** The page query as an opaque value, for a test that renders its SQL. */
export function accountPageQuery(source: Source, after: string, limit: number): object {
  return pageQuery(source, after, limit);
}

async function accountPage(source: Source, after: string, limit: number): Promise<string[]> {
  const rows = await cds.tx((tx) => tx.run(pageQuery(source, after, limit))) as Array<{ stakeAddress: string }>;
  return rows.map(r => r.stakeAddress);
}

/** The accounts of `page` that the UTxO set does not list; those were asked in the first pass. */
async function notInLedger(page: string[]): Promise<string[]> {
  const known = new Set<string>();
  await cds.tx(async (tx) => {
    for (const part of chunk(page, IN_CHUNK)) {
      const rows = await tx.run(SELECT.from(LedgerAccounts).columns('stakeAddress').where({ stakeAddress: { in: part } })) as Array<{ stakeAddress: string }>;
      for (const r of rows) known.add(r.stakeAddress);
    }
  });
  return known.size ? page.filter(a => !known.has(a)) : page;
}

/** Slot of the account snapshot of `epoch`, or null when that epoch has none. */
async function accountSnapshotSlot(epoch: number): Promise<number | null> {
  const row = await cds.tx((tx) => tx.run(
    SELECT.one.from(EpochLedgerSnapshots).columns('accountCount', 'accountSnapshotSlot').where({ epoch })
  )) as { accountCount?: number | null; accountSnapshotSlot?: number | string | null } | undefined;
  return row?.accountCount == null || row.accountSnapshotSlot == null ? null : Number(row.accountSnapshotSlot);
}

// Balance difference to the previous snapshot plus what was withdrawn in between.
// Below zero means a withdrawal the crawl did not store, so the amount is unknown.
export function creditedAmount(now: string | null, before: bigint | undefined, withdrawn: bigint): string | null {
  if (now === null || before === undefined) return null;
  const credited = BigInt(now) - before + withdrawn;
  return credited < 0n ? null : credited.toString();
}

async function storePage(
  tx: cds.Transaction,
  reported: RewardAccountState[],
  opts: AccountSnapshotOptions,
  previousSlot: number | null,
): Promise<void> {
  const before = new Map<string, bigint>();
  const withdrawn = new Map<string, bigint>();
  if (previousSlot != null && opts.withdrawals) {
    for (const part of chunk(reported.map(a => a.stakeAddress), IN_CHUNK)) {
      const balances = await tx.run(
        SELECT.from(AccountEpochSnapshots).columns('stakeAddress', 'withdrawableAmount').where({ epoch: opts.epoch - 1, stakeAddress: { in: part } })
      ) as Array<{ stakeAddress: string; withdrawableAmount: unknown }>;
      for (const r of balances) if (r.withdrawableAmount != null) before.set(r.stakeAddress, lovelace(r.withdrawableAmount));
      const sums = await tx.run(
        SELECT.from(TransactionWithdrawals).columns('stakeAddress', 'sum(lovelace) as total')
          .where({ stakeAddress: { in: part }, 'tx.slot': { between: previousSlot + 1, and: opts.at.slot } })
          .groupBy('stakeAddress')
      ) as Array<{ stakeAddress: string; total: unknown }>;
      for (const r of sums) withdrawn.set(r.stakeAddress, lovelace(r.total));
    }
  }
  const rows = reported.map(a => ({
    epoch: opts.epoch,
    stakeAddress: a.stakeAddress,
    withdrawableAmount: a.withdrawableAmount,
    creditedAmount: creditedAmount(a.withdrawableAmount, before.get(a.stakeAddress), withdrawn.get(a.stakeAddress) ?? 0n),
    deposit: a.deposit,
    poolId: a.poolId,
    drepId: a.drepId,
  }));
  for (const part of chunk(rows, IN_CHUNK)) await tx.run(UPSERT.into(AccountEpochSnapshots).entries(part));
}

// Takes the account snapshot of `epoch` unless it has one. The marker on EpochLedgerSnapshots is
// written last, and only while the snapshot block is still on the stored chain.
export async function snapshotAccounts(opts: AccountSnapshotOptions): Promise<AccountSnapshotResult> {
  const { backend, epoch, at } = opts;
  const pageSize = opts.pageSize ?? 2000;
  const marker = await cds.tx((tx) => tx.run(
    SELECT.one.from(EpochLedgerSnapshots).columns('epoch', 'accountCount').where({ epoch })
  )) as { epoch: number; accountCount?: number | null } | undefined;
  if (!marker) return { taken: false, asked: 0, accounts: 0 };
  if (marker.accountCount != null) return { taken: false, asked: 0, accounts: Number(marker.accountCount) };

  // rows of an attempt that did not finish were read at another block
  await cds.tx((tx) => tx.run(DELETE.from(AccountEpochSnapshots).where({ epoch })));
  const previousSlot = await accountSnapshotSlot(epoch - 1);

  let asked = 0;
  await backend.rewardAccountsAt({ slot: at.slot, hash: at.hash }, async (ask) => {
    let ledgerHasAccounts = false;
    for (const source of SOURCES) {
      for (let after = ''; ;) {
        if (opts.shouldStop?.()) throw new Error(`account snapshot of epoch ${epoch} stopped`);
        const page = await accountPage(source, after, pageSize);
        if (!page.length) break;
        after = page[page.length - 1];
        if (source === 'ledger') ledgerHasAccounts = true;
        const unasked = source === 'certificates' && ledgerHasAccounts ? await notInLedger(page) : page;
        if (!unasked.length) continue;
        asked += unasked.length;
        const reported = await ask(unasked);
        if (reported.length) await cds.tx((tx) => storePage(tx, reported, opts, previousSlot));
      }
    }
  });

  const accounts = await cds.tx(async (tx) => {
    const block = await tx.run(SELECT.one.from(Blocks).columns('hash').where({ hash: at.hash }));
    if (!block) {
      await tx.run(DELETE.from(AccountEpochSnapshots).where({ epoch }));
      return null;
    }
    const counted = await tx.run(SELECT.one.from(AccountEpochSnapshots).columns('count(*) as n').where({ epoch })) as { n: number | string };
    await tx.run(UPDATE.entity(EpochLedgerSnapshots).set({ accountCount: Number(counted.n), accountSnapshotSlot: at.slot }).where({ epoch }));
    return Number(counted.n);
  });
  if (accounts == null) throw new Error(`account snapshot of epoch ${epoch}: block ${at.hash} is no longer on the stored chain`);

  logger.info(`epoch ${epoch} account snapshot (ogmios @ slot ${at.slot}): ${accounts} accounts, ${asked} asked`);
  return { taken: true, asked, accounts };
}

/** Removes the account snapshots read at a block after `forkSlot`. Part of the reorg transaction. */
export async function dropAccountSnapshotsAfter(tx: cds.Transaction, forkSlot: number): Promise<void> {
  const stale = await tx.run(
    SELECT.from(EpochLedgerSnapshots).columns('epoch').where({ accountSnapshotSlot: { '>': forkSlot } })
  ) as Array<{ epoch: number }>;
  for (const { epoch } of stale) {
    await tx.run(DELETE.from(AccountEpochSnapshots).where({ epoch }));
    await tx.run(UPDATE.entity(EpochLedgerSnapshots).set({ accountCount: null, accountSnapshotSlot: null }).where({ epoch }));
  }
}
