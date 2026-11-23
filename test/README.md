# ODATANO Test Suite

136 test files run on vitest: 116 unit files with 2682 tests, and 20 integration files.

- **Unit tests** need no network. Some run on an in-memory or temporary SQLite database.
- **Integration tests** start the CAP server on SQLite. Some mock the backend over HTTP, some call the
  live Preview backends.

## Running Tests

```bash
npm test                              # everything
npm run test:unit                     # unit tests only
npm run test:integration              # integration tests only
npm run test:coverage                 # everything, with a coverage report

npm run test:integration:blockfrost   # needs BLOCKFROST_API_KEY
npm run test:integration:koios
npm run test:integration:ogmios       # needs Ogmios at OGMIOS_URL

npm test -- test/unit/validators.test.ts   # one file
```

Before the tests, `npm test` removes compiled files, generates the model types and creates `db.sqlite`
new. Stop a running `cds watch` first: it holds the file.

## What the Tests Need

- Node.js 22.5 or later.
- `BLOCKFROST_API_KEY` for the Blockfrost suite. Without it the file defines no tests.
- Nothing for Koios. The suite calls `https://preview.koios.rest/api/v1`; `KOIOS_API_URL` overrides it.
- A synced Ogmios at `OGMIOS_URL` (default `ws://localhost:1337`) for `core-ogmios`, `crawler` and
  `reward-accounts`. The last two skip their tests when Ogmios or the Blockfrost key is missing.

## Setup

| File | Does |
|---|---|
| `vitest.config.ts` | Two projects, `unit` and `integration`. One process per test file. Integration files run one after another, because parallel starts hit the rate limits of the providers. Coverage gate: 75 % of branches, functions and lines |
| `test/vitest.globalSetup.ts` | Deletes compiled `.js` files next to the sources. CAP would load them in place of the TypeScript sources |
| `test/vitest.setup.ts` | Sets `NODE_ENV=test`, clears `SKIP_AUTO_INIT`, makes a request without credentials privileged, silences the console unless `LOG_LEVEL=debug` |

An integration test loads `srv/server` with `require`, not `import`. It then shares the module instances
of the server that `cds.test()` starts. A test that brings its own backends sets `SKIP_AUTO_INIT=true` and
calls `resetAppContext(await createTestContext([...]))`.

## Integration Tests (`test/integration/`)

| File | Covers | Backend |
|---|---|---|
| `core.koios.test.ts` | The shared read suite and backend error suite on Koios alone | Koios, live |
| `core.blockfrost.test.ts` | The same two suites on Blockfrost alone | Blockfrost, live |
| `core-ogmios.test.ts` | The read service on Ogmios alone | Ogmios, live |
| `error-handling-service.test.ts` | 400 answers of the services for invalid and missing input | Koios, live |
| `odata_features.test.ts` | `$filter`, `$select`, `$top`, `$skip`, `$count`, `$orderby`, `$expand` | Koios, live |
| `reward-accounts.test.ts` | Reward account registration per backend, and a build with a withdrawal | Preview backends, live |
| `crawler.test.ts` | Chain-sync ingest, recovery from a fork, the tables the crawler fills besides blocks | Ogmios and Blockfrost, live |
| `tx.buildooor.test.ts` | The shared transaction suite and transaction error suite | Koios, mocked |
| `tx-handler-validation.test.ts` | Input checks and error paths of the transaction actions | Koios, mocked |
| `tx-submission-mock.test.ts` | Submit with and without a build record | Koios, mocked |
| `signing-services.test.ts` | The signing workflow, HSM actions with a mock signer | Koios, mocked |
| `defer-submit.test.ts` | `deferSubmit`: the submit runs after the caller's commit | Koios, mocked |
| `nested-tx-guard.test.ts` | A submit called from a transaction that holds the connection fails with 503 | Koios, mocked |
| `provider-read-outside-tx.test.ts` | A read that misses holds no database connection while the backend answers | Koios, mocked |
| `keyed-read-expand.test.ts` | A keyed read honours `$expand` and `$select` | Koios, mocked |
| `address-first-read.test.ts` | The first read of an address returns what the same request indexed | Koios, mocked |
| `blockfrost-custom-backend.test.ts` | A custom Blockfrost URL is the one that is called | Blockfrost, mocked |
| `wallet-worker.test.ts` | Job uniqueness in the database, real transactions, row-level access | Not used |
| `agent-grants.test.ts` | Tokens, administration, allow list, budget, closed worker service | Not used |
| `transport-auth-contract.test.ts` | Basic login of the operator and the token header | Not used |

Shared files, not test files themselves:

| File | Content |
|---|---|
| `core-test-suite.ts` | Read suite: entity reads and read actions, first read and repeated read |
| `error-handling.backend.ts` | Backend error suite |
| `tx-test-suite.ts` | Transaction suite: the build actions, collateral, build details, submission status |
| `tx-error-handling.builder.ts` | Transaction error suite: insufficient funds, invalid assets, invalid scripts |
| `test-fixtures.ts` | Constants and mock data. Loads no HTTP mock |
| `mock-helpers.ts` | HTTP mocks for Koios, built on nock: `setupKoiosMocks()`, `setupUtxoMock()`, `setupTxInfoMock()`, `setupTxResponseMock()`, `resetKoiosMocks()`, `teardownKoiosMocks()` |

## Unit Tests (`test/unit/`)

Each file is `<name>.test.ts`.

### Validation, errors, configuration, database helpers

| File | Covers |
|---|---|
| `validators` | Type guards for hashes, addresses, pool and DRep ids, CBOR; JSON limits |
| `errors` | Error classes, `normalizeBackendError`, `rejectInvalid`, `rejectMissing` |
| `error-paths` | Failover on 503, 429 and timeouts |
| `api-contract` | Page sizes, ranges and enum parameters that the service models enforce |
| `result-numbers` | `Int64` and `Decimal` as text in read and operation results |
| `service-auth-annotations` | Which operations answer without a login |
| `cardano-service-readonly` | Every entity of the read service refuses writes |
| `config` | Configuration loaders: CDS section, environment, default |
| `docker-cds-config` | Database and login settings the Docker image builds from its environment |
| `epoch-slots` | Slot, time and epoch conversion |
| `paging` | Page defaults and stable order |
| `mappers` | Provider data to entity rows, `txSeq`, cost models, script address |
| `cip14-fingerprint` | CIP-14 asset fingerprints against the official test vectors |
| `cip68` | CIP-68 label arithmetic and decimals from a reference datum |
| `deep-json` | JSON with exact big integers at any nesting depth |
| `metadata-label-id` | Metadata labels up to 64 bits as the key of `TransactionMetadata` |
| `readiness` | The readiness answer |
| `read-outside` | A database read before a backend call does not take the connection |
| `detached-tx` | The timeout of a detached transaction covers getting the connection only |
| `db-indexes` | The secondary indexes created at start |
| `db-sanitize` | No NUL character reaches PostgreSQL |
| `pg-inline-json` | Bulk rows on PostgreSQL |
| `pg-order-nulls` | `ORDER BY` on PostgreSQL |
| `schema-asset-sums` | Asset sums per address fit their columns |
| `migrate-schema` | The steps of `scripts/migrate-schema.mjs` on SQLite files |
| `migrate-slot-leader` | `scripts/migrate-slot-leader.mjs` |
| `migrate-schema-upgrade` | `scripts/deploy-schema.mjs` from real 1.9.0 databases, the dry run, the empty-statement guard |
| `network-context` | The configured network before the app context exists |
| `lease` | Database leases on a real SQLite, including a renewal racing a takeover |
| `detached-run` | The runner of the maintenance actions: failure, cancel |
| `window-plan` | Slot-window walks and the PostgreSQL planner settings |
| `key-pages` | Key-ordered page walks, and that they let the event loop run |
| `gen-srv-package` | The BTP module's `package.json`: pinned versions, overrides, compiled output only |
| `check-login-package` | The `@odatano/cap-auth` range, lockfile and installed copy read `trustProxy` |

### Client and backends

| File | Covers |
|---|---|
| `cardano-client` | Backend setup, routing, fallback, evaluation |
| `circuit-breaker` | States and transitions per backend |
| `concurrency` | Parallel requests and the start race |
| `request-coalescer` | One backend call for concurrent equal requests |
| `backend-lazy-load` | A provider SDK loads only when its backend is configured |
| `blockfrost-backend` | Blockfrost backend with the SDK mocked |
| `koios-backend` | Koios backend |
| `ogmios-backend` | Ogmios backend: URL checks, value conversion, account, shutdown |
| `ogmios-chain-sync` | Chain-sync messages to blocks and transactions |
| `ogmios-frame-guard` | Chain-sync frames nested deeper than the JSON parser allows |
| `odatano-backend` | Another ODATANO as backend |
| `cardano-backend-service` | Handlers of `CardanoBackendService` |
| `stored-chain` | Stored blocks and transactions in provider shape |
| `transaction-presence` | Whether a transaction is on chain |
| `pool-metadata` | Pool metadata files: limits, hash check, public hosts only |

### Indexer

| File | Covers |
|---|---|
| `cardano-indexer` | Edge cases of the indexer |
| `indexer-block-full` | Bulk write of a block, inputs resolved from stored outputs |
| `indexer-local-coverage` | Values answered from crawled data |
| `ledger-state` | The crawler-fed UTxO set: apply, undo, recount |
| `pending-spends` | Own submitted transactions in the view of an address |
| `asset-decimals` | Decimals of CIP-68 tokens from the crawled chain, and their backfill |
| `read-navigation` | Navigation and `$expand` reads on the real model: parents indexed first, account pages |

### Transaction building and CBOR

| File | Covers |
|---|---|
| `cardano-tx-builder` | The builder coordinator with the builder mocked |
| `buildooor-tx-builder` | Transfers, mints and Plutus spends on the real builder |
| `buildooor-multi-script` | `BuildPlutusTransaction`: several script inputs, inline and reference scripts |
| `buildooor-transfer-datum` | Transfers with an inline datum given as CBOR |
| `tx-build-helper` | Hash extraction, PlutusData JSON, script parameters |
| `tx-request-parsers` | Parsers of the build payloads |
| `build-request` | The build request parser shared by the service and the worker |
| `build-row-change` | A real build stores its change address and change outputs |
| `plutus-placeholders` | `__INPUT_IDX__` placeholders |
| `plutus-data-json` | `DecodePlutusData` |
| `cbor-parse` | `ParseTransactionCbor` |
| `derive-script-address` | `DeriveScriptAddress` |
| `extract-payment-key-hash` | `ExtractPaymentKeyHash` |
| `keep-relevant` | Coin selection |
| `reference-script` | Reference script type, hash and size |
| `reference-script-fee` | Reference-script fee as the ledger charges it |

### Signing and submitting

| File | Covers |
|---|---|
| `signing` | `ExternalSignerModule`, `SignatureVerifier`, witness set helpers, on real transactions |
| `hsm-signer` | HSM signer with PKCS#11 mocked |
| `cose-verifier` | CIP-30 data signatures |
| `submit-and-finalize` | What a failed submit proves, and the reconciler |
| `submit-recorded` | The submission row and its outcome |
| `check-submission-status` | `CheckSubmissionStatus` confirms at three blocks depth |
| `landing-proof` | When a sent transaction is on chain, can never land or stays open; final refusals by code and text |
| `landing-rules` | The same rules end to end with the real job store and real CBOR |
| `cardano-sign-service` | The HSM change check, the role and HSM answers, the verify prelude |

### App context, plugin, agent grants

| File | Covers |
|---|---|
| `server` | App context, start and shutdown |
| `plugin` | Plugin start, and that a failure does not stop the host |
| `agent-grants` | Enforcement, budget counter, token resolution, issuing a grant |
| `agent-token-auth` | The `x-agent-token` transport lane |
| `agent-token-client-key` | The token throttle keys on the client before the reverse proxies |
| `agent-service-off` | `CardanoAgentService` answers 400 while grants are off |
| `service-events` | CAP events never throw into their caller |

### Crawler

| File | Covers |
|---|---|
| `crawler-engine` | Reorg handling, sources, intersection points |
| `crawler-lifecycle` | Start, chain-sync wiring, pagination loop, retries, poison block |
| `crawler-sync-state` | Cursor, lease, switch-off |
| `crawler-backend-pagination` | Pagination source and reorg detection by parent hash |
| `crawler-epoch-snapshot` | Pool and DRep snapshots per epoch, timeouts that abort |
| `crawl-epoch-final` | Crawled epochs turn final once the crawl has passed them |
| `crawler-chain-links` | Stored parent hashes, the rollback catalogue check, the node-behind status |
| `account-snapshots` | Account snapshots on an in-memory SQLite |
| `input-asset-copies` | Prune and restore of input asset copies, statements on SQLite |
| `input-asset-columns` | The restore names the columns the model has |
| `utxo-set-import` | Import of a UTxO set snapshot |
| `certificate-backfill` | `backfillCertificates` |
| `transaction-backfill` | `backfillTransactions` |
| `credential-backfill` | `backfillPaymentCredentials` |
| `output-datum-backfill` | `backfillOutputDatums` |
| `metadata-position-backfill` | `backfillMetadataPositions` |
| `asset-slice-backfill` | `backfillAssetSlices` on a real SQLite |
| `asset-registry-backfill` | `backfillAssetRegistry` from Koios |
| `asset-registry-files` | `backfillAssetRegistry` from entry files, on an in-memory SQLite |
| `cardano-indexer-service` | `getStatus`, pause, resume, the two probes |

### Wallet worker

| File | Covers |
|---|---|
| `wallet-worker-engine` | Dispatch, retries, the `submitting` state, reconciliation |
| `wallet-worker-job-store` | Job state machine, idempotency, recovery, leases |
| `wallet-worker-lifecycle` | Start and stop of the worker |
| `wallet-worker-confirmation` | Confirmation depth, resubmit after a rollback, dropped transactions |
| `wallet-worker-signers` | Software and HSM signer, witness merge, key handling |
| `wallet-worker-lease-heartbeat` | Lease renewal, check before submit |
| `wallet-worker-build-request` | Job payload to build request, per job kind |
| `cardano-worker-service` | Role gate of `SubmitWalletJob`, job access, worker control |

## Fixtures

`test/integration/test-fixtures.ts` holds the Preview data the tests use, in `TEST_FIXTURES`:

```typescript
validTxHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
txWithMetadata: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
validBlockHash: '890af88d47433ecc9eccf16369aef16df40fc7f41b9d38a8d758c8ca1968a886',
validBech32Address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
validStakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
validPoolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
validDrepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
transactionMetadataLabel: '1990',
```

The file also has unsigned and signed transactions, witness sets, mock UTxO sets and mock protocol
parameters.

## CI

`.github/workflows/test.yaml` runs on a push to `main` and on pull requests, on Node.js 22 and 24. It runs
typecheck, lint and the tests with coverage. The Ogmios suite runs only when the workflow has a synced
node.
