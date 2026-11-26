# ODATANO User Guide

**Version:** v2.0.0-rc.x

How to call the ODATANO services: reading chain data, building, signing and submitting transactions, and
the optional crawler, wallet worker and agent grants.

## Contents

1. [Getting Started](#getting-started)
2. [API Endpoints](#api-endpoints)
3. [OData Query Examples](#odata-query-examples)
4. [Error Responses](#error-responses)
5. [FAQ](#faq)
6. [Transaction Building](#transaction-building)
7. [External Signing](#external-signing)
8. [Upgrading from 1.x](#upgrading-from-1x)
9. [Chain Crawler (opt-in)](#chain-crawler-opt-in)
10. [Wallet Worker (opt-in)](#wallet-worker-opt-in)
11. [Agent Grants (opt-in)](#agent-grants-opt-in)
12. [Events](#events)
13. [Further Reading](#further-reading)

---

## Getting Started

### What is ODATANO?

ODATANO serves Cardano chain data and transaction building as **OData V4** services.

- Reads transactions, blocks, epochs, pools, accounts, DReps, addresses, UTxOs, native assets and metadata.
- Builds unsigned transactions: ADA transfers, native assets, minting, Plutus scripts.
- Takes the signature from a CIP-30 wallet, the Cardano CLI, a hardware wallet or an HSM, verifies it and
  submits the transaction.
- Keeps a record of every build, signing request, verification and submission.
- Stores what it reads in its database and asks a backend only when a row is missing or expired.
- Falls back to the next configured backend when one fails.
- Supports `$filter`, `$select`, `$expand`, `$top`, `$skip`, `$count` and `$orderby`.

### Supported Networks

| Network | `NETWORK` | Addresses |
|---|---|---|
| Mainnet | `mainnet` | `addr1…`, `stake1…` |
| Preview (testnet) | `preview`, the default | `addr_test1…`, `stake_test1…` |
| Preprod (testnet) | `preprod` | `addr_test1…`, `stake_test1…` |

### Services

| Service | Base path | Role |
|---|---|---|
| `CardanoODataService` | `/odata/v4/cardano` | `Read` |
| `CardanoTransactionService` | `/odata/v4/cardano-transaction` | `Transact` |
| `CardanoSignService` | `/odata/v4/cardano-sign` | `Sign` |
| `CardanoIndexerService` | `/odata/v4/cardano-indexer` | `Read` for the status, `Admin` for the actions |
| `CardanoWorkerService` | `/odata/v4/cardano-worker` | `Transact`, `Admin` to pause and resume |
| `CardanoAgentService` | `/odata/v4/cardano-agent` | `Admin` for the administration calls |

### Base URL

```
http://localhost:4004/odata/v4/cardano
```

A request needs a login that holds the role of its service, `Read` for this one. Without a login the answer
is 401, with a login that lacks the role 403. The examples in this guide leave the credentials out. In
development add `-u alice:` to a `curl` call: `alice` is a development user of CAP and the password is not
checked.

`$metadata` lists every entity and action of a service, for example `/odata/v4/cardano/$metadata`.

### Numbers are strings

`Int64` and `Decimal` values and `$count` are JSON strings, for example `"fee": "200000"` and
`"slot": "12345678"`. This holds for entity reads and for the results of actions and functions. `Integer`
values such as `height` and `size` are JSON numbers.

---

## API Endpoints

The paths in this section are relative to `/odata/v4/cardano`. An entity set is read with GET. An action is
called with POST and a JSON body.

A read by key, such as `Blocks('<hash>')`, fetches the row from a backend when the database does not hold
it. A read without a key returns the stored rows.

### Network Information

```http
GET /NetworkInformation('preview')

POST /GetNetworkInformation
{}

POST /GetLedgerProtocolParameters
{}
```

### Blocks & Epochs

```http
GET /Blocks('cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39')
GET /Epochs(123)

POST /GetLatestBlock
{}

POST /GetLatestEpoch
{}

POST /GetBlockByHash
{"hash": "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39"}

POST /GetEpochByNumber
{"epochNumber": 123}
```

- `Blocks.previousHash` is the parent block's hash when the source reported it, else null.
- `Blocks('…')/epoch` and `$expand=epoch` fetch the epoch when it is not stored.
- `Epochs.final` is true once the epoch has ended and no rollback can reach it any more. A row that is
  not final is read from the backend again; when the backend cannot answer, the stored row is returned.

### Transactions

```http
GET /Transactions
GET /Transactions('2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83')
GET /Transactions('2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83')/inputs
GET /Transactions('2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83')/outputs

POST /GetTransactionByHash
{"hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"}

POST /GetMetadataByTxHash
{"txHash": "95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1"}

POST /GetMetadataByLabel
{"label": "674", "fromSlot": "744531", "limit": 100}

POST /GetTransactionConfirmations
{"txHash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"}

POST /ParseTransactionCbor
{"cbor": "84a5008182..."}

POST /DecodePlutusData
{"cbor": "d8799f581c32b3270fd1561cec0aa24b4aec6850cd0196486033e3dd849945c319182aff"}
```

**`GetMetadataByLabel`** returns the stored metadata of one label in chain order, oldest first.

- It reads the database only: crawled transactions and transactions read earlier.
- Each row carries `txSeq`, the chain position `slot * 65536 + transaction index`. Continue from a slot with
  `fromSlot`.
- A row stored by an earlier version has no `txSeq` and is left out until `backfillMetadataPositions` has
  run, see [Backfills](CRAWLER_GUIDE.md#backfills).

**`GetTransactionConfirmations`** returns `blockHeight`, `tipHeight` and `confirmations`.

- `confirmations` is the tip height minus the block height plus one. It is 0 while the transaction is not on
  chain.
- With a synced crawler, a transaction in a crawled block is counted against the crawler's tip without a
  backend call.
- Any other transaction, for example one in the newest `confirmationDepth` blocks, is looked up at the
  backends together with their tip.

**`ParseTransactionCbor`** decodes a transaction from its CBOR hex. **`DecodePlutusData`** turns PlutusData
CBOR hex into the JSON the build actions take as `outputDatumJson`.

- The input of `DecodePlutusData` can be an inline datum, a `TransactionDatums` row or a redeemer.
- The JSON uses `constructor` with `fields`, `int`, `bytes`, `list`, and `map` with `k` and `v`.
- An integer above 2^53 comes back as a decimal string.
- Both actions call no backend. Malformed CBOR is a 400.

**Response Example (Transaction):**

```json
{
  "hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
  "blockHash": "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39",
  "slot": "12345678",
  "size": 450,
  "fee": "200000",
  "deposit": "0"
}
```

### Addresses & Assets

```http
GET /Addresses
GET /Addresses('addr_test1...')

POST /GetAddressByBech32
{"address": "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8"}

POST /GetUTxOsByAddress
{"address": "addr_test1..."}

POST /GetUTxOsByCredential
{"credential": "<56 hex>"}

POST /GetAssetsByAddress
{"address": "addr_test1..."}

POST /GetLatestTransactionsByAddress
{"address": "addr_test1...", "limit": 10}

GET /Addresses('addr_test1...')/utxos
GET /AddressUTxOs?$filter=address_address eq 'addr_test1...'&$top=100
GET /AddressAssets?$filter=address_address eq 'addr_test1...'

GET /Assets('<policy id + asset name hex>')

POST /GetAssetInfo
{"unit": "<policy id + asset name hex>"}

POST /GetAssetHistory
{"unit": "<policy id + asset name hex>", "limit": 100}
```

`GetUTxOsByCredential` takes the payment credential, 28 bytes as 56 lowercase hex characters. It needs Koios
or the [crawler-fed UTxO set](CRAWLER_GUIDE.md#crawler-fed-utxo-set-balances-without-a-provider).

**`AddressUTxOs` and `AddressAssets`** fill like `Addresses`:

- A read that names the address fetches it on a cache miss and then runs the query. The address can be the
  navigation parent or stand in the `$filter`: `address_address eq '…'`, `address/address eq '…'` or
  `address_address in (…)`.
- One read may name up to 10 addresses.
- A read without an address returns only what is cached.
- The rows expire with the address after `INDEX_TTL_MS`. The next read that names the address fetches again.
- With Ogmios as the only backend and no crawled UTxO set, the UTxOs are fetched without an address row. An
  address that holds no UTxO is then asked at the node on every read.

**Datum filter.** `contains(utxodata_inlineDatum, '<hex>')` matches a byte string only up to 64 bytes.
Plutus data CBOR splits a longer byte string into chunks of 64 bytes, so its hex is not contiguous. The same
holds for `utxo_inlineDatum` on `LedgerUTxOs`.

**Payment credential.** Every UTxO row carries `paymentCredential`: the payment key hash or script hash of
its address, 28 bytes as hex. The rows are `TransactionOutputs.utxo`, `TransactionInputs.utxoData`,
`AddressUTxOs.utxodata` and `LedgerUTxOs.utxo`. The credential is the same for every stake variant of an
address, so one filter finds all outputs of a script. A Byron address has none; the field is null.

```http
GET /TransactionOutputs?$filter=utxo_paymentCredential eq '<56 hex>' and txSeq ge 1000000000&$orderby=txSeq
GET /LedgerUTxOs?$filter=utxo_paymentCredential eq '<56 hex>' and spentTxHash eq null
```

**Watching an address.** `GetLatestTransactionsByAddress` takes `sinceTime` in unix seconds: only
transactions with a later block time come back. With `waitMs`, at most 30000, the call waits for one:

- When nothing newer is known, it reads again every 5 seconds. It answers as soon as a transaction appears,
  or with an empty list when the time is up.
- Pass the newest `blockTime` you have seen as the next `sinceTime`.
- A waiting call holds no database connection. On a deployment without local address data each read is one
  backend call.

```http
POST /GetLatestTransactionsByAddress
{"address": "addr_test1...", "sinceTime": "1791301263", "waitMs": 25000}
```

**Response Example (Address with `$expand=assets`, shortened):**

```json
{
  "address": "addr_test1qqetxf...",
  "stakeAddress": "stake_test1...",
  "isScript": false,
  "totalLovelace": "5000000",
  "assets": [
    {
      "unit": "<policy id + asset name hex>",
      "asset_policyId": "<56 hex>",
      "asset_assetName": "SUNDAE",
      "asset_quantity": "1000"
    }
  ]
}
```

### Pools, Accounts & DReps

```http
GET /Pools('pool1...')
POST /GetPoolById
{"poolId": "pool1..."}

GET /Accounts('stake_test1...')
POST /GetAccountByStakeAddress
{"stakeAddress": "stake_test1..."}

GET /Dreps('drep1...')
POST /GetDrepById
{"drepId": "drep1..."}
```

An account row holds `addressCount`, not the addresses. Read them through the navigation:

```http
GET /Accounts('stake_test1...')/Address?$top=10&$skip=0
GET /Accounts('stake_test1...')/Address/$count
```

- With up to 10 addresses every address is fetched and the query runs as you send it.
- With more than 10, a page takes `$top` of at most 10, ordered by `address` (asc or desc), without
  `$filter`. `$count` gives the account's total. `$expand=Address` follows the same rule.
- The address list is stored with the account. Later pages are read without the backend until the
  account expires.
- `Accounts('…')/poolId` and `/drepId` fetch the pool or DRep when they are not stored.
- A figure a backend does not report is null, not 0.

### List Operations: Page Size and Order

Every operation that returns a list takes `limit` and `skip` and answers in a fixed order, so paging with
`skip` is stable. A value outside its range is a 400 before the operation runs. Two bad values in one
request give one 400 with both in `details`.

| Operation | Service | Order | Default `limit` | Max `limit` | `skip` |
|---|---|---|---|---|---|
| `GetAssetHistory` | read | newest first, tx hash on ties | 100 | 100 | `skip + limit` at most 100 |
| `GetLatestTransactionsByAddress` | read | newest first, tx hash on ties | 10 | 100 | `skip + limit` at most 100 |
| `GetUTxOsByAddress` | read | tx hash, output index | 1000 | 5000 | ≥ 0 |
| `GetUTxOsByCredential` | read | tx hash, output index | 1000 | 5000 | ≥ 0 |
| `GetAssetsByAddress` | read | asset unit | 1000 | 5000 | ≥ 0 |
| `GetMetadataByTxHash` | read | metadata label | 1000 | 5000 | ≥ 0 |
| `GetMetadataByLabel` | read | chain position, oldest first | 100 | 1000 | ≥ 0 |
| `GetTransactionBuildsByAddress` | transaction | build id | 1000 | 5000 | ≥ 0 |
| `GetSigningRequestsByAddress` | sign | signing request id | 1000 | 5000 | ≥ 0 |

- `GetAssetHistory` and `GetLatestTransactionsByAddress` read the newest 100 entries of a provider. Older
  entries are in the entity sets `AssetHistory` and `AddressTransactions`.
- Entity sets page with `$top` and `$skip`, at most 1000 rows per page.
- The large entity sets answer only reads an index serves; see "Reads on the large entity sets" below.
- Heights, slots, epochs and output indexes must be 0 or more.
- An enum parameter refuses any other value with a 400: `network` (`mainnet`, `preview`, `preprod`), `kind`
  of a wallet job, `source` of `importUtxoSet`.

### Reads on the large entity sets

`Blocks`, `Transactions`, `TransactionInputs`, `TransactionOutputs`, `TransactionInputAssets`,
`TransactionOutputAssets`, `TransactionMetadata`, `TransactionCertificates`, `TransactionWithdrawals`,
`TransactionRedeemers`, `TransactionDatums`, `AssetHistory`, `Assets`, `LedgerUTxOs`, `LedgerUTxOAssets`,
`LedgerAddresses` and `LedgerAddressAssets` grow with the chain. A read on them that no index serves is
refused with 400 `ODATANO_QUERY_NOT_INDEXED`. The message names the fields a filter can start with.

- `$filter` uses fields that start an index or the key, for example `hash`, `height`, `slot`, `time` and
  `epochNumber` on `Blocks`. The second field of an index counts once the filter fixes the first with `eq`:
  `utxo_paymentCredential eq '…' and txSeq ge …` on `TransactionOutputs`.
- `$orderby` follows an `eq` filter, or runs in index order without one: `$orderby=height desc` on
  `Blocks`.
- `$count` needs a `$filter`.
- `$search`, `$apply` and functions such as `contains` are refused.
- Reads by key, navigations such as `Transactions('…')/outputs` and `$expand` are not checked.
- `TransactionMetadata` is filtered by `id`, the label as a number. `TransactionOutputAssets` is filtered by
  `output_txSeq`. The holders of an asset are in `LedgerUTxOAssets` and `LedgerAddressAssets`, its mints
  and burns in `AssetHistory`.

On PostgreSQL a read that runs longer than the read timeout (default 15 s) is cancelled with 503
`ODATANO_QUERY_TIMEOUT`.

---

## OData Query Examples

### Example 1: Query Transaction by Hash

**cURL:**

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetTransactionByHash \
  -H "Content-Type: application/json" \
  -d '{"hash": "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"}'
```

**PowerShell:**

```powershell
$body = @{hash = "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83"} | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:4004/odata/v4/cardano/GetTransactionByHash" `
  -Method POST -ContentType "application/json" -Body $body
```

**JavaScript:**

```javascript
const response = await fetch(
  "http://localhost:4004/odata/v4/cardano/GetTransactionByHash",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hash: "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
    }),
  }
);
const data = await response.json();
console.log(data);
```

### Example 2: Check Address Balance

```bash
curl -X POST http://localhost:4004/odata/v4/cardano/GetAddressByBech32 \
  -H "Content-Type: application/json" \
  -d '{"address": "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8"}'
```

### Example 3: Use OData Query Options

```http
# Newest stored block
GET /Blocks?$orderby=height desc&$top=1

# Filter
GET /Transactions?$filter=blockHeight gt 2000000&$top=10

# Select fields
GET /Addresses?$select=address,totalLovelace

# Expand related entities
GET /Transactions?$expand=inputs,outputs
```

---

## Error Responses

An error answer carries the HTTP status and an `error` object. `error.code` is the ODATANO code.
`error.message` names the operation and the reason. For an error raised while the operation runs, the
message starts with the code in brackets.

```json
{"error": {"code": "ODATANO_INVALID_INPUT", "message": "GetTransactionByHash: Invalid transaction hash format"}}
```

### Status Code Reference

| Status | `error.code` | Meaning | What to do |
|---|---|---|---|
| 400 | `ODATANO_INVALID_INPUT` | A parameter is missing, malformed or out of range | Fix the request |
| 400 | `ODATANO_QUERY_NOT_INDEXED` | A read on a large entity set that no index serves | Filter on an indexed field |
| 400 | `ODATANO_TX_VALIDATION_FAILED`, `ODATANO_TX_PARSE_FAILED`, `ODATANO_INSUFFICIENT_FUNDS`, `ODATANO_SCRIPT_VALIDATION_FAILURE` | A transaction cannot be built, decoded or accepted | See the [Transaction Workflow Guide](TRANSACTION_WORKFLOW.md) |
| 401 | | No login | Send credentials |
| 403 | `ODATANO_FORBIDDEN` for a wallet or HSM role | The login lacks a role | Use a login with the role |
| 404 | `ODATANO_NOT_FOUND` | The transaction, block or address is not on the configured network | Check the network and the value |
| 409 | `ODATANO_TX_ALREADY_SUBMITTED`, `ODATANO_IDEMPOTENCY_KEY_CONFLICT` | The transaction was submitted before, or the key belongs to another request | Read the existing record |
| 429 | `ODATANO_PROVIDER_RATE_LIMITED` | A backend limits the requests | Wait and retry |
| 500 | `ODATANO_INTERNAL_ERROR` | Unexpected error | Report it |
| 503 | `ODATANO_PROVIDER_UNAVAILABLE` | No backend answered in time | Retry |
| 503 | `ODATANO_SUBMIT_OUTCOME_UNKNOWN` | A submit got no verdict from the node | Do not build again; read the record |
| 503 | `ODATANO_QUERY_TIMEOUT` | A read ran longer than the read timeout | Narrow the filter |

[Error Handling](../concepts%20&%20architecture/ERROR_HANDLING.md) lists every code.

### Common Errors

- **Hash.** A transaction or block hash has 64 hexadecimal characters.
- **Address.** An address is bech32 and belongs to the configured network: `addr_test1…` and `stake_test1…`
  on preview and preprod, `addr1…` and `stake1…` on mainnet. A Byron address (`DdzFF…`) or an address of
  another chain is refused.
- **Missing parameter.** The message names the field, for example `hash is required`.
- **404 for a value you expect to exist.** Look it up on an explorer of the same network, for preview
  https://preview.cexplorer.io.
- **503.** Every configured backend failed or timed out. See "Why is a request slow?" below.

---

## FAQ

### How long are results cached?

- Rows that change over time, such as addresses, accounts and pools, expire after `INDEX_TTL_MS`. The
  default is 3600000 ms, one hour.
- Transactions and blocks are stored for good.

See the [Indexing Concept](../concepts%20&%20architecture/INDEXING.md).

### Which backend do I need?

None beyond the default. `BACKENDS=koios` works without an account on the Koios public tier.

- **Koios:** the default. An optional token (`KOIOS_API_KEY` or `koiosApiKey`, from https://koios.rest)
  raises the rate limit.
- **Ogmios:** a local cardano-node with Ogmios, for live data, script evaluation and the chain crawler.
- **Blockfrost:** needs `BLOCKFROST_API_KEY`, or a self-hosted Blockfrost-compatible node.
- **odatano:** another ODATANO instance as backend (`ODATANO_URL`, `ODATANO_API_KEY`).

The [Backend Configuration Guide](BACKEND_CONFIGURATION.md) says which backend answers which call.

### Can I query mainnet?

Yes. Set `NETWORK=mainnet`. Koios needs no key there either. A Blockfrost key must belong to a mainnet
project.

### Why is a request slow?

- The first read of a row fetches it from a backend. Later reads come from the database.
- A row that expired after `INDEX_TTL_MS` is fetched again.
- A backend that does not answer costs up to `PRIMARY_TIMEOUT_MS` (default 30 s). The call then goes to the
  next backend, which gets up to `FALLBACK_TIMEOUT_MS` (default 60 s). If all fail, the answer is 503.

### Can I change or delete chain data?

No. The entities of the read service are read-only. Transactions are created through the transaction
service.

### How do I get test ADA?

From the testnet faucet: https://docs.cardano.org/cardano-testnets/tools/faucet. Send it to your address,
make a transaction and read it through ODATANO.

### Is the API free to use?

ODATANO is free (Apache 2.0). Limits come from the backend: the Koios public tier is rate limited. A Koios
token or a local Ogmios lifts most of that.

### Can I call it from a browser?

In development yes: CAP allows cross-origin requests there. In production CAP's CORS handling is off. Serve
the application from the same origin, for example behind the AppRouter, or configure CORS as the
[Security Guide](SECURITY_GUIDE.md#cors) describes.

### When GET, when POST?

- **GET** reads an entity set, for example `GET /Transactions`.
- **POST** calls an action, for example `POST /GetTransactionByHash`.
- A **function** is called with GET and its parameters in the URL: `getStatus()`, `GetJobStatus(…)`,
  `GetWorkerStatus()`, `GetGrantStatus()`. A POST to a function returns 405.

---

## Transaction Building

**Base URL:**

```
http://localhost:4004/odata/v4/cardano-transaction
```

### Build Simple ADA Transfer

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/BuildSimpleAdaTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "senderAddress": "addr_test1...",
    "recipientAddress": "addr_test1...",
    "lovelaceAmount": 10000000
  }'
```

**Response:**

```json
{
  "id": "uuid-here",
  "unsignedTxCbor": "84a50081825820...",
  "txBodyHash": "abc123...",
  "fee": "170000"
}
```

### Submit Signed Transaction

After signing outside the server, with the Cardano CLI or a browser wallet:

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-transaction/SubmitTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "buildId": "uuid-from-build",
    "signedTxCbor": "84a5008182..."
  }'
```

`signedTxCbor` is the signed transaction, or the witness set a CIP-30 wallet returns from `signTx`.

- The signed bytes need an expiry at most 24 hours ahead that has not passed, and `isValid` true; other
  bytes are refused with a 400.
- `failed` means the transaction can never land, or landed with failing scripts. See
  [What a failed submit means](TRANSACTION_WORKFLOW.md#what-a-failed-submit-means).
- A submit without a verdict answers 503 `ODATANO_SUBMIT_OUTCOME_UNKNOWN`. The record stays open and the
  server resolves it. Do not build the payment again; read the record.
- `unresolved` means the transaction can no longer land and nothing shows whether it did. An Admin decides it
  with `ResolveSubmission` or `ResolveSigningRequest`.
- A refused transaction that is already on chain answers 409 `ODATANO_TX_ALREADY_SUBMITTED`.

### Available Transaction Actions

| Action | Description |
|--------|-------------|
| `BuildSimpleAdaTransaction` | ADA transfer |
| `BuildTransactionWithMetadata` | ADA transfer with metadata |
| `BuildMultiAssetTransaction` | Transfer of native assets |
| `BuildMintTransaction` | Mint or burn tokens |
| `BuildPlutusSpendTransaction` | Spend a UTxO locked at a Plutus script address |
| `BuildPlutusTransaction` | Spend several script UTxOs in one transaction, each with its own redeemer; outputs as given |
| `SetCollateral` | Make sure the address holds an ADA-only collateral UTxO |
| `GetBuildDetails` | Read a build by its id |
| `GetTransactionBuildsByAddress` | List the builds of an address |
| `SubmitTransaction` | Submit a transaction built here |
| `SubmitSignedTransaction` | Submit a transaction built elsewhere |
| `CheckSubmissionStatus` | Read the state of a submission (bound to `TransactionSubmissions`) |
| `DeriveScriptAddress` | Apply optional parameters to a validator script; returns its address and script hash |
| `ExtractPaymentKeyHash` | Return the payment credential of an address |

The [Transaction Workflow Guide](TRANSACTION_WORKFLOW.md) describes the parameters.

---

## External Signing

The private key stays outside the server. `CardanoSignService` hands out what has to be signed, verifies the
signature and submits.

**Base URL:**

```
http://localhost:4004/odata/v4/cardano-sign
```

### External Signing Workflow

```
1. Build transaction       → unsigned CBOR (CardanoTransactionService)
2. Create signing request  → signing instructions and expiry (CardanoSignService)
3. Sign outside the server → CIP-30 wallet or Cardano CLI
4. Verify and submit       → CardanoSignService
```

### Create Signing Request

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/CreateSigningRequest \
  -H "Content-Type: application/json" \
  -d '{
    "buildId": "uuid-from-build-response",
    "message": "Please sign this transaction"
  }'
```

**Response:**

```json
{
  "id": "signing-request-uuid",
  "txBodyHash": "abc123...",
  "unsignedTxCbor": "84a50081825820...",
  "status": "pending",
  "expiresAt": "2026-02-05T12:30:00Z",
  "cardanoCliCommand": "cardano-cli transaction sign --tx-body-file tx.raw..."
}
```

### Verify and Submit

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SubmitVerifiedTransaction \
  -H "Content-Type: application/json" \
  -d '{
    "signingRequestId": "signing-request-uuid",
    "signedTxCbor": "84a5008182...",
    "signerType": "browser-wallet",
    "signerInfo": "Eternl"
  }'
```

#### From your own CAP handler: `deferSubmit`

This concerns a CAP application that loads ODATANO as a plugin and calls the action in the same process
(`srv.send('SubmitVerifiedTransaction', …)`). A client that calls the action over HTTP is not affected.

`SubmitVerifiedTransaction` and `SignAndSubmitWithHsm` keep their records in database transactions of
their own. A handler that awaits one of them while its own request transaction is open can wait for a
database connection that its own transaction holds. On SQLite, with one pooled connection, that wait
never ends by itself. The action then fails after 10 seconds with 503 `ODATANO_NESTED_TX_TIMEOUT`. The
time is `ODATANO_DETACHED_TX_TIMEOUT_MS`.

Two ways to avoid it:

- Pass `deferSubmit: true`. The signature is verified and the signing request is claimed on your
  transaction, so a bad signature still fails your request. The action answers at once with the
  transaction hash and status `pending`. The transaction is sent after your commit; if your request
  rolls back, nothing is sent. Read the outcome from the signing request (`GetSigningRequest`) or the
  submission (`CheckSubmissionStatus`).
- Or call the action while your handler holds no database connection: before its first database
  statement, or after reading in a transaction of its own (`cds.tx(…)`) that has committed.

### Available External Signing Actions (CardanoSignService)

| Action | Description |
|--------|-------------|
| `CreateSigningRequest` | Create a signing request; it expires after 30 minutes |
| `GetSigningRequest` | Read a signing request; a pending one past its expiry becomes `expired` |
| `VerifySignature` | Verify a signed transaction |
| `SubmitVerifiedTransaction` | Verify and submit in one step |
| `GetSigningRequestsByAddress` | List the signing requests of an address |
| `VerifyDataSignature` | Verify a CIP-30 `signData` message signature, for a wallet login; no transaction |
| `SignWithHsm` | Sign with the HSM; returns the signing request |
| `SignAndSubmitWithHsm` | Sign with the HSM and submit in one step |
| `GetHsmStatus` | HSM connection and key information |

### Signing Methods Supported

| Method | Description |
|--------|-------------|
| **CIP-30 browser wallets** | Eternl, Lace, Yoroi, Vespr and others |
| **Cardano CLI** | Signing with `payment.skey` |
| **Hardware wallets** | Ledger, Trezor through browser extensions |
| **HSM (PKCS#11)** | YubiHSM, AWS CloudHSM, Thales Luna: signing on the server |

### Wallet Login -- Verify a CIP-30 Data Signature

`VerifyDataSignature` verifies a signed **message** (CIP-30 `signData`, COSE_Sign1), not a transaction. It
proves that a user controls a wallet address, without a transaction.

It is the only action of the sign service that needs no login, because the caller is logging in. It writes
nothing and uses no key.

The action answers one question: did the key of this address sign this message? Everything else that makes
a login safe stays in your application:

1. Your app issues the message itself, with a random nonce, its own domain or app name and an expiry, for
   example `MyApp login: <nonce>`.
2. The user signs it in the wallet with CIP-30 `signData(address, payload)`, which returns
   `{ signature, key }`.
3. Your app calls `VerifyDataSignature` with those values and passes the message as `expectedPayload`, so a
   signature over any other message fails.
4. On `valid: true` it creates the session or JWT. It accepts each message once.

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/VerifyDataSignature \
  -H "Content-Type: application/json" \
  -d '{
    "address": "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8",
    "coseSignature": "845869a30127...",
    "coseKey": "a40101032720...",
    "expectedPayload": "MyApp login: 7f3a9c1e"
  }'
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `address` | yes | Bech32 address the wallet signed with. A base, pointer or enterprise address is signed by its payment key, a reward address `stake1…` by its stake key. Key-hash credentials only |
| `coseSignature` | yes | Hex COSE_Sign1 CBOR, the `signature` field from `signData`. At most 65536 characters |
| `coseKey` | yes | Hex COSE_Key CBOR, the `key` field from `signData`. At most 512 characters |
| `expectedPayload` | no | When set, the signed payload must equal it byte for byte. Required when the wallet signed the hash of the message (`hashed: true`, hardware wallets). When left out, the decoded payload is returned for you to check. At most 16384 characters |

**Response:**

```json
{
  "valid": true,
  "reason": "",
  "signedPayload": "MyApp login: 7f3a9c1e",
  "signedPayloadHex": "4d79417070206c6f67696e3a203766336139633165",
  "signerVkh": "2b59938fe8ab0e76054925a575b1c50e406594300cf8f7b09328b863"
}
```

`signedPayload` is empty when the signed bytes are not UTF-8. `signedPayloadHex` always carries them. For a
hashed payload it is the blake2b-224 of the message.

The action checks, in this order:

1. the structure CIP-30 prescribes: `alg` EdDSA in the signed header, a COSE_Key of type OKP with `alg`
   EdDSA and curve Ed25519, no label twice, no detached payload
2. that the `address` in the signed header is the address you passed
3. that the signer's public key hashes (`blake2b-224`) to the credential of that address
4. that the payload equals `expectedPayload`, when given
5. the Ed25519 signature over the COSE `Sig_structure`

A failed check returns HTTP 200 with `valid: false` and a `reason`. Only malformed input returns a 400: a
missing or invalid address, missing CBOR, a value above its length limit.

### HSM Signing (Server-Side)

A PKCS#11 Hardware Security Module signs on the server. The private key never leaves the HSM: the server
sends a hash and the HSM returns a signature. The HSM actions need the role named in `HSM_REQUIRES_ROLE`.

**Check HSM status:**

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/GetHsmStatus \
  -H "Content-Type: application/json" -d '{}'
```

**Response:**

```json
{
  "connected": true,
  "keyId": "0x0001",
  "keyLabel": "cardano-signing-key",
  "publicKeyHash": "a1b2c3...",
  "cardanoAddress": "addr_test1..."
}
```

**Sign only.** Creates the signing request and the verification record:

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SignWithHsm \
  -H "Content-Type: application/json" \
  -d '{"buildId": "uuid-from-build-response"}'
```

**Sign and submit:**

```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/SignAndSubmitWithHsm \
  -H "Content-Type: application/json" \
  -d '{"buildId": "uuid-from-build-response"}'
```

**Response:**

```json
{
  "id": "submission-uuid",
  "txHash": "71f3d8c1...",
  "status": "submitted"
}
```

The [Security Guide](SECURITY_GUIDE.md#hsm-pkcs11-integration) describes the HSM setup.

### Signing Status States

| Status | Description |
|--------|-------------|
| `pending` | Request created, waiting for the signature |
| `signed` | A verification has taken the request and checks the signature |
| `verified` | Signature verified, ready to submit |
| `submitting` | Submit in flight, or its outcome not known yet |
| `submitted` | Transaction submitted to the network |
| `expired` | Still `pending` 30 minutes after it was created |
| `failed` | The signature did not verify, or the node refused the transaction |

The [Transaction Workflow Guide](TRANSACTION_WORKFLOW.md) has the complete flow.

---

## Upgrading from 1.x

[Upgrading from 1.x to 2.0](UPGRADE_2.0.md) lists what a 1.x deployment and its API clients have to change.

---

## Chain Crawler (opt-in)

By default ODATANO indexes lazily: it asks a backend when the database misses a row. The crawler reads the
chain forward from a start block and stores `Blocks` and `Transactions` with their inputs, outputs, assets
and metadata. A query on that range is answered from the database.

The crawler is off until `CRAWLER_ENABLED=true` and a start block are set. The
[Crawler Guide](CRAWLER_GUIDE.md) has the settings, what the crawl stores, the backfills and the operation
of a crawled database.

---

## Wallet Worker (opt-in)

The wallet worker runs transactions for wallets whose keys the server holds. You queue a job. The worker
builds, signs with a software key or an HSM, submits, and follows the transaction until it reaches the
confirmation depth. One job per wallet is in flight at a time, so your own transactions never compete for
the same UTxO.

**Enable it** in the plugin configuration, or with `WALLET_WORKER_ENABLED` and `WALLET_WORKER_WALLETS`:

```jsonc
"cds": { "requires": { "odatano-core": {
  "walletWorker": {
    "enabled": true,
    "wallets": [
      { "walletId": "treasury", "signerType": "software", "keyEnv": "TREASURY_SIGNING_KEY", "requiresRole": "Treasurer" },
      { "walletId": "minter",   "signerType": "hsm" }
    ],
    "confirmationDepth": 3,          // a job is 'confirmed' at this depth
    "confirmationTimeoutMs": 600000, // unseen past this: the same bytes are sent again, with growing waits
    "defaultMaxAttempts": 3          // attempts for a build or submit failure that may pass
  }
}}}
```

- A software wallet reads its signing key from the environment variable named in `keyEnv`. The key appears
  in neither the configuration nor the database.
- The worker wallet is always the sender and receives the change. A caller cannot spend from another
  address through a worker wallet.

**Queue and track jobs** at `/odata/v4/cardano-worker/`:

```http
POST /odata/v4/cardano-worker/SubmitWalletJob
Content-Type: application/json

{
  "walletId": "treasury",
  "kind": "simpleAda",                       // simpleAda | metadata | multiAsset | mint | plutusSpend | payout | submitSigned
  "requestJson": "{\"recipientAddress\":\"addr_test1...\",\"lovelaceAmount\":\"2000000\"}",
  "idempotencyKey": "invoice-4711"           // optional: same key + same request = same job (safe retries)
}
```

`requestJson` is a JSON object with the payload of the matching `Build*` action of the transaction
service, for example `assetsJson`, `mintActionsJson`, `metadataJson` or the Plutus spend fields. It is
checked like the `Build*` action, and a wrong field is a 400 at once. `senderAddress` and `changeAddress`
are always replaced by the wallet's address. The answer carries the `jobId` at once.

A `submitSigned` job takes `signedTxCbor`. The transaction must carry an expiry (TTL) at most 24 hours
ahead; without one the job is refused with 400.

**`payout`** pays several recipients in one transaction. Its `requestJson` takes `outputsJson`, a JSON
array in the form `BuildPlutusTransaction` uses, with at most 150 entries:

```json
{
  "outputsJson": "[{\"address\":\"addr_test1...\",\"lovelaceAmount\":\"2000000\"},{\"address\":\"addr_test1...\",\"lovelaceAmount\":\"3500000\"}]"
}
```

- The outputs keep their order. The change goes back to the wallet after them.
- An entry may carry `assets` and a datum, like an output of `BuildPlutusTransaction`. Each output needs its min-ADA.
- All recipients are paid or none. A job whose transaction would exceed the maximum transaction size fails, and nothing is sent.
- Optional: `forceInputsJson`, `protectInputsJson`, `validityStartMs`, `validityEndMs`.

```http
GET  /odata/v4/cardano-worker/GetJobStatus(jobId=<uuid>)   # function: GET, parameter in the URL
GET  /odata/v4/cardano-worker/GetJobStatus(jobId=<uuid>,waitMs=25000)   # answers when the job is confirmed, failed or cancelled
POST /odata/v4/cardano-worker/CancelJob        # pending jobs only
GET  /odata/v4/cardano-worker/GetWorkerStatus()            # running, wallets, executing, awaitingConfirmation, pendingJobs
POST /odata/v4/cardano-worker/PauseWorker      # Admin
POST /odata/v4/cardano-worker/ResumeWorker     # Admin
```

**Job states:** `pending → building → submitting → submitted → confirmed`. A job can also end as `failed`,
with `errorCode` set, or as `cancelled`.

- A failure that may pass, such as a provider outage, a rate limit or an HSM hiccup, is retried with
  growing delays up to `maxAttempts`.
- A rejection that will not pass, such as a validation error or insufficient funds, fails the job at once.
- After a chain rollback the worker submits the same signed CBOR again. It never rebuilds, so a payment
  cannot happen twice.

**`idempotencyKey`:**

- A key is scoped to the user who queues the job and holds across all wallets and kinds: the same key on
  another wallet or kind is 409 `ODATANO_IDEMPOTENCY_KEY_CONFLICT`.
- A key belongs to one job at a time. A unique constraint in the database enforces it. Two retries that
  arrive at the same moment on two instances still produce one job. The second caller gets the first job's
  `jobId` with `deduplicated: true`.
- A job that fails before its transaction is sent, and a `cancelled` job, release the key. The next retry
  runs again.
- A `confirmed` job keeps the key. A late duplicate gets the completed job, not a second payment.
- A job that fails after its transaction may have been sent (`TX_DROPPED`, `SUBMIT_REJECTED`) keeps the key
  as well: the signed bytes exist and could still reach the chain. A retry with that key returns the failed
  job. To pay again, queue a new job with a new key.
- The same key with a different request is refused with 409 `ODATANO_IDEMPOTENCY_KEY_CONFLICT`. The
  comparison ignores the order of JSON keys.

**`submitting`** guards against a double payment:

- The signed transaction and its hash are written to the job row before the transaction goes to a backend.
- After a crash or a submit without a clear answer, the row stays `submitting`. It keeps the
  `idempotencyKey`, so a retry gets the same job, and it blocks the queue of the wallet.
- The worker resolves it by submitting the same bytes again, and reads the chain.
- The job fails only with proof that the transaction can never land, the same rule as
  [What a failed submit means](TRANSACTION_WORKFLOW.md#what-a-failed-submit-means):
  `SUBMIT_REJECTED` for a refusal that holds for the bytes, `TX_DROPPED` for an expired transaction with
  an input still unspent, `SCRIPT_FAILED` for a transaction that landed with failing scripts. It keeps its
  key in every case.
- Past the rollback horizon with every input spent and nothing showing whether by this transaction, the job
  is `unresolved` (`OUTCOME_UNRESOLVED`). It keeps its key, the worker stops reading and sending it, and the
  wallet queue goes on. `jobUnresolved` is emitted, and `GetWorkerStatus().unresolvedJobs` counts such jobs.
  An Admin decides it with `ResolveJob(jobId, outcome, txHash?, note?)`: `confirmed`, or `failed`
  (`RESOLVED_FAILED`). The job's submission record follows. `failed` is refused with 409
  `ODATANO_OUTCOME_STILL_OPEN` while the bytes have not expired and every input of them is unspent: a landing
  spends every input, so one spent input already rules it out.
- A job stored by an earlier version may hold a transaction without an expiry. It can land as long as every
  input is unspent. After 24 hours plus the horizon the worker ends it: it sends a self-transfer, with an
  expiry, that spends one of those inputs the wallet holds, alone where that input pays for it. The stored
  self-transfer is sent again after 1, 2, 4 and up to 30 minutes until it lands. Once it is k blocks deep, the
  job fails as `INVALIDATED`. The self-transfer is on the job (`invalidationTxHash`, also in `GetJobStatus`);
  one that can no longer land is replaced. When the wallet cannot fund it, the worker tries again hourly.
- Such a job whose transaction spends no UTxO of the wallet stays open, since it can still land, but no
  longer holds the wallet queue (`spendsNoWalletUtxo`).
- When some inputs of such a transaction are spent and others not, past the horizon, it never lands: the job
  fails as `TX_DROPPED`.
- A submitted job that stays unseen past `confirmationTimeoutMs` is sent again with the same bytes, after
  1, 2, 4 and up to 30 minutes.
- A job that sits in `submitting` while a backend is unreachable is waiting for an answer that is safe to
  act on.

**Operations:**

- Job state lives in the database (`CardanoWalletJobs`).
- Several instances coordinate through a lease per wallet. A heartbeat holds it while a job runs, and it is
  checked again right before the transaction is sent. One instance at a time spends a wallet, however long
  a build takes. Rolling deployments are safe.
- Confirmations come from the crawler's block feed when the crawler is on, and from polling otherwise.
  The poll asks the local index and the backends' transaction lookup. With Ogmios alone, a job is on chain
  once one of its own outputs is seen unspent; the depth counts from that tip. Inputs that are spent alone
  never confirm a job. If every output is spent before one was seen, the job stays `submitted` until the
  expiry proof or the unresolved bound ends it.
- Every instance follows the submitted jobs of the wallets it signs for, also those another instance sent.
- Before it sends, the worker checks its own signature against the wallet key and the required signers.
- `PauseWorker`, `ResumeWorker` and the crawler actions need the `Admin` role.

**Authorization:**

- `SubmitWalletJob` needs the `Transact` role.
- A job for a wallet with `signerType: "hsm"` also needs the role in `HSM_REQUIRES_ROLE`
  (`hsm.requiresRole`), the same gate as `SignWithHsm`. Without it the answer is 403.
- A wallet entry may carry `requiresRole`. Then only callers with that role can queue jobs for the wallet,
  403 otherwise. An HSM wallet needs both roles.
- A software wallet without `requiresRole` accepts jobs from every user with `Transact`. Set it wherever
  more than the operator can log in.
- `WorkerWallets` shows the role of each wallet.

---

## Agent Grants (opt-in)

An agent grant is a token `odat_…` with an allow list of actions, a daily budget and an expiry. An agent
sends it in the `x-agent-token` header in place of a user login. The request runs as `agent:<grantId>` with
the roles `agent-grant`, `Read`, `Transact` and `Sign`, never `Admin`, so every `Admin` gate refuses it.
[Agent tokens](SECURITY_GUIDE.md#agent-tokens) in the Security Guide has the rules.

**Enable it** with the environment, or with `agentGrants` in `cds.requires.odatano-core`:

| Variable | Key | Default | Purpose |
|---|---|---|---|
| `AGENT_GRANTS_ENABLED` | `enabled` | `false` | Turns the token check on. While it is off, every call of `CardanoAgentService` answers 400 |
| `AGENT_GRANTS_DELEGATE` | `delegate` | the configured auth kind | CAP auth kind that keeps authenticating requests without a token |
| `AGENT_GRANT_ADMIN_RATE_LIMIT` | `adminRateLimit` | `10` | Administration calls per principal per hour, then 429 |
| `AGENT_TOKEN_CACHE_MS` | `tokenCacheMs` | `10000` | How long a resolved token is reused before its row is read again; `0` turns the cache off |
| `AGENT_GRANT_USAGE_RETENTION_DAYS` | `usageRetentionDays` | `400` | Usage counters older than this are deleted once a day; `0` keeps all |

**Calls** at `/odata/v4/cardano-agent/`:

| Call | Caller | Effect |
|---|---|---|
| `CreateAgentGrant` | Admin | Issues a grant. The answer carries the token once; the server stores only its SHA-256 |
| `UpdateAgentGrant` | Admin | Changes label, allow list, daily budget or expiry. A parameter left out stays as it is. `null` clears the label, the budget or the expiry; the allow list cannot be emptied |
| `RotateAgentGrantToken` | Admin | Returns a new token once. The old one is unknown from the next request on this process, on another replica after at most `AGENT_TOKEN_CACHE_MS` |
| `RevokeAgentGrant` | Admin | The token is unknown from the next request, with the same cache delay on another replica |
| `GetGrantStatus()` | the token | What the grant allows and how much of today's budget is left |
| `GetGrantUsage(grantId, since, until)` | Admin, or the token for its own grant | Admitted calls per service and action, over at most 366 days |

The four Admin calls share the hourly limit. `UpdateAgentGrant` and `RotateAgentGrantToken` answer 409
`GRANT_REVOKED` for a revoked grant.

**What a token may call.** Reads and compute-only actions are always allowed. An action on the allow list
costs one unit of the budget per UTC day. Everything else is a 403.

- Allow-list entries name `Service.operation`, for example `CardanoTransactionService.SubmitTransaction`.
  A name without a service in a new grant means the transaction or sign service, never
  `CardanoBackendService`. Answers list the qualified names.
- Grants stored by rc.50 keep their meaning: the upgrade qualifies their lists, and a stored
  `SubmitTransaction` covers the transaction and the backend service.
- A grant can allow: the `Build*` actions, `SetCollateral`, `CreateSigningRequest`, `VerifySignature`,
  `SubmitTransaction`, `SubmitSignedTransaction`, `SubmitVerifiedTransaction`, `CheckSubmissionStatus`,
  and `CardanoBackendService.SubmitTransaction`.
- A grant can never allow: the HSM actions, the wallet worker, pausing and resuming the crawler or the
  worker, grant administration.

An agent signs its transactions itself. The wallet worker signs with keys the server holds and answers every
token request with 403.

**From code.** A package that issues grants itself, for example against a payment, imports
`issueAgentGrant()`, `updateAgentGrant()`, `rotateAgentGrantToken()`, `revokeAgentGrantById()`,
`getGrantUsage()` and `registerTransportLane()` from `@odatano/core`.

---

## Events

The indexer and the worker publish CAP events. A CAP application that loads ODATANO as a plugin runs in the
same process. It subscribes without a message broker and without `cds.requires.messaging`:

```js
const indexer = await cds.connect.to('CardanoIndexerService');
indexer.on('blockIndexed', ({ data }) => {
  // data: { hash, slot, height, txHashes[], tipSlot, tipHeight }
});
indexer.on('reorg', ({ data }) => {
  // data: { forkSlot, forkHeight, blocksRolledBack } — everything above forkSlot is gone
});

const worker = await cds.connect.to('CardanoWorkerService');
worker.on('jobConfirmed', ({ data }) => {
  // data: { jobId, walletId, kind, txHash }
});
worker.on('jobFailed', ({ data }) => {
  // data: { jobId, walletId, kind, txHash, errorCode, errorMessage }
});
worker.on('jobUnresolved', ({ data }) => {
  // data: { jobId, walletId, kind, txHash, errorMessage }; ResolveJob decides it
});
```

- `jobConfirmed`, `jobFailed` and `jobUnresolved` fire once per job, on its outcome. They replace a
  `GetJobStatus` poll loop. After `ResolveJob`, `jobConfirmed` or `jobFailed` follows.
- Over HTTP the same is `GetJobStatus` with `waitMs`, at most 30000. The call answers when the job is
  confirmed, failed, cancelled or unresolved, or after that time with the state the job then has. Keep `waitMs` below
  the timeout of the proxies in front of the service.
- `blockIndexed` fires for every crawled block. Treat it as a stream.

Three guarantees:

- **After the commit.** When an event arrives, its data is readable: the job row shows `confirmed`, the
  block can be queried.
- **A failing subscriber affects no one else.** A subscriber that throws or hangs is logged and ignored. It
  cannot stall the crawl or a wallet job.
- **No retry, no storage.** An event is sent once, in the process. For at-least-once delivery across
  processes configure a CAP messaging service. The same events then go through it and its outbox.

Events do not appear in `$metadata`, because OData V4 has no events. HTTP clients see no change.

---

## Further Reading

- [Quick Start](../QUICK_START.md): setup and first requests
- [Transaction Workflow](TRANSACTION_WORKFLOW.md): build, sign, submit
- [Crawler Guide](CRAWLER_GUIDE.md): the chain crawler, its backfills and the UTxO set
- [Backend Configuration](BACKEND_CONFIGURATION.md): which backend answers which call
- [Security Guide](SECURITY_GUIDE.md): authentication, roles, HSM
- [Upgrading to 2.0](UPGRADE_2.0.md): what a 1.x deployment and its clients change
- [Developer Guide](DEVELOPER_GUIDE.md): architecture and development
- [Concepts](../concepts%20&%20architecture/): indexing, error handling, data model
- [Test documentation](../../test/README.md): unit and integration tests
- [GitHub Issues](https://github.com/ODATANO/ODATANO/issues)
- Backends: [Blockfrost](https://docs.blockfrost.io/), [Koios](https://koios.rest/)
- [Cardano documentation](https://docs.cardano.org/)
