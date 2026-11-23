# ODATANO Security & Authentication Guide

**Version:** v2.0.0-rc.x

---

## Table of Contents

1. [Security Architecture](#security-architecture)
2. [Authentication (XSUAA)](#authentication-xsuaa)
3. [Authorization & Roles](#authorization--roles)
4. [API & Transport Security](#api--transport-security)
5. [Secret Management](#secret-management)
6. [Transaction Signing Security](#transaction-signing-security)
7. [Input Validation](#input-validation)
8. [Audit Trail](#audit-trail)

---

## Security Architecture

- **Keys.** In the external signing flow the server never sees a private key. Two opt-in features sign
  on the server. The HSM keeps the key in the module. The software signer of the wallet worker holds a
  key from an environment variable in memory.
- **Access.** A request needs a login and the role of the service it calls. Three operations answer
  without a login: `VerifyDataSignature`, `getLiveness()` and `getReadiness()`. So does the `$metadata`
  of the sign and indexer services, which holds no data.
- **Input.** Every operation checks its parameters before it acts.
- **Records.** Builds, signing requests, signature checks and submissions are stored and can be queried.

### Service Separation

| Service | Purpose | What is at stake |
|---------|---------|------------------|
| `CardanoODataService` | Reads chain data | Nothing is changed |
| `CardanoTransactionService` | Builds and submits transactions | Prepares the movement of funds; the key holder still has to sign |
| `CardanoSignService` | Signing requests, signature checks, submission, HSM signing | The HSM actions sign with a key the server can use |
| `CardanoIndexerService` | Crawler status and control | The control actions need `Admin` |
| `CardanoWorkerService` | Wallet jobs: build, sign, submit | Spends wallets whose keys the server holds. A wallet's `requiresRole` limits who may queue jobs; an HSM wallet also needs `hsm.requiresRole` |
| `CardanoBackendService` | Chain reads, script evaluation and submit for another ODATANO that uses this one as its backend | Submit sends a signed transaction |
| `CardanoAgentService` | Agent grants: tokens with an allow list and a budget (off by default) | A grant hands the listed actions to an agent. Administration needs `Admin` and is rate limited |

---

## Authentication (XSUAA)

Production on SAP BTP uses XSUAA. Development uses CAP's mocked authentication. The Docker image uses HTTP
basic auth; see [Docker Deployment](DOCKER_DEPLOYMENT.md#authentication).

### Profile Configuration

```json
{
  "cds": {
    "requires": {
      "[production]": {
        "db": { "kind": "hana" },
        "auth": "xsuaa"
      }
    }
  }
}
```

- **Development** (`cds watch`, `cds serve`): mocked authentication. A Basic-Auth header logs in as the named
  user and the password is not checked. A request without a login gets 401, a user without the role 403.
  Anyone who reaches the port can log in, so never expose a development instance.
- **Production** (`NODE_ENV=production`): XSUAA. Every request needs a valid JWT.

The development users of this repository are in `.cdsrc.json`: `alice` and `bob` hold `Read`, `Transact` and
`Sign`, `carol` holds `Read`, `admin` holds all four roles. A project that uses the plugin names its own
users under `cds.requires.auth.users`.

### xs-security.json

The scopes and role templates of `xs-security.json`:

```json
{
  "scopes": [
    { "name": "$XSAPPNAME.Read", "description": "Read Cardano blockchain data" },
    { "name": "$XSAPPNAME.Transact", "description": "Build and submit Cardano transactions" },
    { "name": "$XSAPPNAME.Sign", "description": "Sign transactions and manage HSM" },
    { "name": "$XSAPPNAME.Admin", "description": "Operate the ODATANO chain crawler and wallet worker" }
  ],
  "role-templates": [
    {
      "name": "CardanoReader",
      "description": "Read Cardano blockchain data",
      "scope-references": ["$XSAPPNAME.Read"]
    },
    {
      "name": "CardanoUser",
      "description": "Read, build/submit and sign Cardano transactions (no operational admin)",
      "scope-references": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign"]
    },
    {
      "name": "CardanoAdmin",
      "description": "Everything a CardanoUser may, and operate the chain crawler, the wallet worker and agent grants",
      "scope-references": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign", "$XSAPPNAME.Admin"]
    }
  ],
  "authorities": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign"]
}
```

`Admin` is not part of `CardanoUser` and not part of `authorities`. An operator gets `CardanoAdmin`
explicitly. `CardanoAdmin` carries all four scopes, because a service asks for its own role before it looks
at the operation: `PauseWorker` needs `Transact` and `Admin`.

### Setup on BTP

The MTA deployment creates the XSUAA instance `odatano-auth` from `xs-security.json` and binds it to the
service and the AppRouter (`mta.yaml`). Nothing has to be created by hand.

---

## Authorization & Roles

The services declare what they require with `@requires` in CDS.

### CDS Annotations

Five of the seven services require a role or a login at the service level: `CardanoODataService`,
`CardanoTransactionService`, `CardanoWorkerService`, `CardanoBackendService` and `CardanoAgentService`.

`CardanoSignService` and `CardanoIndexerService` are `@requires: 'any'` at the service level. CAP checks the
service before the operation, and each of the two has operations that must answer without a login. Every
other element of these two services carries its own requirement:

```cds
@requires: 'any'
service CardanoSignService {
    @requires: 'Sign'
    action CreateSigningRequest(...) returns SigningRequestResult;   // like every other element

    // wallet login happens before a user has a session
    @requires: 'any'
    action VerifyDataSignature(...) returns { ... };
}
```

| Who | What |
|---|---|
| Anyone, without a login | `VerifyDataSignature` (wallet login), `getLiveness()` and `getReadiness()` (probes), the `$metadata` of `CardanoSignService` and `CardanoIndexerService` |
| `Read` | `CardanoODataService`, `CardanoBackendService`, and on `CardanoIndexerService`: `SyncState`, `ReorgLog`, `getStatus()` |
| `Transact` | `CardanoTransactionService`, `CardanoWorkerService`, and on `CardanoBackendService` in addition to `Read`: `EvaluateTransaction`, `SubmitTransaction` |
| `Sign` | `CardanoSignService` except `VerifyDataSignature` |
| Any logged-in user | `CardanoAgentService`, whose operations need `Admin` or the calling agent token |
| `Admin` | `pauseCrawler`, `resumeCrawler`, `importUtxoSet`, every `backfill…` action, `pruneInputAssetCopies`, `restoreInputAssetCopies`, `cancelMaintenance`, `recheckFailedSubmits`, `ResolveJob`, `ResolveSigningRequest`, `ResolveSubmission`, `PauseWorker`, `ResumeWorker`, `CreateAgentGrant`, `UpdateAgentGrant`, `RotateAgentGrantToken`, `RevokeAgentGrant`, reading every row of `WalletJobs` and `AgentGrants` |
| Role named in `hsm.requiresRole` | `GetHsmStatus`, `SignWithHsm`, `SignAndSubmitWithHsm`, `SubmitWalletJob` for an HSM wallet |
| Role named in a wallet's `requiresRole` | `SubmitWalletJob` for that wallet |

Two entities are filtered by row:

- `WalletJobs`: a caller sees their own jobs (`createdBy = $user`). A job of another user answers 404, not
  403, so the answer does not reveal which job ids exist.
- `AgentGrants`: an agent token sees its own grant.

The service enforces these gates itself, in CDS and in its handlers. A caller without the role gets 403.
No role stands in for another: `Admin` alone reads nothing, and it does not replace `hsm.requiresRole` or a
wallet's `requiresRole`.

Where the roles come from:

| Login | Roles |
|---|---|
| XSUAA | The scopes of the user's role collections (`CardanoReader`, `CardanoUser`, `CardanoAdmin`) |
| Docker image | `ODATANO_HTTP_ROLES`, default `Read,Transact,Sign,Admin` for the one configured user |
| Agent token | `Read`, `Transact`, `Sign`; the grant then decides per operation, and `Admin` is never among them |
| Plugin in your own CAP project | Whatever your authentication assigns. A user without `Read` gets 403 on every read |

A software worker wallet without `requiresRole` accepts jobs from every user with `Transact`, with any
recipient and amount. That fits a deployment whose only login is the operator; the Docker image creates one
user with every role. Where several users can transact, set `requiresRole` on the wallet.

### Agent tokens

With `AGENT_GRANTS_ENABLED=true` an Admin can hand an agent a token instead of a user
(`CreateAgentGrant`). The token travels in the `x-agent-token` header; the server stores its SHA-256.

- A token request runs as `agent:<grantId>` with the roles `agent-grant`, `Read`, `Transact` and `Sign`,
  never with `Admin`. Every `Admin` gate, the HSM actions and grant administration refuse it.
- The allow list names `Service.operation`. A name without a service means the transaction or sign
  service; `CardanoBackendService.SubmitTransaction` must be named in full. Grants stored by rc.50 keep
  their meaning through the upgrade.
- Unknown tokens are throttled per client address, the same client the password login sees. A valid
  token is always admitted.
- Reads and compute-only actions are always allowed. An action on the grant's allow list costs one unit of
  its daily budget. Everything else is a 403.
- `CardanoWorkerService` answers every token request with 403: worker wallets sign with server-held keys,
  and an agent signs its transactions itself.
- A revoked or expired grant is an unknown token from the next request.

[Agent Grants](USER_GUIDE.md#agent-grants-opt-in) in the User Guide lists the actions a grant can allow, the
administration calls and the settings.

### Per-address data and ownership

ODATANO does not check that the caller owns an address. A user with `Transact` can build a transaction
for any sender and list the builds of any address (`GetTransactionBuildsByAddress`). A user with `Sign`
can list the signing requests of any address (`GetSigningRequestsByAddress`). Funds are safe:

- An unsigned transaction is useless without the private key. Only the key holder can sign it.
- A verified signing request holds a signed transaction. Submitting it early yields exactly the
  transaction its signer approved.
- Building for addresses the caller does not own is normal for scripts, multi-party Plutus flows
  and dApp backends.

What remains is privacy: a pending request shows what an address is about to do. A deployment with
several end users should add its own authorization (`@restrict`, middleware) that maps the claims of a
user to the addresses that user may see.

### Events and the authorization boundary

The CAP events (`blockIndexed`, `reorg`, `jobConfirmed`, `jobFailed`) are delivered inside the process, to
code of the same CAP application. `@requires`, the `Admin` role and the row filter on `WalletJobs` apply
to HTTP requests. They do not apply to a subscriber: a handler of the host application sees every event,
including jobs other users created.

So an event payload is not filtered for an end user. An application that forwards events to a webhook, a
message broker or a UI applies its own authorization there.

### BTP Role Collections

Create role collections in the SAP BTP Cockpit and assign them to users. The names are yours to choose:

| Role Collection | Role Template | Intended Users |
|-----------------|---------------|----------------|
| ODATANO Reader | CardanoReader | Analysts, dashboards, monitoring |
| ODATANO User | CardanoUser | Application backends, dApp frontends |
| ODATANO Admin | CardanoAdmin | Operators of the crawler, the wallet worker and agent grants |

A user with `CardanoReader` reads and gets 403 on every build, submit and signing operation. The AppRouter
routes require a login; the service behind them decides by scope.

---

## API & Transport Security

### TLS/HTTPS

SAP BTP terminates TLS. The compose file of the Docker stack publishes the API on `127.0.0.1` only; to
serve other hosts, put a reverse proxy with TLS in front of it. Then set `ODATANO_TRUST_PROXY` to the
number of proxies, so the login throttle keys on the real client, and keep the port reachable only
through the proxy (see [Docker Deployment](DOCKER_DEPLOYMENT.md#authentication)).

### AppRouter as Reverse Proxy

```
Internet --> AppRouter (login, session, CSRF) --> service
```

On BTP the AppRouter handles the login and the session and forwards the user's token to the service
(`forwardAuthToken` in `mta.yaml`). The service checks the token and the scopes of every request itself.

### CSRF Protection

`app/router/xs-app.json` sets `"csrfProtection": true` on both routes to the service. A client:

1. fetches a token with a `GET` request and the header `X-CSRF-Token: Fetch`,
2. sends the token in the header `X-CSRF-Token` with every `POST`, `PUT` and `DELETE`.

### CORS

CAP answers CORS requests in development and not in production. The repository configures no CORS rule.
A browser application on another origin needs one at the reverse proxy, or at the AppRouter in
`xs-app.json`:

```json
{
  "cors": [
    {
      "uriPattern": "^/odata/(.*)$",
      "allowedOrigin": [{ "host": "your-domain.com" }],
      "allowedMethods": ["GET", "POST", "OPTIONS"],
      "allowedHeaders": ["Authorization", "Content-Type", "X-CSRF-Token"]
    }
  ]
}
```

### Recommended Security Headers

The repository sets no additional response headers. Set them at the AppRouter or the reverse proxy:

| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |

---

## Secret Management

### Sensitive Variables

| Variable | Gives access to |
|----------|-----------------|
| `HSM_PIN` | The signing key in the HSM |
| The variable a worker wallet names in `keyEnv` | A signing key of the wallet worker |
| `ODATANO_HTTP_PASSWORD` | The operator login of the Docker image |
| `ODATANO_DB_URL` | The database; the URL carries the password |
| `ODATANO_API_KEY` | The gateway key of another ODATANO used as backend |
| `BLOCKFROST_API_KEY` | The Blockfrost project and its quota |
| `KOIOS_API_KEY` | The rate limit of the Koios token |

Ogmios has no authentication. Keep its port (`OGMIOS_URL`) inside the host or a private network.

### Best Practices

- Never commit a secret. `.env` and `prod.mtaext` are git-ignored in this repository; `mta.yaml`,
  `package.json` and `.cdsrc.json` are not.
- **Local development:** a `.env` file in the project root.
- **BTP:** the extension descriptor `prod.mtaext` at deploy time; see
  [Production Deployment](PRODUCTION_DEPLOYMENT.md#environment-variables-odatano-srv).
- A changed key takes effect with the next start of the service.
- The request log masks headers that carry credentials (`cds.log.mask_headers` in `package.json`), and the
  Docker image masks the database password in its start log.

---

## Transaction Signing Security

In the external signing flow the server sees the unsigned transaction, the signed transaction with its
public witnesses, and transaction hashes. It sees no private key.

The two server-side paths are opt-in. With the HSM the key never leaves the PKCS#11 module. The `software`
signer of the wallet worker reads an Ed25519 key from the environment variable named in `keyEnv`. It keeps
the key in memory, never stores it and never returns it through OData.

### External Signing Architecture

![External signing flow](<../assets/architecture & flow diagramms/signflow-ad.png>)

### Signing Methods

| Method | Where the key is | Typical use |
|--------|------------------|-------------|
| CIP-30 browser wallet | Browser extension | Web dApps, Fiori apps |
| Cardano CLI | File system (`.skey`) | Backend automation |
| Hardware wallet | Dedicated device | High-value transactions |
| HSM (PKCS#11) | Hardware module | Server-side automation |

[Transaction Workflow](TRANSACTION_WORKFLOW.md#signing-methods) has the code examples.

### HSM (PKCS#11) Integration

ODATANO signs on the server through a PKCS#11 module.

```bash
HSM_ENABLED=true
HSM_PKCS11_MODULE=/usr/lib/pkcs11/yubihsm_pkcs11.so
HSM_SLOT=0
HSM_PIN=                          # from a credential store in production
HSM_KEY_LABEL=cardano-signing-key
HSM_KEY_ID=0x0001
HSM_REQUIRES_ROLE=HsmSigner       # role a caller needs for the HSM actions
```

- `HSM_PKCS11_MODULE`, `HSM_PIN` and `HSM_REQUIRES_ROLE` are required with `HSM_ENABLED=true`. Without one
  of them the service does not initialize: the process runs and its requests answer 503.
- The key is found by `HSM_KEY_LABEL` or `HSM_KEY_ID`. ODATANO logs in with the PIN and signs with
  `CKM_EDDSA` (Ed25519). It never reads the private key. Create the key in the module as not extractable.
- If the module cannot be opened at start, the service starts without HSM signing. The other signing
  methods work, and `getReadiness()` answers 503 with `hsm: false`.
- The Docker image contains no PKCS#11 binding, so HSM signing is not available in it.

Check the HSM:

```bash
curl -u alice: -X POST http://localhost:4004/odata/v4/cardano-sign/GetHsmStatus \
  -H "Content-Type: application/json" -d '{}'
```

### Verification Checks

`VerifySignature` checks a signed transaction in this order:

1. **CBOR.** The transaction can be parsed.
2. **Body hash.** It matches the build, so the transaction was not changed between build and signature.
3. **Witnesses.** At least one VKey witness is present.
4. **Required signers.** The required key hashes are among the witnesses.
5. **Signatures.** Every witness is a valid Ed25519 signature of the body.

### Signing Request TTL

A signing request expires 30 minutes after it was created. An expired request is refused even with valid
signatures, so a transaction built on old UTxO data is not submitted.

---

## Input Validation

Operations check their parameters with `srv/utils/validators.ts` and the limits in `srv/utils/const.ts`.

### Validators

| Validator | Format | Purpose |
|-----------|--------|---------|
| `isTxHash(s)`, `isBlockHash(s)` | 64 hex characters | Transaction and block hashes |
| `isValidBech32Address(s)` | Bech32 `addr` or `addr_test` | Payment addresses of the configured network |
| `isValidBech32StakeAddress(s)` | Bech32 `stake` or `stake_test` | Stake addresses of the configured network |
| `isValidPoolId(s)` | Bech32 `pool`, 28-byte payload | Stake pool IDs |
| `isValidDrepId(s)` | Bech32 `drep`, 29-byte payload | DRep IDs |
| `isAssetUnit(s)` | 56 to 120 hex characters | Native asset units |
| `isValidCbor(s)` | Hex of even length | Transaction CBOR |
| `validateTransactionInputs()` | Several fields | The parameters of a build |
| `validateJsonWithLimits()` | JSON within the limits below | JSON parameters |

### JSON Complexity Limits (DoS Prevention)

| Limit | Value |
|-------|-------|
| JSON size | 1 MB |
| Nesting depth | 10; 64 for PlutusData (datum, redeemer, script parameter) |
| Keys per object | 100 |
| Array length | 1,000 |
| String length | 65,536 |

### Network-Aware Address Validation

An address has to belong to the configured `NETWORK`. A `preview` address (`addr_test1...`) is refused on
`mainnet`, and a mainnet address on `preview`.

---

## Audit Trail

Every step of a transaction is stored in an entity that OData can query.

### Tracked Entities

| Entity | Records | Key Fields |
|--------|---------|------------|
| `TransactionBuilds` | Every build | `senderAddress`, `fee`, `unsignedTxCbor`, `txBodyHash` |
| `SigningRequests` | Every signing request | `status`, `signerType`, `hsmKeyId`, `expiresAt` |
| `SignatureVerifications` | Every signature check | `isValid`, `witnessCount`, `signerKeyHashes`, `errorMessage` |
| `TransactionSubmissions` | Every submission | `txHash`, `status`, `errorCode`, `retryCount` |

The `status` of a signing request is one of `pending`, `signed`, `verified`, `submitting`, `submitted`,
`expired` and `failed`.

### Querying

```http
# Signing requests of an address
POST /odata/v4/cardano-sign/GetSigningRequestsByAddress
{"address": "addr_test1qq..."}

# Verified requests with their checks and their build
GET /odata/v4/cardano-sign/SigningRequests
    ?$filter=status eq 'verified'&$orderby=createdAt desc&$expand=verifications,build

# Failed submissions
GET /odata/v4/cardano-sign/TransactionSubmissions
    ?$filter=status eq 'failed'
```

## References

- [SAP CAP Security Guide](https://cap.cloud.sap/docs/guides/security/)
- [SAP XSUAA Documentation](https://help.sap.com/docs/btp/sap-business-technology-platform/what-is-sap-authorization-and-trust-management-service)
- [Transaction Workflow](TRANSACTION_WORKFLOW.md): signing methods and code examples
- [Developer Guide](DEVELOPER_GUIDE.md): architecture
- [CIP-30 Cardano Wallet API](https://cips.cardano.org/cip/CIP-30/)
