# Transaction Workflow Guide

**Version:** v2.0.0-rc.x

How to build, sign and submit a Cardano transaction through the ODATANO API.

---

## Table of Contents

1. [Overview](#overview)
2. [Workflow Steps](#workflow-steps)
3. [Signing Methods](#signing-methods)
4. [HSM Signing](#hsm-signing)
5. [Transaction Types](#transaction-types)
6. [API Reference](#api-reference)
7. [Error Handling](#error-handling)
8. [Troubleshooting](#troubleshooting)
9. [Examples](#examples)

---

## Overview

A transaction takes three steps: build, sign, submit.

![Transaction flow](<../assets/architecture & flow diagramms/tx-flow-ad.png>)

- The server builds the unsigned transaction and submits the signed one.
- Signing happens outside the server: with the Cardano CLI, a browser wallet or a hardware wallet. In this
  flow the server holds no private key. With an HSM the server signs, and the key stays in the HSM.
- Every build, signing request and submission is stored: `TransactionBuilds`, `SigningRequests`,
  `TransactionSubmissions`.
- Buildooor builds the transactions.

Every request needs a login. The transaction service asks for the role `Transact`, the signing service
for `Sign`. In development add `-u alice:` to a `curl` call.

---

## Workflow Steps

### Step 1: Build Unsigned Transaction

**POST** `/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`

```json
{
  "senderAddress": "addr_test1vqm5vyp8...",
  "recipientAddress": "addr_test1qrgfq5j...",
  "lovelaceAmount": 10000000
}
```

The server reads the protocol parameters and the sender's UTxOs, selects inputs, calculates the fee and
adds the change output.

The answer carries `unsignedTxCbor`, `txBodyHash`, `fee` and the build `id`. Pass the `id` as `buildId` in
the later steps. The selected inputs and the outputs are stored with the build.

### Step 2: Sign Transaction (External)

The server does not take part in this step.

#### Cardano CLI

```bash
echo '{ "type": "Unwitnessed Tx ConwayEra", "description": "", "cborHex": "84a50081..." }' > unsigned.tx

cardano-cli conway transaction sign \
  --tx-body-file unsigned.tx \
  --signing-key-file payment.skey \
  --testnet-magic 2 \
  --out-file signed.tx

jq -r '.cborHex' signed.tx
```

`--testnet-magic 2` is Preview, `--testnet-magic 1` is Preprod, `--mainnet` is mainnet. A signing request
carries the commands for its transaction in `cardanoCliCommand`.

#### Browser Wallet (CIP-30)

```javascript
const api = await window.cardano.nami.enable();
// CIP-30 returns only the witness set, not the signed transaction
const witnessSetCbor = await api.signTx(unsignedTxCbor, true);
```

Pass `witnessSetCbor` as `signedTxCbor` in Step 3. ODATANO adds the witness set to the build's transaction
before it submits. `VerifySignature` and `SubmitVerifiedTransaction` accept it the same way.

#### Hardware Wallet (Ledger/Trezor)

A hardware wallet signs through a browser wallet extension, with the same CIP-30 call.

### Step 3: Submit Signed Transaction

**POST** `/odata/v4/cardano-transaction/SubmitTransaction`

```json
{
  "buildId": "a8f4c3b2-1e5d-4f9a-b7c6-2d8e9f1a3b4c",
  "signedTxCbor": "84a5008182582071f3d8c1b2..."
}
```

`signedTxCbor` is the full signed transaction (cardano-cli, HSM) or the witness set from a CIP-30 wallet.

The answer is the `TransactionSubmissions` row with `txHash`, `status` and `submittedAt`. The transaction
goes to Ogmios first, then to the configured providers (Koios, Blockfrost). A refusal by the node is final.

---

## Signing Methods

| Method | Key location | Typical use |
|--------|--------------|-------------|
| Cardano CLI | Key file (`.skey`) | Backend automation |
| Browser wallet (CIP-30) | Browser extension | Web applications, Fiori |
| Hardware wallet | Device | High-value transactions |
| HSM (PKCS#11) | HSM | Server-side signing |

---

## HSM Signing

With an HSM configured the server signs. The private key stays in the HSM.

- **External:** build → `CreateSigningRequest` → sign → `SubmitVerifiedTransaction`
- **HSM:** build → `SignAndSubmitWithHsm`

### HSM Actions

| Action | Description |
|--------|-------------|
| `GetHsmStatus` | Connection, key and the Cardano address derived from the key |
| `SignWithHsm` | Signs a build and stores the signing request. Does not submit |
| `SignAndSubmitWithHsm` | Signs a build and submits it |

### Configuration

```bash
HSM_ENABLED=true
HSM_PKCS11_MODULE=/usr/lib/pkcs11/yubihsm_pkcs11.so
HSM_SLOT=0
HSM_PIN=                      # Set via credential store in production
HSM_KEY_LABEL=cardano-signing-key
HSM_REQUIRES_ROLE=HsmSigner   # REQUIRED: startup fails without it
```

`HSM_REQUIRES_ROLE` is required with `HSM_ENABLED=true`. Without it the service does not initialize and
answers 503. It names the role a caller needs, on top of the role of the service, for `GetHsmStatus`,
`SignWithHsm`, `SignAndSubmitWithHsm` and for `SubmitWalletJob` on an HSM wallet.

- A caller without the role gets **403 `ODATANO_FORBIDDEN`**, with the message
  `[ODATANO_FORBIDDEN] <Action>: …`.
- Without a connected HSM, `SignWithHsm` and `SignAndSubmitWithHsm` answer **503
  `ODATANO_HSM_NOT_CONFIGURED`**.
- The HSM signs only a build whose change goes back to the HSM address. The build row, its stored change
  outputs and the unsigned body are checked; any other build is a 400.

### Example

```typescript
// 1. Check HSM status
const status = await POST('/odata/v4/cardano-sign/GetHsmStatus', {});
// → { connected: true, cardanoAddress: "addr_test1...", publicKeyHash: "a1b2..." }

// 2. Build transaction (use HSM address as sender)
const build = await POST('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
  senderAddress: status.cardanoAddress,
  recipientAddress: 'addr_test1...',
  lovelaceAmount: '5000000',
});

// 3. Sign + submit
const submission = await POST('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
  buildId: build.id,
});
// → { txHash: "abc123...", status: "submitted" }
```

The [Security Guide](SECURITY_GUIDE.md#hsm-pkcs11-integration) has the settings and a
check of the module.

---

## Transaction Types

### Simple ADA Transfer

`BuildSimpleAdaTransaction` sends lovelace from one address to another.

- `assetsJson` adds native tokens.
- `outputDatumJson` or `outputDatumCbor` puts an inline datum on the output. A script address needs one.

### Transaction with Metadata

`BuildTransactionWithMetadata` is an ADA transfer with transaction metadata, for example a CIP-20 message
for an invoice or a receipt.

### Multi-Asset Transfer

`BuildMultiAssetTransaction` sends ADA and native tokens. `outputDatumJson` or `outputDatumCbor` puts an
inline datum on the output.

### Token Minting

`BuildMintTransaction` mints or burns native tokens.

- `scriptParamsJson` applies parameters to a parameterized policy.
- `mintRedeemerJson` sets the redeemer.
- `inlineDatumJson` puts a datum on the output that receives the tokens.
- `lockOnScript` together with `scriptParamsJson` sends that output to the script address.
- `requiredSignersJson` fills the `extra_signatories` a Plutus script checks.

### Plutus Smart Contract Spending

`BuildPlutusSpendTransaction` spends a UTxO at a Plutus script address.

- `inlineDatumJson` puts a datum on the continuing output, as a state machine needs it.
- `lockOnScript` together with `scriptParamsJson` sends the output back to the script address.
- `requiredSignersJson` fills `extra_signatories`.

**Plutus workflow:**
```
1. Lock:  BuildSimpleAdaTransaction (outputDatumJson, recipient = script address) → Sign → Submit
          or BuildMintTransaction (lockOnScript + scriptParamsJson + inlineDatumJson) → Sign → Submit
2. Spend: BuildPlutusSpendTransaction (validatorScript + redeemerJson + script UTxO) → Sign → Submit
```

### Several Script Inputs

`BuildPlutusTransaction` spends several script UTxOs in one transaction, each with its own redeemer. An
example is a batcher that fills orders against a state UTxO.

- A script input carries its validator inline, or points at a UTxO that holds it as a reference script.
- The outputs are built in the given order with their datums. The change comes after them.
- The answer lists the execution units of every redeemer under `redeemers`.

**Withdrawals (`withdrawalsJson`)**

- With a staking script, inline or by reference, the script runs under the Reward purpose. Withdraw-zero
  oracles and shared validators are consumed this way.
- Without a script the stake key signs.
- The reward account must be registered on chain, otherwise the build is refused.
- The node confirms a registration only for a credential that is delegated to a pool or a DRep. For any
  other credential Blockfrost and Koios answer from the certificate history; the first that knows the
  account decides. With Ogmios alone the build goes on and the node decides at submit.

**Certificates (`certificatesJson`)**

- They register or deregister a stake credential, in the same transaction as a withdrawal if needed.
- A registration without a script is the legacy certificate. It needs no witness, also for a script
  credential.
- A registration with a script is the Conway deposit certificate. The script runs under the Certifying
  purpose.
- The builder balances the deposit.

**Inputs of another party (`forceInputsJson`)**

`forceInputsJson` may name UTxOs of other key addresses, for a purchase that a third party funds in the same
transaction.

- Each such address needs its payment key hash in `requiredSignersJson`.
- `outputsJson` must spend every unit these UTxOs bring. The sender's change never carries it.
- Such a UTxO is never used as collateral.
- Each party adds its witness to the same `unsignedTxCbor`.

`protectInputsJson` keeps named sender UTxOs out of coin selection and collateral. `BuildSimpleAdaTransaction`,
`BuildMintTransaction`, `BuildPlutusSpendTransaction` and `BuildPlutusTransaction` take it.

### Collateral Setup

`SetCollateral` makes sure an address has a collateral UTxO for Plutus transactions.

- The address has one when it holds an ADA-only UTxO of at least 5 ADA without a reference script, and one
  more UTxO to fund with. The builder takes no other kind as collateral. The answer is then **200** with
  `collateralAvailable: true`, and nothing is built.
- Otherwise the action builds a transaction that sends 5 ADA to the address itself. Sign and submit it.
- The answer is 400 when the address holds less than 6 ADA in total: 5 ADA collateral and 1 ADA for the fee.

---

## API Reference

### BuildSimpleAdaTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Source address |
| recipientAddress | bech32 | Yes | Recipient address |
| lovelaceAmount | Integer | Yes | Amount in lovelace (1 ADA = 1,000,000) |
| changeAddress | bech32 | No | Change address (defaults to sender) |
| outputDatumJson | String | No | Inline datum for recipient output (PlutusData JSON) |
| outputDatumCbor | String | No | Inline datum as PlutusData CBOR hex, written byte for byte; excludes `outputDatumJson` |
| ensureMinAda | Boolean | No | Raise `lovelaceAmount` to the output min-ADA instead of rejecting it |
| assetsJson | String | No | Native assets: `[{"unit":"policyId+name","quantity":"amt"}]` |
| forceInputsJson | String | No | `[{txHash, outputIndex}]` UTxOs that must be consumed |
| protectInputsJson | String | No | `[{txHash, outputIndex}]` sender UTxOs that must never be spent |
| lockOnScript | Boolean | No | Send the output to the script address of `validatorScript` instead of `recipientAddress` |
| validatorScript | String | No | Plutus validator CBOR hex. Required with `lockOnScript`; only the address is derived from it |
| scriptParamsJson | String | No | PlutusData parameters applied to `validatorScript` before the address is derived |
| referenceScriptHex | String | No | Plutus V3 script CBOR hex to store on the output as reference script. Raises the output min-ADA |
| validityStartMs / validityEndMs | String | No | Validity interval in Posix ms; the end defaults to now + 3 600 000 and may be at most 24 h ahead |

Returns `scriptHash` and `scriptAddress` with `lockOnScript`.

### BuildTransactionWithMetadata

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Source address |
| recipientAddress | bech32 | Yes | Recipient address |
| lovelaceAmount | Integer | Yes | Amount in lovelace |
| metadataJson | String | Yes | Transaction metadata (JSON) |
| changeAddress | bech32 | No | Change address |

### BuildMultiAssetTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Source address |
| recipientAddress | bech32 | Yes | Recipient address |
| lovelaceAmount | Integer | Yes | Amount in lovelace |
| assetsJson | String | Yes | Assets: `[{"unit":"policyId+name","quantity":"amt"}]` |
| changeAddress | bech32 | No | Change address |
| outputDatumJson | String | No | Inline datum for recipient output |
| outputDatumCbor | String | No | Inline datum as PlutusData CBOR hex, written byte for byte; excludes `outputDatumJson` |
| ensureMinAda | Boolean | No | Raise `lovelaceAmount` to the output min-ADA instead of rejecting it |
| referenceScriptHex | String | No | Plutus V3 script CBOR hex to store on the output as reference script. Raises the output min-ADA |
| validityStartMs / validityEndMs | String | No | Validity interval in Posix ms; the end defaults to now + 3 600 000 and may be at most 24 h ahead |

### BuildMintTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Sender (pays fees) |
| recipientAddress | bech32 | Yes | Recipient (overridden when `lockOnScript=true`) |
| lovelaceAmount | Integer | Yes | Lovelace with minted assets |
| mintActionsJson | String | Yes | Mint actions: `[{"assetUnit":"policyId+name","quantity":"amt"}]`. An action may carry its own `mintingPolicyScript` and `redeemerJson` |
| mintingPolicyScript | String | Yes | Minting policy CBOR hex, for the actions without their own |
| changeAddress | bech32 | No | Change address |
| requiredSignersJson | String | No | Ed25519 key hashes for `extra_signatories` |
| scriptParamsJson | String | No | PlutusData params for parameterized validators |
| inlineDatumJson | String | No | Inline datum on recipient output |
| mintRedeemerJson | String | No | Minting redeemer (defaults to integer 0) |
| lockOnScript | Boolean | No | Route output to derived script address; needs `scriptParamsJson` |
| forceInputsJson | String | No | `[{txHash, outputIndex}]` UTxOs that must be consumed |
| protectInputsJson | String | No | `[{txHash, outputIndex}]` sender UTxOs that must never be spent |
| referenceInputsJson | String | No | `[{txHash, outputIndex}]` read-only reference inputs |
| extraOutputsJson | String | No | Further outputs `[{address, lovelaceAmount, assets?, inlineDatumJson?, referenceScriptHex?}]`. With them the minted assets go where the entries put them and the first output stays ADA-only |
| metadataJson | String | No | Transaction metadata (JSON), an object keyed by label |
| referenceScriptHex | String | No | Plutus V3 script CBOR hex to store on the recipient output as reference script |
| validityStartMs / validityEndMs | String | No | Validity interval in Posix ms; defaults to now − 120 000 and now + 3 600 000; the end may be at most 24 h ahead |

Returns `scriptHash`, `fingerprint`, `scriptAddress` when applicable.

`assetUnit` takes one of two forms:

- The full `policyId+assetName` hex. Its first 56 hex characters must be the script hash of the minting
  policy, otherwise the request is rejected with 400.
- With `scriptParamsJson`: a bare asset name of at most 28 bytes (56 hex). ODATANO puts the policy id of the
  applied script in front.

An asset name longer than 28 bytes cannot be told from a full unit by its length. Pass it as a full unit.

### BuildPlutusSpendTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Sender (pays fees) |
| recipientAddress | bech32 | Yes | Recipient (overridden when `lockOnScript=true`) |
| lovelaceAmount | Integer | Yes | Lovelace to send |
| validatorScript | String | Yes | Plutus validator CBOR hex |
| scriptTxHash | String | Yes | UTxO tx hash at script address (64-char hex) |
| scriptOutputIndex | Integer | Yes | UTxO output index |
| redeemerJson | String | Yes | Redeemer PlutusData JSON |
| datumJson | String | No | Input datum (for hash-based datums) |
| changeAddress | bech32 | No | Change address |
| requiredSignersJson | String | No | Ed25519 key hashes for `extra_signatories` |
| scriptParamsJson | String | No | PlutusData params for parameterized validators |
| inlineDatumJson | String | No | Inline datum on continuing output |
| lockOnScript | Boolean | No | Re-lock at derived script address; needs `scriptParamsJson` |
| forceInputsJson | String | No | `[{txHash, outputIndex}]` UTxOs that must be consumed |
| protectInputsJson | String | No | `[{txHash, outputIndex}]` sender UTxOs that must never be spent |
| extraOutputsJson | String | No | Further outputs `[{address, lovelaceAmount, assets?, inlineDatumJson?, referenceScriptHex?}]` after the recipient output |
| mintActionsJson | String | No | Mint actions for a spend and a mint in one transaction. Needs `mintingPolicyScript` |
| mintingPolicyScript | String | No | Minting policy CBOR hex. Required with `mintActionsJson` |
| mintRedeemerJson | String | No | Minting redeemer (defaults to integer 0) |
| referenceInputsJson | String | No | `[{txHash, outputIndex}]` read-only reference inputs |
| referenceScriptHex | String | No | Plutus V3 script CBOR hex to store on the recipient output as reference script |
| validityStartMs / validityEndMs | String | No | Validity interval in Posix ms; defaults to now − 120 000 and now + 3 600 000; the end may be at most 24 h ahead |

Returns `scriptHash`, `scriptAddress` when applicable.

### BuildPlutusTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Pays the fee, funds the rest, provides the ADA-only collateral |
| scriptInputsJson | String | No | 0..16 script UTxOs, see below; without them a mint, a withdrawal or a certificate alone is built |
| outputsJson | String | Yes | Outputs in order: `{address, lovelaceAmount, assets?, inlineDatumJson? \| inlineDatumCbor? \| datumHash?, referenceScriptHex?}` |
| changeAddress | bech32 | No | Change address (defaults to senderAddress) |
| referenceInputsJson | String | No | `[{txHash, outputIndex}]` read-only inputs; reference-script UTxOs are added automatically |
| forceInputsJson | String | No | UTxOs that must be consumed; another key address's UTxO needs its key hash in `requiredSignersJson` and its value spent by `outputsJson` |
| protectInputsJson | String | No | Sender UTxOs that must never be spent |
| withdrawalsJson | String | No | 1..16 withdrawals: `{rewardAddress, lovelace, stakingScript? \| referenceScript?, scriptParamsJson?, redeemerJson? \| redeemerCbor?}` |
| certificatesJson | String | No | 1..16 certificates: `{type: registerStake \| deregisterStake, stakeAddress, deposit?, stakingScript? \| referenceScript?, scriptParamsJson?, redeemerJson? \| redeemerCbor?}` |
| requiredSignersJson | String | No | Ed25519 key hashes for `extra_signatories` |
| mintActionsJson | String | No | `[{assetUnit, quantity, mintingPolicyScript? \| referenceScript?, redeemerJson?}]`, a policy per action; with `referenceScript` the `assetUnit` is policyId+assetName |
| validityStartMs / validityEndMs | String | No | Validity interval in Posix ms; defaults to now − 120 000 and now + 3 600 000; the end may be at most 24 h ahead |

A `scriptInputsJson` entry:

```json
{ "txHash": "…", "outputIndex": 0,
  "validatorScript": "<cbor hex>", "scriptParamsJson": "[…]",
  "redeemerJson": "{\"constructor\":0,\"fields\":[]}", "datumJson": null }
```

- `"referenceScript": {"txHash": "…", "outputIndex": 0}` replaces `validatorScript` when the validator sits
  in a reference-script UTxO.
- `datumJson` is for hash datums only. An inline datum is read from the UTxO.
- `redeemerCbor`, `datumCbor` and an output's `inlineDatumCbor` take PlutusData as CBOR hex in place of
  JSON. The bytes go into the transaction unchanged, so placeholders do not work there.
- PlutusData JSON may nest up to 64 levels, every other JSON parameter up to 10. A parameter may be 1 MB long.

**Index placeholders.** A redeemer or an output datum may name an index that is fixed only in the final
transaction. The placeholder is the whole value of an `int` field:

| Placeholder | Resolves to |
|-------------|-------------|
| `__INPUT_IDX:<txHash>#<n>__` | index of the input in the final sorted inputs |
| `__REF_IDX:<txHash>#<n>__` | index of the reference input in the sorted reference inputs, reference-script UTxOs included |
| `__WDRL_IDX:<credential hash>__` | index of the withdrawal of that stake credential, script credentials first, then by hash |

- A placeholder that names a UTxO or a credential the transaction does not carry is a 400.
- Buildooor numbers withdrawal redeemers by hash only. A key-credential withdrawal that sorts before a
  scripted one by hash is therefore refused with 400.
- Reference-script bytes come from Ogmios or Koios. With Blockfrost alone a reference script cannot be used.

**Answer and errors.** The answer lists `redeemers` (`tag`, `redeemerIndex`, `mem`, `steps`), as stored in
`TransactionBuildRedeemers`. A 400 names the cause:

- an output below min-ADA
- the redeemer whose evaluation failed
- a missing collateral; create one with `SetCollateral`
- a transaction above `maxTxSize`

A change output below min-ADA is reported as too little funding, not as an output to raise.

**Collateral.**

- Collateral is added only when a script runs. A build whose withdrawals and certificates all use key
  credentials carries none.
- When the other sender UTxOs cannot pay the outputs, the fee and the change, the collateral UTxO is also
  spent as an input. The ledger allows one UTxO as input and as collateral.
- A UTxO named in `forceInputsJson` is the collateral when no other sender UTxO qualifies. It must belong
  to the sender, be ADA-only, carry no reference script and hold at least 5 ADA. A wallet with a single UTxO
  can then build a mint whose redeemer names that UTxO.
- The same holds for `BuildMintTransaction` and `BuildPlutusSpendTransaction`.

**Sender UTxOs with a reference script.**

- They stay out of coin selection as long as the other UTxOs cover the build. Only when those run short
  does the builder select from them. It also spends one that `forceInputsJson` names.
- Spending such a UTxO costs the Conway reference-script fee (`minFeeRefScriptCostPerByte`): 15 lovelace
  per byte on all networks, 1.2 times more for every 25 600 bytes in one transaction. The fee counts the
  scripts of all inputs and reference inputs.
- The builder prices it from the script bytes when the source delivers them (Ogmios, Koios), or from the
  stored script size (crawled UTxO set).
- A UTxO known by its script hash alone cannot be priced. The log notes it, and the node may reject the
  transaction as underpaid.

### SetCollateral

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| address | bech32 | Yes | Address to set up collateral for |

Returns 200 with an unsigned build, or with `collateralAvailable: true` when the address already holds an
ADA-only UTxO of >= 5 ADA without a reference script and one more UTxO. Returns 400 when the address holds
no UTxO or less than 6 ADA in total.

### SubmitTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| buildId | UUID | Yes | Build ID from a build action |
| signedTxCbor | String | Yes | Signed transaction CBOR hex, or the witness set of a CIP-30 wallet |

### SubmitSignedTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| signedTxCbor | String | Yes | Fully signed transaction CBOR hex |
| network | String | No | `mainnet`, `preview` or `preprod`. A value that differs from the network of the server is a 400 |

For a transaction that was not built by ODATANO. It must carry an expiry (TTL) at most 24 hours ahead;
without one, or with a later one, the answer is 400 and nothing is sent.

---

## Error Handling

| Error Code | HTTP | Cause | Resolution |
|------------|------|-------|------------|
| `ODATANO_INSUFFICIENT_FUNDS` | 400 | The sender does not hold enough ADA | Fund the address or lower the amount |
| `ODATANO_INVALID_INPUT` | 400 | Malformed address, invalid amount, missing field | Check the bech32 format and the required parameters |
| `ODATANO_TX_VALIDATION_FAILED` | 400 | Wrong signing key, changed CBOR, or a datum or redeemer that is not valid PlutusData | Check the key and the JSON; build again if the transaction was changed |
| `ODATANO_PROVIDER_UNAVAILABLE` | 503 | All backends unreachable or timed out | Retry later, check the configured backends |
| `ODATANO_TX_ALREADY_SUBMITTED` | 409 | The transaction is already on chain or in the mempool | Nothing to do; a repeated submit ends here |
| `ODATANO_SUBMIT_OUTCOME_UNKNOWN` | 503 | The submit got no verdict from the node (timeout, outage, rate limit) | Do not build a replacement. Read the status until it leaves `submitting` / `pending` |

### What a failed submit means

A submit can end in three ways, and the stored status says which:

| Outcome | Signing request | Submission | Response |
|---------|-----------------|------------|----------|
| The node accepted the transaction, or the chain already has it | `submitted` | `submitted` | 200, or 409 `ODATANO_TX_ALREADY_SUBMITTED` on `SubmitTransaction` / `SubmitSignedTransaction` |
| The transaction can never land | `failed`, with `errorMessage` | `failed`, with `errorMessage` | 400 with the reason |
| It landed with failing scripts: only its collateral was spent | `failed` | `failed` | 400 with the reason |
| No verdict | stays `submitting` | stays `pending` | 503 `ODATANO_SUBMIT_OUTCOME_UNKNOWN` |
| It can no longer land, and nothing shows whether it did | `unresolved` | `unresolved` | 503 `ODATANO_SUBMIT_OUTCOME_UNKNOWN` |

ODATANO sends only bytes that carry an expiry (TTL) at most 24 hours ahead, that have not expired and
that are not marked to fail their scripts (`isValid` false). `SubmitTransaction`, `SubmitSignedTransaction`,
`SubmitVerifiedTransaction` and `SignAndSubmitWithHsm` refuse other bytes with a 400. A transaction is valid
only while the slot is below its TTL. Every transaction ODATANO builds expires one hour ahead unless
`validityEndMs` says otherwise.

`failed` is a statement about the chain: this transaction can never land. It takes one of two proofs:

- The node refused it for a reason that holds for its bytes in any ledger state: missing or invalid
  signatures, metadata, the wrong network, no inputs, minted ada. Ogmios refusals are judged by their
  JSON-RPC code, Blockfrost and Koios refusals by the ledger failure they name.
- Its expiry has passed by the rollback horizon (3k/f slots: 36 hours on mainnet and preprod, 7.2 hours
  on preview) and one of its inputs is still unspent. A landed transaction spends all its inputs. The node
  answers this; an indexer counts only after 3600 more slots.

Every other refusal (spent inputs, fees, the validity interval, the value of the inputs) and every lookup
that finds nothing is no verdict. A transaction is on chain once the crawled chain inside its coverage,
a backend lookup or one of its own outputs shows it. A crawled row with only its collateral spent, or an
unspent collateral return, means it landed with failing scripts.

Past the horizon with every input spent and nothing showing whether by this transaction, the record is
`unresolved`. The server stops reading it, and an Admin decides it with `ResolveSigningRequest` or
`ResolveSubmission` (outcome `confirmed` or `failed`, an optional `txHash` check and a note kept in
`resolution`). `failed` is refused with 409 `ODATANO_OUTCOME_STILL_OPEN` while the bytes have not expired
and every input of them is unspent; one spent input already rules a landing out. A second resolve of the same record answers 409
`ODATANO_RESOLVED_CONCURRENTLY`.

A record stored by an earlier version may hold bytes without an expiry. Such bytes can land as long as
every input is unspent, so the server never decides them by time: after 24 hours plus the horizon it reads
them once an hour and logs the inputs that would end them. Spending one of those inputs ends such a
transaction: once some inputs are spent and others not past the horizon, it never lands and the record
fails.

Without a verdict the server keeps the signed transaction and resolves the record itself, at start and
every 60 seconds:

- For 10 minutes after the submit it sends the same transaction again, never past its expiry.
- After that it reads the chain until one of the proofs above holds or the transaction is found.

`recheckFailedSubmits` (Admin, on `CardanoIndexerService`) reads every `failed` submission, signing request
and wallet job failed as `TX_DROPPED` or `SUBMIT_REJECTED` again under these rules. One whose transaction is
on chain with passing scripts goes back to `submitted`, with a `resolution` note; a job then confirms by
depth. A found transaction whose script validity no source reports stays failed. Earlier versions marked
some landed transactions `failed`.

For the result, poll `GetSigningRequest` or read the `TransactionSubmissions` row of the transaction hash.

---

## Troubleshooting

### "All backends failed: Failed to acquire requested point"

The Ogmios node is not fully synchronized. Check `curl http://localhost:1337/health` and wait until
`networkSynchronization` is above 0.99.

### "Insufficient funds" but wallet has balance

The UTxOs are not confirmed yet, or a pending transaction spends them.

- Transactions submitted through this instance are tracked. Their inputs are not offered again and their
  change to the sender is, until a crawled block holds them, at most 10 minutes.
- Transactions submitted elsewhere are unknown until they are on chain. Wait one or two minutes.

### "Invalid signature" after signing

The signing key is wrong, or the unsigned transaction was changed. Check that the key belongs to the sender
address and that `--testnet-magic` matches the network. Build again if needed.

### "No ADA-only UTxO available for collateral"

A Plutus transaction needs collateral: an ADA-only UTxO of at least 5 ADA without a reference script, plus
another UTxO to fund with. `SetCollateral` creates one, or reports `collateralAvailable: true` when the
address has it. A sender UTxO named in `forceInputsJson` also serves as collateral when it is ADA-only, has
no reference script and holds at least 5 ADA.

---

## Examples

### Postman Collection
- [ODATANO Full Service Catalog](https://github.com/ODATANO/ODATANO/blob/main/scripts/postman/ODATANO%20M2%20-%20Full%20Service%20Catalog.postman_collection.json)

### TypeScript Scripts
- [Simple ADA Transfer](https://github.com/ODATANO/ODATANO/blob/main/scripts/testing/send-ada-preview.ts)
- [Metadata Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/testing/send-ada-with-metadata-preview.ts)
- [Minting Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/testing/mint-token-preview.ts)
- [Multi-Asset Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/testing/send-multi-asset-preview.ts)
- [Plutus Spend Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/testing/plutus-spend-preview.ts)
- [HSM Signing Example](https://github.com/ODATANO/ODATANO/blob/main/scripts/testing/send-ada-hsm-preview.ts)

---

## References

- [Cardano Transaction Specification](https://github.com/IntersectMBO/cardano-ledger)
- [Ogmios Documentation](https://ogmios.dev/)
- [Cardano CLI Reference](https://github.com/IntersectMBO/cardano-cli)
- [Buildooor TX Library](https://github.com/HarmonicLabs/buildooor)
- [Security Guide](SECURITY_GUIDE.md): signing security, HSM details, signature verification
