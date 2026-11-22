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
`SignatureVerifications` and `TransactionSubmissions`. Delete a SQLite file before `cds deploy`: the
deployment cannot replace `TransactionInputAssets` in the file, a table there and a view in 2.0.

**Keep the database.** Stop the service and back up the database: step 1 cannot be undone, and 1.x does
not run on the changed database. Then:

1. Apply the changes the additive schema deployment refuses: new keys of the transaction input and
   output tables, `Blocks.time` as a timestamp, two removed columns, one renamed table.
   - Plugin: `node node_modules/@odatano/core/scripts/migrate-schema.mjs` with your `db` configuration
     (`--dry-run` first).
   - Docker image: nothing to do, the start does it. On a large database run it as a step of its own:
     `docker compose run --rm --no-deps odatano deploy-schema`, which also does step 2.
2. Deploy the schema: `cds deploy` in a plugin project. The Docker image deploys on every start, on
   PostgreSQL and on SQLite.
3. Start 2.0.

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

**Submitting.** `SubmitTransaction`, `SubmitSignedTransaction`, `SubmitVerifiedTransaction` and
`SignAndSubmitWithHsm`:

- `failed` means the node refused the transaction and it is not on chain.
- A submit without a verdict from the node (timeout, 5xx, rate limit) answers 503
  `ODATANO_SUBMIT_OUTCOME_UNKNOWN`. The record stays open (`submitting` or `pending`) and the server
  resolves it. Do not build the payment again; read the record.
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
for every input. "Input assets" in the User Guide says what each choice costs and how to move a slot
range from one to the other.

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
- Without credentials only `VerifyDataSignature`, `getLiveness()` and `getReadiness()` answer.
- With `HSM_ENABLED=true`, `HSM_REQUIRES_ROLE` must be set. The start fails without it.

## Configuration

- `TX_BUILDERS` / `txBuilders` is gone; a value that is still set has no effect. Buildooor is the only
  transaction builder. `CardanoClientConfig` has no `transactionBuilders`.
- New, all off by default: `CRAWLER_*`, `WALLET_WORKER_*`, `AGENT_GRANTS_ENABLED`,
  `POOL_METADATA_FETCH`, the `odatano` backend (`ODATANO_URL`, `ODATANO_API_KEY`).

## After the upgrade

- `GET /odata/v4/cardano-indexer/getReadiness()` answers 200 with `status: "ready"`.
- A keyed read such as `GET /odata/v4/cardano/Blocks('<hash>')` returns the block.
- The [CHANGELOG](../../CHANGELOG.md) lists every change of the 2.0 line.
