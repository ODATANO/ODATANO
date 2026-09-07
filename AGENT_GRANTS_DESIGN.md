# Agent grants for @odatano/core (Phase B) — design

Status: **implemented 2026-09-05** (steps 1–6 of §7; the test suites are written
and await the user's run). Origin: ODATANO-MCP `PLAN.md` §6 ("agent grants in
core"), prerequisite for exposing wallet-worker jobs to agents. Reference
implementation: NIGHTGATE `srv/sessions/agent-grants.ts` (0.14–0.22) and
`srv/utils/agent-token-auth.ts`.

Implementation deviation worth knowing (§2, §2.4 step 8): the token principal
is **`agent:<grantId>`** with the single role `agent-grant`, NOT the operator.
CAP runs before-handlers in parallel, so a principal swap inside a service hook
would race CAP's own `@requires` / `@restrict` evaluation; authenticating at
the transport and using a dedicated principal removes the race, lets
`createdBy = $user` scope wallet jobs to the grant without a new column, and
makes every `@requires: 'Admin'` refuse the token by construction. The
operator (`userId`) stays on the row for audit.

## 1. Problem

ODATANO authenticates at the transport (CAP `mocked`/`basic` in development,
XSUAA in production) and authorizes at service level only: `authenticated-user`
on all five services, `Admin` on pause/resume, `createdBy = $user` on
`WalletJobs`, an optional role on HSM signing. There is no way to hand an agent
or a consumer a scoped credential: whoever has a user can build, sign-with-HSM,
submit and (with `Admin`) stop the worker. The hosted instance today runs on
one basic-auth admin user.

## 2. Model (inherited from NIGHTGATE, adapted)

A **grant** is a bearer capability, not an identity. The token (`odat_` +
32 random bytes hex, shown once, stored as SHA-256) authorizes and scopes a
request *within* the service; a valid token replaces the transport principal
with the grant's **operator** (`userId`) so every existing `createdBy` /
`req.user` gate keeps working. What differs from NIGHTGATE:

| NIGHTGATE | ODATANO |
|---|---|
| bound to a wallet **session** (+ sponsor session, dust budget, sponsor policy) | bound to a **worker wallet** (`walletId`, optional) |
| grantable = attest/anchor/disclosure/sponsor actions | grantable = builds, signing-request lifecycle, submits, wallet jobs |
| operator = any authenticated user owning the session | operator = an **`Admin`**: worker wallets are server-owned, nobody else may delegate them |
| one service path | five service paths, hook registered centrally |

### 2.1 Entity `CardanoAgentGrants` (db/schema.cds)

```
entity CardanoAgentGrants {
  key ID              : UUID;
      userId          : String(200) not null;   // operator; effective req.user for token requests
      agentLabel      : String(100);
      tokenHash       : String(64) not null;    // SHA-256 of the token; the token itself is never stored
      allowedActions  : LargeString not null;   // JSON array of allow-listed action names
      walletId        : String(50);             // worker wallet pin; required when SubmitWalletJob/CancelJob is allowed
      allowedJobKinds : LargeString;            // JSON array of WalletJobKind; null = every kind
      maxJobsPerDay   : Integer;                // null = unlimited; counts budgeted actions per UTC day
      jobsUsedToday   : Integer default 0;
      budgetWindow    : String(10);             // 'YYYY-MM-DD' (UTC) the counter belongs to
      validUntil      : Timestamp;              // null = no expiry
      isActive        : Boolean default true;
      revokedAt       : Timestamp;
      createdAt       : Timestamp;
      lastUsedAt      : Timestamp;              // informational, for PULSE
}
```

No new column on `CardanoWalletJobs` was needed in the end: a job queued under
a token is created with `createdBy = agent:<grantId>` (the token principal), so
the existing `createdBy = $user` restriction and the `job.createdBy !==
req.user.id` checks in `GetJobStatus` / `CancelJob` scope it to the grant
unchanged. `lastUsedAt` was added for PULSE.

### 2.2 Service surface: a new `CardanoAgentService`

Decided 2026-09-05: not inside `CardanoSignService` (PLAN.md §6 said so) but a
sixth service, `CardanoAgentService` at `/odata/v4/cardano-agent`, so that

- everything about grants lives in one place with one authorization story,
- ODATANO-MCP (and any agent) discovers grant support from the service
  document / `$metadata` instead of probing an action inside the sign service,
- an **agent itself** has a small self-service surface on it: with its token it
  may read its own grant row and call `GetGrantStatus()` to learn what it is
  allowed to do and how much budget is left, which is what an MCP tool needs
  to describe itself honestly. Creation and revocation stay `Admin`-only.

```
@requires: 'authenticated-user'
service CardanoAgentService @(impl: './cardano-agent-service') {

  @readonly
  @restrict: [{ grant: 'READ', to: 'Admin' }]     // token requests are narrowed to their own row by the hook
  entity AgentGrants as projection on db.CardanoAgentGrants excluding { tokenHash };

  type GrantStatus { grantId: UUID; agentLabel: String; allowedActions: array of String; walletId: String;
                     allowedJobKinds: array of String; maxJobsPerDay: Integer; jobsUsedToday: Integer;
                     budgetWindow: String; validUntil: Timestamp; isActive: Boolean }

  /** Token self-service: the calling grant's own status. 400 without a token (an operator lists AgentGrants instead). */
  function GetGrantStatus() returns GrantStatus;

  @requires: 'Admin'
  action CreateAgentGrant(allowedActions: array of String,
                        walletId: String(50),          // optional
                        allowedJobKinds: array of String, // optional
                        maxJobsPerDay: Integer,        // optional
                        validUntil: Timestamp,         // optional
                        agentLabel: String(100))       // optional
  returns { grantId: UUID; token: String; allowedActions: array of String; walletId: String; validUntil: Timestamp };

  @requires: 'Admin'
  action RevokeAgentGrant(grantId: UUID) returns { revoked: Boolean };
}
```

Decided 2026-09-05: grant administration is `Admin`-only, and the grants table
itself is visible to `Admin` only (creation and revocation only through the two
actions; no direct writes). The one exception is a token request, which the
enforcement hook narrows to the grant's own row (`ID = grant.ID`) so an agent
can read its remaining budget and expiry, nothing else. The service is
registered like the other five: `src/plugin.ts` model list and `@impl` rewrite,
`cds-plugin.js` unchanged.

Rate limit on `CreateAgentGrant`: 10 per operator per hour (NIGHTGATE's value).

### 2.3 Allow lists

**Always allowed for any valid token, no budget** — reads and compute-only:
`READ` on every entity set, all 19 `CardanoODataService` actions
(`GetNetworkInformation` … `ParseTransactionCbor`), `GetBuildDetails`,
`GetTransactionBuildsByAddress`, `DeriveScriptAddress`, `ExtractPaymentKeyHash`,
`GetSigningRequest`, `GetSigningRequestsByAddress`, `VerifyDataSignature`,
`GetJobStatus`, `GetWorkerStatus`, `getStatus` (crawler), `GetHsmStatus`
(shape only, no key material), `GetGrantStatus` (the token's own grant).

**Allow-listable** (`allowedActions`):

Every allow-listed action costs **one budget unit** (decided 2026-09-05: a
build is the service an agent buys, "build my transaction, I sign and submit
it myself", so it counts like a submit). Reads and the always-allowed set are
free.

| action | notes |
|---|---|
| `BuildSimpleAdaTransaction`, `BuildTransactionWithMetadata`, `BuildMultiAssetTransaction`, `BuildMintTransaction`, `BuildPlutusSpendTransaction`, `SetCollateral` | unsigned CBOR; the address is the caller's problem (existing security note) |
| `CreateSigningRequest`, `VerifySignature` | signing-request lifecycle for externally signed transactions |
| `SubmitTransaction`, `SubmitSignedTransaction`, `SubmitVerifiedTransaction`, `CheckSubmissionStatus` | only CBOR a wallet already signed reaches the chain |
| `SubmitWalletJob`, `CancelJob` | needs `walletId` on the grant; `walletId` in the request is pinned/injected; `kind` must be in `allowedJobKinds` when set |

An operator who wants builds free and submits metered issues two grants; the
model stays one counter per grant, like NIGHTGATE.

**Never grantable** (403 for every token): `SignWithHsm`, `SignAndSubmitWithHsm`,
`PauseWorker`, `ResumeWorker`, `pauseCrawler`, `resumeCrawler`,
`CreateAgentGrant`, `RevokeAgentGrant`.

### 2.4 Enforcement ladder (one `before('*')` hook on all six services)

1. No grant on the request (the transport lane, §3, authenticated the token
   and parked the grant row on the express request): pass through unchanged.
   No behaviour change for normal users.
2. Token present but wrong prefix or unknown hash → 401 `invalid agent token`
   (non-leaking). Revoked grants are unknown grants.
3. Expired (`validUntil < now`) → 410.
4. Event not always-allowed and not on the allow list → 403 naming the event.
5. Wallet pinning: for `SubmitWalletJob`/`CancelJob`, `data.walletId` must equal
   the grant's `walletId` (403 on mismatch, injected when absent); `kind` must
   be in `allowedJobKinds` when the grant has one. `CancelJob` may only cancel a
   job with `grantId = grant.ID`.
6. READ narrowing is declarative, not in the hook: `WalletJobs` through the
   existing `createdBy = $user` restriction (the token's jobs carry
   `createdBy = agent:<grantId>`), `AgentGrants` through
   `ID = $user.grantId` for the `agent-grant` role; everything else stays
   readable. `GetJobStatus` / `CancelJob` keep their `job.createdBy !==
   req.user.id` → 404 check, which now scopes to the grant.
7. Budget: for allow-listed actions with `maxJobsPerDay` set, one unit via the
   two conditional UPDATEs from NIGHTGATE (window reset by compare-and-swap,
   then bounded increment). 429 when exhausted. Where the statements run
   (`budgetRunnerFor`, review finding 2026-09-06):
   - a plain request: **detached** from the request transaction
     (`runWithoutAmbientTx`) — the spend sticks even when the request fails,
     and no write lock is held across the handler's backend calls. Refund on
     `req.on('failed')` with status 400–428 (the handler refused the input,
     nothing was created), **into the window that was charged** (a refund
     after midnight must not touch the new day); 429 and 5xx keep the unit;
   - a request inside an already-open transaction — the later parts of a
     `$batch` changeset — charges **on that transaction**: it owns the single
     pooled SQLite connection, a detached statement would wait for it until
     the changeset commits, which waits for the hook (deadlock). The
     changeset's rollback is the refund, no listener needed.
8. Principal: set by the transport lane, not here — `new cds.User({ id:
   'agent:<grantId>', roles: ['agent-grant'], attr: { grantId, operator,
   walletId } })`. Deliberately **not** the operator and without any of the
   operator's roles: a token must never inherit `Admin`, and CAP evaluates
   `@requires` / `@restrict` against this user. The grant row rides on the
   express request (`req.http.req.agentGrant`) for the hook. `lastUsedAt` is
   updated detached, at most once per minute per grant.

Registration: `cds.on('serving', srv => …)` for the six service names, without
touching the existing impl files. It lives in `activateAgentGrants()`
(`srv/utils/agent-grants-config.ts`), called from `src/plugin.ts` (plugin mode)
AND from `srv/server.ts` at module load (standalone mode — CAP loads
`cds-plugin.js` only from dependencies, never from the project itself, so the
plugin file alone would leave standalone `cds serve` without grants). The call
is idempotent (marker on the `cds` facade) and never throws. Owner checks in ODATANO live inside `on` handlers, which
run after every `before` hook has settled, so the parallel-before-hook race
NIGHTGATE documents does not apply; `awaitAgentPrincipal` is still exported for
future before-hooks.

## 3. Transport: letting a token past CAP authentication

CAP's auth middleware 401s a request without transport credentials before any
service hook runs. Same solution as NIGHTGATE's standalone image, generalized:

`srv/utils/agent-token-auth.ts`, a CAP custom auth middleware
(`cds.requires.auth.impl`), with two lanes:

- Lane 1, credentials present: delegate to the configured strategy. For
  `basic`/`mocked` users from `cds.requires.auth.users` with a timing-safe
  compare and the failed-attempt throttle (20 per 15 min per client), roles
  carried into `cds.User`. For `jwt`/`xsuaa` (plugin mode in a real consumer):
  delegate to CAP's own strategy (`@sap/cds/lib/auth/jwt-auth` /
  `xsuaa-auth`), loaded once at startup with a self-test that fails fast if the
  internal module moved (CAP 10 pinned via peer dependency `^10`).
- Lane 2, `x-agent-token` present and the path is one of the six ODATANO
  service roots (exact segment match, no lookalike prefixes): authenticate the
  token right here (unknown or revoked → 401, expired → 410, 20 failures per
  client per 15 minutes → 429) and continue as `agent:<grantId>` /
  `agent-grant`, with the grant row parked on the express request for the
  hook in §2.4. A token on any other path is left to the delegate.
  Lanes are a registry (`registerTransportLane`), so `@odatano/x402` adds its
  payment lane next to this one (§9).

Configuration, one key:

```json
"odatano-core": { "agentGrants": { "enabled": true, "delegate": "basic" } }
```

`enabled: false` (default) = no middleware, no lane, nothing changes for
existing consumers. The Docker image and the hosted compose set it. Plugin
consumers on XSUAA opt in with `delegate: "xsuaa"`.

A host that already configured its **own** `cds.requires.auth.impl` keeps it
(review finding 2026-09-06): activation records that module as
`agentGrantsDelegateImpl`, the lane resolves it the way CAP resolves an impl
(relative to `cds.root`) and delegates every non-token request to it, on every
path. `delegate` is then `custom` (the default whenever a custom impl exists).
The lane never replaces a host's gate; it only adds the token path in front.

## 4. Budget semantics

Per UTC day, `maxJobsPerDay` counts **every allow-listed action call**: builds,
signing-request lifecycle, submits, wallet jobs, `CancelJob`. Reads and the
always-allowed set are free. A refused request (handler answers 400–428: bad
input, unknown wallet, disabled wallet) gets its unit back; 429 and 5xx keep it.
A cancelled wallet job does not refund the submit that created it (it consumed
a slot the moment it was admitted; over-count rather than under-count, as in
NIGHTGATE). When x402 sells grants (§9), one unit is one priced call.

## 5. Migration and operations

- Schema: one new entity, one new column. `cds deploy` evolves SQLite/HANA in
  place. The hosted image prunes `cds-dk`, so the hosted instance takes the
  new schema by re-seeding its volume (procedure in `/root/odatano/README.md`);
  the SQLite there holds only cache and an empty ledger today.
- PULSE: the ODATANO panel gets the grants table + create/revoke dialog; the
  backend side (`grantsPanel`, `createGrant`, `revokeGrant`) is generic already
  and needs the action names and the field mapping (`walletId` instead of
  `sessionId`, no sponsor).
- ODATANO-MCP: `ODATANO_TOKEN=odat_…` → `x-agent-token`; `submit_wallet_job` /
  `cancel_job` register when the capability probe sees `AgentGrants` in the
  sign service metadata.
- Version: ships in **2.0.0** (next RC, then final; decided 2026-09-05, see
  §8). CHANGELOG entry, README section "Agent grants", DELIVERABLES note.

## 6. Tests

- Unit (vitest, fake db runner): the ladder in §2.4 case by case — no header,
  marker without token, bad prefix, unknown hash, revoked, expired, event not
  allowed, never-grantable event with it on the list (creation refuses it),
  wallet mismatch / injection, job-kind narrowing, READ narrowing on the three
  entity sets, budget consume/reset/exhaust/refund with two grants racing,
  principal swap drops roles.
- Unit: `agent-token-auth` lanes — valid basic, wrong basic (throttle after 20),
  token on service path, token off path, `$batch` envelope.
- Integration (`cds.test`, mocked auth users `alice` = Admin, `bob` = plain):
  `bob` cannot create a grant (403); `alice` creates one pinned to a wallet;
  the token builds a transaction, submits a wallet job (walletId injected,
  `grantId` recorded), reads `WalletJobs` and sees only its own, cannot
  `PauseWorker` (403), cannot `SignWithHsm` (403), is refused after
  `maxJobsPerDay`; revoke → 401 on the next call.
- Existing suites must pass unchanged with `agentGrants.enabled` unset.

## 7. Work plan

| step | files | size |
|---|---|---|
| 1 schema + CDS | `db/schema.cds`, new `srv/cardano-agent-service.cds` + `.ts`, `src/plugin.ts` model list / `@impl` rewrite, cds-typer | small |
| 2 grants module | `srv/utils/agent-grants.ts` (create/revoke/GetGrantStatus handlers, allow lists, hashing, enforcement, budget) | ~450 lines, two thirds from NIGHTGATE |
| 3 transport auth | `srv/utils/agent-token-auth.ts` with a lane registry (`registerTransportLane`, §9), `src/plugin.ts` (config key, `serving` hook, `auth.impl` wiring), `srv/server.ts` `loadAgentGrantsConfigFromEnv` | ~300 lines |
| 3b public API | `issueAgentGrant()` / `revokeAgentGrant()` / `registerTransportLane()` exported from `src/index.ts` for x402 (§9) | small |
| 4 handlers | `SubmitWalletJob` writes `grantId`; `GetJobStatus`/`CancelJob` honour `req.agentGrant`; `job-store.ts` column | small |
| 5 tests | `test/unit/agent-grants.test.ts`, `test/unit/agent-token-auth.test.ts`, `test/integration/agent-grants.test.ts` | ~600 lines |
| 6 docs + config | README, CHANGELOG, `.env.example` (`AGENT_GRANTS_ENABLED`, `AGENT_GRANTS_DELEGATE`), Dockerfile/compose env, hosted compose | small |
| 7 downstream | PULSE grants panel for ODATANO; ODATANO-MCP token lane | separate changes |

Estimate: steps 1–6 in one to two working days; step 7 afterwards.

## 8. Open decisions (need a yes/no)

1. ~~Grant administration `Admin`-only or any authenticated user?~~ **Decided:
   `Admin`-only, own table readable/changeable by `Admin` only (§2.2).**
2. ~~Home of the actions: `CardanoSignService` or a new service?~~ **Decided:
   own `CardanoAgentService` at `/odata/v4/cardano-agent`, discoverable by
   MCP/agents, with token self-service `GetGrantStatus()` (§2.2).**
3. ~~Budget scope: submits + wallet jobs only, or builds too?~~ **Decided:
   every allow-listed action costs one unit, builds included (§2.3, §4).**
4. ~~Ship as 2.1.0 or into the 2.0.0 RC line?~~ **Decided: everything lands in
   2.0.0 (next RC, then final).** The version line in §5 is superseded.

## 9. Relation to x402 (`@odatano/x402`, decided direction 2026-09-05)

`@odatano/x402` (0.5.x, own repo, CAP plugin on top of core ≥ 1.9.1) gates a
service with HTTP 402 until the caller proves on-chain settlement: pay per
call, no accounts, same surface for humans, services and agents. The question
came up whether core should offer that instead of grants. They answer
different questions and fit together:

| | grants | x402 |
|---|---|---|
| question | *who may do what* with server-held capabilities (worker wallets, submits) | *has this call been paid for*, without an account |
| identity | operator-issued bearer capability, scoped and budgeted | none; a payment proof per request |
| fits | wallet jobs, HSM-adjacent writes, anything that spends the server's ADA | reads, builds, per-query data, anonymous agents |
| alone insufficient for | anonymous access without an operator | deciding *which* wallet an agent may spend from, and how much |

Direction:

1. **x402 stays its own package.** Payment code, facilitator and clients have
   their own release cadence and would burden every core consumer that never
   sells a request. Core does not absorb it.
2. **Core becomes x402-ready in 2.0.0 through the grant design**, with two
   seams:
   - `issueAgentGrant(input): { grantId, token }` exported from core's public
     API (`src/index.ts`), the same code path `CreateAgentGrant` uses. x402 can
     then **sell a grant**: an agent pays N ADA via 402 and receives a token
     with `maxJobsPerDay`/`validUntil` sized by the payment. Self-service
     onboarding without an operator in the loop, budgets as the unit of sale.
   - The transport middleware (§3) is built with **pluggable lanes**: core
     registers the `x-agent-token` lane; x402 registers a `PAYMENT-SIGNATURE`
     lane through a small API (`registerTransportLane(name, matcher, principal)`)
     instead of shipping a second `auth.impl` that would fight ours for the
     single `cds.requires.auth.impl` slot.
3. x402 0.6: peer dependency `@odatano/core ^2.0.0`, "buy a grant" flow, lane
   registration. Tracked in the x402 repo, not here.
