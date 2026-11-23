/**
 * Read service on an in-memory SQLite with the real model: a navigation indexes its parent first,
 * an account answers its addresses page by page, an epoch row is refreshed until it is final, and
 * waiting address watchers share their reads. The indexer is a fake that writes plain rows.
 */
import cds from '@sap/cds';
import path from 'path';
import { navigationOf } from '../../srv/utils/navigation';
import { AllBackendsFailedError } from '../../srv/utils/errors';
import { holdsConnection } from '../../srv/utils/tx-utils';
import { accountAddressList, parseAccountAddressList } from '../../srv/blockchain/cardano-indexer';

const { SELECT, INSERT, DELETE } = cds.ql;
const NS = 'odatano.cardano';
const SRV = 'CardanoODataService';
const H = 'a'.repeat(64);
const STAKE = 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p';
const ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

type Db = { run: (q: unknown) => Promise<unknown> };
/** Whether the request transaction held its connection at each provider call. */
const held: boolean[] = [];
const probe = (db: unknown) => { held.push(holdsConnection(db)); };
const slice = () => { const now = Date.now(); return { validFrom: new Date(now - 1000).toISOString(), validTo: new Date(now + 3_600_000).toISOString() }; };
const fake = {
  fetchTransaction: vi.fn(async (db: Db, hash: string): Promise<FakeTx> => { probe(db); return { hash }; }),
  storeTransaction: vi.fn(async (db: Db, fetched: FakeTx) => {
    await db.run(INSERT.into(`${NS}.Transactions`).entries({ hash: fetched.hash, txSeq: 65536 }));
    const inputs = fetched.inputs ?? [{ address: null }];
    await db.run(INSERT.into(`${NS}.TransactionInputs`).entries(inputs.map((input, inputIndex) => (
      { txSeq: 65536, inputIndex, spentTxHash: 'b'.repeat(64), spentOutputIndex: 0, address_address: input.address }))));
    for (const output of fetched.outputs ?? []) {
      await db.run(INSERT.into(`${NS}.TransactionOutputs`).entries({ txSeq: 65536, outputIndex: output.outputIndex, address_address: output.address }));
    }
    return { hash: fetched.hash };
  }),
  fetchAddress: vi.fn(async (db: Db, address: string): Promise<unknown> => { probe(db); return { address }; }),
  fetchAddressUtxos: vi.fn(async () => []),
  storeAddress: vi.fn(async (db: Db, fetched: { address: string }) => addressRow(db, fetched.address)),
  storeAddressFromUtxos: vi.fn(async (db: Db, address: string) => addressRow(db, address)),
  fetchAccount: vi.fn(async (db: Db, stakeAddress: string) => {
    probe(db);
    return { account: { stakeaddress: stakeAddress, addresses: accountAddresses, poolId: POOL, drepId: null } };
  }),
  // the row the real storeAccount writes: the count and the sorted list of the addresses
  storeAccount: vi.fn(async (db: Db, fetched: { account: { stakeaddress: string; addresses: string[]; poolId: string | null } }) => {
    const list = accountAddressList(fetched.account.addresses);
    const row = { stakeAddress: fetched.account.stakeaddress, addressCount: list.length, poolId_poolId: fetched.account.poolId, ...slice() };
    await db.run(INSERT.into(`${NS}.Accounts`).entries({ ...row, addressList: JSON.stringify(list) }));
    return row;
  }),
  fetchBlock: vi.fn(async (db: Db, hash: string): Promise<{ block: { hash: string; epoch: number }; epoch?: Record<string, unknown> }> => {
    probe(db);
    return { block: { hash, epoch: 7 } };
  }),
  storeBlock: vi.fn(async (db: Db, fetched: { block: { hash: string; epoch: number } }) => {
    const row = { hash: fetched.block.hash, epochNumber: fetched.block.epoch };
    await db.run(INSERT.into(`${NS}.Blocks`).entries(row));
    return row;
  }),
  fetchPool: vi.fn(async (db: Db, poolId: string) => { probe(db); return { poolId }; }),
  storePool: vi.fn(async (db: Db, fetched: { poolId: string }) => {
    const row = { poolId: fetched.poolId, ...slice() };
    await db.run(INSERT.into(`${NS}.Pools`).entries(row));
    return row;
  }),
  indexProtocolParameters: vi.fn(async (): Promise<unknown> => undefined),
  fetchEpoch: vi.fn(async (epoch: number): Promise<Record<string, unknown>> => { held.push(false); return { epoch, blockCount: 21600 }; }),
  storeEpoch: vi.fn(async (db: Db, row: Record<string, unknown>) => {
    const final = { ...row, final: true };
    await db.run(DELETE.from(`${NS}.Epochs`).where({ epoch: row.epoch }));
    await db.run(INSERT.into(`${NS}.Epochs`).entries(final));
    return final;
  }),
  indexAddressTransactions: vi.fn(async () => []),
};
let accountAddresses: string[] = [];
type FakeTx = { hash: string; inputs?: Array<{ address: string | null }>; outputs?: Array<{ outputIndex: number; address: string }> };
const POOL = 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r';

vi.mock('../../srv/server', () => ({ getCardanoIndexer: () => fake }));

async function addressRow(db: Db, address: string) {
  const row = { address, stakeAddress: STAKE, ...slice() };
  await db.run(INSERT.into(`${NS}.Addresses`).entries(row));
  return row;
}

let srv: cds.Service;
const nav = (entity: string, where: Record<string, string>, to: string) => SELECT.from({
  ref: [{ id: `${SRV}.${entity}`, where: Object.entries(where).flatMap(([k, v], i) => [...(i ? ['and'] : []), { ref: [k] }, '=', { val: v }]) }, to],
} as never);

beforeAll(async () => {
  const csn = await cds.load([path.resolve(__dirname, '../../db'), path.resolve(__dirname, '../../srv/cardano-service.cds')]);
  const model = cds.linked(cds.compile.for.nodejs(csn as never) as never);
  cds.model = model as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await (cds as unknown as { deploy: (m: unknown) => { to: (d: unknown) => Promise<unknown> } }).deploy(csn).to(db);
  srv = new cds.ApplicationService(SRV, model as never);
  await srv.init();
  const mod = await import('../../srv/cardano-service') as unknown as { default?: (s: cds.Service) => void } & ((s: cds.Service) => void);
  const impl = mod.default ?? mod;
  // ahead of CAP's own read handler
  srv.prepend(() => impl(srv));
});

beforeEach(async () => {
  vi.clearAllMocks();
  accountAddresses = [];
  held.length = 0;
  for (const e of ['Transactions', 'TransactionInputs', 'TransactionOutputs', 'Addresses', 'Accounts', 'Epochs', 'Blocks', 'Pools', 'LedgerProtocolParameters']) await cds.run(DELETE.from(`${NS}.${e}`));
});

describe('the stored address list of an account', () => {
  it('is unique and sorted, and reads back only a list of strings', () => {
    expect(accountAddressList(['b', 'a', 'b'])).toEqual(['a', 'b']);
    expect(parseAccountAddressList(JSON.stringify(['b', 'a']))).toEqual(['a', 'b']);
    for (const bad of [null, undefined, '', 'not json', '{}', '[1]', 42]) expect(parseAccountAddressList(bad)).toBeNull();
  });
});

describe('navigationOf', () => {
  it('names the parent, its keys and the navigation', () => {
    expect(navigationOf({ query: nav('Transactions', { hash: H }, 'inputs') } as never)).toEqual({ parent: 'Transactions', keys: { hash: H }, nav: 'inputs', navKeys: null, depth: 2, steps: ['inputs'] });
    expect(navigationOf({ query: SELECT.from(`${SRV}.Transactions`) } as never)).toBeNull();
  });
});

describe('navigation reads index their parent', () => {
  it('Transactions(h)/inputs reads the transaction once and answers its inputs', async () => {
    const rows = await srv.run(nav('Transactions', { hash: H }, 'inputs')) as unknown[];
    expect(rows).toHaveLength(1);
    expect(fake.fetchTransaction).toHaveBeenCalledTimes(1);
    await srv.run(nav('Transactions', { hash: H }, 'inputs'));
    expect(fake.fetchTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid parent key with 400', async () => {
    await expect(srv.run(nav('Transactions', { hash: 'nope' }, 'inputs'))).rejects.toMatchObject({ status: 400, code: 'ODATANO_INVALID_INPUT' });
    expect(fake.fetchTransaction).not.toHaveBeenCalled();
  });

  it('reads an address from its UTxOs when no backend aggregates addresses, and writes its row', async () => {
    fake.fetchAddress.mockRejectedValueOnce(new AllBackendsFailedError([]));
    await srv.run(nav('Addresses', { address: ADDR }, 'utxos'));
    expect(fake.fetchAddressUtxos).toHaveBeenCalledWith(ADDR);
    expect(fake.storeAddressFromUtxos).toHaveBeenCalledTimes(1);
    expect(await cds.run(SELECT.one.from(`${NS}.Addresses`).where({ address: ADDR }))).toBeTruthy();
  });
});

describe('a navigation through an input or output to its address', () => {
  const txWithAddresses: FakeTx = { hash: H, inputs: [{ address: ADDR }], outputs: [{ outputIndex: 0, address: ADDR }] };
  const deep = (step: 'inputs' | 'outputs', ...rest: string[]) => SELECT.from({ ref: [
    { id: `${SRV}.Transactions`, where: [{ ref: ['hash'] }, '=', { val: H }] },
    { id: step, where: [{ ref: ['txSeq'] }, '=', { val: 65536 }, 'and', { ref: [step === 'inputs' ? 'inputIndex' : 'outputIndex'] }, '=', { val: 0 }] },
    'address',
    ...rest,
  ] } as never);

  it('indexes the address of an input of a transaction not stored yet, asking the backend before the first write', async () => {
    fake.fetchTransaction.mockImplementationOnce(async (db: Db) => { probe(db); return txWithAddresses; });
    const rows = await srv.run(deep('inputs')) as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([ADDR]);
    expect(fake.fetchAddress).toHaveBeenCalledWith(expect.anything(), ADDR);
    expect(held).toEqual([false, false]);
  });

  it('indexes the address of an output of a stored transaction, and the paths below it', async () => {
    await fake.storeTransaction(cds.db as unknown as Db, txWithAddresses);
    const rows = await srv.run(deep('outputs', 'utxos')) as unknown[];
    expect(rows).toEqual([]);
    expect(fake.fetchTransaction).not.toHaveBeenCalled();
    expect(fake.fetchAddress).toHaveBeenCalledTimes(1);
    expect(await cds.run(SELECT.one.from(`${NS}.Addresses`).where({ address: ADDR }))).toBeTruthy();
  });

  it('indexes the address of TransactionInputs(…)/address', async () => {
    await fake.storeTransaction(cds.db as unknown as Db, txWithAddresses);
    const rows = await srv.run(SELECT.from({ ref: [
      { id: `${SRV}.TransactionInputs`, where: [{ ref: ['txSeq'] }, '=', { val: 65536 }, 'and', { ref: ['inputIndex'] }, '=', { val: 0 }] },
      'address',
    ] } as never)) as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([ADDR]);
  });
});

describe('the addresses of an account', () => {
  const many = Array.from({ length: 12 }, (_, i) => `${ADDR.slice(0, -2)}${String(i).padStart(2, '0')}`);

  it('needs $top of at most 10 when the account has more addresses', async () => {
    accountAddresses = many;
    await expect(srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address'))).rejects.toMatchObject({ status: 400, code: 'ODATANO_INVALID_INPUT' });
    expect(fake.fetchAddress).not.toHaveBeenCalled();
  });

  it('indexes exactly the asked page, in address order', async () => {
    accountAddresses = [...many].reverse();
    const rows = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').limit(2, 1)) as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([...many].sort().slice(1, 3));
    expect(fake.fetchAddress).toHaveBeenCalledTimes(2);
    expect(fake.storeAccount).toHaveBeenCalledTimes(1);
  });

  it('indexes all addresses of a small account without $top', async () => {
    accountAddresses = many.slice(0, 2);
    const rows = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address')) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('asks the backend only while the request holds no connection', async () => {
    accountAddresses = many.slice(0, 3);
    await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address'));
    expect(fake.fetchAccount).toHaveBeenCalledTimes(1);
    expect(fake.fetchAddress).toHaveBeenCalledTimes(3);
    expect(held).toEqual([false, false, false, false]);
  });

  it('reads a stored account with all its addresses without the backend', async () => {
    accountAddresses = many.slice(0, 3);
    await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address'));
    await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address'));
    expect(fake.fetchAccount).toHaveBeenCalledTimes(1);
    expect(fake.fetchAddress).toHaveBeenCalledTimes(3);
  });

  it('counts every address of the account, for /$count and for $count with a page', async () => {
    accountAddresses = many;
    const counted = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').columns({ func: 'count', args: ['*'], as: '$count' } as never)) as Array<{ $count: unknown }>;
    expect(Number(counted[0].$count)).toBe(12);
    expect(fake.fetchAddress).not.toHaveBeenCalled();
    const query = nav('Accounts', { stakeAddress: STAKE }, 'Address').limit(2);
    (query as unknown as { SELECT: { count: boolean } }).SELECT.count = true;
    const page = await srv.run(query) as unknown[] & { $count?: unknown };
    expect(page).toHaveLength(2);
    expect(Number(page.$count)).toBe(12);
  });

  it('follows $orderby on the address and refuses $filter on a large account', async () => {
    accountAddresses = many;
    const rows = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').orderBy('address desc').limit(2, 1)) as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([...many].sort().reverse().slice(1, 3));
    await expect(srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').where({ stakeAddress: STAKE }).limit(2)))
      .rejects.toMatchObject({ status: 400, code: 'ODATANO_INVALID_INPUT' });
  });

  it('applies $filter as written on a small account', async () => {
    accountAddresses = many.slice(0, 3);
    const rows = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').where({ address: many[1] })) as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([many[1]]);
  });

  it('indexes the one address a keyed read names, and only one of the account', async () => {
    accountAddresses = many;
    const keyed = (address: string, ...rest: string[]) => SELECT.from({ ref: [
      { id: `${SRV}.Accounts`, where: [{ ref: ['stakeAddress'] }, '=', { val: STAKE }] },
      { id: 'Address', where: [{ ref: ['address'] }, '=', { val: address }] },
      ...rest,
    ] } as never);
    expect(await srv.run(keyed(many[4]))).toHaveLength(1);
    expect(fake.fetchAddress).toHaveBeenCalledTimes(1);
    expect(await srv.run(keyed(ADDR))).toHaveLength(0);
    expect(fake.fetchAddress).toHaveBeenCalledTimes(1);
    expect(await srv.run(keyed(many[4], 'utxos'))).toEqual([]);
  });

  it('indexes the page of $expand=Address on a keyed read built with cds.ql', async () => {
    accountAddresses = many.slice(0, 2);
    const row = await srv.run(SELECT.one.from({ ref: [{ id: `${SRV}.Accounts`, where: [{ ref: ['stakeAddress'] }, '=', { val: STAKE }] }] } as never)
      .columns('stakeAddress', { ref: ['Address'], expand: ['*'] } as never)) as { Address: unknown[] };
    expect(row.Address).toHaveLength(2);
  });

  it('reads further pages of a large account from its stored address list, without the backend', async () => {
    accountAddresses = many;
    await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').limit(2));
    const rows = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').limit(2, 6)) as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([...many].sort().slice(6, 8));
    expect(fake.fetchAccount).toHaveBeenCalledTimes(1);
    const stored = await cds.run(SELECT.one.from(`${NS}.Accounts`).columns('addressList').where({ stakeAddress: STAKE })) as { addressList: string };
    expect(parseAccountAddressList(stored.addressList)).toEqual([...many].sort());
  });

  it('asks the backend again once the account row has expired', async () => {
    accountAddresses = many;
    await cds.run(INSERT.into(`${NS}.Accounts`).entries({
      stakeAddress: STAKE, addressCount: 12, addressList: JSON.stringify(many),
      validFrom: new Date(Date.now() - 7_200_000).toISOString(), validTo: new Date(Date.now() - 3_600_000).toISOString(),
    }));
    await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'Address').limit(2));
    expect(fake.fetchAccount).toHaveBeenCalledTimes(1);
  });

  it('counts the account total for $expand=Address($count=true) on a large account', async () => {
    accountAddresses = many;
    const row = await srv.run(SELECT.one.from({ ref: [{ id: `${SRV}.Accounts`, where: [{ ref: ['stakeAddress'] }, '=', { val: STAKE }] }] } as never)
      .columns('stakeAddress', { ref: ['Address'], expand: [{ ref: ['address'] }], limit: { rows: { val: 2 }, offset: { val: 10 } }, count: true } as never)) as Record<string, unknown> & { Address: Array<{ address: string }> };
    expect(row.Address.map((a) => a.address)).toEqual([...many].sort().slice(10, 12));
    expect(Number(row['Address@odata.count'])).toBe(12);
  });

  it('indexes the pool of $expand=poolId on a keyed Accounts read', async () => {
    const row = await srv.run(SELECT.one.from({ ref: [{ id: `${SRV}.Accounts`, where: [{ ref: ['stakeAddress'] }, '=', { val: STAKE }] }] } as never)
      .columns('stakeAddress', { ref: ['poolId'], expand: ['*'] } as never)) as { poolId: { poolId: string } | null };
    expect(row.poolId?.poolId).toBe(POOL);
    expect(fake.fetchPool).toHaveBeenCalledTimes(1);
    expect(fake.fetchAccount).toHaveBeenCalledTimes(1);
    expect(held).toEqual([false, false]);
  });

  it('indexes the pool an account delegates to', async () => {
    const rows = await srv.run(nav('Accounts', { stakeAddress: STAKE }, 'poolId')) as Array<{ poolId: string }>;
    expect(rows.map((r) => r.poolId)).toEqual([POOL]);
    expect(fake.fetchPool).toHaveBeenCalledWith(expect.anything(), POOL);
    expect(held).toEqual([false, false]);
  });
});

describe('the epoch of a block', () => {
  it('indexes the block and its epoch, asking the backend before the first write', async () => {
    const rows = await srv.run(nav('Blocks', { hash: H }, 'epoch')) as Array<{ epoch: number }>;
    expect(rows.map((r) => r.epoch)).toEqual([7]);
    expect(fake.fetchBlock).toHaveBeenCalledTimes(1);
    expect(fake.fetchEpoch).toHaveBeenCalledWith(7);
    expect(held).toEqual([false, false]);
  });

  it('indexes the epoch of $expand=epoch on a keyed Blocks read', async () => {
    await cds.run(INSERT.into(`${NS}.Blocks`).entries({ hash: H, epochNumber: 7 }));
    const row = await srv.run(SELECT.one.from({ ref: [{ id: `${SRV}.Blocks`, where: [{ ref: ['hash'] }, '=', { val: H }] }] } as never)
      .columns('hash', { ref: ['epoch'], expand: ['*'] } as never)) as { epoch: { epoch: number } | null };
    expect(row.epoch?.epoch).toBe(7);
    expect(fake.fetchEpoch).toHaveBeenCalledWith(7);
  });

  it('refreshes the epoch of a stored block while it is not final', async () => {
    await cds.run(INSERT.into(`${NS}.Blocks`).entries({ hash: H, epochNumber: 7 }));
    await cds.run(INSERT.into(`${NS}.Epochs`).entries({ epoch: 7, blockCount: 1, final: false }));
    const rows = await srv.run(nav('Blocks', { hash: H }, 'epoch')) as Array<{ blockCount: number }>;
    expect(rows.map((r) => r.blockCount)).toEqual([21600]);
    expect(fake.fetchBlock).not.toHaveBeenCalled();
  });
});

describe('protocol parameters', () => {
  it('answer the stored rows when the backend cannot answer', async () => {
    await cds.run(INSERT.into(`${NS}.LedgerProtocolParameters`).entries({ network: 'preview', epoch: 500, minFeeA: 44 }));
    fake.indexProtocolParameters.mockRejectedValueOnce(new Error('backend down'));
    const rows = await srv.run(SELECT.from(`${SRV}.LedgerProtocolParameters`)) as Array<{ epoch: number }>;
    expect(rows.map((r) => r.epoch)).toEqual([500]);
  });

  it('fail when nothing is stored and the backend cannot answer', async () => {
    fake.indexProtocolParameters.mockRejectedValueOnce(new Error('backend down'));
    await expect(srv.run(SELECT.from(`${SRV}.LedgerProtocolParameters`))).rejects.toBeTruthy();
  });
});

describe('epoch rows', () => {
  // the keyed form an OData key segment parses to
  const read = (epoch: number) => srv.run(SELECT.one.from({ ref: [{ id: `${SRV}.Epochs`, where: [{ ref: ['epoch'] }, '=', { val: epoch }] }] } as never));

  it('refreshes a row that is not final, and leaves a final one alone', async () => {
    await cds.run(INSERT.into(`${NS}.Epochs`).entries({ epoch: 5, blockCount: 100, final: false }));
    expect(await read(5)).toMatchObject({ blockCount: 21600, final: true });
    expect(fake.fetchEpoch).toHaveBeenCalledTimes(1);
    await read(5);
    expect(fake.fetchEpoch).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored row when the backend cannot answer', async () => {
    await cds.run(INSERT.into(`${NS}.Epochs`).entries({ epoch: 6, blockCount: 100 }));
    fake.fetchEpoch.mockRejectedValueOnce(new Error('historic epoch'));
    expect(await read(6)).toMatchObject({ blockCount: 100 });
  });

  it('GetEpochByNumber answers the stored row, as a second call does', async () => {
    const first = await srv.send('GetEpochByNumber', { epochNumber: 7 });
    expect(first).toMatchObject({ epoch: 7, blockCount: 21600, final: true });
  });
});

describe('address watch', () => {
  it('a short waitMs waits that long, and two watchers share their reads', async () => {
    const started = Date.now();
    const watch = () => srv.send('GetLatestTransactionsByAddress', { address: ADDR, sinceTime: 0, waitMs: 300 });
    await Promise.all([watch(), watch()]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    // one shared read at the start and one at the deadline
    expect(fake.indexAddressTransactions).toHaveBeenCalledTimes(2);
  });
});
