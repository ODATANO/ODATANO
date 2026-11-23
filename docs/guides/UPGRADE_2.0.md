# Upgrading from 1.x to 2.0

**Version:** v2.0.0-rc.x

What a 1.x deployment and its API clients have to change for 2.0. The new features of 2.0 (chain
crawler, wallet worker, agent grants, another ODATANO as backend) are off until configured and are
described in the [User Guide](USER_GUIDE.md).

## Requirements

- **Node.js 22.5 or later.**
- **SAP CAP 10** (`@sap/cds ^10`, peer dependency). A CAP 9 project cannot load `@odatano/core@2`.
- **Ogmios 7** when `ogmios` is a backend (server image `cardanosolutions/ogmios:v7.0.0` or later).
- Without `backends` in the configuration, 2.0 uses `["koios"]`.

## Database

2.0 adds tables and columns and changes the keys of four tables. A 1.x database does not start 2.0
as it is. Pick one of the two ways.

**Start on a new database.** The chain data in the database is a cache; 2.0 reads it again on demand.
Only the records of your own transactions are lost: `TransactionBuilds`, `SigningRequests`,
`SignatureVerifications`, `TransactionSubmissions`, wallet jobs and agent grants. Delete a SQLite file
before `cds deploy`. In the file `TransactionInputAssets` is a table and in 2.0 it is a view, and the
deployment cannot replace one with the other.

**Keep the database** (PostgreSQL or SQLite). Stop the service and back up the database: the migration
cannot be undone, and 1.x does not run on the changed database. Then:

1. Upgrade the schema with one command.
   - Plugin project, with your `db` configuration:
     ```bash
     node node_modules/@odatano/core/scripts/deploy-schema.mjs --dry-run
     node node_modules/@odatano/core/scripts/deploy-schema.mjs
     ```
     It applies the changes an additive deployment refuses (new keys of the transaction input and output
     tables, `Blocks.time` as a timestamp, removed columns, a renamed table, the changed unique constraint
     of wallet jobs, qualified grant names), then deploys with schema evolution. Every row stays.
   - Docker image: nothing to do, every start runs the same command. On a large database run it as a step
     of its own: `docker compose run --rm --no-deps odatano deploy-schema`. The mode takes `--dry-run`.
2. Start 2.0.

Do not run a plain `cds deploy` on a kept SQLite database: without schema evolution CAP drops and
recreates every table. `--dry-run` against a missing or empty database says so and creates nothing.
Two instances that start on one PostgreSQL database run the command one after the other.

**SAP HANA.** An HDI container takes no DDL from the runtime user, so a 1.x container is not migrated.
`migrate-schema.mjs` and `deploy-schema.mjs` refuse on HANA with these steps:

1. Create a new HDI container, for example under a new service name in `mta.yaml` or `prod.mtaext`.
2. Deploy this version's mtar; the db module deploys into the new container.
3. Bind `odatano-srv` to it.
4. The chain data is read again on demand. Builds, signing requests, signature checks, submissions,
   wallet jobs and agent grants stay in the old container. Export them first if you still need them,
   then remove the old container.

A container that is already on 2.0 upgrades in place with the normal mtar deploy.

A Docker deployment on a SQLite file moves to PostgreSQL with the image's `migrate` mode.
[Docker Deployment](DOCKER_DEPLOYMENT.md) has the commands and the details of both modes.

## API changes for clients

**Path.** `CardanoODataService` answers at `/odata/v4/cardano`. `/odata/v4/cardano-odata` is gone.

**Numbers are strings.** CAP 10 renders `Decimal`, `Int64` and `$count` as JSON strings. A client that
reads `fee`, `lovelace`, `slot` or a count as a JSON number has to parse the string. This holds for entity
reads and for the results of actions and functions, the counters of `getStatus()` included.

**Errors.** `error.code` of an operation's error carries the ODATANO code, for example
`ODATANO_INVALID_INPUT`, not the HTTP status. The message keeps its `[CODE] Operation:` prefix.

**Input checks.** A value outside its range is a 400. 1.x clamped it.

| Parameter | Range |
|---|---|
| `limit` of `GetAssetHistory`, `GetLatestTransactionsByAddress` | 1 to 100, `skip + limit` at most 100 |
| `limit` of `GetUTxOsByAddress`, `GetUTxOsByCredential`, `GetAssetsByAddress`, `GetMetadataByTxHash`, `GetTransactionBuildsByAddress`, `GetSigningRequestsByAddress` | 1 to 5000, default 1000 |
| heights, slots, epochs, output indexes | 0 or more |
| `network` of `SubmitSignedTransaction` and `DeriveScriptAddress` | one of the three network names |

An invalid PlutusData JSON (datum, redeemer, script parameter) is a 400
`ODATANO_TX_VALIDATION_FAILED`, not a 500.

**Transaction inputs and outputs.** The rows carry no `tx_hash`. Reach the transaction through the
`tx` navigation (`tx/hash`, `$expand=tx`), and a transaction's rows through
`Transactions('<hash>')/inputs` and `/outputs`. A keyed read uses
`TransactionInputs(txSeq=…,inputIndex=…)`.

**Accounts.** An account is stored without its addresses and carries `addressCount`. Read the
addresses through `Accounts('<stake>')/Address`. On an account with more than 10 addresses a read or
`$expand=Address` takes at most 10 per page (`$top`), ordered by `address`, without `$filter`. `$count`
gives the account's total.

**Epochs.** `final` is true once the epoch has ended and no rollback can reach it. A row that is not
final is read from the backend again.

**Agent grants.** Allow lists name `Service.operation`, for example
`CardanoTransactionService.SubmitTransaction`. A new name without a service means the transaction or
sign service, never `CardanoBackendService`. The upgrade rewrites stored lists with the meaning they had
in rc.50: a stored `SubmitTransaction` becomes the transaction and the backend service. `allowedActions`
and `GetGrantStatus()` answer qualified names.

**Submitting.** `SubmitTransaction`, `SubmitSignedTransaction`, `SubmitVerifiedTransaction` and
`SignAndSubmitWithHsm`:

- Every transaction needs an expiry (TTL) at most 24 hours ahead that has not passed. A build without
  `validityEndMs` expires one hour ahead. The four submit actions refuse other bytes, and bytes marked
  `isValid` false, with a 400.
- `failed` means the transaction can never land: it was refused for a reason that holds for its bytes in
  any ledger state, or its TTL has passed by the rollback horizon and one of its inputs is still unspent. A
  transaction that landed with failing scripts is `failed` too.
- `unresolved` is new: the transaction can no longer land and nothing shows whether it did. An Admin
  decides it with `ResolveSubmission`, `ResolveSigningRequest` or `ResolveJob`.
- Earlier versions marked some landed transactions `failed`. Run `recheckFailedSubmits` once after the
  upgrade (Admin, `CardanoIndexerService`); it moves those back to `submitted`.
- A submit without a verdict (timeout, 5xx, rate limit, a refusal that depends on the ledger state)
  answers 503 `ODATANO_SUBMIT_OUTCOME_UNKNOWN`. The record stays open (`submitting` or `pending`) and the
  server resolves it. Do not build the payment again; read the record.
- A refused transaction that is already on chain ends as `submitted` on the sign service and as 409
  `ODATANO_TX_ALREADY_SUBMITTED` on the transaction service.

**`VerifyDataSignature`** follows CIP-30 strictly: the signed header must name the address you pass
and the algorithm EdDSA, the key must be an Ed25519 OKP key. It accepts reward addresses and answers
with `signedPayloadHex` in addition.

**Changed values.**

- `Blocks.slotLeader` is the bech32 pool id of the block producer on every backend.
- `Pools.liveSaturation` is a fraction on every backend (0.7542 for 75.42 %).
- `Pools.blocksEpoch`, `liveSize` and `liveDelegators` are `null` when the backend has no such figure.
  A 0 is a real zero.

## Block time

`Blocks.time` is a timestamp (`Edm.DateTimeOffset`). The value keeps its form
(`2026-11-20T10:00:00.000Z`), and a `$filter` that compares it with a quoted text keeps working. New:
`$filter=time gt 2026-01-01T00:00:00Z` and date functions such as `year(time)`.

The column of an existing PostgreSQL or SQLite database is converted by the schema migration; see
"Schema changes at start" in the Docker guide.

## Input assets

`TransactionInputAssets` reads as before, under the same name and keys. In the database it is a view:
an input's assets come from its stored copy (`TransactionInputAssetCopies`) or from the output it spent
(`TransactionInputs.spentTxSeq`). `TransactionInputs/assets` is a plain navigation; it no longer deletes
with its input. A program that reads the database directly keeps reading `TransactionInputAssets`.

Rows stored by an earlier version keep their copies. A newly crawled input whose spent output is stored
gets no copy and points at the output; `inputAssetCopies` (`CRAWLER_INPUT_ASSET_COPIES`) keeps a copy
for every input. [Input assets](CRAWLER_GUIDE.md#input-assets) in the Crawler Guide says what each choice costs and how to
move a slot range from one to the other.

## Authorization

- **Roles are enforced.** Reading needs `Read`, building and submitting `Transact`, the signing service
  `Sign`, operator actions `Admin`. In 1.x every logged-in user could call everything that was not an
  operator action. A user without the role gets 403.
- **Plugin in your own CAP project:** give your users the roles through your authentication. With CAP's
  mocked authentication:
  `"cds": { "requires": { "auth": { "users": { "alice": { "roles": ["Read", "Transact", "Sign"] } } } } }`
- **XSUAA:** the `Admin` scope is no longer part of the `CardanoUser` role template. Assign the
  `CardanoAdmin` template to operators who pause and resume the crawler or the wallet worker; it carries
  all four scopes. Deploy the changed `xs-security.json` with the application.
- **Docker image:** it runs with `NODE_ENV=production` and HTTP basic auth. `ODATANO_HTTP_PASSWORD` is
  required; the user is `ODATANO_HTTP_USER` (default `odatano`) and holds every role. A deployment that
  sets `ODATANO_HTTP_ROLES` itself lists the roles it needs (`Read,Transact,Sign,Admin`).
  `ODATANO_AUTH=dummy` starts only with `ODATANO_ALLOW_UNAUTHENTICATED=yes-anyone-who-reaches-the-port-is-admin`.
- Without credentials only `VerifyDataSignature`, `getLiveness()`, `getReadiness()` and the `$metadata`
  of the sign and indexer services answer.
- With `HSM_ENABLED=true`, `HSM_REQUIRES_ROLE` must be set. Without it the service does not initialize and
  answers 503.

## Configuration

- `TX_BUILDERS` and `txBuilders` are gone; a value that is still set has no effect. Buildooor is the only
  transaction builder. `CardanoClientConfig` has no `transactionBuilders`.
- New, all off by default: `CRAWLER_*`, `WALLET_WORKER_*`, `AGENT_GRANTS_ENABLED`,
  `POOL_METADATA_FETCH`, the `odatano` backend (`ODATANO_URL`, `ODATANO_API_KEY`).

## After the upgrade

- `GET /odata/v4/cardano-indexer/getReadiness()` answers 200 with `status: "ready"`.
- A keyed read such as `GET /odata/v4/cardano/Blocks('<hash>')` returns the block.
- The [CHANGELOG](../../CHANGELOG.md) lists every change of the 2.0 line.
