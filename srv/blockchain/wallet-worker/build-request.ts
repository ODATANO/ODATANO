import { BackendError } from '../../utils/errors';
import { ERROR_CODES } from '../../utils/error-codes';
import { prepareBuildRequest, preparePayoutRequest as preparePayout, type Prepared } from '../../utils/build-request';
import type { TxBuildPlutusRequest, TxBuildRequest } from '../../utils/types';
import type { Network } from '../cardano-client';
import type { WalletJobKindValue } from './job-store';
import { isValidCbor } from '../../utils/validators';
import { sendProblem } from '../signing/landing-proof';

export { MAX_PAYOUT_OUTPUTS } from '../../utils/build-request';

// A stored wallet-job request becomes the request the build methods take, checked as the Build*
// action of the same kind checks it. Invalid input throws 400 so the job fails at once.

function requestOf<T>(result: Prepared<T>): T {
  if ('error' in result) throw new BackendError(result.error, 400, ERROR_CODES.INVALID_INPUT, undefined, undefined, result.field);
  return result.request;
}

export function preparePayoutRequest(raw: Record<string, unknown>): TxBuildPlutusRequest {
  return requestOf(preparePayout(raw));
}

/** A job's requestJson as an object, or null when it is not a JSON object. */
export function parseJobRequest(requestJson: string | null | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(requestJson ?? '');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Why a submitSigned request cannot be run, or null. The transaction needs an expiry within the cap,
// and passing scripts: otherwise an unanswered submit stays undecided, or only the collateral goes.
export function submitSignedProblem(raw: Record<string, unknown>, network: Network): string | null {
  const cbor = raw.signedTxCbor;
  if (typeof cbor !== 'string' || !cbor) return 'submitSigned needs signedTxCbor in its request';
  if (!isValidCbor(cbor)) return 'signedTxCbor must be a hex string';
  try {
    return sendProblem(cbor, network);
  } catch {
    return 'signedTxCbor is not a readable transaction';
  }
}

/** Raw job request → TxBuildRequest for the matching build method; malformed payloads throw 400 INVALID_INPUT. */
export function prepareWorkerBuildRequest(kind: WalletJobKindValue, raw: Record<string, unknown>, network: Network): TxBuildRequest {
  if (kind === 'payout' || kind === 'submitSigned') {
    throw new BackendError(`Unsupported job kind "${kind}"`, 400, ERROR_CODES.INVALID_INPUT);
  }
  return requestOf(prepareBuildRequest(kind, raw, () => network));
}
