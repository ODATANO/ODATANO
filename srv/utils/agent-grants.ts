/**
 * Agent grants: scoped, budgeted bearer capabilities for agents.
 * Design: AGENT_GRANTS_DESIGN.md. Reference: NIGHTGATE srv/sessions/agent-grants.ts.
 *
 * Three exports carry the feature:
 *   - `resolveAgentToken` + `makeAgentUser`: used by the transport lane
 *     (agent-token-auth.ts) to turn an `x-agent-token` header into the principal
 *     `agent:<grantId>` with the role `agent-grant` BEFORE any service hook runs.
 *     Doing the authentication at the transport (not in a before-hook) matters:
 *     CAP runs before-handlers in parallel, so CAP's own @requires / @restrict
 *     evaluation must already see the final principal.
 *   - `attachAgentGrantEnforcement`: the before('*') hook on all six ODATANO
 *     services. Allow list (403), wallet pinning (403), daily budget (429),
 *     lastUsedAt. Ownership needs no special code: a token's jobs are created
 *     with createdBy = `agent:<grantId>`, so the existing `createdBy = $user`
 *     gates and the `$user.grantId` row restrictions do the narrowing.
 *   - `registerAgentGrantHandlers`: the grant lifecycle for CardanoAgentService
 *     (CreateAgentGrant / UpdateAgentGrant / RotateAgentGrantToken /
 *     RevokeAgentGrant, GetGrantStatus / GetGrantUsage), on top of the
 *     programmatic `issueAgentGrant` / `updateAgentGrant` /
 *     `rotateAgentGrantToken` / `revokeAgentGrantById` that @odatano/x402 uses
 *     to sell grants. Names are this repo's PascalCase; semantics follow
 *     NIGHTGATE's so a gateway (ODATANO ACCESS) drives both with one code path.
 *
 * The token is a capability, not an identity: it never carries the operator's
 * roles, so every `@requires: 'Admin'` surface refuses it by construction.
 */

import cds, { Request } from '@sap/cds';
import crypto from 'node:crypto';
import { runWithoutAmbientTx } from './tx-utils';
import { RateLimiter, principalRateKey } from './rate-limiter';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';
import { loadGrantAdminRateLimit } from './agent-grants-config';

const { SELECT, INSERT, UPDATE } = cds.ql;
const logger = cds.log('AgentGrants');

export const AGENT_TOKEN_HEADER = 'x-agent-token';
export const AGENT_TOKEN_PREFIX = 'odat_';
const TOKEN_BYTES = 32;

/** Role every token principal carries; the only role it ever has. */
export const AGENT_ROLE = 'agent-grant';
/** `agent:<grantId>`: the principal id a token request runs under. */
export const AGENT_PRINCIPAL_PREFIX = 'agent:';

export const GRANTS_ENTITY = 'odatano.cardano.CardanoAgentGrants';
/** Daily per-action counters of admitted calls (feeds GetGrantUsage); never exposed as an entity. */
export const GRANT_USAGE_ENTITY = 'odatano.cardano.CardanoAgentGrantUsage';

/** The services the hook attaches to and the transport lane opens. */
export const AGENT_SERVICE_NAMES: readonly string[] = [
  'CardanoODataService',
  'CardanoTransactionService',
  'CardanoSignService',
  'CardanoWorkerService',
  'CardanoIndexerService',
  'CardanoAgentService',
];

/**
 * Actions an operator MAY put on a grant's allow list. Each call costs one
 * budget unit (a build is the service an agent buys). Everything not here and
 * not in AGENT_ALWAYS_ALLOWED_EVENTS is a hard 403 for token requests: HSM
 * signing, pause/resume, grant administration are never grantable.
 */
export const AGENT_ALLOWLISTABLE_ACTIONS: readonly string[] = [
  // CardanoTransactionService: unsigned CBOR
  'BuildSimpleAdaTransaction',
  'BuildTransactionWithMetadata',
  'BuildMultiAssetTransaction',
  'BuildMintTransaction',
  'BuildPlutusSpendTransaction',
  'SetCollateral',
  // externally signed transactions
  'CreateSigningRequest',
  'VerifySignature',
  'SubmitTransaction',
  'SubmitSignedTransaction',
  'SubmitVerifiedTransaction',
  'CheckSubmissionStatus',
  // server-side wallets (need walletId on the grant)
  'SubmitWalletJob',
  'CancelJob',
];

/** Allow-listable actions that spend from a worker wallet: the grant must be pinned. */
export const AGENT_WALLET_ACTIONS: ReadonlySet<string> = new Set(['SubmitWalletJob', 'CancelJob']);

/**
 * Events every valid token may use without an allow-list entry and without
 * consuming budget: reads, compute-only actions, status polling. `READ` covers
 * every entity set; row-level narrowing is done by the `$user.grantId`
 * restrictions in the CDS models, not here.
 */
export const AGENT_ALWAYS_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'READ',
  // CardanoODataService: chain reads through the backends
  'GetNetworkInformation', 'GetBlockByHash', 'GetEpochByNumber', 'GetPoolById', 'GetDrepById',
  'GetAssetInfo', 'GetAssetHistory', 'GetAccountByStakeAddress', 'GetTransactionByHash',
  'GetMetadataByTxHash', 'GetAddressByBech32', 'GetUTxOsByAddress', 'GetUTxOsByCredential',
  'GetAssetsByAddress', 'GetLatestTransactionsByAddress', 'GetLatestBlock', 'GetLatestEpoch',
  'GetLedgerProtocolParameters', 'ParseTransactionCbor',
  // CardanoTransactionService: compute-only
  'GetBuildDetails', 'GetTransactionBuildsByAddress', 'DeriveScriptAddress', 'ExtractPaymentKeyHash',
  // CardanoSignService: reads and stateless verification
  'GetSigningRequest', 'GetSigningRequestsByAddress', 'VerifyDataSignature', 'GetHsmStatus',
  // CardanoWorkerService / CardanoIndexerService: status and liveness
  'GetJobStatus', 'GetWorkerStatus', 'getStatus', 'getLiveness',
  // CardanoAgentService: the token's own grant (GetGrantUsage is narrowed to it in enforceAgentGrant)
  'GetGrantStatus', 'GetGrantUsage',
]);

/** Mirrors WalletJobKind in db/types.cds; kept literal so this module stays free of cds-models. */
export const AGENT_JOB_KINDS: readonly string[] = ['simpleAda', 'metadata', 'multiAsset', 'mint', 'plutusSpend', 'submitSigned'];

/**
 * Grant administration (Create / Update / Rotate / Revoke): N per principal per
 * hour, N from `agentGrants.adminRateLimit` / `AGENT_GRANT_ADMIN_RATE_LIMIT`
 * (default 10, NIGHTGATE's `NIGHTGATE_GRANT_ADMIN_RATE_LIMIT`). Built on first
 * use so the knob is read once the config is loaded, and re-read after a reset.
 */
let grantAdminRateLimiter: RateLimiter | null = null;

function grantAdminLimiter(): RateLimiter {
  grantAdminRateLimiter ??= new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: loadGrantAdminRateLimit() });
  return grantAdminRateLimiter;
}

/** Forget every rate-limit window and re-read the limit from the config (tests). */
export function __resetGrantRateLimiterForTests(): void {
  grantAdminRateLimiter = null;
  lastUsedTouched.clear();
}

export interface AgentGrantRow {
  ID: string;
  userId: string;
  agentLabel?: string | null;
  tokenHash?: string;
  allowedActions: string;
  walletId?: string | null;
  allowedJobKinds?: string | null;
  maxJobsPerDay?: number | null;
  jobsUsedToday?: number | null;
  budgetWindow?: string | null;
  validUntil?: string | null;
  isActive?: boolean;
  revokedAt?: string | null;
  createdAt?: string | null;
  lastUsedAt?: string | null;
}

/** Anything that runs a CQL statement: the primary db service or one transaction of it. */
export type Runner = { run: (q: unknown) => Promise<unknown> };

function dbRunner(): Runner {
  return cds.db as unknown as Runner;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function hashAgentToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function agentPrincipalId(grantId: string): string {
  return `${AGENT_PRINCIPAL_PREFIX}${grantId}`;
}

/** The grant's JSON list column as an array; malformed or absent = empty. */
export function parseGrantList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function isExpired(grant: AgentGrantRow, now: Date = new Date()): boolean {
  return !!grant.validUntil && new Date(grant.validUntil).getTime() < now.getTime();
}

/** The grant a request runs under, or null for an ordinary principal. */
export function agentGrantOf(req: unknown): AgentGrantRow | null {
  const r = req as {
    http?: { req?: { agentGrant?: AgentGrantRow } };
    _?: { req?: { agentGrant?: AgentGrantRow } };
    user?: { attr?: { grantId?: string } };
  } | null;
  const fromHttp = r?.http?.req?.agentGrant ?? r?._?.req?.agentGrant;
  if (fromHttp) return fromHttp;
  const ctx = (cds as unknown as { context?: { http?: { req?: { agentGrant?: AgentGrantRow } } } }).context;
  return ctx?.http?.req?.agentGrant ?? null;
}

// ---------------------------------------------------------------------------
// Token → principal (transport lane)
// ---------------------------------------------------------------------------

export type TokenResolution =
  | { ok: true; grant: AgentGrantRow }
  | { ok: false; status: 401 | 410; message: string };

/**
 * Authenticate a bearer token: prefix, hash lookup among ACTIVE grants (a
 * revoked grant is an unknown token, non-leaking), expiry. Detached from any
 * ambient transaction: the lane runs before the request transaction exists,
 * and on SQLite the pool holds one connection.
 */
export async function resolveAgentToken(token: string, runner: Runner = dbRunner()): Promise<TokenResolution> {
  if (typeof token !== 'string' || !token.startsWith(AGENT_TOKEN_PREFIX)) {
    return { ok: false, status: 401, message: 'invalid agent token' };
  }
  const grant = (await runWithoutAmbientTx(() =>
    runner.run(SELECT.one.from(GRANTS_ENTITY).where({ tokenHash: hashAgentToken(token), isActive: true }))
  )) as AgentGrantRow | null;
  if (!grant) return { ok: false, status: 401, message: 'invalid agent token' };
  if (isExpired(grant)) return { ok: false, status: 410, message: 'agent grant expired' };
  return { ok: true, grant };
}

/**
 * The principal a token request runs under. Deliberately NOT the operator and
 * WITHOUT the operator's roles: `createdBy = $user` gates then scope to jobs
 * this grant created, `$user.grantId` restrictions to its own grant row, and
 * every `@requires: 'Admin'` refuses it.
 */
export function makeAgentUser(grant: AgentGrantRow): cds.User {
  return new cds.User({
    id: agentPrincipalId(grant.ID),
    roles: [AGENT_ROLE],
    attr: { grantId: grant.ID, operator: grant.userId, walletId: grant.walletId ?? '' },
  } as unknown as string);
}

// ---------------------------------------------------------------------------
// Issue / revoke (programmatic API; the CAP actions call these)
// ---------------------------------------------------------------------------

export interface IssueAgentGrantInput {
  allowedActions: string[];
  walletId?: string | null;
  allowedJobKinds?: string[] | null;
  maxJobsPerDay?: number | null;
  validUntil?: string | null;
  agentLabel?: string | null;
}

export interface IssuedAgentGrant {
  grantId: string;
  /** Shown once. Never logged, never stored. */
  token: string;
  allowedActions: string[];
  walletId: string | null;
  allowedJobKinds: string[];
  maxJobsPerDay: number | null;
  validUntil: string | null;
}

/** A refused grant input; carries the 400 the action answers with. */
export class AgentGrantInputError extends BackendError {
  constructor(message: string, target?: string, context: string = 'CreateAgentGrant') {
    super(`${context}: ${message}`, 400, ERROR_CODES.INVALID_INPUT, undefined, undefined, target);
  }
}

interface NormalizedGrantInput {
  allowedActions: string[];
  walletId: string | null;
  allowedJobKinds: string[];
  maxJobsPerDay: number | null;
  validUntil: string | null;
  agentLabel: string | null;
}

export function validateGrantInput(input: IssueAgentGrantInput, now: Date = new Date(), context: string = 'CreateAgentGrant'): NormalizedGrantInput {
  const fail = (message: string, target?: string) => new AgentGrantInputError(message, target, context);
  const actions = input.allowedActions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw fail('allowedActions must be a non-empty array', 'allowedActions');
  }
  const unknown = actions.filter((a) => !AGENT_ALLOWLISTABLE_ACTIONS.includes(a));
  if (unknown.length > 0) {
    throw fail(
      `allowedActions contains non-grantable entries: ${unknown.join(', ')}. Grantable: ${AGENT_ALLOWLISTABLE_ACTIONS.join(', ')}`,
      'allowedActions'
    );
  }
  const uniqueActions = [...new Set(actions)];

  const walletId = typeof input.walletId === 'string' && input.walletId.trim() ? input.walletId.trim() : null;
  const wantsWallet = uniqueActions.some((a) => AGENT_WALLET_ACTIONS.has(a));
  if (wantsWallet && !walletId) {
    throw fail('walletId is required when SubmitWalletJob or CancelJob is allowed', 'walletId');
  }
  if (walletId && walletId.length > 50) throw fail('walletId must be at most 50 characters', 'walletId');

  let allowedJobKinds: string[] = [];
  if (input.allowedJobKinds !== undefined && input.allowedJobKinds !== null) {
    if (!Array.isArray(input.allowedJobKinds)) throw fail('allowedJobKinds must be an array', 'allowedJobKinds');
    const badKinds = input.allowedJobKinds.filter((k) => !AGENT_JOB_KINDS.includes(k));
    if (badKinds.length > 0) {
      throw fail(`allowedJobKinds contains unknown kinds: ${badKinds.join(', ')}. Known: ${AGENT_JOB_KINDS.join(', ')}`, 'allowedJobKinds');
    }
    allowedJobKinds = [...new Set(input.allowedJobKinds)];
    if (allowedJobKinds.length > 0 && !wantsWallet) {
      throw fail('allowedJobKinds needs SubmitWalletJob in allowedActions', 'allowedJobKinds');
    }
  }

  let maxJobsPerDay: number | null = null;
  if (input.maxJobsPerDay !== undefined && input.maxJobsPerDay !== null) {
    const n = Number(input.maxJobsPerDay);
    if (!Number.isInteger(n) || n < 1) throw fail('maxJobsPerDay must be a positive integer', 'maxJobsPerDay');
    maxJobsPerDay = n;
  }

  let validUntil: string | null = null;
  if (input.validUntil) {
    const t = new Date(input.validUntil);
    if (Number.isNaN(t.getTime())) throw fail('validUntil must be a valid ISO-8601 timestamp', 'validUntil');
    if (t.getTime() <= now.getTime()) throw fail('validUntil must be in the future', 'validUntil');
    validUntil = t.toISOString();
  }

  const agentLabel = typeof input.agentLabel === 'string' && input.agentLabel.trim() ? input.agentLabel.trim() : null;
  if (agentLabel && agentLabel.length > 100) throw fail('agentLabel must be at most 100 characters', 'agentLabel');

  return { allowedActions: uniqueActions, walletId, allowedJobKinds, maxJobsPerDay, validUntil, agentLabel };
}

/**
 * Mint a grant for `operatorId`. Validation errors surface as
 * AgentGrantInputError (400). The INSERT runs on `runner`: the action passes its
 * request transaction, x402 passes whatever transaction its settlement runs in.
 */
export async function issueAgentGrant(
  input: IssueAgentGrantInput,
  operatorId: string,
  runner: Runner = dbRunner()
): Promise<IssuedAgentGrant> {
  if (!operatorId) throw new AgentGrantInputError('an operator id is required');
  const n = validateGrantInput(input);
  const token = AGENT_TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const grant = {
    ID: cds.utils.uuid(),
    userId: operatorId,
    agentLabel: n.agentLabel,
    tokenHash: hashAgentToken(token),
    allowedActions: JSON.stringify(n.allowedActions),
    walletId: n.walletId,
    allowedJobKinds: n.allowedJobKinds.length > 0 ? JSON.stringify(n.allowedJobKinds) : null,
    maxJobsPerDay: n.maxJobsPerDay,
    jobsUsedToday: 0,
    budgetWindow: null,
    validUntil: n.validUntil,
    isActive: true,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  await runner.run(INSERT.into(GRANTS_ENTITY).entries(grant));
  // Deliberately logs the id, the label and the shape, never the token.
  logger.info(
    `agent grant ${grant.ID} issued by ${operatorId}` +
      `${n.agentLabel ? ` for '${n.agentLabel}'` : ''} (actions: ${n.allowedActions.join(', ')}` +
      `${n.walletId ? `, wallet ${n.walletId}` : ''}${n.maxJobsPerDay ? `, budget ${n.maxJobsPerDay}/day` : ''}` +
      `${n.validUntil ? `, until ${n.validUntil}` : ''})`
  );
  return {
    grantId: grant.ID,
    token,
    allowedActions: n.allowedActions,
    walletId: n.walletId,
    allowedJobKinds: n.allowedJobKinds,
    maxJobsPerDay: n.maxJobsPerDay,
    validUntil: n.validUntil,
  };
}

/** Deactivate a grant; false when it does not exist or is already revoked. */
export async function revokeAgentGrantById(grantId: string, runner: Runner = dbRunner()): Promise<boolean> {
  if (!grantId) return false;
  const affected = await runner.run(
    UPDATE.entity(GRANTS_ENTITY)
      .set({ isActive: false, revokedAt: new Date().toISOString() })
      .where({ ID: grantId, isActive: true })
  );
  const revoked = Number(affected) > 0;
  if (revoked) logger.info(`agent grant ${grantId} revoked`);
  return revoked;
}

// ---------------------------------------------------------------------------
// Rotate / update (programmatic API; the CAP actions call these)
// ---------------------------------------------------------------------------

export interface RotatedAgentGrant {
  grantId: string;
  /** Shown once. Never logged, never stored. */
  token: string;
}

/**
 * Replace the grant's token; the old one is an unknown token from the next
 * request (the lane reads tokenHash per request, so nothing needs invalidating;
 * a request in flight with the old token completes). Budget, wallet, allow
 * list and expiry survive. Null when the grant does not exist or is revoked.
 */
export async function rotateAgentGrantToken(grantId: string, runner: Runner = dbRunner()): Promise<RotatedAgentGrant | null> {
  if (!grantId) return null;
  const token = AGENT_TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const affected = await runner.run(
    UPDATE.entity(GRANTS_ENTITY).set({ tokenHash: hashAgentToken(token) }).where({ ID: grantId, isActive: true })
  );
  if (Number(affected) === 0) return null;
  logger.info(`agent grant ${grantId} token rotated`);
  return { grantId, token };
}

/** The editable grant fields, as a client sends them: absent = untouched, explicit null = cleared. */
export interface UpdateAgentGrantInput {
  agentLabel?: string | null;
  allowedActions?: string[] | null;
  allowedJobKinds?: string[] | null;
  maxJobsPerDay?: number | null;
  validUntil?: string | null;
}

/** Row fields a grant edit never touches; a different wallet binding is a different grant (NIGHTGATE: sessionId). */
export const GRANT_IMMUTABLE_FIELDS: readonly string[] = ['walletId', 'userId', 'tokenHash'];

const GRANT_EDITABLE_FIELDS: readonly (keyof UpdateAgentGrantInput)[] = [
  'agentLabel', 'allowedActions', 'allowedJobKinds', 'maxJobsPerDay', 'validUntil',
];

export type UpdateAgentGrantResult =
  | { ok: true; grantId: string; updated: string[] }
  | { ok: false; status: 404 | 409; code?: 'GRANT_REVOKED'; message: string };

/**
 * Change the given fields of an ACTIVE grant. A field absent from `input`
 * keeps its value; an explicit null clears agentLabel, allowedJobKinds,
 * maxJobsPerDay or validUntil (NIGHTGATE's updateAgentGrant semantics).
 * allowedActions cannot be emptied. The merged row goes through
 * validateGrantInput, so the cross-field rules hold: wallet actions need the
 * grant's (immutable) wallet, job kinds need SubmitWalletJob, a given
 * validUntil lies in the future. Lowering maxJobsPerDay below jobsUsedToday is
 * allowed; the grant is simply over budget until the UTC day rolls.
 *
 * Validation errors surface as AgentGrantInputError (400); an unknown grant is
 * 404 and a revoked one 409 GRANT_REVOKED (revoked grants are never edited;
 * re-mint instead).
 */
export async function updateAgentGrant(
  grantId: string,
  input: UpdateAgentGrantInput,
  runner: Runner = dbRunner()
): Promise<UpdateAgentGrantResult> {
  const has = (k: keyof UpdateAgentGrantInput) => Object.prototype.hasOwnProperty.call(input, k);
  const existing = (await runner.run(SELECT.one.from(GRANTS_ENTITY).where({ ID: grantId }))) as AgentGrantRow | null;
  if (!existing) return { ok: false, status: 404, message: 'Grant not found' };
  if (existing.isActive === false) return { ok: false, status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' };

  // The merged row. validUntil only when given: an untouched expiry that has
  // meanwhile passed is the lane's 410, not this edit's 400.
  const n = validateGrantInput(
    {
      allowedActions: has('allowedActions') ? (input.allowedActions as string[]) : parseGrantList(existing.allowedActions),
      walletId: existing.walletId ?? null,
      allowedJobKinds: has('allowedJobKinds') ? input.allowedJobKinds : parseGrantList(existing.allowedJobKinds),
      maxJobsPerDay: has('maxJobsPerDay') ? input.maxJobsPerDay : existing.maxJobsPerDay,
      validUntil: has('validUntil') ? input.validUntil : null,
      agentLabel: has('agentLabel') ? input.agentLabel : existing.agentLabel,
    },
    new Date(),
    'UpdateAgentGrant'
  );

  const patch: Record<string, unknown> = {};
  if (has('allowedActions')) patch.allowedActions = JSON.stringify(n.allowedActions);
  if (has('allowedJobKinds')) patch.allowedJobKinds = n.allowedJobKinds.length > 0 ? JSON.stringify(n.allowedJobKinds) : null;
  if (has('maxJobsPerDay')) patch.maxJobsPerDay = n.maxJobsPerDay;
  if (has('validUntil')) patch.validUntil = n.validUntil;
  if (has('agentLabel')) patch.agentLabel = n.agentLabel;
  const updated = GRANT_EDITABLE_FIELDS.filter((f) => has(f));
  if (updated.length === 0) return { ok: true, grantId, updated: [] };

  // Conditional on isActive: a concurrent revoke wins over the edit.
  const affected = await runner.run(UPDATE.entity(GRANTS_ENTITY).set(patch).where({ ID: grantId, isActive: true }));
  if (Number(affected) === 0) return { ok: false, status: 409, code: 'GRANT_REVOKED', message: 'Grant is revoked' };
  logger.info(`agent grant ${grantId} updated (${updated.join(', ')})`);
  return { ok: true, grantId, updated };
}

// ---------------------------------------------------------------------------
// Usage history (GetGrantUsage)
// ---------------------------------------------------------------------------

export const USAGE_WINDOW_MAX_MS = 366 * 24 * 60 * 60 * 1000;
export const USAGE_WINDOW_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;

/** ISO timestamp or undefined; `null` when the value does not parse. */
function parseTimestamp(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const t = new Date(String(raw));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export type UsageWindow =
  | { ok: true; since: string; until: string; sinceDay: string; untilDay: string }
  | { ok: false; message: string; target: string };

/**
 * since (default until - 30 days) .. until (default now), at most 366 days
 * (NIGHTGATE's rules and wording). Counters are per UTC day, so the days both
 * ends fall on are included whole.
 */
export function resolveUsageWindow(since: unknown, until: unknown, now: Date = new Date()): UsageWindow {
  const to = parseTimestamp(until);
  const from = parseTimestamp(since);
  if (to === null) return { ok: false, message: 'until must be a valid ISO-8601 timestamp', target: 'until' };
  if (from === null) return { ok: false, message: 'since must be a valid ISO-8601 timestamp', target: 'since' };
  const toMs = to ? new Date(to).getTime() : now.getTime();
  const fromMs = from ? new Date(from).getTime() : toMs - USAGE_WINDOW_DEFAULT_MS;
  if (fromMs > toMs) return { ok: false, message: 'since must not lie after until', target: 'since' };
  if (toMs - fromMs > USAGE_WINDOW_MAX_MS) return { ok: false, message: 'the window may span at most 366 days', target: 'since' };
  const sinceIso = new Date(fromMs).toISOString();
  const untilIso = new Date(toMs).toISOString();
  return { ok: true, since: sinceIso, until: untilIso, sinceDay: sinceIso.slice(0, 10), untilDay: untilIso.slice(0, 10) };
}

export interface GrantUsageCall {
  service: string;
  action: string;
  /** Admitted and kept (budget charged and not refunded). */
  count: number;
  /** Admitted, then refunded because the handler refused the input. */
  refunded: number;
}

export interface AgentGrantUsage {
  grantId: string;
  since: string;
  until: string;
  calls: GrantUsageCall[];
  total: number;
  jobsUsedToday: number;
  maxJobsPerDay: number | null;
}

/** The grant's admitted calls in `window`, grouped by service and action (one SUM per group). */
export async function getGrantUsage(
  grant: AgentGrantRow,
  window: Extract<UsageWindow, { ok: true }>,
  runner: Runner = dbRunner()
): Promise<AgentGrantUsage> {
  const rows = ((await runner.run(
    SELECT.from(GRANT_USAGE_ENTITY)
      .columns(
        'service',
        'action',
        { func: 'sum', args: [{ ref: ['calls'] }], as: 'calls' },
        { func: 'sum', args: [{ ref: ['refunded'] }], as: 'refunded' }
      )
      .where({ grant_ID: grant.ID, day: { '>=': window.sinceDay } })
      .and({ day: { '<=': window.untilDay } })
      .groupBy('service', 'action')
  )) ?? []) as Array<{ service?: string; action?: string; calls?: unknown; refunded?: unknown }>;
  const calls: GrantUsageCall[] = rows
    .map((r) => {
      const admitted = Number(r.calls ?? 0);
      const refunded = Number(r.refunded ?? 0);
      return { service: String(r.service ?? ''), action: String(r.action ?? ''), count: Math.max(admitted - refunded, 0), refunded };
    })
    .sort((a, b) => a.service.localeCompare(b.service) || a.action.localeCompare(b.action));
  const status = toGrantStatus(grant);
  return {
    grantId: grant.ID,
    since: window.since,
    until: window.until,
    calls,
    total: calls.reduce((sum, c) => sum + c.count, 0),
    jobsUsedToday: status.jobsUsedToday,
    maxJobsPerDay: status.maxJobsPerDay,
  };
}

export interface AgentGrantStatus {
  grantId: string;
  agentLabel: string | null;
  allowedActions: string[];
  walletId: string | null;
  allowedJobKinds: string[];
  maxJobsPerDay: number | null;
  jobsUsedToday: number;
  budgetWindow: string | null;
  validUntil: string | null;
  isActive: boolean;
}

export function toGrantStatus(grant: AgentGrantRow): AgentGrantStatus {
  return {
    grantId: grant.ID,
    agentLabel: grant.agentLabel ?? null,
    allowedActions: parseGrantList(grant.allowedActions),
    walletId: grant.walletId ?? null,
    allowedJobKinds: parseGrantList(grant.allowedJobKinds),
    maxJobsPerDay: grant.maxJobsPerDay ?? null,
    // A counter from an earlier UTC day is spent budget of a window that is over.
    jobsUsedToday: grant.budgetWindow === utcDay() ? Number(grant.jobsUsedToday ?? 0) : 0,
    budgetWindow: grant.budgetWindow ?? null,
    validUntil: grant.validUntil ?? null,
    isActive: grant.isActive !== false,
  };
}

// ---------------------------------------------------------------------------
// CardanoAgentService handlers
// ---------------------------------------------------------------------------

/**
 * The common prelude of the four administration actions: the rate limit first
 * (refusals consume the window, like NIGHTGATE), then the token principal
 * (belt and braces: none of these is always-allowed or allow-listable, so the
 * hook 403s, and @requires: 'Admin' refuses the role-less principal anyway),
 * then authentication. False after a reject.
 */
function checkGrantAdmin(req: Request, verb: string): boolean {
  const rate = grantAdminLimiter().check(principalRateKey(req, 'grant-admin'));
  if (!rate.allowed) {
    req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
    return false;
  }
  if (agentGrantOf(req)) {
    req.reject(403, `an agent grant cannot ${verb} grants`);
    return false;
  }
  if (!req.user?.id) {
    req.reject(401, 'authentication required');
    return false;
  }
  return true;
}

function userIs(req: Request, role: string): boolean {
  const user = req.user as { is?: (r: string) => boolean } | undefined;
  return typeof user?.is === 'function' ? user.is(role) === true : false;
}

/** Validation rejections are thrown BEFORE any transaction work (project convention). */
export function registerAgentGrantHandlers(srv: cds.Service): void {
  srv.on('CreateAgentGrant', async (req: Request) => {
    if (!checkGrantAdmin(req, 'issue')) return;
    const operatorId = String(req.user.id);

    const data = (req.data ?? {}) as IssueAgentGrantInput;
    let normalized: NormalizedGrantInput;
    try {
      normalized = validateGrantInput(data);
    } catch (err) {
      if (err instanceof BackendError) return req.reject(err.statusCode, err.message, err.target);
      throw err;
    }
    const issued = await issueAgentGrant(normalized, operatorId, cds.tx(req) as unknown as Runner);
    return {
      grantId: issued.grantId,
      token: issued.token,
      allowedActions: issued.allowedActions,
      walletId: issued.walletId,
      allowedJobKinds: issued.allowedJobKinds,
      maxJobsPerDay: issued.maxJobsPerDay,
      validUntil: issued.validUntil,
    };
  });

  srv.on('RevokeAgentGrant', async (req: Request) => {
    if (!checkGrantAdmin(req, 'revoke')) return;
    const { grantId } = (req.data ?? {}) as { grantId?: string };
    if (!grantId) return req.reject(400, 'grantId is required', 'grantId');
    const revoked = await revokeAgentGrantById(grantId, cds.tx(req) as unknown as Runner);
    if (!revoked) return req.reject(404, 'Grant not found or already revoked', 'grantId');
    return true;
  });

  srv.on('RotateAgentGrantToken', async (req: Request) => {
    if (!checkGrantAdmin(req, 'rotate')) return;
    const { grantId } = (req.data ?? {}) as { grantId?: string };
    if (!grantId) return req.reject(400, 'grantId is required', 'grantId');
    const rotated = await rotateAgentGrantToken(grantId, cds.tx(req) as unknown as Runner);
    if (!rotated) return req.reject(404, 'Grant not found or already revoked', 'grantId');
    return rotated;
  });

  srv.on('UpdateAgentGrant', async (req: Request) => {
    if (!checkGrantAdmin(req, 'update')) return;
    const data = (req.data ?? {}) as UpdateAgentGrantInput & { grantId?: string } & Record<string, unknown>;
    if (!data.grantId) return req.reject(400, 'grantId is required', 'grantId');
    const immutable = GRANT_IMMUTABLE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(data, f));
    if (immutable.length > 0) {
      return req.reject(400, `${immutable.join(', ')} cannot be changed; issue a new grant for a different binding`, immutable[0]);
    }
    let result: UpdateAgentGrantResult;
    try {
      result = await updateAgentGrant(data.grantId, data, cds.tx(req) as unknown as Runner);
    } catch (err) {
      if (err instanceof BackendError) return req.reject(err.statusCode, err.message, err.target);
      throw err;
    }
    if (!result.ok) {
      if (result.code) return req.reject({ status: result.status, code: result.code, message: result.message } as never);
      return req.reject(result.status, result.message, 'grantId');
    }
    return { grantId: result.grantId, updated: result.updated };
  });

  // GetGrantStatus: the calling token's own grant, read fresh so the budget
  // counter is current. An operator without a token lists AgentGrants instead.
  srv.on('GetGrantStatus', async (req: Request) => {
    const grant = agentGrantOf(req);
    if (!grant) return req.reject(400, 'GetGrantStatus needs an x-agent-token; operators read the AgentGrants entity');
    const fresh = (await cds.tx(req).run(SELECT.one.from(GRANTS_ENTITY).where({ ID: grant.ID }))) as AgentGrantRow | null;
    return toGrantStatus(fresh ?? grant);
  });

  // GetGrantUsage: an Admin sees any grant (revoked ones keep their history), a
  // token only its own — the hook already narrowed it (404, non-leaking).
  srv.on('GetGrantUsage', async (req: Request) => {
    const data = (req.data ?? {}) as { grantId?: string; since?: unknown; until?: unknown };
    if (!data.grantId) return req.reject(400, 'grantId is required', 'grantId');
    const window = resolveUsageWindow(data.since, data.until);
    if (!window.ok) return req.reject(400, window.message, window.target);
    const own = agentGrantOf(req);
    if (own && own.ID !== data.grantId) return req.reject(404, 'Grant not found', 'grantId');
    if (!own && !userIs(req, 'Admin')) return req.reject(403, "GetGrantUsage needs Admin or the grant's own token");
    const tx = cds.tx(req) as unknown as Runner;
    const grant = (await tx.run(SELECT.one.from(GRANTS_ENTITY).where({ ID: data.grantId }))) as AgentGrantRow | null;
    if (!grant) return req.reject(404, 'Grant not found', 'grantId');
    return getGrantUsage(grant, window, tx);
  });
}

// ---------------------------------------------------------------------------
// Enforcement (before('*') on the six services)
// ---------------------------------------------------------------------------

export function attachAgentGrantEnforcement(srv: cds.Service, runner?: Runner): void {
  const serviceName = String(srv.name ?? 'unknown');
  srv.before('*', (req: Request) => enforceAgentGrant(req, runner, undefined, serviceName));
}

/**
 * Exported for unit tests; see the module doc for the ladder. Ordinary
 * principals pass through untouched: this hook is a no-op without a grant.
 */
/**
 * Where the hook's own writes go.
 *
 * Default: DETACHED from the request transaction (`runWithoutAmbientTx`), so
 * the spend sticks even when the request later fails and no write lock is held
 * across the handler's backend round trips.
 *
 * Exception: a request that already sits inside an open transaction — the
 * second and later parts of a `$batch` changeset (atomicity group) — owns the
 * pooled connection. On SQLite the pool has one connection, so a detached
 * statement would wait for it until the changeset commits, which waits for
 * this hook: a deadlock. Such a request rides its own transaction instead; the
 * changeset's rollback is then the refund, and no `failed` listener is needed.
 * `ready` is set the moment CAP begins the transaction, `dbc` once the
 * connection is acquired; either means "already open".
 */
export interface BudgetRunner {
  runner: Runner;
  /** true: statements run outside the request transaction (and a refused request is refunded). */
  detached: boolean;
}

export function budgetRunnerFor(req: Request, injected?: Runner, detached?: boolean): BudgetRunner {
  if (injected) return { runner: injected, detached: detached ?? true };
  let tx: (Runner & { dbc?: unknown; ready?: unknown }) | null = null;
  try {
    tx = cds.tx(req) as unknown as Runner & { dbc?: unknown; ready?: unknown };
  } catch {
    tx = null;
  }
  if (tx && (tx.dbc || tx.ready)) return { runner: tx, detached: false };
  return { runner: dbRunner(), detached: true };
}

async function runStmt(br: BudgetRunner, statement: unknown): Promise<unknown> {
  return br.detached ? runWithoutAmbientTx(() => br.runner.run(statement)) : br.runner.run(statement);
}

/**
 * Exported for unit tests; see the module doc for the ladder. Ordinary
 * principals pass through untouched: this hook is a no-op without a grant.
 * `runner` / `detached` are test seams; production picks them per request.
 */
export async function enforceAgentGrant(
  req: Request,
  runner?: Runner,
  detached?: boolean,
  serviceName: string = 'unknown'
): Promise<unknown> {
  const grant = agentGrantOf(req);
  if (!grant) return;

  // Defence in depth: the lane already refused inactive and expired grants, but
  // a grant can be revoked between two parts of a $batch, or expire mid-flight.
  if (grant.isActive === false) return req.reject(401, 'invalid agent token');
  if (isExpired(grant)) return req.reject(410, 'agent grant expired');

  const br = budgetRunnerFor(req, runner, detached);

  const event = String(req.event ?? '');
  if (AGENT_ALWAYS_ALLOWED_EVENTS.has(event)) {
    // The handler's Admin gate alone would answer for every grant: a token sees
    // its own usage only, and a foreign id is not found (non-leaking, NIGHTGATE).
    if (event === 'GetGrantUsage') {
      const asked = String((req.data as { grantId?: unknown } | undefined)?.grantId ?? '');
      if (asked !== grant.ID) return req.reject(404, 'Grant not found', 'grantId');
    }
    await touchLastUsed(grant, br);
    return;
  }

  const allowed = parseGrantList(grant.allowedActions);
  if (!allowed.includes(event)) {
    return req.reject(403, `action '${event}' is not allowed for this agent grant`);
  }

  const data = req.data as Record<string, unknown> | undefined;
  if (AGENT_WALLET_ACTIONS.has(event)) {
    if (!grant.walletId) {
      return req.reject(403, 'this agent grant has no wallet binding; issue it with walletId to queue wallet jobs');
    }
    if (data && typeof data === 'object') {
      if (event === 'SubmitWalletJob') {
        if (data.walletId !== undefined && data.walletId !== null && data.walletId !== '' && data.walletId !== grant.walletId) {
          return req.reject(403, 'walletId does not match this agent grant');
        }
        data.walletId = grant.walletId;
        const kinds = parseGrantList(grant.allowedJobKinds);
        if (kinds.length > 0 && !kinds.includes(String(data.kind ?? ''))) {
          return req.reject(403, `job kind '${String(data.kind ?? '')}' is not allowed for this agent grant (allowed: ${kinds.join(', ')})`);
        }
      }
      // CancelJob: the job lookup is owner-scoped by createdBy = agent:<grantId>
      // in the worker service, so a foreign job is a 404 there already.
    }
  }

  let charge: BudgetCharge | null = null;
  if (grant.maxJobsPerDay !== undefined && grant.maxJobsPerDay !== null) {
    charge = await consumeDailyBudget(br, grant);
    if (!charge.consumed) {
      return req.reject(429, `agent grant daily budget exhausted (${grant.maxJobsPerDay}/day)`);
    }
  }

  // Admitted: one usage unit on (grant, day, service, action), budgeted or not.
  const usageDay = await recordGrantUsage(br, grant, serviceName, event);

  // Detached writes: a request the handler refuses as invalid (400..428)
  // admitted nothing, so give the budget unit back — in the window it was
  // charged to, not in whatever day it is when the refund runs — and mark the
  // usage unit refunded. 429 and every 5xx keep both (over-count, never
  // under-count). Writes made inside the request's own transaction need none
  // of this: its rollback undoes them.
  if (br.detached) {
    const chargedWindow = charge?.window ?? null;
    (req as unknown as { on?: (ev: string, fn: (err: unknown) => void) => void }).on?.('failed', (err: unknown) => {
      const e = err as { status?: unknown; statusCode?: unknown; code?: unknown } | null;
      const status = Number(e?.status ?? e?.statusCode ?? e?.code);
      if (Number.isInteger(status) && status >= 400 && status < 429) {
        // Off the failing request's tick: its transaction is still rolling
        // back when 'failed' fires, and a write on a second connection at
        // that moment is the SQLite lock contention this module must never cause.
        setImmediate(() => {
          if (chargedWindow) {
            void refundDailyBudget(br, grant, chargedWindow).catch((refundErr: unknown) =>
              logger.warn(`daily budget refund for grant ${grant.ID} failed: ${String((refundErr as Error)?.message ?? refundErr)}`)
            );
          }
          void refundGrantUsage(br, grant, serviceName, event, usageDay).catch((refundErr: unknown) =>
            logger.warn(`usage refund for grant ${grant.ID} failed: ${String((refundErr as Error)?.message ?? refundErr)}`)
          );
        });
      }
    });
  }

  await touchLastUsed(grant, br);
}

export interface BudgetCharge {
  consumed: boolean;
  /** The UTC day the unit was charged to; the refund must name the same window. */
  window: string;
}

/**
 * Consume one unit of the grant's daily budget. Two conditional UPDATEs so
 * concurrent requests cannot overspend: a window reset (compare-and-swap on
 * the OLD window value) and a bounded increment (`jobsUsedToday < max`). Runs
 * on the BudgetRunner the hook chose (detached by default, see budgetRunnerFor).
 */
export async function consumeDailyBudget(br: BudgetRunner | Runner, grant: AgentGrantRow): Promise<BudgetCharge> {
  const runner: BudgetRunner = 'runner' in br ? br : { runner: br, detached: true };
  const today = utcDay();
  const max = grant.maxJobsPerDay as number;

  if (grant.budgetWindow !== today) {
    const reset = await runStmt(runner,
      UPDATE.entity(GRANTS_ENTITY)
        .set({ budgetWindow: today, jobsUsedToday: 1 })
        .where({ ID: grant.ID, budgetWindow: grant.budgetWindow ?? null })
    );
    if (Number(reset)) return { consumed: true, window: today };
    // Lost the reset race: another request already moved the window.
  }
  const incremented = await runStmt(runner,
    UPDATE.entity(GRANTS_ENTITY)
      .set({ jobsUsedToday: { '+=': 1 } })
      .where({ ID: grant.ID, budgetWindow: today, jobsUsedToday: { '<': max } })
  );
  return { consumed: Number(incremented) > 0, window: today };
}

/**
 * Undo one consumeDailyBudget in the window it was charged to (a refused
 * request created nothing). A refund that lands after midnight must not touch
 * the new day's counter: the unit was spent yesterday, yesterday keeps it.
 */
export async function refundDailyBudget(br: BudgetRunner | Runner, grant: AgentGrantRow, window: string): Promise<void> {
  const runner: BudgetRunner = 'runner' in br ? br : { runner: br, detached: true };
  await runStmt(runner,
    UPDATE.entity(GRANTS_ENTITY)
      .set({ jobsUsedToday: { '-=': 1 } })
      .where({ ID: grant.ID, budgetWindow: window, jobsUsedToday: { '>': 0 } })
  );
}

/**
 * One admitted call: `calls + 1` on (grant, UTC day, service, action). A
 * conditional UPDATE first (the common path), an INSERT when the row does not
 * exist yet, one more UPDATE when a racing request inserted it first. Runs on
 * the hook's BudgetRunner and is AWAITED like every other write of the hook
 * (see touchLastUsed), but never fails the request: usage is accounting, not
 * admission. Returns the day the call was counted on (the refund names it).
 */
export async function recordGrantUsage(
  br: BudgetRunner | Runner,
  grant: AgentGrantRow,
  service: string,
  action: string,
  now: Date = new Date()
): Promise<string> {
  const runner: BudgetRunner = 'runner' in br ? br : { runner: br, detached: true };
  const day = utcDay(now);
  const key = { grant_ID: grant.ID, day, service, action };
  const bump = () => runStmt(runner, UPDATE.entity(GRANT_USAGE_ENTITY).set({ calls: { '+=': 1 } }).where(key));
  try {
    if (Number(await bump()) > 0) return day;
    try {
      await runStmt(runner, INSERT.into(GRANT_USAGE_ENTITY).entries({ ...key, calls: 1, refunded: 0 }));
    } catch {
      await bump(); // lost the insert race: the row exists now
    }
  } catch (err) {
    logger.warn(`usage record for grant ${grant.ID} (${service}.${action}) failed: ${String((err as Error)?.message ?? err)}`);
  }
  return day;
}

/** `refunded + 1` on the row the call was counted on: a refused request admitted nothing. */
export async function refundGrantUsage(
  br: BudgetRunner | Runner,
  grant: AgentGrantRow,
  service: string,
  action: string,
  day: string
): Promise<void> {
  const runner: BudgetRunner = 'runner' in br ? br : { runner: br, detached: true };
  await runStmt(runner,
    UPDATE.entity(GRANT_USAGE_ENTITY)
      .set({ refunded: { '+=': 1 } })
      .where({ grant_ID: grant.ID, day, service, action })
  );
}

/**
 * lastUsedAt, at most once a minute per grant. AWAITED, like the budget
 * statements: every write this hook makes must be finished before the handler
 * opens the request's own transaction. A fire-and-forget write on a second
 * connection races the handler's reads and, on SQLite in WAL mode, turns the
 * handler's first UPSERT into "database is locked" (SQLITE_BUSY_SNAPSHOT) —
 * seen live on 2026-09-05. A failed touch is logged and never fails the request.
 */
const lastUsedTouched = new Map<string, number>();
const LAST_USED_INTERVAL_MS = 60_000;

async function touchLastUsed(grant: AgentGrantRow, br: BudgetRunner): Promise<void> {
  const now = Date.now();
  const last = lastUsedTouched.get(grant.ID) ?? 0;
  if (now - last < LAST_USED_INTERVAL_MS) return;
  lastUsedTouched.set(grant.ID, now);
  try {
    await runStmt(br, UPDATE.entity(GRANTS_ENTITY).set({ lastUsedAt: new Date(now).toISOString() }).where({ ID: grant.ID }));
  } catch (err) {
    logger.debug(`lastUsedAt update for grant ${grant.ID} failed: ${String((err as Error)?.message ?? err)}`);
  }
}
