# FR: Agent-grant lifecycle parity with NIGHTGATE (for ODATANO ACCESS)

Status: OPEN (2026-09-18). Blocks the go-live of ODATANO ACCESS.
Requested by: ODATANO ACCESS (`../ACCESS`, the gateway that sells one
`oda_` key for both chains and holds one `odat_` grant per key underneath).
Design records: `AGENT_GRANTS_DESIGN.md` (this repo),
`../PULSE/ACCESS-KONZEPT-2026-09-17.md`.

## Why

ACCESS mints, rotates, tops up, revokes and reports on grants on BOTH
products through one code path (`srv/lib/upstream.ts`, `srv/lib/provision.ts`).
NIGHTGATE's `srv/sessions/agent-grants.ts` offers the full lifecycle;
ODATANO's `srv/utils/agent-grants.ts` (v2.0.0-rc.5) offers
`CreateAgentGrant`, `RevokeAgentGrant` and `GetGrantStatus` only. ACCESS
therefore has to special-case ODATANO in four places, and one of them is a
hard blocker:

| Concern | NIGHTGATE | ODATANO today | ACCESS consequence |
|---|---|---|---|
| Grant admin rate limit | `NIGHTGATE_GRANT_ADMIN_RATE_LIMIT` (default 10/h per principal) | hard-coded 10/h (`agent-grants.ts:114`) | the 11th key minted in an hour fails on ODATANO; a giveaway batch cannot be redeemed |
| Token rotation | `rotateAgentGrantToken(grantId)` | none | ACCESS must revoke + re-create, burning a rate-limit slot and a new grant id per rotation |
| Grant update | `updateAgentGrant(grantId, …)` | none | extending validity or raising the daily budget on top-up means revoke + re-create |
| Usage history | `getGrantUsage(grantId, since, until)` | `jobsUsedToday` on the row only | no per-grant history for the partner usage view, no reconciliation against the ACCESS ledger |
| Liveness | `getLiveness()` on `/api/v1/indexer`, no auth | none; ACCESS probes the service document with operator basic auth | health and credentials are mixed; a wrong operator password reads as "ODATANO down" |

Everything below is additive. No existing action, type or entity changes
shape. Names follow this repo's PascalCase convention; semantics follow
NIGHTGATE's so ACCESS can drive both products with the same code.

## What

### 1. `AGENT_GRANT_ADMIN_RATE_LIMIT` (blocker)

Env knob for the grant-administration rate limiter in
`srv/utils/agent-grants.ts`, read once at module load like the other
`AGENT_GRANTS_*` knobs in `agent-grants-config.ts`:

```
# Grant administration calls (CreateAgentGrant, UpdateAgentGrant,
# RotateAgentGrantToken, RevokeAgentGrant) per operator per hour. Default 10.
#AGENT_GRANT_ADMIN_RATE_LIMIT=10
```

- Integer, minimum 1, default 10 (unchanged behaviour when unset).
- Applies to every admin action of this FR, not only `CreateAgentGrant`.
- `.env.example`, the README config table and `AGENT_GRANTS_DESIGN.md`
  get the line.
- ACCESS on the hosted box sets it to 600: one gateway principal mints for
  everybody, and the gateway carries its own per-IP and per-account limits.

### 2. `RotateAgentGrantToken`

```cds
@title      : 'Rotate Agent Grant Token'
@description: 'Replace the grant token; the old token is unknown from the next request. Budget, wallet, allow list and expiry survive. Admin only.'
@requires   : 'Admin'
action RotateAgentGrantToken(
    @title: 'Grant Id' grantId : UUID
) returns RotatedGrant;

type RotatedGrant {
    grantId : UUID;
    token   : String; // shown once, never stored
}
```

- Generates a fresh `odat_` token (same `TOKEN_BYTES`, same
  `hashAgentToken`) and writes the new `tokenHash` in one UPDATE
  `where ID = ? and isActive = true`.
- 404 `Grant not found or already revoked` when the UPDATE touches no row
  (same wording as `RevokeAgentGrant`).
- 403 for a token principal, belt and braces like the other admin actions.
- Rate limited under (1).
- A request in flight with the old token completes; the next one is 401.
  The resolver reads `tokenHash` per request, so nothing needs invalidating.

### 3. `UpdateAgentGrant`

```cds
@title      : 'Update Agent Grant'
@description: 'Change label, allow list, wallet, job kinds, daily budget or expiry of an active grant. Absent (null) parameters stay as they are. Admin only.'
@requires   : 'Admin'
action UpdateAgentGrant(
    @title: 'Grant Id'          grantId         : UUID,
    @title: 'Agent Label'       agentLabel      : String(100),
    @title: 'Allowed Actions'   allowedActions  : many String,
    @title: 'Wallet Id'         walletId        : String(50),
    @title: 'Allowed Job Kinds' allowedJobKinds : many String,
    @title: 'Max Jobs Per Day'  maxJobsPerDay   : Integer,
    @title: 'Valid Until'       validUntil      : Timestamp
) returns UpdatedGrant;

type UpdatedGrant {
    grantId : UUID;
    updated : many String; // parameter names that were applied
}
```

- Null or absent means untouched. Clearing `validUntil` or
  `maxJobsPerDay` back to unlimited is out of scope (ACCESS never needs
  it); document that a value, once set, can only be replaced.
- The merged row (current values overlaid with the given ones) goes
  through the existing `validateGrantInput`, so the cross-field rules
  hold: `walletId` required with `SubmitWalletJob` or `CancelJob`, job
  kinds need `SubmitWalletJob`, `validUntil` in the future, action names
  known. `allowedActions` cannot be emptied.
- Lowering `maxJobsPerDay` below `jobsUsedToday` is allowed; the grant is
  simply over budget until the UTC day rolls.
- 404 when not found or revoked (a revoked grant is never updated; ACCESS
  re-mints instead), 403 for a token principal, 400 with `target` from the
  validator, rate limited under (1).

### 4. `GetGrantUsage`

```cds
@title      : 'Get Grant Usage'
@description: 'Admitted calls under a grant between since (default until - 30 days) and until (default now), at most 366 days, grouped by service and action. An Admin sees any grant; a token sees only its own.'
function GetGrantUsage(
    @title: 'Grant Id' grantId : UUID,
    @title: 'Since'    since   : Timestamp,
    @title: 'Until'    until   : Timestamp
) returns GrantUsage;

type GrantUsage {
    grantId       : UUID;
    since         : Timestamp;
    until         : Timestamp;
    calls         : many {
        service  : String(60);  // CardanoTransactionService, CardanoSignService, ...
        action   : String(100); // BuildSimpleAdaTransaction, SubmitTransaction, ...
        count    : Integer;     // admitted (budget charged and not refunded)
        refunded : Integer;     // admitted, then refunded because the handler failed
    };
    total         : Integer;
    jobsUsedToday : Integer;
    maxJobsPerDay : Integer;
}
```

Data source, new entity in `db/schema.cds` next to `CardanoAgentGrants`:

```cds
/** Daily per-action counters of admitted calls under a grant (feeds GetGrantUsage). */
entity CardanoAgentGrantUsage {
    key grant    : Association to CardanoAgentGrants;
    key day      : String(10);   // UTC YYYY-MM-DD
    key service  : String(60);
    key action   : String(100);
        count    : Integer default 0;
        refunded : Integer default 0;
}
```

- Written where the budget is charged today: `consumeDailyBudget` UPSERTs
  `count = count + 1` on (grant, day, service, action);
  `refundDailyBudget` does `refunded = refunded + 1`. Both already run on
  the budget runner, so the detached and worker lanes are covered.
- Grants without `maxJobsPerDay` (unlimited) count too: the usage write is
  unconditional, only the budget check stays conditional.
- One row per grant, day and action: a few dozen rows per grant per day at
  most. No retention job for now; add `AGENT_GRANT_USAGE_RETENTION_DAYS`
  later if it grows.
- `since` and `until` snap to whole UTC days; a span over 366 days is 400.
- A token principal calling with a foreign `grantId` gets 403 (mirror of
  NIGHTGATE's `enforceAgentGrant` narrowing). `GetGrantUsage` joins the
  always-allowed set for token principals next to `GetGrantStatus`.
- `CardanoAgentGrantUsage` is NOT exposed as an entity on
  `CardanoAgentService`; the function is the contract.

### 5. `GET /health`

Unauthenticated liveness on the express app, registered by the plugin
(`srv/plugin.ts`) and by standalone `srv/server.ts` via
`cds.on('bootstrap', app => app.get('/health', …))`, ahead of any auth
middleware:

```json
{ "status": "ok", "timestamp": "2026-09-18T10:00:00.000Z", "uptime": 1234,
  "version": "2.0.0-rc.6", "network": "preprod" }
```

- 200 as long as the process answers; no backend or DB probe. That stays
  with `CardanoIndexerService.getStatus` and the backend health entities,
  which remain authenticated.
- No secrets, no backend names, no API key state in the body.
- The Dockerfile `HEALTHCHECK` can move from the service document to
  `/health`; the ACCESS upstream probe does the same and drops the
  operator credentials from the probe.

## ACCESS-side follow-up (not part of this FR, listed so nothing is lost)

- `srv/lib/upstream.ts`: `odatano.rotateGrant`, `odatano.updateGrant`,
  `odatano.grantUsage`; probe `/health` instead of the service document.
- `srv/lib/provision.ts`: rotation and top-up call the upstream rotate and
  update on both products instead of revoke + create on ODATANO.
- `scripts/mock-odatano.mjs` and `scripts/smoke.mjs`: the new actions.
- Hosted `.env`: `AGENT_GRANT_ADMIN_RATE_LIMIT=600`.

## Tests

- `test/unit/agent-grants*.test.ts`: rate limit knob (default 10, env
  override, minimum 1); rotate (old token 401, new token admitted, budget
  counter survives, 404 on revoked, 403 for a token principal); update
  (partial update leaves the rest, validator rules on the merged row,
  cannot empty `allowedActions`, 404 on revoked); usage (counts on admit,
  refunded on handler failure, day grouping, foreign grant 403 for a token,
  366-day cap).
- Integration: the existing agent-grant lane test gets one rotate and one
  update step.
- `/health`: plugin mode and standalone both answer without credentials.

## Out of scope

- Clearing `validUntil` or `maxJobsPerDay` back to unlimited via update.
- Deploy budgets, contract or circuit allow lists (NIGHTGATE-only concepts).
- Per-grant DUST or ADA cost accounting (ACCESS prices in units, not fees).
- A usage retention job.

## Release

Target: 2.0.0-rc.6, before ODATANO ACCESS goes live on `api.odatano.dev`.
Changelog line: "Agent grants: rotate, update and usage history; grant admin
rate limit configurable; unauthenticated `GET /health`."
