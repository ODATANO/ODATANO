import cds from '@sap/cds';
import type { CardanoClient, Network } from '../cardano-client';
import type { CardanoIndexer } from '../cardano-indexer';
import { EPOCH_CONFIG_BY_NETWORK } from '../../utils/const';
import { InsufficientFundsError, TransactionAlreadySubmittedError } from '../../utils/errors';
import { getTxHashFromCbor } from '../../utils/tx-build-helper';
import { runWithoutAmbientTx } from '../../utils/tx-utils';
import { getExternalSignerModule } from '../signing/external-signer';
import { hasUnspentOutput, judgeLanding } from '../signing/landing-proof';
import { findOnChain } from '../transaction-presence';
import { recordInvalidation, type WalletJobRow } from './job-store';
import type { WorkerSigner } from './signers';

const logger = cds.log('CardanoWalletWorker');

// A job transaction without an expiry can land as long as one of its inputs is unspent. A
// self-transfer that spends such an input ends that: once it is deeper than the node can roll back,
// the job's transaction can never land.

/** Lovelace the self-transfer sends back to the wallet; the change carries the rest. */
const INVALIDATION_LOVELACE = '1000000';

/** Sends stored self-transfer bytes again; a refusal proves nothing, the next check reads the chain. */
export async function resendInvalidation(deps: InvalidationDeps, job: WalletJobRow): Promise<void> {
  try {
    await deps.client.submitTransaction(job.invalidationTxCbor!);
  } catch (err) {
    if (!(err instanceof TransactionAlreadySubmittedError)) logger.debug(`Job ${job.ID}: self-transfer ${job.invalidationTxHash} resend refused:`, err);
  }
}

export type OutputRef = { txHash: string; outputIndex: number };

/** confirmed: deep enough, the job's transaction can never land. included: on chain, not deep enough yet.
 *  retry: it can no longer land itself. unknown: its inputs are spent and nothing shows by whom.
 *  waiting: not seen yet and it may still land, so its bytes are sent again. */
export type InvalidationState = 'confirmed' | 'included' | 'retry' | 'unknown' | 'waiting';

export interface InvalidationDeps {
  client: CardanoClient;
  indexer: CardanoIndexer;
  network: Network;
}

/** Blocks the self-transfer must be deep before it counts: the depth no rollback reaches. */
export function invalidationDepth(network: Network): number {
  return EPOCH_CONFIG_BY_NETWORK[network].securityParam;
}

const keyOf = (r: OutputRef): string => `${r.txHash}#${r.outputIndex}`;

/** An unspent input of the job's transaction that the wallet holds, or null, and the UTxOs the wallet holds. */
export async function pickInvalidationInput(
  deps: InvalidationDeps, address: string, unspentInputs: OutputRef[],
): Promise<{ input: OutputRef | null; held: OutputRef[] }> {
  const held = (await runWithoutAmbientTx(() => cds.tx((tx) => deps.indexer.resolveAddressUtxos(tx, address))))
    .map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex }));
  const keys = new Set(held.map(keyOf));
  return { input: unspentInputs.find((r) => keys.has(keyOf(r))) ?? null, held };
}

/** The self-transfer cannot be funded: the wallet has too little besides inputs it must not spend. */
export class InvalidationUnfundedError extends Error {}

// Builds, signs, stores and sends the self-transfer. It spends the input alone where that pays for it,
// else with other wallet UTxOs, never with an input another stale job waits on (`keep`). The bytes are
// stored before the send, as for a job. Returns its hash, or null when the job changed meanwhile.
export async function sendInvalidation(
  deps: InvalidationDeps, job: WalletJobRow, signer: WorkerSigner, input: OutputRef,
  around: { held?: OutputRef[]; keep?: OutputRef[] } = {},
): Promise<string | null> {
  const address = signer.getAddress();
  const keep = (around.keep ?? []).filter((r) => keyOf(r) !== keyOf(input));
  const alone = [...(around.held ?? []).filter((r) => keyOf(r) !== keyOf(input)), ...keep];
  const buildWith = (protectInputs: OutputRef[]) => runWithoutAmbientTx(() => cds.tx((tx) => deps.indexer.indexSimpleBuildResult(tx, {
    network: deps.network,
    senderAddress: address,
    changeAddress: address,
    recipientAddress: address,
    lovelaceAmount: INVALIDATION_LOVELACE,
    forceInputs: [input],
    ...(protectInputs.length ? { protectInputs } : {}),
  })));
  let build: Awaited<ReturnType<typeof buildWith>>;
  try {
    build = await buildWith(alone);
  } catch (err) {
    if (!(err instanceof InsufficientFundsError)) throw err;
    try {
      build = await buildWith(keep);
    } catch (again) {
      if (again instanceof InsufficientFundsError) throw new InvalidationUnfundedError(again.message);
      throw again;
    }
  }
  const signedTxCbor = signer.signTransaction(build.unsignedTxCbor as string, build.txBodyHash as string);
  getExternalSignerModule().verifyOrThrow(signedTxCbor, build.txBodyHash as string, { requiredSigners: [signer.getPublicKeyHash().toLowerCase()] });
  const txHash = getTxHashFromCbor(signedTxCbor);
  const stored = await runWithoutAmbientTx(() => cds.tx((tx) => recordInvalidation(tx, job.ID, { txHash, signedTxCbor }, job.invalidationTxHash)));
  if (!stored) return null;
  try {
    await deps.client.submitTransaction(signedTxCbor);
  } catch (err) {
    // a refusal proves nothing here: the next check reads the chain
    if (!(err instanceof TransactionAlreadySubmittedError)) logger.warn(`Job ${job.ID}: invalidating tx ${txHash} was refused on send:`, err);
  }
  logger.warn(`Job ${job.ID}: tx ${job.txHash} has no expiry and has not landed; sent self-transfer ${txHash} spending ${input.txHash}#${input.outputIndex}`);
  return txHash;
}

// Where the self-transfer stands. seen holds the tip height at which an own output was first seen,
// for backends that cannot look transactions up.
export async function checkInvalidation(deps: InvalidationDeps, job: WalletJobRow, seen: Map<string, number>): Promise<InvalidationState> {
  const txHash = job.invalidationTxHash!;
  const signedTxCbor = job.invalidationTxCbor!;
  const tipHeight = (await deps.client.getLatestBlock()).height ?? null;
  const presence = await findOnChain(deps.indexer, deps.client, txHash);
  let height: number | null = presence?.height ?? null;
  if (presence === undefined && tipHeight != null && await hasUnspentOutput(signedTxCbor, txHash, deps.client)) {
    // a tip below the height seen means a rollback: count again from here
    const first = seen.get(job.ID);
    height = first != null && first <= tipHeight ? first : tipHeight;
    seen.set(job.ID, height);
  }
  if (height != null && tipHeight != null) {
    return tipHeight - height + 1 >= invalidationDepth(deps.network) ? 'confirmed' : 'included';
  }
  seen.delete(job.ID);
  const sentAtMs = job.invalidationSentAt ? Date.parse(job.invalidationSentAt) : null;
  const landing = await judgeLanding(signedTxCbor, txHash, deps, Number.isFinite(sentAtMs) ? sentAtMs : null);
  if (landing.verdict === 'neverLands') return 'retry';
  if (landing.verdict === 'unresolved') return 'unknown';
  return 'waiting';
}
