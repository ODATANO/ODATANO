/**
 * The rules that end a transaction without an expiry, on the real model in an in-memory SQLite with
 * the real job store, real transaction bytes and, for the self-transfer, the real Buildooor builder.
 */
import cds from '@sap/cds';
import path from 'path';
import crypto from 'node:crypto';
import { Cbor, CborArray, CborMap, CborUInt, CborBytes, CborSimple, type CborObj } from '@harmoniclabs/cbor';
import * as jobs from '../../srv/blockchain/wallet-worker/job-store';
import { judgeLanding, resetLandingMemory, settleSlots } from '../../srv/blockchain/signing/landing-proof';
import { InvalidationUnfundedError, checkInvalidation, invalidationDepth, sendInvalidation } from '../../srv/blockchain/wallet-worker/invalidation';
import { refuseFailedWhileItCanLand } from '../../srv/utils/resolution';
import { recheckFailed } from '../../srv/blockchain/signing/failed-recheck';
import { createWorkerSigner } from '../../srv/blockchain/wallet-worker/signers';
import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import { CardanoTransactionBuilder } from '../../srv/blockchain/cardano-tx-builder';
import { PendingSpends } from '../../srv/blockchain/pending-spends';
import { parseTransaction } from '../../srv/cbor';
import { getTxHashFromCbor } from '../../srv/utils/tx-build-helper';
import { NotFoundError, ProviderUnavailableError } from '../../srv/utils/errors';
import { posixToSlot } from '../../srv/utils/epoch-slots';
import { mockLedgerProtocolParams } from '../integration/test-fixtures';

const ADDRESS = Buffer.from('60' + 'ab'.repeat(28), 'hex');
const SETTLE = settleSlots('preview');
const LONG_AGO = Date.parse('2020-01-01T00:00:00Z');
const outRef = ([h, i]: [string, number]) => new CborArray([new CborBytes(Buffer.from(h, 'hex')), new CborUInt(i)]);

function tx(inputs: Array<[string, number]>, ttl: number | null): string {
  const body: Array<{ k: CborUInt; v: CborObj }> = [
    { k: new CborUInt(0), v: new CborArray(inputs.map(outRef)) },
    { k: new CborUInt(1), v: new CborArray([new CborArray([new CborBytes(ADDRESS), new CborUInt(2_000_000)])]) },
    { k: new CborUInt(2), v: new CborUInt(170_000) },
  ];
  if (ttl !== null) body.push({ k: new CborUInt(3), v: new CborUInt(ttl) });
  return Buffer.from(Cbor.encode(new CborArray([new CborMap(body), new CborMap([]), new CborSimple(true), new CborSimple(null)]))).toString('hex');
}

const key = (h: string, i: number) => `${h}#${i}`;

/** Ogmios alone over a ledger of unspent outpoints. */
function ledgerClient(unspent: Set<string>, tip = { slot: 10_000_000, height: 50 }, sends: string[] = []) {
  return {
    network: 'preview' as const,
    supports: (m: string) => m !== 'getTransaction',
    getLatestBlock: async () => ({ height: tip.height, slot: tip.slot }),
    isUtxoUnspent: async (h: string, i: number) => unspent.has(key(h, i)),
    readLedger: async (refs: Array<{ txHash: string; outputIndex: number }>) => ({ live: true, tip: tip.slot, unspent: refs.map(r => unspent.has(key(r.txHash, r.outputIndex))) }),
    submitTransaction: async (c: string) => { sends.push(c); throw new ProviderUnavailableError('down', 'ogmios'); },
  };
}

const noCrawl = { findCrawledTransaction: async () => null };
let indexer: CardanoIndexer;

beforeAll(async () => {
  const csn = await cds.load([path.resolve(__dirname, '../../db'), path.resolve(__dirname, '../../srv')]);
  cds.model = cds.linked(cds.compile.for.nodejs(csn) as never) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await (cds as unknown as { deploy: (m: unknown) => { to: (d: unknown) => Promise<unknown> } }).deploy(csn).to(db);
  indexer = new CardanoIndexer({ network: 'preview' } as never, {} as never);
});

beforeEach(() => resetLandingMemory());

async function wallet(walletId: string) {
  await cds.tx((t) => jobs.upsertWalletRegistration(t, { walletId, signerType: 'software', address: `addr_test1${walletId}`, publicKeyHash: 'ab'.repeat(28) }));
}

async function submittedJob(cbor: string, walletId: string, kind = 'submitSigned'): Promise<{ jobId: string; txHash: string }> {
  const txHash = getTxHashFromCbor(cbor);
  const { jobId } = await cds.tx((t) => jobs.insertJob(t, { walletId, kind: kind as never, request: JSON.stringify({ n: txHash }), createdBy: 'alice' }));
  await cds.tx(async (t) => {
    await jobs.markBuilding(t, jobId, 1);
    await jobs.markSubmitting(t, jobId, { txHash, unsignedTxCbor: null, signedTxCbor: cbor, fee: null });
    await jobs.markSubmitted(t, jobId, txHash);
    await t.run(cds.ql.UPDATE.entity('odatano.cardano.CardanoWalletJobs').set({ submittedAt: '2020-01-01T00:00:00Z' }).where({ ID: jobId }));
  });
  return { jobId, txHash };
}

const job = async (jobId: string) => (await cds.tx((t) => jobs.getJobById(t, jobId)))!;

function worker(client: unknown) {
  return import('../../srv/blockchain/wallet-worker/wallet-worker').then(({ CardanoWalletWorker }) => new CardanoWalletWorker({
    client: client as never, indexer, network: 'preview', instanceId: 'test',
    config: { enabled: true, wallets: [], maxConcurrentWallets: 1, confirmationDepth: 3, confirmationTimeoutMs: 0, pollIntervalMs: 100_000, defaultMaxAttempts: 3, resubmitOnRollback: false },
  }));
}

describe('an operator resolves as failed what can no longer land', () => {
  it('allows failed once one input is spent; refuses it only while every input is unspent', async () => {
    const cbor = tx([['a1'.repeat(32), 0], ['a2'.repeat(32), 0]], null);
    const client = (unspent: boolean[]) => ({ network: 'preview' as const, readLedger: async () => ({ live: true, tip: 1, unspent }) });
    await expect(refuseFailedWhileItCanLand('ResolveJob', 'failed', cbor, client([false, true]) as never)).resolves.toBeUndefined();
    await expect(refuseFailedWhileItCanLand('ResolveJob', 'failed', cbor, client([true, true]) as never))
      .rejects.toMatchObject({ statusCode: 409, code: 'ODATANO_OUTCOME_STILL_OPEN', message: expect.stringMatching(/every input it spends is unspent/) });
  });
});

describe('a transaction without an expiry whose inputs are partly spent', () => {
  it('never lands once that spend is older than the rollback horizon', async () => {
    const cbor = tx([['b1'.repeat(32), 0], ['b2'.repeat(32), 0]], null);
    const hash = getTxHashFromCbor(cbor);
    const tip = { slot: 10_000_000, height: 50 };
    const deps = { indexer: noCrawl as never, client: ledgerClient(new Set([key('b2'.repeat(32), 0)]), tip) as never };
    // first seen: a younger spend could still be rolled back
    expect(await judgeLanding(cbor, hash, deps, LONG_AGO)).toEqual({ verdict: 'open' });
    tip.slot += SETTLE - 1;
    expect(await judgeLanding(cbor, hash, deps, LONG_AGO)).toEqual({ verdict: 'open' });
    tip.slot += 1;
    expect(await judgeLanding(cbor, hash, deps, LONG_AGO)).toMatchObject({ verdict: 'neverLands' });
  });

  it('is stale only while every input is unspent', async () => {
    const cbor = tx([['b3'.repeat(32), 0], ['b4'.repeat(32), 0]], null);
    const unspent = new Set([key('b3'.repeat(32), 0), key('b4'.repeat(32), 0)]);
    expect(await judgeLanding(cbor, getTxHashFromCbor(cbor), { indexer: noCrawl as never, client: ledgerClient(unspent) as never }, LONG_AGO))
      .toMatchObject({ verdict: 'stale', unspentInputs: [{ txHash: 'b3'.repeat(32), outputIndex: 0 }, { txHash: 'b4'.repeat(32), outputIndex: 0 }] });
  });
});

describe('a stale job that spends no UTxO of the wallet', () => {
  it('stops holding the wallet queue and stays open, since it can still land', async () => {
    await wallet('wq');
    const cbor = tx([['c1'.repeat(32), 0]], null);
    const { jobId } = await submittedJob(cbor, 'wq');
    process.env.INVALIDATION_RULES_KEY = '09'.repeat(32);
    const signer = createWorkerSigner({ walletId: 'wq', signerType: 'software', keyEnv: 'INVALIDATION_RULES_KEY' }, 'preview');
    const client = ledgerClient(new Set([key('c1'.repeat(32), 0)]));
    const w = await worker(client);
    // the wallet holds other UTxOs, none of the job's inputs
    (w as unknown as { deps: { indexer: unknown } }).deps.indexer = Object.assign(Object.create(indexer), { resolveAddressUtxos: async () => [{ txHash: 'ff'.repeat(32), outputIndex: 0 }] });
    expect(await cds.tx((t) => jobs.walletHasActiveJob(t, 'wq'))).toBe(true);
    await (w as unknown as { handleInvalidation: (j: unknown, s: unknown) => Promise<void> }).handleInvalidation(await job(jobId), signer);
    expect(await job(jobId)).toMatchObject({ status: 'submitted', spendsNoWalletUtxo: true });
    expect(await cds.tx((t) => jobs.walletHasActiveJob(t, 'wq'))).toBe(false);
  });

  it('a job that spends a wallet UTxO keeps holding the queue', async () => {
    await wallet('wh');
    const { jobId } = await submittedJob(tx([['c2'.repeat(32), 0]], null), 'wh');
    await cds.tx((t) => jobs.markBuilding(t, jobId, 2)); // no-op on a submitted job
    expect(await cds.tx((t) => jobs.walletHasActiveJob(t, 'wh'))).toBe(true);
  });
});

describe('the stored self-transfer', () => {
  it('is sent again while it is not on chain and not expired', async () => {
    await wallet('wr');
    const { jobId } = await submittedJob(tx([['d1'.repeat(32), 0]], null), 'wr');
    const inv = tx([['d1'.repeat(32), 0]], posixToSlot('preview', Date.now() + 3_600_000));
    await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: getTxHashFromCbor(inv), signedTxCbor: inv }));
    const sends: string[] = [];
    const client = ledgerClient(new Set([key('d1'.repeat(32), 0)]), { slot: posixToSlot('preview', Date.now()), height: 50 }, sends);
    const w = await worker(client);
    // the worker holds the wallet lease while it handles the job
    await cds.tx((t) => jobs.tryAcquireWalletLease(t, 'wr', 'test'));
    const run = (w as unknown as { handleInvalidation: (j: unknown, s: unknown) => Promise<void> }).handleInvalidation.bind(w);
    await run(await job(jobId), {});
    await cds.tx((t) => jobs.tryAcquireWalletLease(t, 'wr', 'test'));
    expect(sends).toEqual([inv]);
    // the next send waits for its backoff
    await run(await job(jobId), {});
    expect(sends).toHaveLength(1);
  });

  it('is written only over the one the caller read, so two instances do not overwrite each other', async () => {
    await wallet('wg');
    const { jobId } = await submittedJob(tx([['d2'.repeat(32), 0]], null), 'wg');
    expect(await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: 'e1'.repeat(32), signedTxCbor: 'aa' }, null))).toBe(true);
    expect(await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: 'e2'.repeat(32), signedTxCbor: 'bb' }, null))).toBe(false);
    expect(await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: 'e2'.repeat(32), signedTxCbor: 'bb' }, 'e1'.repeat(32)))).toBe(true);
    expect(await job(jobId)).toMatchObject({ invalidationTxHash: 'e2'.repeat(32) });
  });

  it('counts its depth again from the tip after a rollback below the height first seen', async () => {
    await wallet('wd');
    const { jobId } = await submittedJob(tx([['d3'.repeat(32), 0]], null), 'wd');
    const inv = tx([['d3'.repeat(32), 0]], posixToSlot('preview', Date.now() + 3_600_000));
    const invHash = getTxHashFromCbor(inv);
    await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: invHash, signedTxCbor: inv }));
    const tip = { slot: 1, height: 200 };
    const client = ledgerClient(new Set([key(invHash, 0)]), tip);
    const seen = new Map([[jobId, 300]]);
    expect(await checkInvalidation({ network: 'preview', indexer: noCrawl, client } as never, await job(jobId), seen)).toBe('included');
    expect(seen.get(jobId)).toBe(200);
    tip.height = 200 + invalidationDepth('preview') - 1;
    expect(await checkInvalidation({ network: 'preview', indexer: noCrawl, client } as never, await job(jobId), seen)).toBe('confirmed');
  });
});

describe('a real self-transfer from the Buildooor builder', () => {
  const KEY_ENV = 'INVALIDATION_BUILD_KEY';
  function setup(held: Array<{ txHash: string; outputIndex: number; lovelace: string }>) {
    process.env[KEY_ENV] = crypto.randomBytes(32).toString('hex');
    const signer = createWorkerSigner({ walletId: 'wb', signerType: 'software', keyEnv: KEY_ENV }, 'preview');
    const address = signer.getAddress();
    const utxos = held.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex, address, amount: [{ unit: 'lovelace', quantity: u.lovelace }] }));
    const builder = new CardanoTransactionBuilder({
      network: 'preview', pendingSpends: new PendingSpends(),
      getAddressUtxos: async () => utxos, getProtocolParameters: async () => mockLedgerProtocolParams, getUnspentOutputs: async () => null,
    } as never);
    const sent: string[] = [];
    const deps = {
      network: 'preview' as const,
      indexer: { indexSimpleBuildResult: (_t: unknown, req: never) => builder.buildSimpleAdaTransaction(req, mockLedgerProtocolParams as never) },
      client: { submitTransaction: async (c: string) => { sent.push(c); return getTxHashFromCbor(c); } },
    };
    return { signer, deps, sent, refs: held.map(({ txHash, outputIndex }) => ({ txHash, outputIndex })) };
  }

  it('spends the input alone when it pays for itself, and sends the rest back to the wallet', async () => {
    await wallet('wb');
    const X = { txHash: 'f1'.repeat(32), outputIndex: 0 };
    const { signer, deps, sent, refs } = setup([{ ...X, lovelace: '10000000' }, { txHash: 'f2'.repeat(32), outputIndex: 1, lovelace: '50000000' }]);
    const { jobId } = await submittedJob(tx([[X.txHash, 0]], null), 'wb');
    const hash = await sendInvalidation(deps as never, await job(jobId), signer, X, { held: refs });
    const p = parseTransaction(sent[0]);
    expect(hash).toBe(getTxHashFromCbor(sent[0]));
    expect(p.inputs.map(i => key(i.txHash, i.outputIndex))).toEqual([key(X.txHash, 0)]);
    expect(p.outputs.every(o => o.address === signer.getAddress())).toBe(true);
    expect((await job(jobId)).invalidationTxCbor).toBe(sent[0]);
  });

  it('adds other wallet UTxOs when the input cannot pay alone, but never one another stale job waits on', async () => {
    const X = { txHash: 'f3'.repeat(32), outputIndex: 0 };
    const other = { txHash: 'f4'.repeat(32), outputIndex: 0 };
    const kept = { txHash: 'f5'.repeat(32), outputIndex: 0 };
    const { signer, deps, sent, refs } = setup([{ ...X, lovelace: '1100000' }, { ...other, lovelace: '50000000' }, { ...kept, lovelace: '50000000' }]);
    const { jobId } = await submittedJob(tx([[X.txHash, 0]], null), 'wb');
    await sendInvalidation(deps as never, await job(jobId), signer, X, { held: refs, keep: [kept] });
    const inputs = parseTransaction(sent[0]).inputs.map(i => key(i.txHash, i.outputIndex));
    expect(inputs).toContain(key(X.txHash, 0));
    expect(inputs).not.toContain(key(kept.txHash, 0));
  });

  it('cannot be funded when the wallet holds only a small input: a distinct error, nothing stored', async () => {
    const X = { txHash: 'f6'.repeat(32), outputIndex: 0 };
    const { signer, deps, sent, refs } = setup([{ ...X, lovelace: '1100000' }]);
    const { jobId } = await submittedJob(tx([[X.txHash, 0]], null), 'wb');
    await expect(sendInvalidation(deps as never, await job(jobId), signer, X, { held: refs })).rejects.toBeInstanceOf(InvalidationUnfundedError);
    expect(sent).toEqual([]);
    expect((await job(jobId)).invalidationTxHash).toBeNull();
  });
});

describe('re-checking failed wallet jobs', () => {
  it('a job an earlier version dropped although it landed goes back to submitted, and its submission follows', async () => {
    await wallet('wf');
    const cbor = tx([['a5'.repeat(32), 0]], null);
    const { jobId, txHash } = await submittedJob(cbor, 'wf');
    await cds.tx((t) => jobs.markFailedAfterSend(t, jobId, jobs.JOB_ERROR_CODES.TX_DROPPED, new Error('timeout')));
    await cds.run(cds.ql.INSERT.into('odatano.cardano.TransactionSubmissions').entries({ id: cds.utils.uuid(), txHash, signedTxCbor: cbor, status: 'failed' }));
    const client = { supports: () => true, getTransaction: async () => ({ hash: txHash, slot: 900, blockHeight: 18, spendsCollaterals: false }) };
    const progress = await recheckFailed({ indexer: noCrawl as never, client: client as never });
    // the submission row is restored on its own pass, the job on the next
    expect(progress).toMatchObject({ submissions: 1, jobs: 1, restored: 2 });
    expect(await job(jobId)).toMatchObject({ status: 'submitted', errorCode: null, resolution: expect.stringMatching(/re-checked .*on chain at slot 900/) });
    expect(await cds.run(cds.ql.SELECT.one.from('odatano.cardano.TransactionSubmissions').columns('status').where({ txHash }))).toMatchObject({ status: 'submitted' });
  });

  it('a found transaction whose script validity nobody reports stays failed', async () => {
    await wallet('wv');
    const cbor = tx([['a6'.repeat(32), 0]], null);
    const { jobId, txHash } = await submittedJob(cbor, 'wv');
    await cds.tx((t) => jobs.markFailedAfterSend(t, jobId, jobs.JOB_ERROR_CODES.SUBMIT_REJECTED, new Error('refused')));
    const client = { supports: () => true, getTransaction: async () => ({ hash: txHash, slot: 900, blockHeight: 18 }) };
    await recheckFailed({ indexer: noCrawl as never, client: client as never });
    expect(await job(jobId)).toMatchObject({ status: 'failed', errorCode: jobs.JOB_ERROR_CODES.SUBMIT_REJECTED });
  });

  it('a job failed for another reason is not read', async () => {
    await wallet('wo');
    const cbor = tx([['a7'.repeat(32), 0]], null);
    const { jobId, txHash } = await submittedJob(cbor, 'wo');
    await cds.tx((t) => jobs.markFailedAfterSend(t, jobId, jobs.JOB_ERROR_CODES.SCRIPT_FAILED, new Error('scripts')));
    const client = { supports: () => true, getTransaction: async () => ({ hash: txHash, slot: 900, blockHeight: 18, spendsCollaterals: false }) };
    await recheckFailed({ indexer: noCrawl as never, client: client as never });
    expect(await job(jobId)).toMatchObject({ status: 'failed' });
  });
});

describe('a lookup that fails proves nothing for the re-check', () => {
  it('leaves the job failed', async () => {
    await wallet('wl');
    const cbor = tx([['a8'.repeat(32), 0]], null);
    const { jobId } = await submittedJob(cbor, 'wl');
    await cds.tx((t) => jobs.markFailedAfterSend(t, jobId, jobs.JOB_ERROR_CODES.TX_DROPPED, new Error('timeout')));
    const client = { supports: () => true, getTransaction: async (h: string) => { throw new NotFoundError('Transaction ' + h); } };
    await recheckFailed({ indexer: noCrawl as never, client: client as never });
    expect(await job(jobId)).toMatchObject({ status: 'failed' });
  });
});
