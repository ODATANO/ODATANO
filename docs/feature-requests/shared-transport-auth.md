# FR: one transport auth for ODATANO CORE and NIGHTGATE (`@odatano/cap-auth`)

Status: Phase 1 built (`../CAP-AUTH`, 0.1.0, unpublished), Phase 2 built (NIGHTGATE 0.24.3), Phase 3 built (CORE 2.0.0-rc.8); Phase 4 (ACCESS) open. Deviations from the plan are noted inline.

## Problem

Both products install a custom `cds.requires.auth.impl` so that agent tokens
can reach a service (CAP's own strategies 401 a request without transport
credentials before any service hook runs). The two implementations diverged:

| | ODATANO CORE (`srv/utils/agent-token-auth.ts`) | NIGHTGATE (`srv/utils/agent-token-auth.ts`) |
|---|---|---|
| Structure | registered lanes, then DELEGATE to CAP's strategy for `kind` | four fixed lanes, then `reject401` |
| Request without credentials | CAP's `basic-auth`/`jwt-auth` decides; the model's `@requires` applies | 401 before the model is consulted |
| Basic credentials | CAP's `basic-auth` (no throttle) | own lane, timing-safe compare, 20 failures per 15 min per address, then 429 |
| Agent token | verified in the lane, principal `agent:<grantId>` with role `agent-grant` | marker principal `agent-token-transport`, the grant hook verifies (also per `$batch` part) |
| Public lane | none | `/api/v1/verify` under `NIGHTGATE_PUBLIC_VERIFY`, any-origin CORS |
| Extensible | `registerTransportLane` (x402 planned) | no |
| Image runtime | `NODE_ENV=development`, `CDS_REQUIRES_AUTH=mocked` | `NODE_ENV=production`, basic with operator password |

Consequences seen in operation:

- NIGHTGATE 0.24.2 made the indexer probes `@requires: 'any'` at the CAP
  level; on the hosted image they still answer 401 (`WWW-Authenticate: Basic
  realm="nightgate"`, our realm), because the transport layer rejects the
  request first. The gateway (ODATANO ACCESS) probes with operator
  credentials instead.
- The CORE image only appears to get this right: `mocked` under
  `development` never requires a login. With `production` and a password it
  would behave like NIGHTGATE does today at the model level, minus the
  throttle.
- NIGHTGATE keeps a second, CAP-free status surface (`/nightgate/*` with its
  own bearer token) for the container HEALTHCHECK. Two answers for "ready"
  hid the 0.24.2 gap: the container was healthy, the gateway path was closed.

## Target model

Authentication is a thin transport layer of lanes that always ends in CAP's
own strategy. Authorization lives only in the CDS model. No middleware
opens or closes a path on its own, and no model relies on CAP's implicit
production defaults.

1. Every service carries an explicit service-level `@requires`; elements
   only narrow it. Anonymous exists exactly where the model says `any`:
   liveness and readiness. Those two stay cheap and leak nothing (no
   version, no chain height). Metrics, runtime info and sync status stay
   `authenticated-user`. A model test in each product pins the layout
   (NIGHTGATE: `test/unit/service-auth-annotations.test.ts`).
2. One shared middleware, `@odatano/cap-auth`: registered lanes first, then
   the delegate for the configured `kind`. No terminal 401 of its own.
3. Same runtime in both images: `NODE_ENV=production`, `kind: basic` with
   an operator password. BTP keeps `xsuaa`; the delegate follows `kind`.
4. ACCESS is the only public entry; the backends sit on the internal Docker
   network. Gateway key to product token as `x-agent-token` stays. Health
   is probed anonymously on both products under the same shape,
   `/api/v1/indexer/getLiveness()`, without operator credentials. Rate
   limiting is primarily the gateway's job; the backend throttles remain as
   the second line.
5. One probe surface. NIGHTGATE's `/nightgate/*` status routes shrink to
   what the container HEALTHCHECK needs, or go.

Later, with real tenants: ACCESS mints a short-lived JWT per request and the
backends run `kind: jwt`. No backend holds a shared password; roles come
from the token.

## Phase 1: the package

- Repo `ODATANO/CAP-AUTH`, npm `@odatano/cap-auth`, Apache-2.0, CommonJS,
  TypeScript, peer dependency `@sap/cds` (`^9 || ^10`), no runtime
  dependencies (the rate limiter is about 60 lines and moves in).
- Installed as `cds.requires.auth.impl: '@odatano/cap-auth'`. CAP calls the
  module's default export with the merged `cds.requires.auth` options.

### API

```ts
import auth, { registerTransportLane, inLaneOf, markerUser, RateLimiter } from '@odatano/cap-auth';

interface TransportLane {
  name: string;                                   // unique; re-registering replaces
  match(req): boolean;                            // cheap header/path test
  authenticate(req, res): Promise<LaneOutcome>;   // { handled: true } | { pass: true } | { next: true }
}
// handled: the lane sent a response (401/410/429), stop.
// pass:    req.user is set, continue into CAP (authorization by the model).
// next:    not this lane's request after all; try the next lane, then the delegate.

registerTransportLane(lane);           // before cds 'bootstrap'; later calls throw
inLaneOf(path, prefix);                // exact segment boundary: prefix, prefix/..., prefix?...
markerUser(id);                        // a cds.User that owns nothing and has no roles
```

Built in, in this order:

1. `basic` lane (only when the delegate kind is `basic` or `mocked` and the
   request carries `Authorization: Basic`): timing-safe compare against
   `users`, roles from the user entry, failures throttled per client
   address (20 per 15 min, then 429 with `Retry-After`). Wrong credentials
   are `handled` (401 with `WWW-Authenticate: Basic realm="<realm>"`),
   never `next`: a bad password must not fall through to a token lane.
2. Product lanes in registration order.
3. Delegate: CAP's strategy for `kind` (`basic-auth`, `jwt-auth`, `ias-auth`,
   `dummy-auth`; same table as `@sap/cds/lib/srv/middlewares/auth`), or
   `delegateImpl` when the host had its own custom impl. The delegate never
   sees `impl`/`delegateImpl` (no recursion).

Options (`cds.requires.auth`): `kind`, `users`, `impl`, `delegateImpl`,
`realm` (default `odatano`), `basicThrottle: { windowMs, maxFailures, maxKeys }`.

### Contract

| Request | Outcome |
|---|---|
| no credentials, element `@requires: 'any'` | 200 (delegate admits anonymous, model allows) |
| no credentials, `authenticated-user` element | 401 from CAP, `WWW-Authenticate` from the delegate |
| valid basic | operator with configured roles |
| wrong basic, under budget | 401, counted |
| wrong basic, over budget | 429 + `Retry-After`, right or wrong password |
| `x-agent-token` on a lane path | the product's lane decides |
| `x-agent-token` off any lane path | lanes return `next`, delegate 401s (nothing else carried) |
| `Basic` AND `x-agent-token` | basic wins; a valid password is the operator, a wrong one is 401 |

Shipped as `@odatano/cap-auth/contract`: a Vitest matrix that runs against a
booted `cds.test()` app, so each product proves the same table in its own
CI with its own services and lanes.

### Not in the package

- Token verification. CORE verifies `odat_` in its lane; NIGHTGATE verifies
  `ngat_` in the grant hook (per `$batch` part) and passes a marker
  principal. Both remain product lanes; converging them is a separate step.
- Any path constant. Lane prefixes come from the product (CORE reads
  `cds.services[*].path`, NIGHTGATE its service roots).
- Public-verify CORS. NIGHTGATE's lane keeps it; the package only provides
  `markerUser` and `inLaneOf`.

### Done when

- `npm test` in the package covers the contract with a stub delegate and
  with CAP's real `basic-auth` and `dummy-auth`.
- 0.1.0 published; a fresh `cds.test()` app with only the package and
  `kind: basic` answers the contract table.

## Phase 2: NIGHTGATE consumes it (0.24.3)

- `cds.requires.auth.impl` in `docker/cds-config.mjs` becomes
  `@odatano/cap-auth`; `srv/utils/agent-token-auth.ts` is deleted. The
  agent-token lane and the public-verify lane are registered from
  `src/plugin.ts` (marker principals unchanged, `srv/sessions/agent-grants.ts`
  untouched). `realm: 'nightgate'`.
- Effect on the hosted image: the anonymous indexer probes answer 200
  through the model; nothing else changes (every NIGHTGATE service already
  carries a service-level `@requires`). Until then ACCESS keeps its operator
  fallback for health.
- `test/unit/agent-token-auth.test.ts` is replaced by the contract run plus
  the two lane tests.

## Phase 3: ODATANO CORE consumes it (2.0.0)

- `createAgentTokenAuth`, `loadDelegate`, `resolveCustomImpl` and the lane
  registry leave `srv/utils/agent-token-auth.ts`; what stays is the
  `odat_` lane, registered from `src/plugin.ts` when `agentGrants.enabled`.
  The x402 lane registers the same way.
- Image: `NODE_ENV=production`, `kind: basic` with `ODATANO_HTTP_PASSWORD`,
  `realm: 'odatano'`. `getLiveness()` stays the only anonymous element.
- `docs/AGENT_GRANTS_DESIGN.md` section 3 points at the package.

## Phase 4: ACCESS

- Health for both upstreams via anonymous `getLiveness()`; the operator
  credentials remain only for admin calls. `admin/health` reports
  `auth: anonymous` for both.
- NIGHTGATE's `/nightgate/*` routes are reduced to the container
  HEALTHCHECK (`/nightgate/ready` with the internal token) or replaced by
  the model probe; decided in NIGHTGATE 0.25.x.

## Invariants to keep

- A wrong basic credential never reaches a lane or the delegate.
- Lane prefixes match on segment boundaries; `/api/v1/nightgate-admin` is
  not in the `/api/v1/nightgate` lane.
- Marker principals own nothing: a handler reached under one is not
  authenticated until its hook says so.
- No service without a service-level `@requires`; the model tests fail
  otherwise.
- The package adds no path of its own and sends no terminal 401.

## Open

- Package versioning against two CAP majors (`^9 || ^10`): the delegate
  table is read from `@sap/cds` at load, so a renamed strategy file breaks
  at boot, not silently. A smoke test per supported major in the package CI.
- Whether the throttle key should include the user id next to the address
  (a shared NAT would lock out a whole office after 20 wrong tries).
