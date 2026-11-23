# ODATANO Developer Guide

**Version:** v2.0.0-rc.x

How the code is laid out, how the plugin starts, and which patterns a change has to follow. What the
services do for a client is in the [User Guide](USER_GUIDE.md).

## Table of Contents

1. [Architecture](#architecture)
2. [Setup](#setup)
3. [Plugin](#plugin)
4. [Core Components](#core-components)
5. [App Context](#app-context)
6. [Signing Module](#signing-module)
7. [Error Handling](#error-handling)
8. [Testing](#testing)
9. [Deployment](#deployment)
10. [Troubleshooting](#troubleshooting)
11. [Rules for Changes](#rules-for-changes)

---

## Architecture

### Services

Seven services. Each has a model file `srv/<name>.cds` and an implementation `srv/<name>.ts`.

| Service | File | Path | Purpose |
|---|---|---|---|
| CardanoODataService | `cardano-service` | `/odata/v4/cardano` | Read chain data: 33 entities, 22 actions |
| CardanoTransactionService | `cardano-tx-service` | `/odata/v4/cardano-transaction` | Build and submit: 9 entities, 14 actions |
| CardanoSignService | `cardano-sign-service` | `/odata/v4/cardano-sign` | Signing requests, verification, HSM: 5 entities, 9 actions |
| CardanoIndexerService | `cardano-indexer-service` | `/odata/v4/cardano-indexer` | Crawler status and control, health probes |
| CardanoWorkerService | `cardano-worker-service` | `/odata/v4/cardano-worker` | Wallet jobs |
| CardanoAgentService | `cardano-agent-service` | `/odata/v4/cardano-agent` | Agent grants |
| CardanoBackendService | `cardano-backend-service` | `/odata/v4/cardano-backend` | Chain data in provider shape for another ODATANO |

**Operations**

| Service | Operations |
|---|---|
| CardanoODataService | GetNetworkInformation, GetBlockByHash, GetEpochByNumber, GetPoolById, GetDrepById, GetAccountByStakeAddress, GetTransactionByHash, GetTransactionConfirmations, GetMetadataByTxHash, GetMetadataByLabel, GetAddressByBech32, GetUTxOsByAddress, GetUTxOsByCredential, GetAssetsByAddress, GetAssetInfo, GetAssetHistory, GetLatestTransactionsByAddress, GetLatestBlock, GetLatestEpoch, GetLedgerProtocolParameters, ParseTransactionCbor, DecodePlutusData |
| CardanoTransactionService | BuildSimpleAdaTransaction, BuildTransactionWithMetadata, BuildMultiAssetTransaction, BuildMintTransaction, BuildPlutusSpendTransaction, BuildPlutusTransaction, SubmitTransaction, SubmitSignedTransaction, SetCollateral, DeriveScriptAddress, ExtractPaymentKeyHash, GetBuildDetails, CheckSubmissionStatus, GetTransactionBuildsByAddress |
| CardanoSignService | CreateSigningRequest, GetSigningRequest, GetSigningRequestsByAddress, VerifySignature, VerifyDataSignature, SubmitVerifiedTransaction, SignWithHsm, SignAndSubmitWithHsm, GetHsmStatus |
| CardanoIndexerService | Functions: getStatus, getLiveness, getReadiness. Actions, all Admin: pauseCrawler, resumeCrawler, importUtxoSet, backfillCertificates, backfillTransactions, backfillPaymentCredentials, backfillOutputDatums, backfillMetadataPositions, backfillEpochs, backfillAssetDecimals, backfillAssetRegistry, pruneInputAssetCopies, restoreInputAssetCopies |
| CardanoWorkerService | Actions: SubmitWalletJob, CancelJob, and for Admin PauseWorker and ResumeWorker. Functions: GetJobStatus, GetWorkerStatus |
| CardanoAgentService | Actions, all Admin: CreateAgentGrant, UpdateAgentGrant, RotateAgentGrantToken, RevokeAgentGrant. Functions: GetGrantStatus, GetGrantUsage |
| CardanoBackendService | One action per backend method; see `cardano-backend-service.cds` |

An OData function is called with HTTP GET and its parameters in the URL, for example
`GET .../GetJobStatus(jobId=<uuid>)`. A POST to a function answers 405.

**Events.** `CardanoIndexerService` publishes `blockIndexed` and `reorg`. `CardanoWorkerService` publishes
`jobConfirmed`, `jobFailed` and `jobUnresolved`, once per outcome. An event is emitted after its commit and never throws into
the caller. Events do not appear in `$metadata`.

### Entities

`db/schema.cds` defines 52 entities in the namespace `odatano.cardano`.

| Group | Entities |
|---|---|
| Chain data | NetworkInformation, Blocks, Epochs, Pools, Dreps, Assets, AssetHistory, Accounts, Addresses, AddressAssets, AddressUTxOs, UTxOAssets, AddressTransactions, LedgerProtocolParameters |
| Transactions | Transactions, TransactionInputs, TransactionOutputs, TransactionInputAssets, TransactionInputAssetCopies, TransactionOutputAssets, TransactionMetadata, TransactionCertificates, TransactionWithdrawals, TransactionRedeemers, TransactionDatums |
| UTxO set from the crawler | LedgerUTxOs, LedgerUTxOAssets, LedgerAddresses, LedgerAddressAssets, LedgerAccounts |
| Epoch snapshots | PoolEpochSnapshots, DrepEpochSnapshots, EpochLedgerSnapshots, AccountEpochSnapshots |
| Builds and submissions | TransactionBuilds, TransactionBuildInputs, TransactionBuildOutputs, TransactionBuildInputAssets, TransactionBuildOutputAssets, TransactionBuildRedeemers, TransactionSubmissions, TransactionSubmissionErrors, AddressTransactionBuilds |
| Signing | SigningRequests, SignatureVerifications, AddressSigningRequests |
| Crawler | CardanoSyncState, CardanoReorgLog |
| Wallet worker | CardanoWorkerWallets, CardanoWalletJobs |
| Agent grants | CardanoAgentGrants, CardanoAgentGrantUsage |

Three things to know before touching the model:

- **Temporal entities** carry `validFrom` and `validTo` and expire after `INDEX_TTL_MS`:
  NetworkInformation, Pools, Dreps, Assets, Accounts, Addresses, AddressAssets, AddressUTxOs, UTxOAssets and
  TransactionBuilds. The other entities have neither field.
- **Input and output rows are keyed by `txSeq`**, the chain position of their transaction
  (`slot * 65536 + txIndex`), not by its hash.
- **`TransactionInputAssets` is a view.** An input has stored copies in `TransactionInputAssetCopies`, or a
  reference `spentTxSeq` to the output it spent. Writes go to the copy table.

### Layers

```
HTTP client
    ↓
Service implementations (srv/*-service.ts)
    ↓
App context (srv/server.ts: getCardanoIndexer(), getCardanoClient(), getCardanoTxBuilder())
    ↓
CardanoIndexer, CardanoTransactionBuilder, crawler, wallet worker
    ↓
CardanoClient (routing and failover across the backends)
    ↓
Backends: Ogmios (node), Koios, Blockfrost, another ODATANO
```

The transaction builder is Buildooor. The database is the cache of the lazy path and the store of the
crawler.

### A read request

```
1. The handler validates the input.
2. It looks for the row in the database.
3. On a miss it reads from the backends.
4. It maps the answer and stores it.
5. It runs the client's query and answers.
```

[Indexing](../concepts%20&%20architecture/INDEXING.md) describes the two write paths, on demand and by
crawler.

---

## Setup

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm ci

cp .env.example .env     # NETWORK=preview, BACKENDS=koios; KOIOS_API_KEY is optional
npm run db:deploy        # deploys the schema to db.sqlite

npm run cds:watch        # development: runs the TypeScript sources, reloads on change

npm run build            # production: compile first
npm start                # runs cds-serve on the compiled files; it does not compile
```

The compiled `.js` files sit next to their sources and are gitignored. `npm ci` and `npm run build` compile
in place, and CAP then loads the `.js` files. Run `npm run clean` before `npm run cds:watch` to run the
TypeScript sources.

The repository's own CAP configuration lives in `.cdsrc.json`: the database, the `[production]` profile
(HANA and XSUAA), the build tasks, the cds-typer settings and the development users. It ships neither in
the npm package nor in the image. The `cds` section of `package.json` holds only `log.mask_headers`, the
one setting a project that uses the plugin should get from it.

| Script | Does |
|---|---|
| `npm run cds:types` | Generates the model types into `@cds-models/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | All tests; see [Testing](#testing) |
| `npm run release:check` | Every local release gate; see [Release gates](#release-gates) |

### Key files

```
src/
  plugin.ts                     # CAP plugin registration, served and shutdown hooks
  index.ts                      # Public API of the package
srv/
  server.ts                     # App context, start and shutdown
  config.ts                     # Every setting: CDS section, environment, default
  cardano-service.{cds,ts}      # Read service
  cardano-tx-service.{cds,ts}   # Build and submit
  cardano-sign-service.{cds,ts} # Signing requests, verification, HSM
  cardano-indexer-service.{cds,ts}  # Crawler status and control
  cardano-worker-service.{cds,ts}   # Wallet jobs
  cardano-agent-service.{cds,ts}    # Agent grants
  cardano-backend-service.{cds,ts}  # Provider-shaped answers for another ODATANO
  cbor/                         # Transaction and PlutusData decoding
  blockchain/
    cardano-client.ts           # Routing and failover across the backends
    cardano-indexer.ts          # Indexing on demand, bulk block write for the crawler
    cardano-tx-builder.ts       # Coordinates the transaction builder
    circuit-breaker.ts          # Skips a backend that keeps failing
    stored-chain.ts             # Stored blocks and transactions in provider shape
    ledger-state.ts             # Crawler-fed UTxO set
    backends/
      cardano-backend.ts        # Backend interfaces and capability guards
      ogmios-backend.ts         # Node over WebSocket: tip state, submit, evaluate, chain-sync
      koios-backend.ts
      blockfrost-backend.ts
      odatano-backend.ts        # Another ODATANO as backend
    transaction-building/
      cardano-tx.ts             # Builder interface (CardanoTxBuilder)
      buildooor-tx.ts           # The Buildooor builder
    signing/
      external-signer.ts        # Signing requests and their workflow
      signature-verifier.ts     # Witness verification
      hsm-signer.ts             # PKCS#11 signing; the key stays in the module
      cose-verifier.ts          # CIP-8 data signatures (wallet login)
      landing-proof.ts          # When a sent transaction is on chain, can never land, or still open
      submission-finalizer.ts   # Submit, its record and the reconciler
    crawler/
      crawler.ts                # Engine: chain-sync and pagination, reorg handling
      sync-state.ts             # Cursor row and database lease
      hooks.ts                  # In-process listeners for blockIndexed and reorg
      account-snapshots.ts      # Reward accounts per epoch
      input-asset-copies.ts     # Prune and restore of input asset copies
      utxo-set-import.ts        # Import of a UTxO set snapshot
      window-plan.ts            # Slot-window walks: one transaction per window, key lookups on PostgreSQL
      key-pages.ts              # Key-ordered page walks
      *-backfill.ts             # One file per backfill action
    wallet-worker/
      wallet-worker.ts          # Dispatch loop: build, sign, submit
      job-store.ts              # Job state machine, idempotency, leases
      signers.ts                # HSM and software signer
      confirmation-tracker.ts   # Confirmation depth, resubmit after a rollback
  utils/
    validators.ts               # Input validation
    build-request.ts            # Build* request parsing, shared by the service and the worker
    navigation.ts               # Navigation path and key of a read
    detached-run.ts             # Runner of the maintenance actions, with cancel
    lease.ts                    # Database leases (crawler, UTxO import, wallet)
    db-kind.ts                  # Database kind and bulk SQL helpers
    errors.ts                   # Error classes and normalizeBackendError
    error-codes.ts              # ODATANO_* codes
    backend-request-handler.ts  # handleRequest, handleBackendRequest
    mappers.ts                  # Provider data to entity rows
    tx-utils.ts                 # readOutside, detachedTx
    result-numbers.ts           # Int64 and Decimal as text in results
    agent-grants.ts, agent-access.ts, agent-token-auth.ts   # Agent grants
    db-indexes.ts               # Secondary indexes created at start
    signing-helper.ts           # CIP-30 witness set handling
db/schema.cds                   # 52 entities
scripts/migrate-schema.mjs      # Schema changes the additive deployment refuses
scripts/deploy-schema.mjs       # Migration, then deploy with schema evolution; the upgrade command
test/                           # vitest, see test/README.md
```

---

## Plugin

ODATANO is published as [`@odatano/core`](https://www.npmjs.com/package/@odatano/core), a CAP plugin.
CAP loads every package that has a `cds-plugin.js` at its root.

### Start sequence

```
1. CAP finds cds-plugin.js in node_modules/@odatano/core/ and requires src/plugin.
2. src/plugin.ts registers the kind 'odatano-core' with the schema and the seven service models.
3. On 'loaded' it rewrites the relative @impl paths to package paths, so Node resolves them
   from the consumer project.
4. On 'served' it calls initialize() from src/index.ts, which builds the app context and
   starts the crawler and the wallet worker when configured.
5. On 'shutdown' it calls shutdown().
```

A failed start is logged and never thrown: the plugin must not stop the host application.

`PLUGIN_MODEL` and `IMPL_PATHS` in `src/plugin.ts` name every service file. A service missing there
answers 404 in a consumer project. `test/unit/plugin.test.ts` checks both lists against `srv/*-service.cds`.

### Package contents

```
@odatano/core
├── cds-plugin.js        # CAP entry point: require('./src/plugin')
├── src/                 # plugin.js, index.js
├── srv/                 # *.cds models, compiled *.js, blockchain/, utils/, cbor/
├── db/                  # schema.cds and its types
├── @cds-models/         # generated model types
└── scripts/             # migrate-schema.mjs, migrate-slot-leader.mjs
```

`tsconfig.build.json` sets `outDir: "."`. The compiled `.js` files then sit next to the `.cds` files, where
CAP resolves a service's `@impl`.

```bash
npm run build:plugin     # generate types, compile in place
npm pack --dry-run       # check the contents
```

`prepublishOnly` (`scripts/publish-guard.mjs`) refuses to publish a tree that is not committed and tagged,
and a commit whose "Release" workflow run is not green. It needs `gh`, logged in.

### Release gates

`npm run release:check` runs them in this order and stops at the first failure. Each gate cleans up its
temp folder and image, also when it fails.

| Gate | Checks |
|---|---|
| 1 | The version is the same in `package.json`, both places of `package-lock.json` and `mta.yaml` |
| 1b | The CHANGELOG has a `## [vX]` heading for the version, and no tag `vX` points at another commit |
| 2 | No stale `**Version:**` header in the docs |
| 3 | typecheck, lint, `npm audit`, the audits of `app/router` and `app/wallet`, `npm pack --dry-run`, and `scripts/smoke-consumer.mjs` (the tarball in an empty CAP project, also under `NODE_ENV=production`) |
| 3b | `scripts/check-login-package.mjs`: the range, the lockfile and the installed copy of `@odatano/cap-auth` read `trustProxy` |
| 4 | `scripts/build/verify-btp-module.mjs`: the BTP module built as `mta.yaml` does, installed, every service implementation loaded as JavaScript, and audited |
| 5 | Where docker runs: the image is built and passes `scripts/smoke-image.mjs` (logins, the one SQLite writer, a restart, development users refused) |

`.github/workflows/release.yml` runs the same gates on a tag and pushes the image it tested.

### Configuration (`srv/config.ts`)

Every setting is read in `srv/config.ts` and nowhere else. For each one:

```
cds.requires["odatano-core"].<key>   wins over   the environment variable   wins over   the default
```

In a consumer project:

```json
{
  "cds": {
    "requires": {
      "odatano-core": {
        "network": "preview",
        "backends": ["koios"],
        "koiosApiKey": "optional_koios_token",
        "primaryTimeoutMs": 30000,
        "fallbackTimeoutMs": 60000,
        "indexTtlMs": 3600000
      }
    }
  }
}
```

Standalone, with the environment:

```env
NETWORK=preview
BACKENDS=koios
KOIOS_API_KEY=optional_koios_token
```

The values above are the defaults, except the token. The loaders are not cached. CAP copies a local `.env`
into `process.env` on the first read of `cds.env`, so a test that clears variables reads `cds.env` first.

### One start, two entry points

Both `src/plugin.ts` and `srv/server.ts` listen to `served`. The plugin hook runs first and builds the app
context. The hook in `server.ts` then returns:

```typescript
cds.on('served', async () => {
  if (appContext) return;            // the plugin built it
  if (autoInitSkipped()) return;     // SKIP_AUTO_INIT=true, used by tests
  // standalone start
});
```

### Public API (`src/index.ts`)

```typescript
import { initialize, shutdown, getStatus } from '@odatano/core';
import { getCardanoClient, getCardanoIndexer, getCardanoTxBuilder } from '@odatano/core';
import type { CardanoClientConfig, Network, BackendName } from '@odatano/core';
```

| Export | Description |
|--------|-------------|
| `initialize()` | Loads the configuration, builds the app context, starts crawler and worker when configured |
| `shutdown()` | Stops worker and crawler, closes the backend connections |
| `getStatus()` | `{ initialized, network, backends }` |
| `getCardanoClient()`, `getCardanoIndexer()`, `getCardanoTxBuilder()` | The instances of the app context |
| `CardanoClient`, `CardanoIndexer`, `CardanoTransactionBuilder` | The classes |
| `loadConfigFromEnv()` and the loaders for HSM, crawler, wallet worker and agent grants | Configuration as the package reads it |
| `parseTransaction(cborHex)` | Decodes transaction CBOR. Inline datums keep their bytes |
| `verifyTxWitnesses(signedTxCbor)` | Checks every vkey signature against the body hash. Returns the signer key hashes |
| `posixToSlot(network, posixMs)`, `slotToPosixMs(network, slot)` | Slot conversion, exact from the Shelley start on. `posixToSlot` throws a `RangeError` for an earlier time |
| `getTransactionConfirmations(txHash)` | Blocks on top of a transaction, 0 while it is not on chain. Needs `initialize()` |
| `applyScriptParameters(scriptHex, params)` | Applies parameters to a parameterized Plutus script |
| `plutusScriptHash(scriptHex, version)` | Script hash for `plutusV2` or `plutusV3` |
| `getHsmSigner()` | The HSM signer, when one is configured |
| `issueAgentGrant()`, `updateAgentGrant()`, `rotateAgentGrantToken()`, `revokeAgentGrantById()`, `getGrantUsage()` | Grant administration from code |
| `agentAccessOf(service, event)` | What an agent token may do with an operation: `read`, `grant`, `operator`, or `closed` for a service closed to tokens |
| `agentGrantableActions()` | Names of the operations a grant may list |
| `registerTransportLane()` | Adds a way to authenticate a request before CAP's own strategy |

---

## Core Components

### 1. Service handlers

Every service implementation starts with `answerNumbersAsText(srv)`; see [Rules for Changes](#rules-for-changes).

A read that fills the cache on a miss is built from two halves. `fetch` reads the database and calls the
backend. `store` writes.

```typescript
const transactionIndex = indexPair(
  (db, hash: string) => indexer().fetchTransaction(db, hash),
  (db, fetched) => indexer().storeTransaction(db, fetched),
);

srv.on('READ', Transactions, indexOnMissRead(Transactions, 'hash', isTxHash, transactionIndex, { errorMessage: 'Invalid transaction hash format' }));
srv.on('GetTransactionByHash', indexOnMissAction('GetTransactionByHash', Transactions, 'hash', isTxHash, transactionIndex, { errorMessage: 'Invalid transaction hash format' }));
```

Both helpers call `indexMissing` in `srv/cardano-service.ts`:

1. It looks for the row outside the request transaction.
2. On a miss it calls `fetch`. The request transaction holds no database connection while the backend answers.
3. It looks again, now on the request transaction.
4. It calls `store` unless the row has appeared in the meantime.

`indexOnMissRead` then runs the client's own query, so `$expand`, `$select` and `$filter` apply.

A handler written by hand validates first and wraps the work in `handleRequest`:

```typescript
srv.on(GetTransactionConfirmations, async (req) => {
  const { txHash } = req.data;
  if (!txHash) rejectMissing(req, 'GetTransactionConfirmations', 'txHash');
  if (!isTxHash(txHash)) rejectInvalid(req, 'GetTransactionConfirmations', 'Invalid transaction hash format', 'txHash');
  return handleRequest(req, (db) => indexer().resolveTransactionConfirmations(db, txHash));
});
```

`rejectMissing` and `rejectInvalid` throw a 400. `handleRequest` gives the callback the request transaction
and maps every error to an OData error.

### 2. Validators (`srv/utils/validators.ts`)

```typescript
isTxHash(s)                     // 64 lowercase hex characters
isBlockHash(s)                  // 64 lowercase hex characters
isAssetUnit(s)                  // policy id plus asset name
isValidCredential(s)            // 56 hex characters
isValidPoolId(s)                // bech32 pool id
isValidDrepId(s)                // bech32 DRep id
isValidBech32Address(s)         // address of the active network
isValidBech32StakeAddress(s)    // stake address of the active network
isEpochNumber(s)
isValidCbor(s)                  // hex of even length
validateTransactionInputs(data, fields)   // several fields at once
validateJsonWithLimits(json, field)       // size, depth and key limits
```

Validate before `handleRequest`, so an invalid request costs no backend call.

### 3. Errors (`srv/utils/errors.ts`)

```
BackendError                            base class, 500
├── NotFoundError                       404
├── TransactionValidationError          400
├── ScriptValidationError               400
├── InsufficientFundsError              400
├── MixedAssetsError                    400
├── TransactionAlreadySubmittedError    409
├── ChainPointMismatchError             409
├── RateLimitError                      429
├── ProviderUnavailableError            503
│   └── ChainSyncClosedError
├── SubmitOutcomeUnknownError           503
├── ChainSyncStalledError               503
├── ChainSyncFrameError                 503
├── HsmError                            503
├── BackendInitError                    500
└── AllBackendsFailedError              status of the last backend error, 503 when none was called
ConfigError                             not a BackendError
AllBackendsInitFailedError              not a BackendError
```

[Error Handling](../concepts%20&%20architecture/ERROR_HANDLING.md) has the codes and the rules that turn a
provider error into one of these classes.

### 4. Indexer (`srv/blockchain/cardano-indexer.ts`)

- An index method is split: `fetchX` reads and calls the backend, `storeX` writes, `indexX` does both.
- A composite fetches everything first. `fetchAddress` includes the address's transactions, `fetchAccount`
  its addresses, `fetchBlock` its epoch.
- Related rows are written in the caller's transaction, so all persist or none.
- `indexBlockFull` writes a whole block for the crawler, one UPSERT per table.

### 5. Client (`srv/blockchain/cardano-client.ts`)

`CardanoClient` holds one node backend (Ogmios) and the provider backends in the fixed order Blockfrost,
Koios, another ODATANO.
`METHOD_ROUTING` says per method which side is asked first:

- Node first: tip and state queries such as `getLatestBlock`, `getAddressUtxos`, `getPool`, `getAccount`,
  `getProtocolParameters`, `submitTransaction`.
- Providers first: history such as `getTransaction`, `getBlock`, `getEpoch`, `getAssetInfo`,
  `getAddressTransactions`, `getNetworkInformation`.

For one call the client goes through the backends in that order:

- A backend that does not support the method is skipped.
- A backend whose circuit is open is skipped. A circuit opens after repeated failures. A 4xx other than
  429 is a verdict, not a failure, and closes a half-open circuit. 401, 402 and 403 arrive as 503 and fail
  over.
- Each call has a timeout: `fallbackTimeoutMs` for Koios and a remote ODATANO, `primaryTimeoutMs` for the others.
- An error is normalized and the next backend is asked. For `submitTransaction` a verdict is final: every
  backend submits to the same ledger.
- When all failed, the client throws `AllBackendsFailedError` with every error.

Backend modules load on first use (`backendModules`). A static import of a backend class outside its own
module would load its SDK for every consumer.

---

## App Context

`srv/server.ts` holds one context for the process:

```typescript
interface AppContext {
  cardanoClient: CardanoClient;
  cardanoIndexer: CardanoIndexer;
  cardanoTxBuilder: CardanoTransactionBuilder;
}
```

```typescript
getAppContext(): AppContext          // throws a 503 while no context exists
getCardanoIndexer(): CardanoIndexer
getCardanoClient(): CardanoClient
getCardanoTxBuilder(): CardanoTransactionBuilder

initializeFromConfig(config, protocolParams?, hsmConfig?): Promise<void>   // no effect when a context exists
shutdownAppContext(): Promise<void>

// tests
createTestContext(backends, protocolParams?): Promise<AppContext>
resetAppContext(context: AppContext | null): void   // throws in production
```

A handler resolves the instance per request:

```typescript
import { getCardanoIndexer } from './server';

const indexer = () => getCardanoIndexer();
```

A test sets `SKIP_AUTO_INIT=true` before the server starts and builds its own context:

```typescript
beforeAll(async () => {
  resetAppContext(await createTestContext(['koios']));
});

afterAll(async () => {
  await shutdownAppContext();
});
```

---

## Signing Module

`srv/blockchain/signing/`. For external signing the server never holds the key: it exports the unsigned
transaction and verifies what comes back. `hsm-signer.ts` signs on the server, and the key stays in the HSM.

### ExternalSignerModule

```typescript
createSigningRequest(buildId, unsignedTxCbor, txBodyHash, network, message, options?): UnsignedTxExportPayload
verifySignedTransaction(signedTxCbor, expectedTxBodyHash, options?): SignatureVerificationResult
verifyOrThrow(signedTxCbor, expectedTxBodyHash, options?): SignatureVerificationResult

createWorkflowState(request): SigningWorkflowState
markAsSigned(state, signedTxCbor): SigningWorkflowState
markAsVerified(state, result): SigningWorkflowState
markAsSubmitted(state, txHash): SigningWorkflowState
markAsFailed(state, errorMessage): SigningWorkflowState
isExpired(expiresAt): boolean
```

### SignatureVerifier

```typescript
verify(signedTxCbor, options?): SignatureVerificationResult          // never throws
verifyOrThrow(signedTxCbor, options?): SignatureVerificationResult
extractTxBodyHash(txCbor): string
isSigned(txCbor): boolean
getWitnessCount(txCbor): number
```

### Status of a signing request

| Status | Meaning |
|---|---|
| `pending` | Created, waiting for the signature |
| `signed` | A signed transaction was handed in |
| `verified` | The signature is valid |
| `submitting` | The submit is running, or it ended without a verdict and the server is resolving it |
| `submitted` | The transaction was accepted |
| `expired` | Not signed within 30 minutes |
| `failed` | Verification failed, or the node refused the transaction |

### Wallet witness sets (`srv/utils/signing-helper.ts`)

```typescript
combineTransactionWithWitnesses(unsignedTxCbor, witnessSetCbor): string   // CIP-30 witness set into the transaction
isWitnessSetCbor(cborHex): boolean                                        // witness set or full transaction
toSignedTransaction(unsignedTxCbor, signedTxOrWitnessSet): string         // accepts either
```

---

## Error Handling

| HTTP | When | Example |
|------|------|---------|
| 400 | Invalid or missing input, failed validation | Malformed hash, insufficient funds |
| 401 | No login | |
| 403 | Login without the role | A user without `Read` on the read service |
| 404 | Not on chain | Unknown transaction hash |
| 409 | Conflict | Transaction already submitted |
| 429 | Rate limit of a provider | |
| 500 | Internal error | |
| 503 | No backend answered, or a submit got no verdict | Provider timeout |

A handler rejects invalid input itself, before any backend call. `handleRequest` maps every other error.
The body of an error carries the `ODATANO_*` code in `error.code`.
[Error Handling](../concepts%20&%20architecture/ERROR_HANDLING.md) lists the codes.

---

## Testing

[test/README.md](../../test/README.md) describes the suites, the commands and what each needs.

- `npm run test:unit` needs no network.
- `npm test` runs everything. The pretest creates `db.sqlite` new.
- The test setup makes a request without credentials privileged, so a test needs no login.

An integration test starts the server with `cds.test` and replaces the app context:

```typescript
import cds from '@sap/cds';
// require, not import: the test must share the module instances of the server cds.test() starts
const { createTestContext, resetAppContext, shutdownAppContext } =
  require('../../srv/server') as typeof import('../../srv/server');

process.env.SKIP_AUTO_INIT = 'true';

describe('GetTransactionByHash', () => {
  const test = cds.test(__dirname + '/../../');

  beforeAll(async () => {
    resetAppContext(await createTestContext(['koios']));
  });

  afterAll(async () => {
    await shutdownAppContext();
  });

  it('refuses a malformed hash', async () => {
    await expect(
      test.post('/odata/v4/cardano/GetTransactionByHash', { hash: 'invalid' })
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
```

vitest has no `fail()`. Assert on the rejection, as above.

---

## Deployment

Development:

```env
DEBUG=CardanoService,CardanoIndexer
NETWORK=preview
BACKENDS=koios
# KOIOS_API_KEY=          # optional token, raises the Koios rate limit
INDEX_TTL_MS=60000
```

Production:

```env
NETWORK=mainnet
BACKENDS=ogmios,koios
OGMIOS_URL=ws://ogmios:1337
KOIOS_API_KEY=your_koios_token
PORT=4004
```

```bash
npm run build
NODE_ENV=production npm start
```

**Request log.** In production CAP writes one JSON line per request, with the request headers as fields.
Headers whose name contains `authorization`, `cookie`, `cert`, `ssl`, `token`, `key`, `secret` or
`project_id` are written as `***` (`cds.log.mask_headers` in the `package.json` of `@odatano/core`). A
consumer that sets its own `cds.log.mask_headers` replaces that list, so it has to carry these patterns
itself.

The [Docker guide](DOCKER_DEPLOYMENT.md) covers the image and the compose stack, the
[Production guide](PRODUCTION_DEPLOYMENT.md) covers SAP BTP.

---

## Troubleshooting

**Port 4004 in use**

```bash
# Windows
netstat -ano | findstr :4004
taskkill /PID <PID> /F

# Linux, macOS
lsof -i :4004
kill -9 <PID>
```

**Tests fail at the start.** The tests start their own server and create `db.sqlite` new. Stop a running
`cds watch` first: it holds the file.

**Slow answers**

- Check the timeouts: `primaryTimeoutMs` and `fallbackTimeoutMs` in `cds.requires.odatano-core`, or
  `PRIMARY_TIMEOUT_MS` and `FALLBACK_TIMEOUT_MS`.
- Check the status of the configured providers, for example https://koios.rest or
  https://status.blockfrost.io.

**Blockfrost tests are skipped or fail.** They need `BLOCKFROST_API_KEY`. The Koios tests need no key.

---

## Rules for Changes

1. **Validate input before `handleRequest`.**
2. **Wrap handler work in `handleRequest`.** It maps errors and provides the request transaction.
3. **Throw the error classes of `srv/utils/errors.ts`**, not a plain `Error`.
4. **Read the database first.** Stored chain data needs no backend call.
5. **Declare agent access** on every new action and function in the service model:
   `@odatano.agent: 'read'` (every token), `'grant'` (only when the grant lists it, one budget unit per
   call) or `'operator'` (no token). An operation without it is refused for agent tokens.
6. **Ask the backend before the first write.** SQLite has one connection, and a transaction takes it
   with its first statement. A database read that comes before a backend call goes through
   `readOutside(tx, read)` (`srv/utils/tx-utils.ts`), and an index method has a `fetch` half that
   reads and a `store` half that writes. A handler stores only after every backend call returned.
7. **Start a new service implementation with `answerNumbersAsText(srv)`** (`srv/utils/result-numbers.ts`).
   CAP reads `Int64` and `Decimal` from the database as text; this renders the rows a handler builds
   the same way.
8. **Name a new service file in `src/plugin.ts`**, in `PLUGIN_MODEL` and `IMPL_PATHS`.
9. **Read settings in `srv/config.ts` only.**
10. **A schema change that is not additive needs a step in `scripts/migrate-schema.mjs`.** Without it the
    deployment refuses on an existing database.
11. **Test the error cases too.**

---

**More**

- [User Guide](USER_GUIDE.md): the API
- [Crawler Guide](CRAWLER_GUIDE.md): running the chain crawler
- [Transaction Workflow](TRANSACTION_WORKFLOW.md): build, sign and submit
- [Test Documentation](../../test/README.md)
- [Error Handling](../concepts%20&%20architecture/ERROR_HANDLING.md)
- [Indexing](../concepts%20&%20architecture/INDEXING.md)
- [Backend Configuration](BACKEND_CONFIGURATION.md)
- [Production Deployment](PRODUCTION_DEPLOYMENT.md)
