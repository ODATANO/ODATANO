import cds from '@sap/cds';
import { isSubmitRejection } from '../../utils/errors';
import { extractTxCacheTargets } from '../../utils/tx-build-helper';
import { MAX_VALIDITY_MS } from '../../utils/const';
import { posixToSlot, rollbackHorizonSlots } from '../../utils/epoch-slots';
import { findOnChain, type PresenceIndexer, type TransactionLookup } from '../transaction-presence';
import type { CardanoClient, Network } from '../cardano-client';

const logger = cds.log('LandingProof');

// On chain needs positive evidence: the crawled chain, a backend that returns it, an own output unspent.
// Never lands needs the tip past the expiry by the rollback horizon and an input still unspent. Past
// that point without either proof the outcome is unresolved, and an operator decides it.

/** Slots an indexer may lag the node; added to the horizon when the ledger read came from one. */
export const PROVIDER_LAG_SLOTS = 3600;
/** Outputs of the transaction looked up to see whether it landed, besides the last one (the change). */
const OUTPUTS_CHECKED = 10;

/** Slots past its expiry after which a transaction can no longer land on the chain the node follows. */
export function settleSlots(network: Network): number {
  return rollbackHorizonSlots(network);
}

export type LandingClient = TransactionLookup & Pick<CardanoClient, 'network' | 'isUtxoUnspent' | 'readLedger'>;
export type LandingIndexer = PresenceIndexer;

// onChain: it landed. scriptFailed: it landed with failing scripts, only its collateral was spent.
// neverLands: it cannot land. unresolved: it can no longer land, but nothing shows whether it did.
// stale: no expiry, the bound has passed, every input is unspent, so it still can. open: it may still land.
export type LandingVerdict =
  | { verdict: 'onChain' }
  | { verdict: 'scriptFailed'; reason: string }
  | { verdict: 'neverLands'; reason: string }
  | { verdict: 'unresolved'; reason: string }
  | { verdict: 'stale'; reason: string; unspentInputs: Array<{ txHash: string; outputIndex: number }> }
  | { verdict: 'open' };

// Ogmios refusals that hold for the bytes at any time and in any ledger state: bad or missing
// signatures, metadata, no inputs, wrong network, minted ada, boot address attributes, an input also
// a reference, a pointer address in the collateral return.
const FINAL_CODES = new Set([3100, 3101, 3105, 3106, 3107, 3108, 3121, 3124, 3126, 3127, 3164, 3169]);
// The same failures as the ledger names them in the refusal text of Blockfrost and Koios.
const FINAL_TEXT = /InvalidWitnessesUTXOW|MissingVKeyWitnessesUTXOW|MissingTxBodyMetadataHash|MissingTxMetadata|ConflictingMetadataHash|InvalidMetadata|InputSetEmptyUTxO|WrongNetwork|TriesToForgeADA|OutputBootAddrAttrsTooBig|NonDisjointRefInputs/;

/** The errors an error carries: itself, its originalError and the errors it collects. */
function errorTree(err: unknown, depth = 0): unknown[] {
  if (depth > 4 || err == null || typeof err !== 'object') return err == null ? [] : [err];
  const nested = [(err as { originalError?: unknown }).originalError, ...((err as { errors?: unknown[] }).errors ?? [])];
  return [err, ...nested.flatMap((e) => (e == null ? [] : errorTree(e, depth + 1)))];
}

/** JSON-RPC codes of node refusals (3000-3999) anywhere in the error. */
function nodeRefusalCodes(err: unknown): number[] {
  return errorTree(err)
    .map((e) => (e as { code?: unknown }).code)
    .filter((c): c is number => typeof c === 'number' && c >= 3000 && c < 4000);
}

function errorText(err: unknown): string {
  return errorTree(err).map((e) => (e instanceof Error ? e.message : typeof e === 'string' ? e : '')).join(' ');
}

// True when the refusal holds for these bytes whatever the ledger holds, so the transaction can never
// land. A refusal over inputs, the validity interval, fees, scripts or protocol parameters is no
// verdict: a resend of a transaction that already landed gets those too. An unknown refusal is none.
export function isFinalRefusal(err: unknown): boolean {
  if (!isSubmitRejection(err)) return false;
  const codes = nodeRefusalCodes(err);
  if (codes.length) return codes.some((c) => FINAL_CODES.has(c));
  return FINAL_TEXT.test(errorText(err));
}

export interface LandingFacts {
  ttlSlot: number | null;
  inputs: Array<{ txHash: string; outputIndex: number }>;
  outputCount: number;
  isValid: boolean;
  collateralInputs: Array<{ txHash: string; outputIndex: number }>;
  hasCollateralReturn: boolean;
}

/** Expiry, inputs, outputs and collateral of a signed transaction. */
export function landingFacts(signedTxCbor: string): LandingFacts {
  const t = extractTxCacheTargets(signedTxCbor);
  return {
    ttlSlot: t.ttlSlot ?? null,
    inputs: t.inputs ?? [],
    outputCount: t.outputCount ?? 0,
    isValid: t.isValid !== false,
    collateralInputs: t.collateralInputs ?? [],
    hasCollateralReturn: t.hasCollateralReturn === true,
  };
}

// Why ODATANO will not send these bytes, or null. The expiry is what lets a send without an answer
// be decided, and the cap bounds how long a record or a wallet queue can stay open. Bytes marked to
// fail their scripts would only spend the collateral.
export function sendProblem(signedTxCbor: string, network: Network, nowMs: number = Date.now()): string | null {
  const { ttlSlot, isValid } = landingFacts(signedTxCbor);
  if (!isValid) return 'The transaction is marked to fail its scripts (isValid false); sending it would only spend its collateral';
  if (ttlSlot === null) return 'The transaction has no expiry (body key 3, TTL); set one, so its outcome can be decided';
  // valid only while the slot is below the TTL
  if (ttlSlot <= posixToSlot(network, nowMs)) return `The transaction expired at slot ${ttlSlot}; no node accepts it any more`;
  const latest = posixToSlot(network, nowMs + MAX_VALIDITY_MS);
  if (ttlSlot > latest) return `The transaction expires at slot ${ttlSlot}, more than ${MAX_VALIDITY_MS / 3_600_000} hours ahead (latest slot ${latest})`;
  return null;
}

/** True once the expiry has passed by the wall clock: then no node accepts the bytes any more. */
export function isExpired(signedTxCbor: string, network: Network, nowMs: number = Date.now()): boolean {
  let ttlSlot: number | null;
  try {
    ttlSlot = landingFacts(signedTxCbor).ttlSlot;
  } catch {
    return false; // unreadable bytes: the node answers for them
  }
  return ttlSlot !== null && posixToSlot(network, nowMs) >= ttlSlot;
}

/** Own output indexes read for landing evidence: the last (the builder puts the change there), then the first. */
export function outputsToCheck(outputCount: number): number[] {
  if (outputCount <= 0) return [];
  const first = Array.from({ length: Math.min(outputCount, OUTPUTS_CHECKED) }, (_, i) => i);
  return [...new Set([outputCount - 1, ...first])];
}

/** True when one of the transaction's own outputs is unspent: then it landed with passing scripts. */
export async function hasUnspentOutput(signedTxCbor: string, txHash: string, client: Pick<CardanoClient, 'isUtxoUnspent'>): Promise<boolean> {
  for (const i of outputsToCheck(landingFacts(signedTxCbor).outputCount)) {
    if (await client.isUtxoUnspent(txHash, i)) return true;
  }
  return false;
}

// Tip slot at which inputs of a transaction without an expiry were first seen spent: some of them, or
// all. A spend counts once it is older than the rollback horizon, since a rollback could undo a younger one.
const someSpentSince = new Map<string, number>();
const allSpentSince = new Map<string, number>();

/** Forgets what this process remembers about spent inputs; for tests. */
export function resetLandingMemory(): void {
  someSpentSince.clear();
  allSpentSince.clear();
}

/** The tip slot `seen` holds for a transaction, set to `tip` on the first look. */
function firstSeen(seen: Map<string, number>, txHash: string, tip: number): number {
  const since = seen.get(txHash);
  if (since !== undefined) return since;
  seen.set(txHash, tip);
  return tip;
}

// What an own output shows: on chain, landed with failing scripts (its collateral return, which the
// ledger puts after the outputs, is unspent), or nothing.
async function ownOutputEvidence(facts: LandingFacts, signedTxCbor: string, txHash: string, client: LandingClient): Promise<LandingVerdict | null> {
  if (await hasUnspentOutput(signedTxCbor, txHash, client)) return { verdict: 'onChain' };
  if (facts.hasCollateralReturn && await client.isUtxoUnspent(txHash, facts.outputCount)) {
    return { verdict: 'scriptFailed', reason: scriptFailedReason(txHash) };
  }
  return null;
}

function scriptFailedReason(txHash: string): string {
  return `Transaction ${txHash} is on chain with failing scripts: only its collateral was spent, the payment did not happen`;
}

// Reads the chain for a sent transaction. sentAtMs bounds a transaction without an expiry. A lookup
// that cannot answer proves nothing, and then nothing else decides either.
export async function judgeLanding(
  signedTxCbor: string,
  txHash: string,
  { indexer, client }: { indexer: LandingIndexer; client: LandingClient },
  sentAtMs: number | null = null,
  nowMs: number = Date.now(),
): Promise<LandingVerdict> {
  try {
    let presence: Awaited<ReturnType<typeof findOnChain>>;
    try {
      presence = await findOnChain(indexer, client, txHash);
    } catch (lookupErr: unknown) {
      logger.debug({ txHash, error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr) }, 'Transaction lookup gave no answer');
      return { verdict: 'open' };
    }
    if (presence) return presence.scriptFailed ? { verdict: 'scriptFailed', reason: scriptFailedReason(txHash) } : { verdict: 'onChain' };

    const facts = landingFacts(signedTxCbor);
    const settle = settleSlots(client.network);
    if (facts.ttlSlot === null) return await judgeWithoutExpiry(facts, signedTxCbor, txHash, client, settle, sentAtMs, nowMs);
    // the wall clock first, so no ledger read runs while the transaction may still land
    if (posixToSlot(client.network, nowMs) <= facts.ttlSlot + settle) return { verdict: 'open' };

    // tip, inputs and collateral from one source; an unknown outpoint is not unspent
    const refs = [...facts.inputs, ...facts.collateralInputs];
    const ledger = await client.readLedger(refs);
    if (ledger.tip <= facts.ttlSlot + settle + (ledger.live ? 0 : PROVIDER_LAG_SLOTS)) return { verdict: 'open' };
    const own = await ownOutputEvidence(facts, signedTxCbor, txHash, client);
    if (own) return own;
    // a landing spends every input, or with failing scripts every collateral input
    const inputUnspent = ledger.unspent.slice(0, facts.inputs.length).includes(true);
    const collateralUnspent = facts.collateralInputs.length === 0 || ledger.unspent.slice(facts.inputs.length).includes(true);
    if (inputUnspent && collateralUnspent) {
      return { verdict: 'neverLands', reason: `Transaction ${txHash} expired at slot ${facts.ttlSlot} and an input it spends is still unspent (tip ${ledger.tip})` };
    }
    return { verdict: 'unresolved', reason: `Transaction ${txHash} expired at slot ${facts.ttlSlot}; its inputs are spent and nothing shows whether by this transaction` };
  } catch (err: unknown) {
    logger.warn({ txHash, error: err instanceof Error ? err.message : String(err) }, 'Chain read for a sent transaction was inconclusive');
    return { verdict: 'open' };
  }
}

// Without an expiry the bytes can land while every input is unspent: past the longest expiry plus the
// horizon that makes them stale. A landing spends every input, so some but not all spent past the horizon
// means it never lands, all spent means unresolved. Before that bound only own outputs decide.
async function judgeWithoutExpiry(
  facts: LandingFacts, signedTxCbor: string, txHash: string, client: LandingClient,
  settle: number, sentAtMs: number | null, nowMs: number,
): Promise<LandingVerdict> {
  if (sentAtMs == null || nowMs <= sentAtMs + MAX_VALIDITY_MS + settle * 1000) return { verdict: 'open' };
  const own = await ownOutputEvidence(facts, signedTxCbor, txHash, client);
  if (own) return own;
  const ledger = await client.readLedger(facts.inputs);
  const unspentInputs = facts.inputs.filter((_, i) => ledger.unspent[i]);
  const margin = settle + (ledger.live ? 0 : PROVIDER_LAG_SLOTS);
  if (unspentInputs.length === facts.inputs.length) {
    someSpentSince.delete(txHash);
    allSpentSince.delete(txHash);
    return { verdict: 'stale', reason: `Transaction ${txHash} has no expiry and has not landed; every input it spends is unspent, so it can still land`, unspentInputs };
  }
  if (unspentInputs.length) {
    allSpentSince.delete(txHash);
    if (ledger.tip < firstSeen(someSpentSince, txHash, ledger.tip) + margin) return { verdict: 'open' };
    someSpentSince.delete(txHash);
    return { verdict: 'neverLands', reason: `Transaction ${txHash} has no expiry; one of its inputs is spent by another transaction and another is unspent, so it never landed and never can` };
  }
  someSpentSince.delete(txHash);
  if (ledger.tip < firstSeen(allSpentSince, txHash, ledger.tip) + margin) return { verdict: 'open' };
  allSpentSince.delete(txHash);
  return { verdict: 'unresolved', reason: `Transaction ${txHash} has no expiry; its inputs are spent and nothing shows whether by this transaction` };
}
