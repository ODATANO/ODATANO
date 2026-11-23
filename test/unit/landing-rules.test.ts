/**
 * The landing rules end to end, on the real model in an in-memory SQLite with the real job store,
 * the real tracker and real transaction bytes. The backend is a fake with an Ogmios-like ledger.
 * "On chain" needs positive evidence; "never lands" needs the expiry passed and an unspent input.
 */
import cds from '@sap/cds';
import path from 'path';
import { Cbor, CborArray, CborMap, CborUInt, CborBytes, CborSimple } from '@harmoniclabs/cbor';
import { ConfirmationTracker } from '../../srv/blockchain/wallet-worker/confirmation-tracker';
import * as jobs from '../../srv/blockchain/wallet-worker/job-store';
import { attemptSubmit } from '../../srv/blockchain/signing/submission-finalizer';
import { getTxHashFromCbor } from '../../srv/utils/tx-build-helper';
import { NotFoundError, ProviderUnavailableError } from '../../srv/utils/errors';
import { PROVIDER_LAG_SLOTS, settleSlots } from '../../srv/blockchain/signing/landing-proof';

const SETTLE_SLOTS = settleSlots('preview');

const ADDRESS = Buffer.from('60' + 'ab'.repeat(28), 'hex');

/** Signed transaction bytes with the given inputs, expiry and number of outputs. */
function tx(inputs: Array<[string, number]>, ttl: number | null, outputs = 2): string {
  const body: Array<{ k: CborUInt; v: CborArray | CborUInt }> = [
    { k: new CborUInt(0), v: new CborArray(inputs.map(([h, i]) => new CborArray([new CborBytes(Buffer.from(h, 'hex')), new CborUInt(i)]))) },
    { k: new CborUInt(1), v: new CborArray(Array.from({ length: outputs }, () => new CborArray([new CborBytes(ADDRESS), new CborUInt(2_000_000)]))) },
    { k: new CborUInt(2), v: new CborUInt(170_000) },
  ];
  if (ttl !== null) body.push({ k: new CborUInt(3), v: new CborUInt(ttl) });
  return Buffer.from(Cbor.encode(new CborArray([new CborMap(body), new CborMap([]), new CborSimple(true), new CborSimple(null)]))).toString('hex');
}

/** A ledger the fake backend answers from: the tip and the unspent outputs. */
interface Ledger { tip: number; height: number; unspent: Set<string> }

function ogmiosOnly(chain: Ledger) {
  const unspent = (h: string, i: number) => chain.unspent.has(`${h}#${i}`);
  return {
    network: 'preview' as const,
    supports: (m: string) => m !== 'getTransaction',
    getLatestBlock: async () => ({ height: chain.height, slot: chain.tip }),
    getCurrentSlot: async () => chain.tip,
    isUtxoUnspent: async (h: string, i: number) => unspent(h, i),
    readLedger: async (refs: Array<{ txHash: string; outputIndex: number }>) => ({ live: true, tip: chain.tip, unspent: refs.map(r => unspent(r.txHash, r.outputIndex)) }),
    submitTransaction: async () => { throw new ProviderUnavailableError('down', 'ogmios'); },
  };
}

const indexer = { findCrawledTransaction: async () => null };

beforeAll(async () => {
  const csn = await cds.load([path.resolve(__dirname, '../../db'), path.resolve(__dirname, '../../srv')]);
  cds.model = cds.linked(cds.compile.for.nodejs(csn) as never) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await (cds as unknown as { deploy: (m: unknown) => { to: (d: unknown) => Promise<unknown> } }).deploy(csn).to(db);
  await cds.tx((t) => jobs.upsertWalletRegistration(t, { walletId: 'w', signerType: 'software', address: 'addr_test1w', publicKeyHash: 'ab'.repeat(28) }));
});

async function submittedJob(cbor: string): Promise<{ jobId: string; txHash: string }> {
  const txHash = getTxHashFromCbor(cbor);
  const { jobId } = await cds.tx((t) => jobs.insertJob(t, { walletId: 'w', kind: 'submitSigned', request: JSON.stringify({ n: txHash }) }));
  await cds.tx(async (t) => {
    await jobs.markBuilding(t, jobId, 1);
    await jobs.markSubmitting(t, jobId, { txHash, unsignedTxCbor: null, signedTxCbor: cbor, fee: null });
    await jobs.markSubmitted(t, jobId, txHash);
  });
  return { jobId, txHash };
}

function trackerFor(chain: Ledger) {
  const finals: Array<{ outcome: string }> = [];
  const tracker = new ConfirmationTracker({
    client: ogmiosOnly(chain) as never,
    indexer: indexer as never,
    options: { confirmationDepth: 3, confirmationTimeoutMs: 600_000, pollIntervalMs: 100_000, resubmitOnRollback: false },
    onFinal: (j) => finals.push(j),
  });
  return { tracker, finals };
}

const status = async (jobId: string) => (await cds.tx((t) => jobs.getJobById(t, jobId)))!.status;

describe('Ogmios-only confirmation needs an own output seen unspent', () => {
  it('never confirms a job whose only input another transaction spent', async () => {
    const cbor = tx([['11'.repeat(32), 0]], 5000);
    const { jobId, txHash } = await submittedJob(cbor);
    const chain: Ledger = { tip: 100, height: 10, unspent: new Set(['11'.repeat(32) + '#0']) };
    const { tracker, finals } = trackerFor(chain);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    await tracker.pollOnce();
    chain.unspent.clear();
    for (let h = 11; h <= 14; h++) { chain.height = h; chain.tip += 20; await tracker.pollOnce(); }
    tracker.stop();
    expect(await status(jobId)).toBe('submitted');
    expect(finals).toEqual([]);
  });

  it('never confirms a job whose input comes from a parent the ledger does not know', async () => {
    const cbor = tx([['22'.repeat(32), 0]], 5000);
    const { jobId, txHash } = await submittedJob(cbor);
    const chain: Ledger = { tip: 100, height: 10, unspent: new Set() };
    const { tracker } = trackerFor(chain);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    for (let h = 10; h <= 13; h++) { chain.height = h; await tracker.pollOnce(); }
    tracker.stop();
    expect(await status(jobId)).toBe('submitted');
  });

  it('confirms once an own output was seen, counting depth from that tip, while an own output stays unspent', async () => {
    const cbor = tx([['33'.repeat(32), 0]], 5000);
    const { jobId, txHash } = await submittedJob(cbor);
    const chain: Ledger = { tip: 100, height: 10, unspent: new Set() };
    const { tracker, finals } = trackerFor(chain);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    chain.unspent.add(`${txHash}#1`);
    await tracker.pollOnce();
    chain.height = 11; await tracker.pollOnce();
    expect(await status(jobId)).toBe('submitted');
    chain.height = 12; await tracker.pollOnce();
    tracker.stop();
    expect(await status(jobId)).toBe('confirmed');
    expect(finals).toEqual([expect.objectContaining({ outcome: 'confirmed' })]);
  });

  it('drops the inclusion when every own output and input is spent before the depth: that shows nothing about who spent them', async () => {
    const cbor = tx([['38'.repeat(32), 0]], 5000);
    const { jobId, txHash } = await submittedJob(cbor);
    const chain: Ledger = { tip: 100, height: 10, unspent: new Set() };
    const { tracker, finals } = trackerFor(chain);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    chain.unspent.add(`${txHash}#1`);
    await tracker.pollOnce();
    // spent by the recipient, or rolled back with a conflicting spend of the same input: both read alike
    chain.unspent.clear();
    for (let h = 11; h <= 14; h++) { chain.height = h; await tracker.pollOnce(); }
    tracker.stop();
    expect(await status(jobId)).toBe('submitted');
    expect(finals).toEqual([]);
  });

  it('watches again when the seen output is gone and an input is unspent again', async () => {
    const cbor = tx([['44'.repeat(32), 0]], 5000);
    const { jobId, txHash } = await submittedJob(cbor);
    const chain: Ledger = { tip: 100, height: 10, unspent: new Set([`${'ab'.repeat(32)}#9`]) };
    const { tracker } = trackerFor(chain);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    chain.unspent = new Set([`${txHash}#0`]);
    await tracker.pollOnce();
    // rolled back: the output is gone and the input is unspent again
    chain.unspent = new Set(['44'.repeat(32) + '#0']);
    chain.height = 12; await tracker.pollOnce();
    chain.height = 13; await tracker.pollOnce();
    tracker.stop();
    expect(await status(jobId)).toBe('submitted');
    const job = await cds.tx((t) => jobs.getJobById(t, jobId));
    expect(job!.confirmedHeight ?? null).toBeNull();
  });
});

describe('never lands: the expiry passed and an input is unspent', () => {
  // the transaction's own outputs are spent or unknown; `inputUnspent` says how its input reads
  const lagging = (inputUnspent: boolean, tip: number, live: boolean) => ({
    network: 'preview' as const,
    supports: () => true,
    getTransaction: async () => { throw new NotFoundError('Transaction x (not in the crawled chain up to slot 900)'); },
    getCurrentSlot: async () => tip,
    isUtxoUnspent: async () => false,
    readLedger: async (refs: unknown[]) => ({ live, tip, unspent: refs.map(() => inputUnspent) }),
    submitTransaction: async () => { throw new ProviderUnavailableError('timeout', 'x'); },
  });

  it('a lagging lookup that does not know a landed transaction never makes it fail: past the horizon it is unresolved', async () => {
    const cbor = tx([['55'.repeat(32), 0]], 1000);
    const r = await attemptSubmit(cbor, getTxHashFromCbor(cbor), false, indexer as never, lagging(false, 1000 + SETTLE_SLOTS + 1, true) as never);
    expect(r.outcome).toBe('unresolved');
  });

  it('an input the node holds unspent after the expiry proves it', async () => {
    const cbor = tx([['66'.repeat(32), 0]], 1000);
    const r = await attemptSubmit(cbor, getTxHashFromCbor(cbor), false, indexer as never, lagging(true, 1000 + SETTLE_SLOTS + 1, true) as never);
    expect(r.outcome).toBe('rejected');
    expect(r.error).toMatchObject({ statusCode: 400 });
  });

  it('an indexer that says unspent counts only past the longer margin for indexers', async () => {
    const cbor = tx([['77'.repeat(32), 0]], 1000);
    const hash = getTxHashFromCbor(cbor);
    expect((await attemptSubmit(cbor, hash, false, indexer as never, lagging(true, 1000 + SETTLE_SLOTS + 1, false) as never)).outcome).toBe('unknown');
    expect((await attemptSubmit(cbor, hash, false, indexer as never, lagging(true, 1000 + SETTLE_SLOTS + PROVIDER_LAG_SLOTS + 1, false) as never)).outcome).toBe('rejected');
  });
});
