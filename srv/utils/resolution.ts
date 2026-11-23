import { BackendError, rejectInvalid } from './errors';
import { ERROR_CODES } from './error-codes';
import { isExpired, landingFacts } from '../blockchain/signing/landing-proof';
import type { CardanoClient } from '../blockchain/cardano-client';
import type { Request } from '@sap/cds';

/** What an operator read on the chain for an unresolved outcome. */
export type ResolvedOutcome = 'confirmed' | 'failed';

/** The note a resolution leaves on the record: the outcome, who, when and why. */
export function resolutionNote(outcome: ResolvedOutcome, user: string | undefined, note: string | null | undefined, now = new Date()): string {
  const why = note?.trim() ? `: ${note.trim()}` : '';
  return `${outcome} by ${user ?? 'unknown'} at ${now.toISOString()}${why}`.slice(0, 500);
}

/** Refuses a resolution whose txHash names another transaction than the record's. */
export function checkResolvedTxHash(req: Request, action: string, given: string | null | undefined, recorded: string | null | undefined): void {
  if (given && given.toLowerCase() !== (recorded ?? '').toLowerCase()) {
    rejectInvalid(req, action, `txHash ${given} is not the transaction of this record (${recorded ?? 'none'})`, 'txHash');
  }
}

// A failed outcome needs bytes that can no longer land. A landing spends every input, so one spent
// input already rules it out; while every input is unspent and the bytes are not expired, they can
// still land, and failed is refused. Read before the request takes its connection.
export async function refuseFailedWhileItCanLand(
  action: string,
  outcome: ResolvedOutcome,
  signedTxCbor: string | null | undefined,
  client: Pick<CardanoClient, 'readLedger' | 'network'>,
): Promise<void> {
  if (outcome !== 'failed' || !signedTxCbor || isExpired(signedTxCbor, client.network)) return;
  let inputs: Array<{ txHash: string; outputIndex: number }>;
  try {
    inputs = landingFacts(signedTxCbor).inputs;
  } catch {
    return; // unreadable bytes cannot be sent either
  }
  if (!inputs.length) return;
  // an outpoint the backend does not know reads as spent
  const { unspent } = await client.readLedger(inputs);
  if (inputs.every((_, i) => unspent[i] === true)) {
    throw new BackendError(
      `${action}: the transaction can still land, every input it spends is unspent. ` +
      'Resolve it as failed once one of them is spent by another transaction',
      409, ERROR_CODES.OUTCOME_STILL_OPEN,
    );
  }
}

/** The 409 for a record another call resolved first. */
export function resolvedConcurrently(action: string): BackendError {
  return new BackendError(`${action}: the record was resolved concurrently`, 409, ERROR_CODES.RESOLVED_CONCURRENTLY);
}
