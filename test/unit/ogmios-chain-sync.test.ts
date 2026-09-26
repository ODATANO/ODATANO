/**
 * OgmiosBackend.openChainSync + mapOgmiosBlock/mapOgmiosTx: the chain-sync factory is mocked and
 * its message handlers driven with fixture payloads (mapping, ordering, tip, skip and error paths).
 */

vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
};
  return { default: cdsMock, ...cdsMock };
});

type Handlers = {
  rollForward: (r: { block: unknown; tip: unknown }, next: () => void) => Promise<void>;
  rollBackward: (r: { point: unknown; tip?: unknown }, next: () => void) => Promise<void>;
};
// Captured by the vi.mock factory below, which is hoisted above all
// statements — so the object itself must be hoisted too.
const captured: {
  handlers?: Handlers;
  opts?: { sequential?: boolean };
  points?: unknown[];
  inFlight?: number;
  contextError?: (err: Error) => void;
  contextClose?: (code: number, reason: Buffer) => void;
  socket: { readyState: number; OPEN: number; CLOSED: number; terminate: Mock; close: Mock };
  resume: Mock;
  shutdown: Mock;
} = vi.hoisted(() => ({
  socket: { readyState: 1, OPEN: 1, CLOSED: 3, terminate: vi.fn(), close: vi.fn() },
  resume: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('@cardano-ogmios/client', () => ({
  // the frame guard wraps this on every openChainSync; these tests drive the message
  // handlers directly, so a plain parser is enough to stand in for it
  safeJSON: { parse: (raw: unknown) => JSON.parse(String(raw)) },
  createInteractionContext: vi.fn(async (
    onError: (err: Error) => void,
    onClose: (code: number, reason: Buffer) => void,
  ) => {
    captured.contextError = onError;
    captured.contextClose = onClose;
    return { socket: captured.socket };
  }),
  createLedgerStateQueryClient: vi.fn(),
  createTransactionSubmissionClient: vi.fn(),
  createChainSynchronizationClient: vi.fn(async (_ctx: unknown, handlers: Handlers, opts: { sequential?: boolean }) => {
    captured.handlers = handlers;
    captured.opts = opts;
    return {
      resume: captured.resume,
      shutdown: captured.shutdown,
    };
  }),
}));

import type { Mock } from 'vitest';
import { createChainSynchronizationClient } from '@cardano-ogmios/client';
import { OgmiosBackend } from '../../srv/blockchain/backends/ogmios-backend';
import type { ChainSyncCallbacks, ChainPoint } from '../../srv/blockchain/backends/cardano-backend';
import type { BlockData, Transaction } from '../../srv/utils/types';

const NETWORK = 'preview' as const;
const OGMIOS_URL = 'ws://localhost:1337';

/** Minimal Ogmios Praos block fixture (Conway era). */
function praosBlock(over: Record<string, unknown> = {}) {
  return {
    type: 'praos',
    era: 'conway',
    id: 'a'.repeat(64),
    ancestor: 'b'.repeat(64),
    height: 100,
    slot: 5000,
    size: { bytes: 1234 },
    issuer: { verificationKey: 'bf55661898d4b7c66caf7106c4e45caacd8f51265cf0dc61dabf6dd12fb5d952' },
    transactions: [
      {
        id: 'c'.repeat(64),
        spends: 'inputs',
        inputs: [{ transaction: { id: 'd'.repeat(64) }, index: 1 }],
        outputs: [
          {
            address: 'addr_test1xyz',
            value: { ada: { lovelace: 2_000_000n }, ['p'.repeat(56)]: { '746f6b656e': 5n } },
            datum: 'd87980',
          },
        ],
        fee: { ada: { lovelace: 170_000n } },
        metadata: { labels: { '721': { json: { name: 'nft' } } } },
      },
    ],
    ...over,
  };
}

/** Open a stream with recording callbacks and return everything needed to drive it. */
async function openStream(cbOverrides: Partial<ChainSyncCallbacks> = {}, timeoutMs = 5000) {
  const backend = new OgmiosBackend(NETWORK, timeoutMs, OGMIOS_URL);
  const rolled: { block: BlockData; txs: Transaction[]; tip?: ChainPoint }[] = [];
  const rolledBack: (ChainPoint | 'origin')[] = [];
  const errors: unknown[] = [];
  const callbacks: ChainSyncCallbacks = {
    rollForward: async (block, txs, tip) => { rolled.push({ block, txs, tip }); },
    rollBackward: async (point) => { rolledBack.push(point); },
    onError: async (err) => { errors.push(err); },
    ...cbOverrides,
  };
  const handle = await backend.openChainSync([{ slot: 4000, hash: 'e'.repeat(64) }], callbacks);
  return { backend, handle, rolled, rolledBack, errors };
}

describe('OgmiosBackend.openChainSync', () => {
  beforeEach(() => {
    captured.handlers = undefined;
    captured.opts = undefined;
    captured.points = undefined;
    captured.inFlight = undefined;
    captured.contextError = undefined;
    captured.contextClose = undefined;
    captured.socket.readyState = 1;
    captured.socket.terminate.mockClear();
    captured.socket.close.mockClear();
    captured.resume.mockReset().mockImplementation(async (points: unknown[], inFlight: number) => {
      captured.points = points;
      captured.inFlight = inFlight;
    });
    captured.shutdown.mockReset().mockResolvedValue(undefined);
    vi.mocked(createChainSynchronizationClient).mockClear();
  });

  it('resumes sequentially from the given intersection point with inFlight=1', async () => {
    await openStream();
    expect(captured.opts).toEqual({ sequential: true });
    expect(captured.points).toEqual([{ slot: 4000, id: 'e'.repeat(64) }]);
    expect(captured.inFlight).toBe(1);
  });

  it("resumes from ['origin'] when asked to sync from genesis", async () => {
    const backend = new OgmiosBackend(NETWORK, 5000, OGMIOS_URL);
    await backend.openChainSync('origin', { rollForward: async () => {}, rollBackward: async () => {} });
    expect(captured.points).toEqual(['origin']);
  });

  it('forwards every candidate intersection point, newest first', async () => {
    // The ladder is what lets the node intersect at the last common block after a
    // reorg we slept through, instead of failing the stream outright.
    const backend = new OgmiosBackend(NETWORK, 5000, OGMIOS_URL);
    await backend.openChainSync([
      { slot: 4000, hash: 'a'.repeat(64) },
      { slot: 3999, hash: 'b'.repeat(64) },
      { slot: 3996, hash: 'c'.repeat(64) },
    ], { rollForward: async () => {}, rollBackward: async () => {} });

    expect(captured.points).toEqual([
      { slot: 4000, id: 'a'.repeat(64) },
      { slot: 3999, id: 'b'.repeat(64) },
      { slot: 3996, id: 'c'.repeat(64) },
    ]);
  });

  it('maps a praos block to BlockData + Transactions and requests the next block', async () => {
    const { rolled } = await openStream();
    const next = vi.fn();
    await captured.handlers!.rollForward({ block: praosBlock(), tip: { slot: 6000, id: 'f'.repeat(64), height: 120 } }, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(rolled).toHaveLength(1);

    const { block, txs, tip } = rolled[0];
    expect(block).toMatchObject({
      hash: 'a'.repeat(64),
      height: 100,
      slot: 5000,
      slotLeader: 'pool1p0mrcmu9qn0x6nk4eunj0p8qy3tryv370a96u9su2l6jwkytnru', // blake2b-224 of the issuer key
      size: 1234,
      txCount: 1,
      fees: '170000', // sum of per-tx fees
    });
    expect(typeof block.time).toBe('number');
    expect(typeof block.epoch).toBe('number');
    expect(typeof block.epochSlot).toBe('number');

    expect(tip).toEqual({ slot: 6000, hash: 'f'.repeat(64), height: 120 });

    expect(txs).toHaveLength(1);
    const tx = txs[0];
    expect(tx).toMatchObject({
      hash: 'c'.repeat(64),
      blockHash: 'a'.repeat(64),
      blockHeight: 100,
      slot: 5000,
      index: 0,
      fee: '170000',
      deposit: '0',
    });
    // inputs are bare references — resolved later by the indexer (resolveInputs)
    expect(tx.inputs).toEqual([{ address: '', amount: [], txHash: 'd'.repeat(64), outputIndex: 1 }]);
    // outputs carry lovelace + native assets via convertOgmiosValue
    expect(tx.outputs[0].address).toBe('addr_test1xyz');
    expect(tx.outputs[0].amount).toEqual(expect.arrayContaining([
      { unit: 'lovelace', quantity: '2000000' },
      { unit: `${'p'.repeat(56)}746f6b656e`, quantity: '5' },
    ]));
    expect(tx.outputs[0].inlineDatum).toBe('d87980');
    expect(tx.outputs[0].referenceScriptHash).toBeNull();
    // metadata labels mapped
    expect(tx.metadata).toEqual([{ txHash: 'c'.repeat(64), label: '721', json: { name: 'nft' } }]);
  });

  it('hashes an output reference script', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    (block.transactions as Array<{ outputs: Array<Record<string, unknown>> }>)[0].outputs[0].script =
      { language: 'native', json: {}, cbor: '830301818200581cc1baff904af9856e688bd19fc0cdb723c34a3cef8e1caf42f8ef265d' };
    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    expect(rolled[0].txs[0].outputs[0].referenceScriptHash).toBe('bfa7584bb6fca4ba58a9b7a5acb7ed046b0bfeab1c737651c447dc5c');
  });

  it('returns undefined metadata (not []) for metadata-less transactions', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    delete (block.transactions as Array<Record<string, unknown>>)[0].metadata;
    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());
    expect(rolled[0].txs[0].metadata).toBeUndefined();
  });

  it('maps collateral and reference declarations on a successful transaction', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.collaterals = [{ transaction: { id: '1'.repeat(64) }, index: 2 }];
    tx.references = [{ transaction: { id: '2'.repeat(64) }, index: 3 }];
    tx.collateralReturn = {
      address: 'addr_test1ignored',
      value: { ada: { lovelace: 1_000_000n } },
    };

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    expect(rolled[0].txs[0].inputs).toEqual([
      { address: '', amount: [], txHash: 'd'.repeat(64), outputIndex: 1 },
      { address: '', amount: [], txHash: '1'.repeat(64), outputIndex: 2, isCollateral: true },
      { address: '', amount: [], txHash: '2'.repeat(64), outputIndex: 3, isReference: true },
    ]);
    expect(rolled[0].txs[0].outputs).toHaveLength(1);
    expect(rolled[0].txs[0].outputs[0].isCollateral).toBe(false);
  });

  it('uses only consumed collaterals and collateral return when spends=collaterals', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.spends = 'collaterals';
    tx.collaterals = [{ transaction: { id: '1'.repeat(64) }, index: 2 }];
    tx.references = [{ transaction: { id: '2'.repeat(64) }, index: 3 }];
    tx.collateralReturn = {
      address: 'addr_test1return',
      value: { ada: { lovelace: 1_500_000n } },
      datumHash: '3'.repeat(64),
    };

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    const mapped = rolled[0].txs[0];
    // The declared regular input/output are phantom ledger effects on phase-2 failure.
    expect(mapped.inputs).toEqual([
      { address: '', amount: [], txHash: '1'.repeat(64), outputIndex: 2, isCollateral: true },
      { address: '', amount: [], txHash: '2'.repeat(64), outputIndex: 3, isReference: true },
    ]);
    expect(mapped.outputs).toEqual([expect.objectContaining({
      address: 'addr_test1return',
      amount: [{ unit: 'lovelace', quantity: '1500000' }],
      // Collateral return follows the one declared regular output in UTxO indexing.
      outputIndex: 1,
      dataHash: '3'.repeat(64),
      isCollateral: true,
    })]);
  });

  it('charges the declared total_collateral, not the body fee, when spends=collaterals', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.spends = 'collaterals';
    tx.collaterals = [{ transaction: { id: '1'.repeat(64) }, index: 2 }];
    tx.collateralReturn = { address: 'addr_test1return', value: { ada: { lovelace: 1_500_000n } } };
    tx.totalCollateral = { ada: { lovelace: 3_000_000n } };

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    const mapped = rolled[0].txs[0];
    // The ledger took the collateral; the body's 170_000 was never collected.
    expect(mapped.fee).toBe('3000000');
    expect(mapped.spendsCollaterals).toBe(true);
    expect(mapped.totalCollateral).toBe('3000000');
    expect(rolled[0].block.fees).toBe('3000000');
  });

  it('leaves the body fee for the indexer when a phase-2 failure declares no total_collateral', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.spends = 'collaterals';
    tx.collaterals = [{ transaction: { id: '1'.repeat(64) }, index: 2 }];

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    const mapped = rolled[0].txs[0];
    // Nothing better is known here — the collateral inputs are bare references at map time.
    expect(mapped.fee).toBe('170000');
    expect(mapped.spendsCollaterals).toBe(true);
    expect(mapped.totalCollateral).toBeNull();
  });

  it('keeps the declared fee on a successful transaction that only declares collateral', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.collaterals = [{ transaction: { id: '1'.repeat(64) }, index: 2 }];
    tx.totalCollateral = { ada: { lovelace: 3_000_000n } };

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    const mapped = rolled[0].txs[0];
    // Collateral is only declared here, never consumed — the fee is the fee.
    expect(mapped.fee).toBe('170000');
    expect(mapped.spendsCollaterals).toBe(false);
    expect(rolled[0].block.fees).toBe('170000');
  });

  it('passes tip=undefined when the node reports an origin tip', async () => {
    const { rolled } = await openStream();
    await captured.handlers!.rollForward({ block: praosBlock(), tip: 'origin' }, vi.fn());
    expect(rolled[0].tip).toBeUndefined();
  });

  it('skips non-praos (byron ebb/bft) blocks but still requests the next block', async () => {
    const { rolled } = await openStream();
    const next = vi.fn();
    await captured.handlers!.rollForward({ block: praosBlock({ type: 'ebb', transactions: undefined }), tip: 'origin' }, next);
    expect(rolled).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('maps rollBackward points and forwards origin as-is', async () => {
    const { rolledBack } = await openStream();
    const next = vi.fn();
    await captured.handlers!.rollBackward({ point: { slot: 4321, id: '9'.repeat(64) } }, next);
    await captured.handlers!.rollBackward({ point: 'origin' }, next);
    expect(rolledBack).toEqual([{ slot: 4321, hash: '9'.repeat(64) }, 'origin']);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('routes a rollForward callback failure to onError WITHOUT requesting the next block (deterministic stop, no silent skip)', async () => {
    const { errors } = await openStream({
      rollForward: async () => { throw new Error('persist failed'); },
    });
    const next = vi.fn();
    await captured.handlers!.rollForward({ block: praosBlock(), tip: 'origin' }, next);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('persist failed');
    expect(next).not.toHaveBeenCalled();
  });

  it('routes a rollBackward callback failure to onError without advancing', async () => {
    const { errors } = await openStream({
      rollBackward: async () => { throw new Error('reorg failed'); },
    });
    const next = vi.fn();
    await captured.handlers!.rollBackward({ point: 'origin' }, next);
    expect(errors).toHaveLength(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('routes an unexpected context error to onError and suppresses the following close duplicate', async () => {
    const { errors } = await openStream();
    captured.contextError!(new Error('socket exploded'));
    captured.contextClose!(1006, Buffer.from('abnormal closure'));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('socket exploded');
  });

  it('routes an unexpected context close to onError', async () => {
    const { errors } = await openStream();
    captured.contextClose!(1006, Buffer.from('node restart'));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: 'ProviderUnavailableError',
      statusCode: 503,
      message: expect.stringContaining('node restart'),
    });
  });

  it('cleans up the context when chain-sync client creation fails', async () => {
    vi.mocked(createChainSynchronizationClient).mockRejectedValueOnce(new Error('client open failed'));

    await expect(openStream()).rejects.toThrow('client open failed');
    expect(captured.socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled resume and releases the socket', async () => {
    captured.resume.mockImplementationOnce(() => new Promise(() => undefined));

    await expect(openStream({}, 10)).rejects.toThrow(/timeout.*chainSync\/resume/i);
    expect(captured.shutdown).toHaveBeenCalledTimes(1);
    expect(captured.socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('close() shuts the chain-sync client down', async () => {
    const { handle, errors } = await openStream();
    await handle.close();
    // The library invokes this during shutdown; it must not look like an outage.
    captured.contextClose!(1000, Buffer.from('normal closure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(captured.shutdown).toHaveBeenCalledTimes(1);
    expect(captured.socket.terminate).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('bounds a stalled close, force-releases the socket, and remains idempotent', async () => {
    const { handle } = await openStream({}, 10);
    captured.shutdown.mockImplementationOnce(() => new Promise(() => undefined));

    const first = handle.close();
    const second = handle.close();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/timeout.*chainSync\/shutdown/i);
    expect(captured.shutdown).toHaveBeenCalledTimes(1);
    expect(captured.socket.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('OgmiosBackend chain-sync — mint/burn field', () => {
  beforeEach(() => {
    captured.handlers = undefined;
    captured.opts = undefined;
  });

  const POLICY = 'p'.repeat(56);
  const NAME_HEX = '746f6b656e';

  it('maps the mint field with its sign preserved (negative = burn)', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.mint = { [POLICY]: { [NAME_HEX]: 1000n, '': -25n } };

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    expect(rolled[0].txs[0].mint).toEqual([
      { unit: `${POLICY}${NAME_HEX}`, quantity: '1000' },
      { unit: POLICY, quantity: '-25' },
    ]);
  });

  it('reports an empty mint (not undefined) for a transaction that mints nothing', async () => {
    const { rolled } = await openStream();

    await captured.handlers!.rollForward({ block: praosBlock(), tip: 'origin' }, vi.fn());

    // [] means "the source knows there was no mint" — undefined would make the indexer
    // fall back to the input/output delta, which chain-sync inputs cannot support
    expect(rolled[0].txs[0].mint).toEqual([]);
  });

  it('reports NO mint for a phase-2 failure — the declared mint is never applied', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    tx.spends = 'collaterals';
    tx.mint = { [POLICY]: { [NAME_HEX]: 1000n } };

    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());

    expect(rolled[0].txs[0].mint).toBeUndefined();
  });
});

describe('OgmiosBackend chain-sync — certificates and withdrawals (crawler.certificates)', () => {
  beforeEach(() => {
    captured.handlers = undefined;
    captured.opts = undefined;
  });

  const CRED = '9084d6174b028be3b346f5eb11e0a8bf889a7e464447f7973605c886';
  const DREP_HASH = 'bed9febc46ee63fa370bbc65446c067d61adcc46d8094e372694666b';
  const POOL = 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r';

  async function roll(certificates?: unknown[], withdrawals?: Record<string, unknown>) {
    const { rolled } = await openStream();
    const block = praosBlock();
    const tx = (block.transactions as Array<Record<string, unknown>>)[0];
    if (certificates) tx.certificates = certificates;
    if (withdrawals) tx.withdrawals = withdrawals;
    await captured.handlers!.rollForward({ block, tip: 'origin' }, vi.fn());
    return rolled[0].txs[0];
  }

  it('reports [] (known empty), never undefined, for a transaction without them', async () => {
    const tx = await roll();
    expect(tx.certificates).toEqual([]);
    expect(tx.withdrawals).toEqual([]);
  });

  it('re-encodes stake credentials as bech32 (preview → stake_test1…) and keeps the deposit', async () => {
    const tx = await roll([
      { type: 'stakeCredentialRegistration', credential: CRED, from: 'verificationKey', deposit: { ada: { lovelace: 2_000_000n } } },
      { type: 'stakeCredentialDeregistration', credential: CRED, from: 'verificationKey' },
    ]);
    expect(tx.certificates).toEqual([
      { certIndex: 0, kind: 'stake_registration', stakeAddress: expect.stringMatching(/^stake_test1/), deposit: '2000000' },
      { certIndex: 1, kind: 'stake_deregistration', stakeAddress: expect.stringMatching(/^stake_test1/), deposit: null },
    ]);
    // same credential → same reward account on both rows
    expect(tx.certificates![0].stakeAddress).toBe(tx.certificates![1].stakeAddress);
  });

  it('splits a Conway stake+vote delegation into pool_delegation + vote_delegation with ONE certIndex', async () => {
    const tx = await roll([
      {
        type: 'stakeDelegation', credential: CRED, from: 'verificationKey',
        stakePool: { id: POOL },
        delegateRepresentative: { type: 'registered', id: DREP_HASH, from: 'verificationKey' },
      },
    ]);
    expect(tx.certificates).toEqual([
      { certIndex: 0, kind: 'pool_delegation', stakeAddress: expect.stringMatching(/^stake_test1/), poolId: POOL },
      { certIndex: 0, kind: 'vote_delegation', stakeAddress: expect.stringMatching(/^stake_test1/), drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0' },
    ]);
  });

  it('names the predefined DReps the way Koios does', async () => {
    const tx = await roll([
      { type: 'stakeDelegation', credential: CRED, from: 'verificationKey', delegateRepresentative: { type: 'abstain' } },
      { type: 'stakeDelegation', credential: CRED, from: 'script', delegateRepresentative: { type: 'noConfidence' } },
    ]);
    expect(tx.certificates!.map(c => c.drepId)).toEqual(['drep_always_abstain', 'drep_always_no_confidence']);
    // a script credential encodes to a different reward account than the key one
    expect(tx.certificates![0].stakeAddress).not.toBe(tx.certificates![1].stakeAddress);
  });

  it('maps pool and DRep lifecycle certificates, incl. the retirement epoch', async () => {
    const tx = await roll([
      { type: 'stakePoolRegistration', stakePool: { id: POOL, vrfVerificationKeyHash: 'x' } },
      { type: 'stakePoolRetirement', stakePool: { id: POOL, retirementEpoch: 321 } },
      { type: 'delegateRepresentativeRegistration', delegateRepresentative: { type: 'registered', id: DREP_HASH, from: 'script' }, deposit: { ada: { lovelace: 500_000_000n } } },
      { type: 'delegateRepresentativeUpdate', delegateRepresentative: { type: 'registered', id: DREP_HASH, from: 'verificationKey' } },
      { type: 'delegateRepresentativeRetirement', delegateRepresentative: { type: 'registered', id: DREP_HASH, from: 'verificationKey' }, deposit: { ada: { lovelace: 500_000_000n } } },
    ]);
    expect(tx.certificates).toEqual([
      { certIndex: 0, kind: 'pool_registration', poolId: POOL },
      { certIndex: 1, kind: 'pool_retirement', poolId: POOL, epoch: 321 },
      { certIndex: 2, kind: 'drep_registration', drepId: expect.stringMatching(/^drep1/), deposit: '500000000' },
      { certIndex: 3, kind: 'drep_update', drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0' },
      { certIndex: 4, kind: 'drep_retirement', drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0', deposit: '500000000' },
    ]);
    // script DRep (0x23 header) ≠ key DRep (0x22) for the same hash
    expect(tx.certificates![2].drepId).not.toBe(tx.certificates![3].drepId);
  });

  it('passes an unknown certificate type through as the raw kind instead of dropping it', async () => {
    const tx = await roll([
      { type: 'constitutionalCommitteeDelegation', member: {}, delegate: {} },
      { type: 'somethingNewFromTheNextEra', foo: 1 },
    ]);
    expect(tx.certificates).toEqual([
      { certIndex: 0, kind: 'committee_hot_auth' },
      { certIndex: 1, kind: 'somethingNewFromTheNextEra' },
    ]);
  });

  it('maps the withdrawals record (reward account → lovelace)', async () => {
    const tx = await roll(undefined, {
      stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn: { ada: { lovelace: 123_456n } },
    });
    expect(tx.withdrawals).toEqual([
      { stakeAddress: 'stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn', amount: '123456' },
    ]);
  });
});
