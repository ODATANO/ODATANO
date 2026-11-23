/**
 * What counts as evidence for the outcome of a sent transaction, on the real model in an in-memory
 * SQLite with the real job store, tracker and indexer and real transaction bytes. A stored row counts
 * only inside the crawled chain; a landing with failing scripts is its own outcome; past the last
 * moment a transaction could land without evidence the record is unresolved, never failed.
 */
import cds from '@sap/cds';
import path from 'path';
import { Cbor, CborArray, CborMap, CborUInt, CborBytes, CborSimple, type CborObj } from '@harmoniclabs/cbor';
import { ConfirmationTracker } from '../../srv/blockchain/wallet-worker/confirmation-tracker';
import * as jobs from '../../srv/blockchain/wallet-worker/job-store';
import { attemptSubmit } from '../../srv/blockchain/signing/submission-finalizer';
import { judgeLanding, isFinalRefusal, isExpired, outputsToCheck, resetLandingMemory, sendProblem, settleSlots } from '../../srv/blockchain/signing/landing-proof';
import { checkInvalidation, invalidationDepth, sendInvalidation } from '../../srv/blockchain/wallet-worker/invalidation';
import { refuseFailedWhileItCanLand } from '../../srv/utils/resolution';
import { recheckFailed } from '../../srv/blockchain/signing/failed-recheck';
import { createWorkerSigner } from '../../srv/blockchain/wallet-worker/signers';
import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';
import { BlockfrostBackend } from '../../srv/blockchain/backends/blockfrost-backend';
import { OdatanoBackend } from '../../srv/blockchain/backends/odatano-backend';
import { getTxHashFromCbor } from '../../srv/utils/tx-build-helper';
import { NotFoundError, ProviderUnavailableError, TransactionValidationError } from '../../srv/utils/errors';
import { posixToSlot } from '../../srv/utils/epoch-slots';

const ADDRESS = Buffer.from('60' + 'ab'.repeat(28), 'hex');
const SETTLE = settleSlots('preview');
/** A slot well inside the wall clock, so the expiry has passed for the clock as well. */
const OLD_TTL = 1000;

const outRef = ([h, i]: [string, number]) => new CborArray([new CborBytes(Buffer.from(h, 'hex')), new CborUInt(i)]);

/** Signed transaction bytes. Collateral adds body keys 13 and 16 (its return). */
function tx(inputs: Array<[string, number]>, ttl: number | null, opts: { outputs?: number; isValid?: boolean; collateral?: Array<[string, number]> } = {}): string {
  const outputs = opts.outputs ?? 2;
  const body: Array<{ k: CborUInt; v: CborObj }> = [
    { k: new CborUInt(0), v: new CborArray(inputs.map(outRef)) },
    { k: new CborUInt(1), v: new CborArray(Array.from({ length: outputs }, () => new CborArray([new CborBytes(ADDRESS), new CborUInt(2_000_000)]))) },
    { k: new CborUInt(2), v: new CborUInt(170_000) },
  ];
  if (ttl !== null) body.push({ k: new CborUInt(3), v: new CborUInt(ttl) });
  if (opts.collateral) {
    body.push({ k: new CborUInt(13), v: new CborArray(opts.collateral.map(outRef)) });
    body.push({ k: new CborUInt(16), v: new CborArray([new CborBytes(ADDRESS), new CborUInt(3_000_000)]) });
  }
  return Buffer.from(Cbor.encode(new CborArray([new CborMap(body), new CborMap([]), new CborSimple(opts.isValid ?? true), new CborSimple(null)]))).toString('hex');
}

/** A ledger the fake backend answers from. */
interface Ledger { tip: number; height: number; unspent: Set<string> }

/** Ogmios alone: no transaction lookup, the ledger answers. */
function ogmiosOnly(chain: Ledger, sends: { n: number } = { n: 0 }) {
  const unspent = (h: string, i: number) => chain.unspent.has(`${h}#${i}`);
  return {
    network: 'preview' as const,
    supports: (m: string) => m !== 'getTransaction',
    getLatestBlock: async () => ({ height: chain.height, slot: chain.tip }),
    isUtxoUnspent: async (h: string, i: number) => unspent(h, i),
    readLedger: async (refs: Array<{ txHash: string; outputIndex: number }>) => ({ live: true, tip: chain.tip, unspent: refs.map(r => unspent(r.txHash, r.outputIndex)) }),
    submitTransaction: async () => { sends.n++; throw new ProviderUnavailableError('down', 'ogmios'); },
  };
}

let indexer: CardanoIndexer;
const noCrawl = { findCrawledTransaction: async () => null };

beforeAll(async () => {
  const csn = await cds.load([path.resolve(__dirname, '../../db'), path.resolve(__dirname, '../../srv')]);
  cds.model = cds.linked(cds.compile.for.nodejs(csn) as never) as typeof cds.model;
  const db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await (cds as unknown as { deploy: (m: unknown) => { to: (d: unknown) => Promise<unknown> } }).deploy(csn).to(db);
  await cds.tx((t) => jobs.upsertWalletRegistration(t, { walletId: 'w', signerType: 'software', address: 'addr_test1w', publicKeyHash: 'ab'.repeat(28) }));
  indexer = new CardanoIndexer({ network: 'preview' } as never, {} as never);
});

async function submittedJob(cbor: string, idempotencyKey?: string, walletId = 'w'): Promise<{ jobId: string; txHash: string }> {
  const txHash = getTxHashFromCbor(cbor);
  const { jobId } = await cds.tx((t) => jobs.insertJob(t, { walletId, kind: 'submitSigned', request: JSON.stringify({ n: txHash }), idempotencyKey, createdBy: 'alice' }));
  await cds.tx(async (t) => {
    await jobs.markBuilding(t, jobId, 1);
    await jobs.markSubmitting(t, jobId, { txHash, unsignedTxCbor: null, signedTxCbor: cbor, fee: null });
    await jobs.markSubmitted(t, jobId, txHash);
  });
  return { jobId, txHash };
}

function trackerFor(client: unknown, idx: unknown = noCrawl) {
  const finals: Array<{ outcome: string; errorCode?: string }> = [];
  const tracker = new ConfirmationTracker({
    client: client as never,
    indexer: idx as never,
    options: { confirmationDepth: 3, confirmationTimeoutMs: 0, pollIntervalMs: 100_000, resubmitOnRollback: false },
    onFinal: (j) => finals.push(j),
  });
  return { tracker, finals };
}

const job = async (jobId: string) => (await cds.tx((t) => jobs.getJobById(t, jobId)))!;

/** A crawled chain: a synced cursor with a live lease over [from, last]. */
async function crawl(from: number, last: number) {
  await cds.run(cds.ql.UPSERT.into('odatano.cardano.CardanoSyncState').entries({
    ID: 'SINGLETON', network: 'preview', startSlot: from, lastSlot: last, lastHeight: 100, tipHeight: 100, syncStatus: 'synced',
    desiredRunning: true, leaseOwner: 'me', leaseUntil: new Date(Date.now() + 60_000).toISOString(), nodeBehindSince: null,
  }));
}

async function storeTx(hash: string, slot: number, opts: { block?: boolean; inputs?: Array<{ isCollateral: boolean; isReference: boolean }> } = {}) {
  const blockHash = hash.slice(0, 2).repeat(32);
  const txSeq = slot * 65536;
  await cds.run(cds.ql.INSERT.into('odatano.cardano.Transactions').entries({ hash, slot, txSeq, blockHeight: 90, blockHash }));
  if (opts.block !== false) await cds.run(cds.ql.INSERT.into('odatano.cardano.Blocks').entries({ hash: blockHash, slot, height: 90 }));
  for (const [i, input] of (opts.inputs ?? []).entries()) {
    await cds.run(cds.ql.INSERT.into('odatano.cardano.TransactionInputs').entries({ txSeq, inputIndex: i, ...input }));
  }
}

describe('a stored row is evidence only inside the crawled chain', () => {
  it('a lazily stored row outside the crawl, or without its block, proves nothing', async () => {
    await crawl(5000, 6000);
    await storeTx('a1'.repeat(32), 4000);
    await storeTx('a2'.repeat(32), 5500, { block: false });
    expect(await cds.tx((t) => indexer.findCrawledTransaction(t, 'a1'.repeat(32)))).toBeNull();
    expect(await cds.tx((t) => indexer.findCrawledTransaction(t, 'a2'.repeat(32)))).toBeNull();
  });

  it('a crawled row with its block counts, and a failed script phase shows in its inputs', async () => {
    await crawl(5000, 6000);
    await storeTx('a3'.repeat(32), 5600, { inputs: [{ isCollateral: false, isReference: false }] });
    await storeTx('a4'.repeat(32), 5700, { inputs: [{ isCollateral: true, isReference: false }, { isCollateral: false, isReference: true }] });
    expect(await cds.tx((t) => indexer.findCrawledTransaction(t, 'a3'.repeat(32)))).toMatchObject({ blockHeight: 90, spendsCollaterals: false });
    expect(await cds.tx((t) => indexer.findCrawledTransaction(t, 'a4'.repeat(32)))).toMatchObject({ spendsCollaterals: true });
  });

  it('a worker job with a stale row and every backend answering 404 is not confirmed', async () => {
    const cbor = tx([['b1'.repeat(32), 0]], posixToSlot('preview', Date.now() + 3_600_000));
    const { jobId, txHash } = await submittedJob(cbor);
    // the row was stored by a lookup, then its block rolled back: no crawl covers it
    await cds.run(cds.ql.DELETE.from('odatano.cardano.CardanoSyncState'));
    await storeTx(txHash, 500);
    const client = {
      network: 'preview' as const,
      supports: () => true,
      getLatestBlock: async () => ({ height: 20, slot: 900 }),
      getTransaction: async () => { throw new NotFoundError(`Transaction ${txHash}`); },
      isUtxoUnspent: async () => false,
      readLedger: async (refs: unknown[]) => ({ live: true, tip: 900, unspent: refs.map(() => true) }),
      submitTransaction: async () => { throw new ProviderUnavailableError('x', 'blockfrost'); },
    };
    const { tracker } = trackerFor(client, indexer);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    for (let i = 0; i < 3; i++) await tracker.pollOnce();
    tracker.stop();
    expect((await job(jobId)).status).toBe('submitted');
  });
});

describe('a landing with failing scripts', () => {
  it('is told by its unspent collateral return, not as never landing', async () => {
    const cbor = tx([['c1'.repeat(32), 0]], OLD_TTL, { isValid: false, collateral: [['c2'.repeat(32), 0]] });
    const hash = getTxHashFromCbor(cbor);
    // landed with failing scripts: the body input untouched, the collateral spent, its return (output #2) unspent
    const chain: Ledger = { tip: OLD_TTL + SETTLE + 1, height: 10, unspent: new Set(['c1'.repeat(32) + '#0', `${hash}#2`]) };
    expect(await judgeLanding(cbor, hash, { indexer: noCrawl as never, client: ogmiosOnly(chain) as never })).toMatchObject({ verdict: 'scriptFailed' });
  });

  it('is a failed worker job of its own code when a lookup reports it', async () => {
    const cbor = tx([['c3'.repeat(32), 0]], posixToSlot('preview', Date.now() + 3_600_000));
    const { jobId, txHash } = await submittedJob(cbor);
    const client = {
      network: 'preview' as const,
      supports: () => true,
      getLatestBlock: async () => ({ height: 20, slot: 900 }),
      getTransaction: async () => ({ hash: txHash, slot: 800, blockHeight: 18, spendsCollaterals: true }),
      isUtxoUnspent: async () => false,
      readLedger: async (refs: unknown[]) => ({ live: true, tip: 900, unspent: refs.map(() => false) }),
      submitTransaction: async () => undefined,
    };
    const { tracker, finals } = trackerFor(client);
    tracker.start();
    tracker.track({ jobId, walletId: 'w', kind: 'submitSigned', txHash, signedTxCbor: cbor });
    await tracker.pollOnce();
    tracker.stop();
    expect(await job(jobId)).toMatchObject({ status: 'failed', errorCode: jobs.JOB_ERROR_CODES.SCRIPT_FAILED });
    expect(finals).toEqual([expect.objectContaining({ outcome: 'failed', errorCode: 'SCRIPT_FAILED' })]);
  });

  it('is never sent: bytes marked to fail their scripts are refused', () => {
    const cbor = tx([['c4'.repeat(32), 0]], posixToSlot('preview', Date.now() + 3_600_000), { isValid: false, collateral: [['c5'.repeat(32), 0]] });
    expect(sendProblem(cbor, 'preview')).toMatch(/isValid false/);
  });
});

describe('past the last moment it could land, without evidence: unresolved', () => {
  it('a landed transaction whose outputs are spent is unresolved, and is not sent past its expiry', async () => {
    const cbor = tx([['d1'.repeat(32), 0]], OLD_TTL);
    const sends = { n: 0 };
    const chain: Ledger = { tip: OLD_TTL + SETTLE + 1, height: 10, unspent: new Set() };
    const r = await attemptSubmit(cbor, getTxHashFromCbor(cbor), true, noCrawl as never, ogmiosOnly(chain, sends) as never);
    expect(r.outcome).toBe('unresolved');
    expect(sends.n).toBe(0);
  });

  it('stays open before the horizon has passed', async () => {
    const cbor = tx([['d2'.repeat(32), 0]], OLD_TTL);
    const chain: Ledger = { tip: OLD_TTL + SETTLE, height: 10, unspent: new Set(['d2'.repeat(32) + '#0']) };
    expect((await attemptSubmit(cbor, getTxHashFromCbor(cbor), false, noCrawl as never, ogmiosOnly(chain) as never)).outcome).toBe('unknown');
  });

  it('a worker job without an expiry and an unspent input stays open: it can still land, and its wallet waits', async () => {
    const cbor = tx([['d3'.repeat(32), 0]], null);
    await cds.tx((t) => jobs.upsertWalletRegistration(t, { walletId: 'w2', signerType: 'software', address: 'addr_test1w2', publicKeyHash: 'cd'.repeat(28) }));
    const { jobId, txHash } = await submittedJob(cbor, 'invoice-stale', 'w2');
    const chain: Ledger = { tip: 10_000_000, height: 20, unspent: new Set(['d3'.repeat(32) + '#0']) };
    const stale: unknown[] = [];
    const sends = { n: 0 };
    const tracker = new ConfirmationTracker({
      client: ogmiosOnly(chain, sends) as never, indexer: noCrawl as never,
      options: { confirmationDepth: 3, confirmationTimeoutMs: 0, pollIntervalMs: 100_000, resubmitOnRollback: false },
      onStale: (_j, inputs) => stale.push(inputs),
    });
    tracker.start();
    tracker.track({ jobId, walletId: 'w2', kind: 'submitSigned', txHash, signedTxCbor: cbor, submittedAt: '2020-01-01T00:00:00Z' });
    await tracker.pollOnce();
    tracker.stop();
    expect((await job(jobId)).status).toBe('submitted');
    expect(stale).toEqual([[{ txHash: 'd3'.repeat(32), outputIndex: 0 }]]);
    expect(sends.n).toBe(0); // the old bytes are not sent again; the worker spends an input instead
    expect(await cds.tx((t) => jobs.walletHasActiveJob(t, 'w2'))).toBe(true);
  });

  it('a transaction without an expiry is unresolved only once its inputs stay spent past the horizon', async () => {
    resetLandingMemory();
    const cbor = tx([['d5'.repeat(32), 0]], null);
    const hash = getTxHashFromCbor(cbor);
    const chain: Ledger = { tip: 10_000_000, height: 20, unspent: new Set() };
    const deps = { indexer: noCrawl as never, client: ogmiosOnly(chain) as never };
    const longAgo = Date.parse('2020-01-01T00:00:00Z');
    // first seen spent: a younger spend could still be rolled back
    expect(await judgeLanding(cbor, hash, deps, longAgo)).toEqual({ verdict: 'open' });
    chain.tip += SETTLE - 1;
    expect(await judgeLanding(cbor, hash, deps, longAgo)).toEqual({ verdict: 'open' });
    chain.tip += 1;
    expect(await judgeLanding(cbor, hash, deps, longAgo)).toMatchObject({ verdict: 'unresolved' });
  });

  it('an operator resolves it, and the note stays on the job', async () => {
    const cbor = tx([['d4'.repeat(32), 0]], null);
    const { jobId } = await submittedJob(cbor);
    await cds.tx((t) => jobs.markUnresolved(t, jobId, new Error('no evidence')));
    expect(await cds.tx((t) => jobs.resolveUnresolvedJob(t, jobId, 'confirmed', 'confirmed by admin at now: seen on an explorer'))).toBe(true);
    expect(await job(jobId)).toMatchObject({ status: 'confirmed', resolution: 'confirmed by admin at now: seen on an explorer' });
    expect(await cds.tx((t) => jobs.resolveUnresolvedJob(t, jobId, 'failed', 'again'))).toBe(false);
  });
});

describe('a lookup that cannot answer proves nothing', () => {
  it('stays open even when the ledger would say never lands', async () => {
    const cbor = tx([['e1'.repeat(32), 0]], OLD_TTL);
    const client = {
      ...ogmiosOnly({ tip: OLD_TTL + SETTLE + 1, height: 10, unspent: new Set(['e1'.repeat(32) + '#0']) }),
      supports: () => true,
      getTransaction: async () => { throw new ProviderUnavailableError('timeout', 'koios'); },
    };
    expect(await judgeLanding(cbor, getTxHashFromCbor(cbor), { indexer: noCrawl as never, client: client as never })).toEqual({ verdict: 'open' });
  });
});

describe('backends', () => {
  it('Blockfrost reads a collateral output as unknown, since consumed_by_tx is always null there', async () => {
    const b = new BlockfrostBackend('preview' as never, 1000, 'previewKEY' as never);
    (b as unknown as { api: unknown }).api = { txsUtxos: async () => ({ outputs: [
      { output_index: 0, collateral: false, consumed_by_tx: null },
      { output_index: 1, collateral: true, consumed_by_tx: null },
    ] }) };
    expect(await b.isUtxoUnspent('aa'.repeat(32), 0)).toBe(true);
    expect(await b.isUtxoUnspent('aa'.repeat(32), 1)).toBe(false);
  });

  it('another ODATANO keeps the JSON-RPC code of a node refusal, so it is classified as a node refusal is', () => {
    const backend = new OdatanoBackend('preview' as never, 1000, 'https://remote.example' as never, 'oda_key' as never);
    const message = '[ODATANO_TX_VALIDATION_FAILED] SubmitTransaction: node rejected the transaction (3100): Some signatures are invalid.';
    const err = (backend as unknown as { mapError: (op: string, e: unknown) => Error }).mapError('SubmitTransaction', {
      isAxiosError: true, message, response: { status: 400, data: { error: { message, code: 'ODATANO_TX_VALIDATION_FAILED' } } },
    });
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(isFinalRefusal(err)).toBe(true);
    const spent = (backend as unknown as { mapError: (op: string, e: unknown) => Error }).mapError('SubmitTransaction', {
      isAxiosError: true, message: 'x', response: { status: 400, data: { error: { message: 'node rejected the transaction (3117): unknown inputs', code: 'ODATANO_TX_VALIDATION_FAILED' } } },
    });
    expect(isFinalRefusal(spent)).toBe(false);
  });
});

describe('the expiry boundary', () => {
  it('bytes are valid only while the slot is below their TTL', () => {
    const now = Date.now();
    const slot = posixToSlot('preview', now);
    const atTtl = tx([['f1'.repeat(32), 0]], slot);
    expect(isExpired(atTtl, 'preview', now)).toBe(true);
    expect(sendProblem(atTtl, 'preview', now)).toMatch(/expired at slot/);
    expect(isExpired(tx([['f1'.repeat(32), 0]], slot + 1), 'preview', now)).toBe(false);
  });

  it('landing evidence reads the last output, where the builder puts the change, and the first ones', () => {
    expect(outputsToCheck(0)).toEqual([]);
    expect(outputsToCheck(3)).toEqual([2, 0, 1]);
    expect(outputsToCheck(150)).toEqual([149, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('a transaction without an expiry is ended by spending one of its inputs', () => {
  const KEY_ENV = 'LANDING_EVIDENCE_TEST_KEY';
  beforeAll(() => { process.env[KEY_ENV] = '07'.repeat(32); });
  afterAll(() => { delete process.env[KEY_ENV]; });

  it('the self-transfer is signed, stored before it is sent, and spends an input the wallet holds', async () => {
    const signer = createWorkerSigner({ walletId: 'w3', signerType: 'software', keyEnv: KEY_ENV }, 'preview');
    const old = tx([['f2'.repeat(32), 0]], null);
    const { jobId } = await submittedJob(old);
    // the builder's answer: a self-transfer spending the forced input, with an expiry
    const unsigned = tx([['f2'.repeat(32), 0]], posixToSlot('preview', Date.now() + 3_600_000));
    const builds: unknown[] = [];
    const sent: string[] = [];
    const deps = {
      network: 'preview' as const,
      indexer: {
        resolveAddressUtxos: async () => [{ txHash: 'f2'.repeat(32), outputIndex: 0 }],
        indexSimpleBuildResult: async (_t: unknown, req: unknown) => { builds.push(req); return { unsignedTxCbor: unsigned, txBodyHash: getTxHashFromCbor(unsigned) }; },
      },
      client: { submitTransaction: async (c: string) => { sent.push(c); return getTxHashFromCbor(c); } },
    };
    const hash = await sendInvalidation(deps as never, await job(jobId), signer, { txHash: 'f2'.repeat(32), outputIndex: 0 });
    expect(hash).toBe(getTxHashFromCbor(unsigned));
    expect(builds).toEqual([expect.objectContaining({
      forceInputs: [{ txHash: 'f2'.repeat(32), outputIndex: 0 }], recipientAddress: signer.getAddress(), changeAddress: signer.getAddress(),
    })]);
    const stored = await job(jobId);
    expect(stored).toMatchObject({ status: 'submitted', invalidationTxHash: hash });
    expect(sent).toEqual([stored.invalidationTxCbor]);
  });

  it('counts once the self-transfer is deeper than k blocks, and asks for a new one once it can no longer land', async () => {
    const inv = tx([['f3'.repeat(32), 0]], OLD_TTL);
    const invHash = getTxHashFromCbor(inv);
    const { jobId } = await submittedJob(tx([['f3'.repeat(32), 0]], null));
    await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: invHash, signedTxCbor: inv }));
    const k = invalidationDepth('preview');
    const chain = { height: 100 + k - 2, found: true };
    const client = {
      network: 'preview' as const,
      supports: () => true,
      getLatestBlock: async () => ({ height: chain.height, slot: OLD_TTL + SETTLE + 10 }),
      getTransaction: async () => {
        if (chain.found) return { hash: invHash, slot: 900, blockHeight: 100 };
        throw new NotFoundError('Transaction ' + invHash);
      },
      // its own outputs are not there, the input it spends is unspent
      isUtxoUnspent: async (h: string) => h !== invHash,
      readLedger: async (refs: unknown[]) => ({ live: true, tip: OLD_TTL + SETTLE + 10, unspent: refs.map(() => true) }),
    };
    const deps = { network: 'preview' as const, indexer: noCrawl, client };
    const seen = new Map<string, number>();
    expect(await checkInvalidation(deps as never, await job(jobId), seen)).toBe('included');
    chain.height = 100 + k - 1;
    expect(await checkInvalidation(deps as never, await job(jobId), seen)).toBe('confirmed');
    // not on chain, expired, its input still unspent: it can never land, a new one is due
    chain.found = false;
    expect(await checkInvalidation(deps as never, await job(jobId), seen)).toBe('retry');
  });
});

describe('an operator cannot resolve as failed what can still land', () => {
  const client = (unspent: boolean) => ({ network: 'preview' as const, readLedger: async (refs: unknown[]) => ({ live: true, tip: 1, unspent: refs.map(() => unspent) }) });

  it('refuses failed with 409 while the bytes are not expired and an input is unspent', async () => {
    const live = tx([['f4'.repeat(32), 0]], null);
    await expect(refuseFailedWhileItCanLand('ResolveJob', 'failed', live, client(true) as never)).rejects.toMatchObject({ statusCode: 409, code: 'ODATANO_OUTCOME_STILL_OPEN' });
    await expect(refuseFailedWhileItCanLand('ResolveJob', 'failed', live, client(false) as never)).resolves.toBeUndefined();
    await expect(refuseFailedWhileItCanLand('ResolveJob', 'confirmed', live, client(true) as never)).resolves.toBeUndefined();
  });

  it('allows failed for expired bytes: an unspent input then proves it never landed', async () => {
    await expect(refuseFailedWhileItCanLand('ResolveJob', 'failed', tx([['f5'.repeat(32), 0]], OLD_TTL), client(true) as never)).resolves.toBeUndefined();
  });
});

describe('failed records whose transaction is on chain', () => {
  it('go back to submitted with a note; the others stay failed', async () => {
    await crawl(5000, 6000);
    const landed = 'f6'.repeat(32);
    const missing = 'f7'.repeat(32);
    await storeTx(landed, 5800);
    const ids = { landed: cds.utils.uuid(), missing: cds.utils.uuid(), request: cds.utils.uuid() };
    await cds.run(cds.ql.INSERT.into('odatano.cardano.TransactionSubmissions').entries([
      { id: ids.landed, txHash: landed, signedTxCbor: '00', status: 'failed', errorMessage: 'refused' },
      { id: ids.missing, txHash: missing, signedTxCbor: '00', status: 'failed', errorMessage: 'refused' },
    ]));
    await cds.run(cds.ql.INSERT.into('odatano.cardano.SigningRequests').entries({
      id: ids.request, txBodyHash: landed, signedTxCbor: '00', status: 'failed', network: 'preview', submission_id: ids.landed,
    }));
    const client = { supports: () => true, getTransaction: async (h: string) => { throw new NotFoundError('Transaction ' + h); } };
    const progress = await recheckFailed({ indexer: indexer as never, client: client as never });
    expect(progress).toMatchObject({ restored: 2 });
    const rows = await cds.run(cds.ql.SELECT.from('odatano.cardano.TransactionSubmissions').columns('id', 'status', 'resolution')
      .where({ id: { in: [ids.landed, ids.missing] } })) as Array<{ id: string; status: string; resolution: string | null }>;
    expect(rows.find((r) => r.id === ids.landed)).toMatchObject({ status: 'submitted', resolution: expect.stringMatching(/re-checked .*on chain at slot 5800/) });
    expect(rows.find((r) => r.id === ids.missing)).toMatchObject({ status: 'failed', resolution: null });
    expect(await cds.run(cds.ql.SELECT.one.from('odatano.cardano.SigningRequests').columns('status').where({ id: ids.request }))).toMatchObject({ status: 'submitted' });
  });
});

describe('the worker ends a transaction without an expiry through its self-transfer', () => {
  it('fails the job as INVALIDATED once the self-transfer is past rollback depth, and the submission follows', async () => {
    const { CardanoWalletWorker } = await import('../../srv/blockchain/wallet-worker/wallet-worker');
    await cds.tx((t) => jobs.upsertWalletRegistration(t, { walletId: 'w4', signerType: 'software', address: 'addr_test1w4', publicKeyHash: 'ef'.repeat(28) }));
    const old = tx([['f8'.repeat(32), 0]], null);
    const { jobId, txHash } = await submittedJob(old, undefined, 'w4');
    await cds.tx((t) => t.run(cds.ql.UPDATE.entity('odatano.cardano.CardanoWalletJobs').set({ submittedAt: '2020-01-01T00:00:00Z' }).where({ ID: jobId })));
    await cds.run(cds.ql.INSERT.into('odatano.cardano.TransactionSubmissions').entries({ id: cds.utils.uuid(), txHash, signedTxCbor: old, status: 'submitted' }));
    const inv = tx([['f8'.repeat(32), 0]], OLD_TTL);
    const invHash = getTxHashFromCbor(inv);
    await cds.tx((t) => jobs.recordInvalidation(t, jobId, { txHash: invHash, signedTxCbor: inv }));
    const k = invalidationDepth('preview');
    const client = {
      network: 'preview' as const,
      supports: () => true,
      getLatestBlock: async () => ({ height: 100 + k, slot: 50_000 }),
      getTransaction: async (h: string) => {
        if (h === invHash) return { hash: invHash, slot: 900, blockHeight: 100 };
        throw new NotFoundError('Transaction ' + h);
      },
      // the shared input is spent, by the self-transfer
      isUtxoUnspent: async () => false,
      readLedger: async (refs: unknown[]) => ({ live: true, tip: 50_000, unspent: refs.map(() => false) }),
    };
    await crawl(5000, 6000);
    const worker = new CardanoWalletWorker({
      client: client as never, indexer, network: 'preview', instanceId: 'test',
      config: { enabled: true, wallets: [], maxConcurrentWallets: 1, confirmationDepth: 3, confirmationTimeoutMs: 0, pollIntervalMs: 100_000, defaultMaxAttempts: 3, resubmitOnRollback: false },
    });
    await (worker as unknown as { handleInvalidation: (j: unknown, s: unknown) => Promise<void> }).handleInvalidation(await job(jobId), {});
    expect(await job(jobId)).toMatchObject({ status: 'failed', errorCode: jobs.JOB_ERROR_CODES.INVALIDATED });
    expect(await cds.run(cds.ql.SELECT.one.from('odatano.cardano.TransactionSubmissions').columns('status').where({ txHash }))).toMatchObject({ status: 'failed' });
    // the wallet queue goes on
    expect(await cds.tx((t) => jobs.walletHasActiveJob(t, 'w4'))).toBe(false);
  });
});
