/**
 * OgmiosBackend.openChainSync + mapOgmiosBlock/mapOgmiosTx (crawler C2c).
 * Mocks the @cardano-ogmios/client chain-sync factory, captures the message handlers
 * and drives them with fixture Ogmios payloads — asserting the BlockData/Transaction
 * mapping, ordering (nextBlock), tip propagation, skip- and error-paths.
 */

jest.mock('@sap/cds', () => ({
  log: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() })),
}));

type Handlers = {
  rollForward: (r: { block: unknown; tip: unknown }, next: () => void) => Promise<void>;
  rollBackward: (r: { point: unknown; tip?: unknown }, next: () => void) => Promise<void>;
};
const captured: {
  handlers?: Handlers;
  opts?: { sequential?: boolean };
  points?: unknown[];
  inFlight?: number;
  shutdown: jest.Mock;
} = { shutdown: jest.fn() };

jest.mock('@cardano-ogmios/client', () => ({
  createInteractionContext: jest.fn(async () => ({ socket: {} })),
  createLedgerStateQueryClient: jest.fn(),
  createTransactionSubmissionClient: jest.fn(),
  createChainSynchronizationClient: jest.fn(async (_ctx: unknown, handlers: Handlers, opts: { sequential?: boolean }) => {
    captured.handlers = handlers;
    captured.opts = opts;
    return {
      resume: jest.fn(async (points: unknown[], inFlight: number) => {
        captured.points = points;
        captured.inFlight = inFlight;
      }),
      shutdown: captured.shutdown,
    };
  }),
}));

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
    issuer: { verificationKey: 'vkeyhex' },
    transactions: [
      {
        id: 'c'.repeat(64),
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
async function openStream(cbOverrides: Partial<ChainSyncCallbacks> = {}) {
  const backend = new OgmiosBackend(NETWORK, 5000, OGMIOS_URL);
  const rolled: { block: BlockData; txs: Transaction[]; tip?: ChainPoint }[] = [];
  const rolledBack: (ChainPoint | 'origin')[] = [];
  const errors: unknown[] = [];
  const callbacks: ChainSyncCallbacks = {
    rollForward: async (block, txs, tip) => { rolled.push({ block, txs, tip }); },
    rollBackward: async (point) => { rolledBack.push(point); },
    onError: async (err) => { errors.push(err); },
    ...cbOverrides,
  };
  const handle = await backend.openChainSync({ slot: 4000, hash: 'e'.repeat(64) }, callbacks);
  return { backend, handle, rolled, rolledBack, errors };
}

describe('OgmiosBackend.openChainSync', () => {
  beforeEach(() => {
    captured.handlers = undefined;
    captured.opts = undefined;
    captured.points = undefined;
    captured.inFlight = undefined;
    captured.shutdown.mockClear();
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

  it('maps a praos block to BlockData + Transactions and requests the next block', async () => {
    const { rolled } = await openStream();
    const next = jest.fn();
    await captured.handlers!.rollForward({ block: praosBlock(), tip: { slot: 6000, id: 'f'.repeat(64), height: 120 } }, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(rolled).toHaveLength(1);

    const { block, txs, tip } = rolled[0];
    expect(block).toMatchObject({
      hash: 'a'.repeat(64),
      height: 100,
      slot: 5000,
      slotLeader: 'vkeyhex',
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
    // metadata labels mapped
    expect(tx.metadata).toEqual([{ txHash: 'c'.repeat(64), label: '721', json: { name: 'nft' } }]);
  });

  it('returns undefined metadata (not []) for metadata-less transactions', async () => {
    const { rolled } = await openStream();
    const block = praosBlock();
    delete (block.transactions as Array<Record<string, unknown>>)[0].metadata;
    await captured.handlers!.rollForward({ block, tip: 'origin' }, jest.fn());
    expect(rolled[0].txs[0].metadata).toBeUndefined();
  });

  it('passes tip=undefined when the node reports an origin tip', async () => {
    const { rolled } = await openStream();
    await captured.handlers!.rollForward({ block: praosBlock(), tip: 'origin' }, jest.fn());
    expect(rolled[0].tip).toBeUndefined();
  });

  it('skips non-praos (byron ebb/bft) blocks but still requests the next block', async () => {
    const { rolled } = await openStream();
    const next = jest.fn();
    await captured.handlers!.rollForward({ block: praosBlock({ type: 'ebb', transactions: undefined }), tip: 'origin' }, next);
    expect(rolled).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('maps rollBackward points and forwards origin as-is', async () => {
    const { rolledBack } = await openStream();
    const next = jest.fn();
    await captured.handlers!.rollBackward({ point: { slot: 4321, id: '9'.repeat(64) } }, next);
    await captured.handlers!.rollBackward({ point: 'origin' }, next);
    expect(rolledBack).toEqual([{ slot: 4321, hash: '9'.repeat(64) }, 'origin']);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('routes a rollForward callback failure to onError WITHOUT requesting the next block (deterministic stop, no silent skip)', async () => {
    const { errors } = await openStream({
      rollForward: async () => { throw new Error('persist failed'); },
    });
    const next = jest.fn();
    await captured.handlers!.rollForward({ block: praosBlock(), tip: 'origin' }, next);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('persist failed');
    expect(next).not.toHaveBeenCalled();
  });

  it('routes a rollBackward callback failure to onError without advancing', async () => {
    const { errors } = await openStream({
      rollBackward: async () => { throw new Error('reorg failed'); },
    });
    const next = jest.fn();
    await captured.handlers!.rollBackward({ point: 'origin' }, next);
    expect(errors).toHaveLength(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('close() shuts the chain-sync client down', async () => {
    const { handle } = await openStream();
    await handle.close();
    expect(captured.shutdown).toHaveBeenCalledTimes(1);
  });
});
