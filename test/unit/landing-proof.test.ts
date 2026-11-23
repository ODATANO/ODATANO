/**
 * What the chain proves about a sent transaction: on chain, landed with failing scripts, never lands,
 * unresolved, or still open. On chain needs positive evidence. Never lands needs the tip past the
 * expiry by the rollback horizon and an input still unspent, read with the tip from one source. Past
 * that point with neither, the outcome is unresolved. A lookup that cannot answer decides nothing.
 */
export {};

const { onChain, facts } = vi.hoisted(() => ({
  onChain: vi.fn(),
  facts: {
    inputs: [{ txHash: 'in', outputIndex: 0 }], outputCount: 2, ttlSlot: 1000 as number | null,
    validityStartSlot: null as number | null, outputAddresses: [] as string[],
    isValid: true, collateralInputs: [] as Array<{ txHash: string; outputIndex: number }>, hasCollateralReturn: false,
  },
}));

vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
  return { default: cdsMock, ...cdsMock };
});
vi.mock('../../srv/blockchain/transaction-presence', () => ({ findOnChain: onChain }));
vi.mock('../../srv/utils/tx-build-helper', () => ({ extractTxCacheTargets: () => facts }));

import { PROVIDER_LAG_SLOTS, settleSlots, sendProblem, hasUnspentOutput, isExpired, isFinalRefusal, judgeLanding, resetLandingMemory } from '../../srv/blockchain/signing/landing-proof';
import {
  AllBackendsFailedError, ProviderUnavailableError, RateLimitError, TransactionValidationError,
} from '../../srv/utils/errors';
import { posixToSlot } from '../../srv/utils/epoch-slots';
import { MAX_VALIDITY_MS } from '../../srv/utils/const';

const SETTLE = settleSlots('preview');
const chain = { tip: 500, live: true, unspent: new Set<string>() };
const unspent = (txHash: string, index: number) => chain.unspent.has(`${txHash}#${index}`);
const client = {
  network: 'preview' as const,
  getTransaction: vi.fn(),
  supports: vi.fn(() => true),
  isUtxoUnspent: vi.fn(async (txHash: string, index: number) => unspent(txHash, index)),
  readLedger: vi.fn(async (refs: Array<{ txHash: string; outputIndex: number }>) =>
    ({ live: chain.live, tip: chain.tip, unspent: refs.map((r) => unspent(r.txHash, r.outputIndex)) })),
};
const deps = { indexer: { findCrawledTransaction: vi.fn() }, client: client as never };
const judge = (sentAtMs: number | null = null) => judgeLanding('cbor', 'tx', deps, sentAtMs);
const expired = 1000 + SETTLE + 1;
/** Sent long enough ago that a transaction without an expiry is past every bound. */
const longAgo = () => Date.now() - MAX_VALIDITY_MS - SETTLE * 1000 - 1000;

beforeEach(() => {
  chain.tip = 500;
  chain.live = true;
  chain.unspent = new Set(['in#0']);
  Object.assign(facts, {
    inputs: [{ txHash: 'in', outputIndex: 0 }], outputCount: 2, ttlSlot: 1000, isValid: true, collateralInputs: [], hasCollateralReturn: false,
  });
  client.isUtxoUnspent.mockClear();
  client.readLedger.mockClear();
  onChain.mockReset();
  onChain.mockResolvedValue(null);
});

describe('judgeLanding', () => {
  it('is on chain when the crawled chain or a backend has it, and landed with failing scripts when that one says so', async () => {
    onChain.mockResolvedValue({ slot: 1, height: 1, scriptFailed: false });
    expect(await judge()).toEqual({ verdict: 'onChain' });
    onChain.mockResolvedValue({ slot: 1, height: 1, scriptFailed: true });
    expect(await judge()).toMatchObject({ verdict: 'scriptFailed' });
  });

  it('is on chain past the horizon when one of its own outputs is unspent, before any index caught up', async () => {
    chain.tip = expired;
    chain.unspent = new Set(['tx#1']);
    expect(await judge()).toEqual({ verdict: 'onChain' });
  });

  it('landed with failing scripts when its collateral return, the output after the others, is unspent', async () => {
    chain.tip = expired;
    Object.assign(facts, { collateralInputs: [{ txHash: 'col', outputIndex: 0 }], hasCollateralReturn: true });
    chain.unspent = new Set(['in#0', 'tx#2']);
    expect(await judge()).toMatchObject({ verdict: 'scriptFailed' });
  });

  it('stays open while the wall clock is before the horizon and reads nothing on the ledger', async () => {
    facts.ttlSlot = posixToSlot('preview', Date.now());
    expect(await judge()).toEqual({ verdict: 'open' });
    expect(client.isUtxoUnspent).not.toHaveBeenCalled();
    expect(client.readLedger).not.toHaveBeenCalled();
  });

  it('never lands once the node tip is past the expiry by the horizon and an input is unspent', async () => {
    chain.tip = 1000 + SETTLE;
    expect(await judge()).toEqual({ verdict: 'open' });
    chain.tip = expired;
    expect(await judge()).toMatchObject({ verdict: 'neverLands', reason: expect.stringContaining('expired at slot 1000') });
  });

  it('needs an unspent collateral input as well when the bytes carry collateral', async () => {
    chain.tip = expired;
    Object.assign(facts, { collateralInputs: [{ txHash: 'col', outputIndex: 0 }] });
    expect(await judge()).toMatchObject({ verdict: 'unresolved' });
    chain.unspent.add('col#0');
    expect(await judge()).toMatchObject({ verdict: 'neverLands' });
  });

  it('is unresolved past the horizon when every input is spent and nothing shows by whom', async () => {
    chain.tip = 1_000_000;
    chain.unspent.clear();
    expect(await judge()).toMatchObject({ verdict: 'unresolved' });
  });

  it('takes an indexer that says unspent only past the longer margin, since it may lag the node', async () => {
    chain.live = false;
    chain.tip = expired;
    expect(await judge()).toEqual({ verdict: 'open' });
    chain.tip = 1000 + SETTLE + PROVIDER_LAG_SLOTS + 1;
    expect(await judge()).toMatchObject({ verdict: 'neverLands' });
  });

  it('a transaction without an expiry: open before the bound, stale while an input is unspent, never as never landing', async () => {
    facts.ttlSlot = null;
    chain.tip = 10_000_000;
    expect(await judge(null)).toEqual({ verdict: 'open' });
    expect(await judge(Date.now() - MAX_VALIDITY_MS)).toEqual({ verdict: 'open' });
    expect(client.readLedger).not.toHaveBeenCalled();
    // it can still land through its unspent input
    expect(await judge(longAgo())).toMatchObject({ verdict: 'stale', unspentInputs: [{ txHash: 'in', outputIndex: 0 }] });
    chain.unspent = new Set(['tx#0']);
    expect(await judge(longAgo())).toEqual({ verdict: 'onChain' });
  });

  it('a transaction without an expiry is unresolved only once every input stayed spent past the horizon', async () => {
    resetLandingMemory();
    facts.ttlSlot = null;
    chain.tip = 10_000_000;
    chain.unspent = new Set();
    expect(await judge(longAgo())).toEqual({ verdict: 'open' });
    chain.tip += settleSlots('preview');
    expect(await judge(longAgo())).toMatchObject({ verdict: 'unresolved' });
  });

  it('stays open when the transaction lookup fails, whatever the ledger says', async () => {
    onChain.mockRejectedValue(new ProviderUnavailableError('down', 'koios'));
    chain.tip = expired;
    expect(await judge()).toEqual({ verdict: 'open' });
    expect(client.readLedger).not.toHaveBeenCalled();
  });

  it('stays open when a ledger read fails', async () => {
    client.readLedger.mockRejectedValueOnce(new ProviderUnavailableError('down', 'ogmios'));
    chain.tip = expired;
    expect(await judge()).toEqual({ verdict: 'open' });
  });
});

describe('isFinalRefusal', () => {
  const ogmios = (code: number, message: string) =>
    new TransactionValidationError(`node rejected the transaction (${code})`, Object.assign(new Error(message), { code }));

  it('holds for an Ogmios refusal that is about the bytes in any ledger state', () => {
    for (const code of [3100, 3101, 3105, 3106, 3107, 3108, 3121, 3124, 3126, 3127, 3164, 3169]) {
      expect(isFinalRefusal(ogmios(code, 'x'))).toBe(true);
    }
  });

  it('does not hold for refusals a resend of a landed transaction also gets, or that a protocol version decides', () => {
    // spent inputs, validity interval, fee, value not conserved, script integrity, mempool, malformed scripts
    for (const code of [3117, 3118, 3122, 3123, 3113, 3997, 3102, 3109, 3116]) {
      expect(isFinalRefusal(ogmios(code, 'Signature is invalid'))).toBe(false);
    }
    expect(isFinalRefusal(new AllBackendsFailedError([ogmios(3117, 'x')]))).toBe(false);
  });

  it('judges Blockfrost and Koios by the ledger failure names in their text', () => {
    expect(isFinalRefusal(new TransactionValidationError('ConwayUtxowFailure (InvalidWitnessesUTXOW [...])', undefined))).toBe(true);
    expect(isFinalRefusal(new TransactionValidationError('BadInputsUTxO, ValueNotConservedUTxO, InvalidWitnessesUTXOW', undefined))).toBe(true);
    expect(isFinalRefusal(new TransactionValidationError('ConwayUtxowFailure BadInputsUTxO', undefined))).toBe(false);
    expect(isFinalRefusal(new TransactionValidationError('MalformedScriptWitnesses', undefined))).toBe(false);
    expect(isFinalRefusal(new TransactionValidationError('ValueNotConservedUTxO FeeTooSmallUTxO', undefined))).toBe(false);
    expect(isFinalRefusal(new TransactionValidationError('something the ledger never said', undefined))).toBe(false);
  });

  it('does not hold without a verdict', () => {
    expect(isFinalRefusal(new ProviderUnavailableError('timeout', 'koios'))).toBe(false);
    expect(isFinalRefusal(new RateLimitError('koios'))).toBe(false);
    expect(isFinalRefusal(undefined)).toBe(false);
  });
});

describe('sendProblem', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');

  it('names a transaction without a TTL', () => {
    facts.ttlSlot = null;
    expect(sendProblem('cbor', 'preview', now)).toMatch(/no expiry/);
  });

  it('accepts an expiry up to 24 hours ahead and refuses a later one', () => {
    const latest = posixToSlot('preview', now + 24 * 3_600_000);
    facts.ttlSlot = latest;
    expect(sendProblem('cbor', 'preview', now)).toBeNull();
    facts.ttlSlot = latest + 1;
    expect(sendProblem('cbor', 'preview', now)).toMatch(/more than 24 hours ahead/);
  });

  it('refuses bytes whose expiry has passed', () => {
    facts.ttlSlot = posixToSlot('preview', now) - 1;
    expect(sendProblem('cbor', 'preview', now)).toMatch(/expired at slot/);
  });

  it('refuses bytes marked to fail their scripts', () => {
    facts.ttlSlot = posixToSlot('preview', now + 3_600_000);
    facts.isValid = false;
    expect(sendProblem('cbor', 'preview', now)).toMatch(/isValid false/);
  });
});

describe('isExpired', () => {
  it('is true once the wall clock is past the expiry slot', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    // valid only while the slot is below the TTL
    facts.ttlSlot = posixToSlot('preview', now) + 1;
    expect(isExpired('cbor', 'preview', now)).toBe(false);
    expect(isExpired('cbor', 'preview', now + 1000)).toBe(true);
    facts.ttlSlot = null;
    expect(isExpired('cbor', 'preview', now)).toBe(false);
  });
});

describe('hasUnspentOutput', () => {
  it('reads the transaction outputs on the ledger', async () => {
    chain.unspent = new Set(['tx#1']);
    expect(await hasUnspentOutput('cbor', 'tx', client as never)).toBe(true);
    chain.unspent.clear();
    expect(await hasUnspentOutput('cbor', 'tx', client as never)).toBe(false);
  });
});
