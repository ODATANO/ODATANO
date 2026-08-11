# Transaction Workflow Guide

**Version:** v2.0.0-rc.1 | **Last Updated:** August 2026

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
const witnesses = await api.signTx(unsignedTxCbor, true);
```

#### Hardware Wallet (Ledger/Trezor)

Via browser extension integration (same CIP-30 API as above).

### Step 3: Submit Signed Transaction

**POST** `/odata/v4/cardano-transaction/SubmitTransaction`

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
**Action:** `BuildSimpleAdaTransaction` — Transfer lovelace between addresses. Supports `outputDatumJson` for sending to script addresses and `assetsJson` for including native tokens.

### Transaction with Metadata
**Action:** `BuildTransactionWithMetadata` — ADA transfer with attached CIP-20 metadata (invoices, receipts, on-chain records).

### Multi-Asset Transfer
**Action:** `BuildMultiAssetTransaction` — Transfer ADA + native tokens. Supports `outputDatumJson` for script address outputs.

### Token Minting
**Action:** `BuildMintTransaction` — Create native tokens. Supports `scriptParamsJson` for parameterized validators, `inlineDatumJson` for datum on minted output, `mintRedeemerJson` for custom redeemers, `lockOnScript` to route output to script address, and `requiredSignersJson` for Plutus `extra_signatories`.

### Plutus Smart Contract Spending
**Action:** `BuildPlutusSpendTransaction` — Spend UTxOs locked at Plutus script addresses. Supports `inlineDatumJson` for continuing output datum (state machines), `lockOnScript` to re-lock at script address, and `requiredSignersJson`.

**Plutus workflow:**
```
1. Lock:  BuildMintTransaction (lockOnScript + inlineDatumJson) → Sign → Submit
2. Spend: BuildPlutusSpendTransaction (validatorScript + redeemer + lockOnScript) → Sign → Submit
```

### Collateral Setup
**Action:** `SetCollateral` — Creates a dedicated 5 ADA collateral UTxO for Plutus transactions. When the address already has **at least two** UTxOs of >= 5 ADA, it returns **200** with `collateralAvailable: true` and builds nothing. Returns 400 if the address holds less than 6 ADA in total (5 ADA collateral + 1 ADA fee buffer).

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
UTxOs not yet confirmed or spent in a pending transaction. Wait 1-2 minutes for confirmations.

### "Invalid signature" after signing
Wrong signing key or unsigned TX was modified. Verify key matches sender address, check `--testnet-magic` matches network. Re-build if needed.

### "No ADA-only UTxO available for collateral"
Plutus transactions require collateral. Use `SetCollateral` to create a dedicated 5 ADA UTxO, or ensure the sender already has **two or more** UTxOs of >= 5 ADA each — that is the condition under which `SetCollateral` reports `collateralAvailable: true`.

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
