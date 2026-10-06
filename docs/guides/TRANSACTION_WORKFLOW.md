# Transaction Workflow Guide

**Version:** v2.0.0-rc.x | **Last Updated:** September 2026

This guide covers building, signing, and submitting Cardano transactions via the ODATANO API.

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

ODATANO follows a **Build → Sign → Submit** workflow with complete private key isolation:

![alt text](<../assets/architecture & flow diagramms/tx-flow-ad.png>)

- Server **never** sees private keys
- Signing is external (CLI, browser wallet, hardware wallet) or via HSM (key never leaves chip)
- Full audit trail via TransactionBuilds, SigningRequests, TransactionSubmissions entities
- Transaction builder: Buildooor (the sole builder; CSL was removed)

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

**Response** includes `unsignedTxCbor`, `txBodyHash`, `fee`, `inputs[]`, `outputs[]`, and a `buildId` for tracking.

The server fetches protocol parameters and UTxOs, selects inputs, calculates fees, creates change output, serializes to unsigned CBOR, and stores the build record.

### Step 2: Sign Transaction (External)

**The server never performs this step.** Private keys remain under client control.

#### Cardano CLI

```bash
echo '{ "type": "Tx ConwayEra", "description": "", "cborHex": "84a50081..." }' > unsigned.tx

cardano-cli conway transaction sign \
  --tx-body-file unsigned.tx \
  --signing-key-file payment.skey \
  --testnet-magic 2 \
  --out-file signed.tx

cat signed.tx | jq -r '.cborHex'
```

#### Browser Wallet (CIP-30)

```javascript
const api = await window.cardano.nami.enable();
// CIP-30 returns only the witness set, not the signed transaction
const witnessSetCbor = await api.signTx(unsignedTxCbor, true);
```

Pass `witnessSetCbor` as `signedTxCbor` in Step 3. ODATANO adds the witness set to the build's transaction
before it submits. `VerifySignature` and `SubmitVerifiedTransaction` accept it the same way.

#### Hardware Wallet (Ledger/Trezor)

Via browser extension integration (same CIP-30 API as above).

### Step 3: Submit Signed Transaction

**POST** `/odata/v4/cardano-transaction/SubmitTransaction`

`signedTxCbor` is either the full signed transaction (cardano-cli, HSM) or the witness set from a CIP-30 wallet.

```json
{
  "buildId": "a8f4c3b2-1e5d-4f9a-b7c6-2d8e9f1a3b4c",
  "signedTxCbor": "84a5008182582071f3d8c1b2..."
}
```

**Response** includes `txHash`, `status`, `submittedAt`, and `submittedToBackend`. Submission goes to Ogmios (primary), then Blockfrost/Koios as fallback.

---

## Signing Methods

| Method | Speed | Security | Key Location | Use Case |
|--------|-------|----------|-------------|----------|
| Cardano CLI | Medium | High | File system (`.skey`) | Backend automation |
| Browser Wallet (CIP-30) | Fast | Very High | Browser extension | Web dApps, Fiori |
| Hardware Wallet | Slow | Maximum | Dedicated device | High-value transactions |
| HSM (PKCS#11) | Fast | Maximum | HSM chip | Enterprise automation |

---

## HSM Signing

When an HSM is configured, ODATANO supports automated server-side signing. The private key never leaves the HSM chip.

### Workflow Comparison

**External (4 steps):** Build → CreateSigningRequest → Sign (client) → SubmitVerifiedTransaction

**HSM (2 steps):** Build → SignAndSubmitWithHsm

### HSM Actions

| Action | Description |
|--------|-------------|
| `GetHsmStatus` | Check HSM connection, key info, derived Cardano address |
| `SignWithHsm` | Sign a build (creates signing request + verification, no submit) |
| `SignAndSubmitWithHsm` | Sign + submit in one atomic step |

### Configuration

```bash
HSM_ENABLED=true
HSM_PKCS11_MODULE=/usr/lib/pkcs11/yubihsm_pkcs11.so
HSM_SLOT=0
HSM_PIN=                      # Set via credential store in production
HSM_KEY_LABEL=cardano-signing-key
HSM_REQUIRES_ROLE=HsmSigner   # REQUIRED: startup fails without it
```

`HSM_REQUIRES_ROLE` is mandatory whenever `HSM_ENABLED=true` — the server throws a
`ConfigError` at startup if it is missing. It names the role a caller must hold to use
any HSM signing path: `SignWithHsm`, `SignAndSubmitWithHsm`, and `SubmitWalletJob` for an
HSM-backed worker wallet. Callers without it get **403 `ODATANO_FORBIDDEN`**.

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

For HSM security details, supported hardware, and SoftHSM dev setup, see [Security Guide](SECURITY_GUIDE.md#hsm-pkcs11-integration).

---

## Transaction Types

### Simple ADA Transfer
**Action:** `BuildSimpleAdaTransaction` — Transfer lovelace between addresses. Supports `outputDatumJson` or `outputDatumCbor` for sending to script addresses and `assetsJson` for including native tokens.

### Transaction with Metadata
**Action:** `BuildTransactionWithMetadata` — ADA transfer with attached CIP-20 metadata (invoices, receipts, on-chain records).

### Multi-Asset Transfer
**Action:** `BuildMultiAssetTransaction` — Transfer ADA + native tokens. Supports `outputDatumJson` or `outputDatumCbor` for script address outputs.

### Token Minting
**Action:** `BuildMintTransaction` — Create native tokens. Supports `scriptParamsJson` for parameterized validators, `inlineDatumJson` for datum on minted output, `mintRedeemerJson` for custom redeemers, `lockOnScript` to route output to script address, and `requiredSignersJson` for Plutus `extra_signatories`.

### Plutus Smart Contract Spending
**Action:** `BuildPlutusSpendTransaction` — Spend UTxOs locked at Plutus script addresses. Supports `inlineDatumJson` for continuing output datum (state machines), `lockOnScript` to re-lock at script address, and `requiredSignersJson`.

**Plutus workflow:**
```
1. Lock:  BuildMintTransaction (lockOnScript + inlineDatumJson) → Sign → Submit
2. Spend: BuildPlutusSpendTransaction (validatorScript + redeemer + lockOnScript) → Sign → Submit
```

### Several Script Inputs
**Action:** `BuildPlutusTransaction` — Spend several script UTxOs in one transaction (for example a batcher filling
orders against a state UTxO), each with its own redeemer. A script input carries its validator inline or points
at a UTxO holding it as reference script. The outputs are built exactly in the given order with their datums,
change comes after them. Every redeemer's execution units come back under `redeemers`.

`withdrawalsJson` adds reward-account withdrawals: with a staking script (inline or by reference) the script runs
under the Reward purpose, which is how withdraw-zero oracles and shared validators are consumed; without a script
the stake key signs. The reward account must be registered on chain, otherwise the build is refused;
`certificatesJson` registers (or deregisters) the credential, in the same transaction if needed. A registration
without a script is the witness-free legacy certificate, also for a script credential; with a script it is the
Conway deposit certificate and the script runs under the Certifying purpose. The deposit is balanced by the builder.

`forceInputsJson` may name UTxOs of other key addresses, for a purchase that a third party funds in the same
transaction. Each such address must have its payment key hash in `requiredSignersJson`, every unit its UTxOs bring
must be spent by `outputsJson` (the sender's change never carries it), and it is never used as collateral. Each
party adds its witness to the same `unsignedTxCbor`. `protectInputsJson` keeps named sender UTxOs out of coin
selection and collateral on every build action.

### Collateral Setup
**Action:** `SetCollateral` — Creates a dedicated 5 ADA collateral UTxO for Plutus transactions. When the address already holds an ADA-only UTxO of >= 5 ADA without a reference script (the only kind the builders take as collateral) and at least one other UTxO to fund with, it returns **200** with `collateralAvailable: true` and builds nothing. Returns 400 if the address holds less than 6 ADA in total (5 ADA collateral + 1 ADA fee buffer).

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

### BuildMintTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| senderAddress | bech32 | Yes | Sender (pays fees) |
| recipientAddress | bech32 | Yes | Recipient (overridden when `lockOnScript=true`) |
| lovelaceAmount | Integer | Yes | Lovelace with minted assets |
| mintActionsJson | String | Yes | Mint actions: `[{"assetUnit":"policyId+name","quantity":"amt"}]` |
| mintingPolicyScript | String | Yes | Minting policy CBOR hex |
| changeAddress | bech32 | No | Change address |
| requiredSignersJson | String | No | Ed25519 key hashes for `extra_signatories` |
| scriptParamsJson | String | No | PlutusData params for parameterized validators |
| inlineDatumJson | String | No | Inline datum on recipient output |
| mintRedeemerJson | String | No | Minting redeemer (defaults to integer 0) |
| lockOnScript | Boolean | No | Route output to derived script address |

Returns `scriptHash`, `fingerprint`, `scriptAddress` when applicable.

`assetUnit` is either the full `policyId+assetName` hex — the 56-hex policyId prefix must
match the minting policy's script hash, otherwise the request is rejected with 400 — or,
when `scriptParamsJson` is set, a bare assetName of at most 28 bytes (56 hex) that is
expanded with the applied script's policyId. Asset names longer than 28 bytes are
length-indistinguishable from a full unit and must always be passed as a full unit.

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
| lockOnScript | Boolean | No | Re-lock at derived script address |

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
| protectInputsJson | String | No | Sender UTxOs that must never be spent (also on the other build actions) |
| withdrawalsJson | String | No | 1..16 withdrawals: `{rewardAddress, lovelace, stakingScript? | referenceScript?, scriptParamsJson?, redeemerJson? | redeemerCbor?}` |
| certificatesJson | String | No | 1..16 certificates: `{type: registerStake | deregisterStake, stakeAddress, deposit?, stakingScript? | referenceScript?, scriptParamsJson?, redeemerJson? | redeemerCbor?}` |
| requiredSignersJson | String | No | Ed25519 key hashes for `extra_signatories` |
| mintActionsJson | String | No | `[{assetUnit, quantity, mintingPolicyScript? | referenceScript?, redeemerJson?}]`, a policy per action; with `referenceScript` the `assetUnit` is policyId+assetName |
| validityStartMs / validityEndMs | String | No | Validity interval in Posix ms |

A `scriptInputsJson` entry:

```json
{ "txHash": "…", "outputIndex": 0,
  "validatorScript": "<cbor hex>", "scriptParamsJson": "[…]",
  "redeemerJson": "{\"constructor\":0,\"fields\":[]}", "datumJson": null }
```

or with `"referenceScript": {"txHash": "…", "outputIndex": 0}` instead of `validatorScript`. `datumJson` is
only for hash datums; inline datums are read from the UTxO. `redeemerCbor`, `datumCbor` and an output's
`inlineDatumCbor` take PlutusData as CBOR hex instead of JSON and put those bytes into the transaction
unchanged (no `__INPUT_IDX__` placeholders there). PlutusData JSON may nest up to 64 levels, every other
JSON parameter up to 10; the size limit is 1 MB for both. Index placeholders in any redeemer or output datum
(as the whole value of an `int` field):

| Placeholder | Resolves to |
|-------------|-------------|
| `__INPUT_IDX:<txHash>#<n>__` | index of the input in the final sorted inputs |
| `__REF_IDX:<txHash>#<n>__` | index of the reference input in the sorted reference inputs, reference-script UTxOs included |
| `__WDRL_IDX:<credential hash>__` | index of the withdrawal of that stake credential, script credentials first, then by hash |

A placeholder naming a UTxO or credential the transaction does not carry is a 400. Buildooor numbers withdrawal
redeemers by hash only, so a key-credential withdrawal that sorts before a scripted one by hash is refused with
400. Reference-script bytes come from Ogmios
or Koios; with Blockfrost alone a reference script cannot be used.

The response lists `redeemers` (`tag`, `index`, `mem`, `steps`); they are stored as `TransactionBuildRedeemers` (`tag`, `redeemerIndex`, `mem`, `steps`).
400 errors name the cause: the output below min-ADA, the redeemer whose evaluation failed, a missing collateral
(create one with `SetCollateral`), or a transaction above `maxTxSize`. A change output below min-ADA is reported as
too little funding, not as an output to raise.

Collateral is added only when a script runs. A build whose withdrawals and certificates all use key credentials
carries none. When the other sender UTxOs cannot pay the outputs, the fee and the change, the collateral UTxO is
also spent as an input; the ledger allows one UTxO as input and as collateral. For the same reason a UTxO named
in `forceInputsJson` is the collateral when no other sender UTxO qualifies: it must belong to the sender, be
ADA-only, carry no reference script and hold at least 5 ADA. A wallet with a single UTxO can then build a mint
whose redeemer names that UTxO. This holds for `BuildMintTransaction` and `BuildPlutusSpendTransaction` as well.

### SetCollateral

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| address | bech32 | Yes | Address to set up collateral for |

Returns 200 — either an unsigned build, or `collateralAvailable: true` when two or more UTxOs of >= 5 ADA already exist. Returns 400 on insufficient funds (< 6 ADA total).

### SubmitTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| buildId | UUID | Yes | Build ID from a build action |
| signedTxCbor | String | Yes | Fully signed transaction CBOR hex |

### SubmitSignedTransaction

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| signedTxCbor | String | Yes | Fully signed transaction CBOR hex |
| network | String | Yes | Target network |

For externally built transactions (not via ODATANO actions).

---

## Error Handling

| Error Code | HTTP | Cause | Resolution |
|------------|------|-------|------------|
| `ODATANO_INSUFFICIENT_FUNDS` | 400 | Sender doesn't have enough ADA | Top up address or reduce amount |
| `ODATANO_INVALID_INPUT` | 400 | Malformed address, invalid amount, missing fields | Validate bech32 format, check required params |
| `ODATANO_TX_VALIDATION_FAILED` | 400 | Wrong signing key or tampered CBOR | Verify correct `.skey`, re-build if modified |
| `ODATANO_PROVIDER_UNAVAILABLE` | 503 | All backends unreachable/timed out | Retry after 30s, check Ogmios/Blockfrost status |
| `ODATANO_TX_ALREADY_SUBMITTED` | 409 | Transaction already on chain/mempool | Expected (idempotent), check explorer |

---

## Troubleshooting

### "All backends failed: Failed to acquire requested point"
Ogmios node not fully synchronized. Check: `curl http://localhost:1337/health` — wait until `networkSynchronization > 0.99`.

### "Insufficient funds" but wallet has balance
UTxOs not yet confirmed or spent in a pending transaction. Transactions submitted through this
instance are tracked: their inputs are not offered again and their change to the sender is, until a
crawled block holds them (at most 10 minutes). Transactions submitted elsewhere are not known until
they are on chain; wait 1-2 minutes for confirmations.

### "Invalid signature" after signing
Wrong signing key or unsigned TX was modified. Verify key matches sender address, check `--testnet-magic` matches network. Re-build if needed.

### "No ADA-only UTxO available for collateral"
Plutus transactions require collateral. Use `SetCollateral` to create a dedicated 5 ADA UTxO, or ensure the sender already has an ADA-only UTxO of >= 5 ADA without a reference script plus another UTxO — that is the condition under which `SetCollateral` reports `collateralAvailable: true`, the same rule the builders apply. A sender UTxO named in `forceInputsJson` also serves as collateral when it is ADA-only, has no reference script and holds at least 5 ADA.

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
- [Security Guide](SECURITY_GUIDE.md) — Signing security, HSM details, signature verification

---
