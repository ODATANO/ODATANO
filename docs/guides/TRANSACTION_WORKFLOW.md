# Transaction Workflow Guide

**ODATANO Milestone 2 & 3 - Transaction Build, Sign & Submit**

This guide explains how to build, sign, and submit Cardano transactions using the ODATANO API with external signing. M3 adds a complete external signing workflow with SigningRequests and cryptographic verification.

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Workflow Steps](#workflow-steps)
4. [Signing Methods](#signing-methods)
5. [HSM Signing Workflow](#hsm-signing-workflow)
6. [API Reference](#api-reference)
7. [Error Handling](#error-handling)
8. [Examples](#examples)

---

## Overview

ODATANO follows a **3-step workflow** for transaction handling with complete **private key isolation**:

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   BUILD     │ ───> │     SIGN     │ ───> │   SUBMIT    │
│  (Server)   │      │  (External)  │      │  (Server)   │
└─────────────┘      └──────────────┘      └─────────────┘
```

### Key Principles

✅ **Server NEVER sees private keys**
✅ **External signing only** (CLI, Browser Wallet, Hardware Wallet)
✅ **Optional HSM signing** (automated server-side via PKCS#11, private key never leaves chip)
✅ **Full audit trail** (TransactionBuilds + TransactionSubmissions)
✅ **Protocol compliance** (Cardano CBOR standards)  

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                    ODATANO API Server                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ CardanoTransactionService                             │  │
│  │                                                       │  │
│  │  BuildSimpleAdaTransaction ──> Unsigned TX (CBOR)     │  │
│  │  BuildTransactionWithMetadata ──> Unsigned TX         │  │
│  │  BuildMultiAssetTransaction ──> Unsigned TX           │<─│───────────────┐
│  │  BuildMintTransaction ──> Unsigned TX                 │  │               │
│  │  SubmitTransaction ──> Blockchain Submit              │  │               │
│  │  SubmitSignedTransaction ──> External TX Submit       │  │               │
│  └───────────────────────────────────────────────────────┘  │               │
│                                                             │               │
│  ┌───────────────────────────────────────────────────────┐  │               │
│  │ CardanoSignService                                    │  │               │
│  │                                                       │  │               │
│  │  CreateSigningRequest ──> Signing Instructions        │  │               │
│  │  VerifySignature ──> Signature Verification           │  │               │
│  │  SubmitVerifiedTransaction ──> Verify + Submit        │<─│───────────────│
│  └───────────────────────────────────────────────────────┘  │               │
│                          ↓                                  │               │
│  ┌───────────────────────────────────────────────────────┐  │               │
│  │ Transaction Builder Registry                          │  │               │
│  │                                                       │  │               │
│  │  CSL Builder (Cardano Serialization Lib)              │  │               │
│  │  Buildooor Builder (HarmonicLabs)                     │  │               │
│  └───────────────────────────────────────────────────────┘  │               │
│                          ↓                                  │               │
│  ┌───────────────────────────────────────────────────────┐  │               │
│  │ Multi-Backend Client (Ogmios + Blockfrost/Koios)      │  │               │
│  │                                                       │  │               │
│  │  getAddressUtxos()     ──> Live UTxO data             │  │               │
│  │  getProtocolParameters() ──> Current params           │  │               │
│  │  submitTransaction()   ──> Node TxSubmission          │  │               │ 
│  └───────────────────────────────────────────────────────┘  │               │
│                          ↓                                  │               │
│  ┌─────────────────┐         ┌─────────────────────────┐    │               │
│  │ Ogmios Backend  │         │ Blockfrost/Koios        │    │               │
│  │ (Live - Primary)│         │ (Fallback)              │    │               │
│  └─────────────────┘         └─────────────────────────┘    │               │
└─────────────────────────────────────────────────────────────┘               │
                           ↓                                                  │
              ┌───────────────────────┐                                       │
              │  Cardano Preview Node │                                       │
              │  (Self-hosted)        │                                       │
              └───────────────────────┘                                       │
                           ↓                                                  │
┌─────────────────────────────────────────────────────────────┐               │
│                    External Signer                          │               │
│                                                             │               │
│  • Cardano CLI (Docker/Local)                               │               │   
│  • Browser Wallets (Nami, Eternl, Yoroi) via CIP-30         │───────────────┘
│  • Hardware Wallets (Ledger, Trezor)                        │
│  • Custom Signing Infrastructure                            │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User/Application
    │
    ├─► 1. POST BuildSimpleAdaTransaction
    │      Input:  { senderAddress, recipientAddress, lovelaceAmount }
    │      Output: { id, unsignedTxCbor, txBodyHash, fee, inputs[], outputs[] }
    │
    ├─► 2. External Signing (Off-Server)
    │      Tool:   cardano-cli / Browser Wallet / Hardware Wallet
    │      Input:  unsignedTxCbor
    │      Output: signedTxCbor (includes witness set)
    │
    └─► 3. POST SubmitTransaction
           Input:  { buildId, signedTxCbor }
           Output: { txHash, status: 'submitted', submittedAt }
```

---

## Workflow Steps (simplyfied)

### Step 1: Build Unsigned Transaction

**Endpoint:** `POST /odata/v4/cardano-transaction/BuildSimpleAdaTransaction`

**Request:**
```json
{
  "senderAddress": "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp",
  "recipientAddress": "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622",
  "lovelaceAmount": 10000000
}
```

**Response:**
```json
{
  "id": "a8f4c3b2-1e5d-4f9a-b7c6-2d8e9f1a3b4c",
  "senderAddress": "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp",
  "recipientAddress": "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622",
  "lovelaceAmount": 10000000,
  "unsignedTxCbor": "84a50081825820f3d8c...",
  "txBodyHash": "abc123...",
  "fee": 170000,
  "createdAt": 1735862400,
  "builderEngine": "buildooor",
  "inputs": [
    {
      "txHash": "f3d8c1b2...",
      "index": 0,
      "lovelace": "100000000"
    }
  ],
  "outputs": [
    {
      "address": "addr_test1qrgfq5...",
      "lovelace": "10000000"
    },
    {
      "address": "addr_test1vqm5vyp8...",
      "lovelace": "89830000"
    }
  ]
}
```

**What happens:**
1. Server queries current protocol parameters from Ogmios (or Blockfrost fallback)
2. Queries sender address UTxOs from Ogmios/Blockfrost
3. Selects sufficient UTxOs to cover amount + estimated fees
4. Transaction builder (CSL or Buildooor) constructs transaction body
5. Calculates precise fee based on transaction size
6. Creates change output back to sender address
7. Serializes transaction to CBOR format (unsigned)
8. Stores build record in database (TransactionBuilds entity) with TTL
9. Returns unsigned CBOR + build metadata to client

---

### Step 2: Sign Transaction (External)

**The server NEVER performs this step!**  
Private keys remain under user/client control.

#### Option A: Cardano CLI (Docker)

```bash
# 1. Save unsigned TX as TextEnvelope JSON
echo '{
  "type": "Tx ConwayEra",
  "description": "Ledger Cddl Format",
  "cborHex": "84a50081825820f3d8c..."
}' > unsigned.tx

# 2. Sign with your payment.skey
docker run --rm \
  -v $(pwd):/work \
  -v $(pwd):/keys \
  ghcr.io/blinklabs-io/cardano-node:latest \
  cli conway transaction sign \
  --tx-body-file /work/unsigned.tx \
  --signing-key-file /keys/payment.skey \
  --testnet-magic 2 \
  --out-file /work/signed.tx

# 3. Extract signedTxCbor from JSON
cat signed.tx | jq -r '.cborHex'
```

#### Option B: Browser Wallet (CIP-30)

```javascript
// Connect to wallet (Nami, Eternl, Yoroi, etc.)
const api = await window.cardano.nami.enable();

// Sign the unsigned transaction
const signedTxVkeyWitness = await api.signTx(unsignedTxCbor, true);

// signedTxVkeyWitness is ready for submission
```

#### Option C: Hardware Wallet (Ledger/Trezor)

```javascript
// Via browser extension integration
const yoroi = await window.cardano.yoroi.enable();
const signedTx = await yoroi.signTx(unsignedTxCbor, true);
```

**Output:**  
`signedTxCbor` - A hex-encoded CBOR string starting with `84a4` or `84a5` (fully signed transaction)

---

### Step 3: Submit Signed Transaction

**Endpoint:** `POST /odata/v4/cardano-transaction/SubmitTransaction`

**Request:**
```json
{
  "buildId": "a8f4c3b2-1e5d-4f9a-b7c6-2d8e9f1a3b4c",
  "signedTxCbor": "84a5008182582071f3d8c1b2...witnesses here...f6"
}
```

**Response:**
```json
{
  "id": "b9e5d4c3-2f6e-5a0b-c8d7-3e9f0a2b4d5e",
  "build_id": "a8f4c3b2-1e5d-4f9a-b7c6-2d8e9f1a3b4c",
  "txHash": "71f3d8c1b2a3e4f5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9",
  "status": "submitted",
  "submittedAt": 1735862410,
  "submittedToBackend": "ogmios",
  "backendResponse": "Submitted successfully",
  "confirmations": 0,
  "hasErrors": false
}
```

**What happens:**
1. Server validates buildId exists in database
2. Decodes and validates signed CBOR structure
3. Extracts txHash from signed transaction
4. Submits to Cardano network via multi-backend client:
   - **Primary:** Ogmios (local node, 10-100ms) if available
   - **Fallback:** Blockfrost API (if Ogmios unavailable)
   - **Fallback:** Koios API (if both above are unavailable)
5. Stores submission record in database (TransactionSubmissions entity)
6. Records submission timestamp and backend used
7. Returns transaction hash for tracking on blockchain explorer

---

## Signing Methods

### Comparison

| Method | Speed | Security | Use Case | Private Key Location |
|--------|-------|----------|----------|---------------------|
| **Cardano CLI** | Medium (200-500ms) | High | Backend automation, scripting | File system (encrypted) |
| **Browser Wallet** | Fast (10-50ms) | Very High | Web dApps, Fiori apps | Browser extension (encrypted) |
| **Hardware Wallet** | Slow (5-10s) | Maximum | High-value transactions | Hardware device |
| **HSM (PKCS#11)** | Fast (10-50ms) | Maximum | Enterprise automation | Hardware Security Module |

---

## HSM Signing Workflow

When an HSM is configured, ODATANO supports fully automated server-side signing. The private key never leaves the HSM chip -- the server sends the transaction body hash to the HSM via PKCS#11, and the HSM returns an Ed25519 signature.

### Workflow Comparison

**External Signing (4 steps):**
```
┌─────────┐   ┌───────────────────┐   ┌──────────────┐   ┌─────────────────────────┐
│  BUILD  │ → │ CreateSigningReq  │ → │ Sign (Client)│ → │ SubmitVerifiedTransaction│
│ (Server)│   │     (Server)      │   │  (External)  │   │        (Server)         │
└─────────┘   └───────────────────┘   └──────────────┘   └─────────────────────────┘
```

**HSM Signing (2 steps):**
```
┌─────────┐   ┌──────────────────────┐
│  BUILD  │ → │ SignAndSubmitWithHsm  │
│ (Server)│   │      (Server + HSM)   │
└─────────┘   └──────────────────────┘
```

### HSM Actions

| Action | Description |
|--------|-------------|
| `GetHsmStatus` | Check HSM connection, key info, and derived Cardano address |
| `SignWithHsm` | Sign a build with HSM (creates signing request + verification, does NOT submit) |
| `SignAndSubmitWithHsm` | Sign with HSM and submit to blockchain in one atomic step |

### Configuration

**Plugin mode** (`package.json`):
```json
{
  "cds": { "requires": { "odatano-core": {
    "network": "preview",
    "backends": ["blockfrost"],
    "blockfrostApiKey": "preview_KEY",
    "hsm": {
      "enabled": true,
      "pkcs11Module": "/usr/lib/pkcs11/yubihsm_pkcs11.so",
      "slot": 0,
      "pin": "0001password",
      "keyLabel": "cardano-signing-key"
    }
  }}}
}
```

**Environment variables:**
```bash
HSM_ENABLED=true
HSM_PKCS11_MODULE=/usr/lib/pkcs11/yubihsm_pkcs11.so
HSM_SLOT=0
HSM_PIN=0001password
HSM_KEY_LABEL=cardano-signing-key
# Optional: HSM_KEY_ID=0x0001
```

### Example: Automated HSM Transaction

```typescript
// 1. Check HSM status
const { data: status } = await POST('/odata/v4/cardano-sign/GetHsmStatus', {});
// → { connected: true, cardanoAddress: "addr_test1...", publicKeyHash: "a1b2..." }

// 2. Build transaction (use HSM address as sender)
const { data: build } = await POST('/odata/v4/cardano-transaction/BuildSimpleAdaTransaction', {
  senderAddress: status.cardanoAddress,
  recipientAddress: 'addr_test1...',
  lovelaceAmount: '5000000',
});

// 3. Sign + submit in one call
const { data: submission } = await POST('/odata/v4/cardano-sign/SignAndSubmitWithHsm', {
  buildId: build.id,
});
// → { txHash: "abc123...", status: "submitted" }
```

### Supported Hardware

| Device | PKCS#11 Module | Use Case |
|--------|---------------|----------|
| **YubiHSM 2** | `yubihsm_pkcs11.so` | On-premise, USB-attached |
| **AWS CloudHSM** | `cloudhsm_pkcs11.so` | Cloud, FIPS 140-2 Level 3 |
| **Thales Luna** | `libCryptoki2.so` | Enterprise, high-throughput |
| **SoftHSM** | `libsofthsm2.so` | Development and testing only |

### SoftHSM Quick Setup (Development)

For local development and testing without physical HSM hardware, use SoftHSM (Linux/WSL):

```bash
# Install and configure
sudo apt-get install -y softhsm2 opensc
mkdir -p ~/.config/softhsm2/tokens
cat > ~/.config/softhsm2/softhsm2.conf << EOF
directories.tokendir = $HOME/.config/softhsm2/tokens
objectstore.backend = file
EOF
export SOFTHSM2_CONF=$HOME/.config/softhsm2/softhsm2.conf

# Initialize token and generate Ed25519 key
softhsm2-util --init-token --slot 0 --label "odatano-dev" --pin 1234 --so-pin 5678
pkcs11-tool --module /usr/lib/softhsm/libsofthsm2.so \
  --login --pin 1234 \
  --keypairgen --key-type EC:edwards25519 \
  --label "cardano-signing-key" --id 01

# Start ODATANO with SoftHSM
HSM_ENABLED=true HSM_PKCS11_MODULE=/usr/lib/softhsm/libsofthsm2.so \
HSM_SLOT=0 HSM_PIN=1234 HSM_KEY_LABEL=cardano-signing-key cds watch
```

For detailed setup instructions, see [Security Guide — SoftHSM Setup](SECURITY_GUIDE.md#softhsm-setup-development--testing).

### Security Properties

- **Key isolation**: Private key is generated inside the HSM and marked `CKA_EXTRACTABLE=false`
- **Signing mechanism**: `CKM_EDDSA` (Ed25519) via PKCS#11 v3.0
- **Address derivation**: Enterprise address from blake2b-224(publicKey) + bech32 encoding
- **Audit trail**: Every HSM signature records `signerType='hsm'` and `hsmKeyId` in SigningRequests
- **Non-fatal startup**: If HSM is unreachable during server boot, the app continues without HSM (other signing methods still work)

For security configuration details, see [Security Guide](SECURITY_GUIDE.md#hsm-pkcs11-integration).

---

## Transaction Types

ODATANO supports six types of transactions:

### 1. Simple ADA Transfer
**Action:** `BuildSimpleAdaTransaction`
Transfer lovelace between addresses.

**Use cases:**
- Sending ADA payments
- Consolidating UTxOs
- Basic wallet-to-wallet transfers

### 2. Transaction with Metadata
**Action:** `BuildTransactionWithMetadata`
ADA transfer with attached metadata (CIP-20).

**Use cases:**
- Payment invoices with reference numbers
- Proof of purchase/receipt
- Timestamped records on-chain

### 3. Multi-Asset Transfer
**Action:** `BuildMultiAssetTransaction`
Transfer ADA + native tokens in a single transaction.

**Use cases:**
- Token distributions
- Token transfers with ADA fees

### 4. Token Minting
**Action:** `BuildMintTransaction`
Create new native tokens.

**Use cases:**
- Token creation
- Asset issuance

### 5. Plutus Smart Contract Spending
**Action:** `BuildPlutusSpendTransaction`
Spend a UTxO locked at a Plutus validator script address.

**Use cases:**
- Redeeming funds locked in a Plutus smart contract
- Executing on-chain logic (validator scripts)
- DeFi protocol interactions
- State-machine patterns with continuing outputs (use `inlineDatumJson` to attach updated datum)

**Workflow:**
```
1. Lock:  BuildMintTransaction (with lockOnScript + inlineDatumJson) → Sign → Submit
         OR BuildSimpleAdaTransaction (with outputDatumJson + assetsJson) → Sign → Submit
         OR BuildMultiAssetTransaction (with outputDatumJson) → Sign → Submit
2. Spend: BuildPlutusSpendTransaction (validatorScript + redeemer + scriptUtxo + lockOnScript) → Sign → Submit
```

### 6. Collateral Setup
**Action:** `SetCollateral`
Ensure a dedicated ADA-only collateral UTxO exists for Plutus transactions.

**Use cases:**
- Preparing an address for Plutus script interactions
- Ensuring collateral availability before smart contract calls

**Logic:**
- Checks if the address has at least 2 UTxOs with >= 5 ADA each
- If already available, returns 409 (Collateral already available)
- If insufficient funds (< 6 ADA total), returns 400
- Otherwise, builds a self-send transaction creating a 5 ADA collateral UTxO

## Transaction Builders

ODATANO supports two transaction builder implementations:

### CSL (Cardano Serialization Library)
- **Library:** `@emurgo/cardano-serialization-lib-nodejs`
- **Maturity:** Production-ready, widely used
- **Performance:** Excellent
- **Features:** Complete Cardano transaction support
- **Configuration:** `TX_BUILDERS=csl`

### Buildooor
- **Library:** `@harmoniclabs/buildooor`
- **Maturity:** Newer, actively developed
- **Performance:** Excellent
- **Features:** Modern TypeScript API
- **Configuration:** `TX_BUILDERS=buildooor`

**Dual Builder Support:**
```bash
TX_BUILDERS=csl,buildooor
```
Both builders available, CSL used as primary.

---

## API Reference

### BuildSimpleAdaTransaction

**Action:** `BuildSimpleAdaTransaction`  
**Method:** POST  
**Path:** `/odata/v4/cardano-transaction/BuildSimpleAdaTransaction`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| senderAddress | bech32 | Yes | Source address (must have sufficient UTxOs) |
| recipientAddress | bech32 | Yes | Recipient address |
| lovelaceAmount | Integer | Yes | Amount in lovelace (1 ADA = 1,000,000 lovelace) |
| changeAddress | bech32 | No | Change address (defaults to sender) |
| outputDatumJson | String | No | Inline datum to attach to the recipient output (JSON, DetailedSchema). Required when sending to a script address. |
| assetsJson | String | No | JSON array of native assets to include in the output: `[{"unit":"policyId+assetName","quantity":"amount"}]`. Use when locking tokens at a script address. |

**Returns:** `TransactionBuild` entity

---

### BuildTransactionWithMetadata

**Action:** `BuildTransactionWithMetadata`
**Method:** POST
**Path:** `/odata/v4/cardano-transaction/BuildTransactionWithMetadata`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| senderAddress | bech32 | Yes | Source address |
| recipientAddress | bech32 | Yes | Recipient address |
| lovelaceAmount | Integer | Yes | Amount in lovelace |
| changeAddress | bech32 | No | Change address (defaults to sender) |
| metadataJson | String | Yes | Transaction metadata as JSON string |

**Returns:** `TransactionBuild` entity

---

### BuildMultiAssetTransaction

**Action:** `BuildMultiAssetTransaction`
**Method:** POST
**Path:** `/odata/v4/cardano-transaction/BuildMultiAssetTransaction`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| senderAddress | bech32 | Yes | Source address |
| recipientAddress | bech32 | Yes | Recipient address |
| lovelaceAmount | Integer | Yes | Amount in lovelace |
| assetsJson | String | Yes | JSON array of assets: `[{"unit":"policyId+assetName","quantity":"amount"}]` |
| changeAddress | bech32 | No | Change address (defaults to sender) |
| outputDatumJson | String | No | Inline datum to attach to the recipient output (JSON, DetailedSchema). Required when sending to a script address. |

**Returns:** `TransactionBuild` entity

---

### BuildMintTransaction

**Action:** `BuildMintTransaction`
**Method:** POST
**Path:** `/odata/v4/cardano-transaction/BuildMintTransaction`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| senderAddress | bech32 | Yes | Sender address (pays fees) |
| recipientAddress | bech32 | Yes | Recipient address for minted assets (overridden when `lockOnScript=true`) |
| lovelaceAmount | Integer | Yes | Amount in lovelace to send with minted assets |
| mintActionsJson | String | Yes | JSON array of mint actions: `[{"assetUnit":"policyId+assetName","quantity":"amount"}]` |
| mintingPolicyScript | String | Yes | Minting policy script in CBOR hex format |
| changeAddress | bech32 | No | Change address (defaults to sender) |
| requiredSignersJson | String | No | JSON array of Ed25519 key hashes (hex, 28 bytes each) for Plutus `extra_signatories` checks |
| scriptParamsJson | String | No | JSON array of PlutusData parameters to apply to the minting policy script (for parameterized validators). Response includes `scriptHash`. |
| inlineDatumJson | String | No | PlutusData JSON to attach as inline datum on the recipient output (for minted tokens that must carry on-chain state) |
| mintRedeemerJson | String | No | PlutusData JSON for the minting policy redeemer (defaults to integer 0 if not specified) |
| lockOnScript | Boolean | No | When `true` and `scriptParamsJson` is provided, routes the output to the enterprise script address derived from the applied script hash. Response includes `scriptAddress`. |

**Returns:** `TransactionBuild` entity (includes `scriptHash`, `fingerprint`, and `scriptAddress` when applicable)

---

### BuildPlutusSpendTransaction

**Action:** `BuildPlutusSpendTransaction`
**Method:** POST
**Path:** `/odata/v4/cardano-transaction/BuildPlutusSpendTransaction`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| senderAddress | bech32 | Yes | Sender address (pays fees) |
| recipientAddress | bech32 | Yes | Recipient address for unlocked funds (overridden when `lockOnScript=true`) |
| lovelaceAmount | Integer | Yes | Amount in lovelace to send to recipient |
| validatorScript | String | Yes | Plutus validator script in CBOR hex format |
| scriptTxHash | String | Yes | Transaction hash of the UTxO locked at the script address (64-char hex) |
| scriptOutputIndex | Integer | Yes | Output index of the UTxO locked at the script address |
| redeemerJson | String | Yes | Redeemer data as JSON string (converted to PlutusData) |
| datumJson | String | No | Datum data as JSON string (for hash-based datums) |
| changeAddress | bech32 | No | Change address (defaults to sender) |
| requiredSignersJson | String | No | JSON array of Ed25519 key hashes (hex, 28 bytes each) for Plutus `extra_signatories` checks |
| scriptParamsJson | String | No | JSON array of PlutusData parameters to apply to the validator script (for parameterized validators). Response includes `scriptHash`. |
| inlineDatumJson | String | No | PlutusData JSON to attach as inline datum on the recipient output (for state-machine validators that require continuing output datum) |
| lockOnScript | Boolean | No | When `true` and `scriptParamsJson` is provided, routes the continuing output to the enterprise script address derived from the applied script hash. Response includes `scriptAddress`. |

**Returns:** `TransactionBuild` entity (includes `scriptHash` and `scriptAddress` when applicable)

---

### SetCollateral

**Action:** `SetCollateral`
**Method:** POST
**Path:** `/odata/v4/cardano-transaction/SetCollateral`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| address | bech32 | Yes | Address to check and set up collateral for |

**Returns:** `TransactionBuild` entity (if collateral setup needed) or 409 if already available

**Error Codes:**

| HTTP | Description |
|------|-------------|
| 200 | Collateral setup transaction built successfully |
| 400 | Invalid address or insufficient funds (need >= 6 ADA) |
| 409 | Collateral already available (>= 2 UTxOs with >= 5 ADA) |

---

### SubmitTransaction

**Action:** `SubmitTransaction`  
**Method:** POST  
**Path:** `/odata/v4/cardano-transaction/SubmitTransaction`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| buildId | UUID | Yes | ID of the original build from BuildSimpleAdaTransaction |
| signedTxCbor | String | Yes | Fully signed transaction in CBOR hex format |

**Returns:** `TransactionSubmission` entity

---

### SubmitSignedTransaction

**Action:** `SubmitSignedTransaction`
**Method:** POST
**Path:** `/odata/v4/cardano-transaction/SubmitSignedTransaction`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| signedTxCbor | String | Yes | Fully signed transaction in CBOR hex format |
| network | String(10) | Yes | Target network |

**Use case:** For transactions built externally (not via ODATANO actions)

**Returns:** `TransactionSubmission` entity

---

## Error Handling

### 1. Insufficient Funds

**Error Code:** `ODATANO_INSUFFICIENT_FUNDS`  
**HTTP Status:** 400

**Scenario:** Sender address doesn't have enough UTxOs to cover amount + fees

```json
{
  "error": {
    "code": "ODATANO_INSUFFICIENT_FUNDS",
    "message": "Insufficient funds: address has 5.5 ADA but needs 10.17 ADA (amount: 10 ADA + estimated fee: 0.17 ADA)",
    "@Common.numericSeverity": 4
  }
}
```

**Resolution:**
- Wait for pending transactions to confirm
- Top up the sender address
- Reduce the transfer amount

---

### 2. Invalid Input Data

**Error Code:** `ODATANO_INVALID_INPUT`  
**HTTP Status:** 400

**Scenario:** Malformed address, invalid amount, or missing required fields

```json
{
  "error": {
    "code": "ODATANO_INVALID_INPUT",
    "message": "Invalid sender address format: expected bech32 'addr_test1...' or 'addr1...'",
    "target": "senderAddress",
    "@Common.numericSeverity": 4
  }
}
```

**Resolution:**
- Validate address format with bech32 library
- Ensure lovelaceAmount is positive integer
- Check all required fields are provided

---

### 3. Invalid Signature

**Error Code:** `ODATANO_TX_VALIDATION_FAILED`  
**HTTP Status:** 400

**Scenario:** Transaction signed with wrong key, or CBOR tampered

```json
{
  "error": {
    "code": "ODATANO_TX_VALIDATION_FAILED",
    "message": "Transaction validation failed: signature verification failed for input 0",
    "@Common.numericSeverity": 4
  }
}
```

**Resolution:**
- Verify you signed with the correct payment.skey
- Ensure signedTxCbor wasn't modified after signing
- Check the signing key corresponds to senderAddress

---

### 4. Network Failure

**Error Code:** `ODATANO_PROVIDER_UNAVAILABLE`  
**HTTP Status:** 503

**Scenario:** Ogmios/Blockfrost unreachable, network timeout

```json
{
  "error": {
    "code": "ODATANO_PROVIDER_UNAVAILABLE",
    "message": "All backends failed: Ogmios timeout (8000ms), Blockfrost connection refused",
    "@Common.numericSeverity": 4
  }
}
```

**Resolution:**
- Retry after 30 seconds
- Check Ogmios container is running: `docker ps | grep ogmios`
- Verify network connectivity to Blockfrost API
- Check firewall rules for port 1337 (Ogmios)

---

### 5. Duplicate/Replay Transaction

**Error Code:** `ODATANO_TX_ALREADY_SUBMITTED`  
**HTTP Status:** 409

**Scenario:** Same transaction hash already exists on chain

```json
{
  "error": {
    "code": "ODATANO_TX_ALREADY_SUBMITTED",
    "message": "Transaction 71f3d8c1... already exists in mempool or on chain",
    "@Common.numericSeverity": 3
  }
}
```

**Resolution:**
- This is expected behavior (idempotent)
- Check transaction status on blockchain explorer
- If confirmed, update application state accordingly

---

## Examples

### Postman Collection
- [ODATANO M2 Transaction Workflow Postman Collection](https://github.com/ODATANO/ODATANO/blob/main/scripts/ODATANO%20M2%20-%20Full%20Service%20Catalog.postman_collection.json)

### Complete TypeScript Examples

- [Build + Sign + Submit Simple ADA Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/send-ada-preview.ts)
- [Build + Sign + Submit Metadata Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/send-ada-with-metadata-preview.ts)
- [Build + Sign + Submit Minting Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/mint-token-preview.ts)
- [Build + Sign + Submit Multi-Asset Transaction](https://github.com/ODATANO/ODATANO/blob/main/scripts/send-multi-asset-preview.ts)

### Real Preview Examples

- Simple ADA Transfer:  
  ![M2 Preview Testing Results](https://github.com/ODATANO/ODATANO/blob/main/docs/requirments%20%26%20milestones/ODATANO-M2%20Testing%20Screenshots%20Postman%20%26%20Scripts.pdf)
---

## Troubleshooting

### "All backends failed: Failed to acquire requested point"

**Cause:** Ogmios node not fully synchronized

**Solution:**
```bash
curl http://localhost:1337/health
# Wait until > 0.99 (99% synced)
```

---

### "Insufficient funds" but wallet has balance"

**Cause:** UTxOs not yet confirmed or spent in pending transaction

**Solution:**
- Check pending transactions on explorer
- Wait for confirmations (1-2 minutes)

---

### "Invalid signature" after signing

**Cause:** Wrong signing key or unsigned TX modified

**Solution:**
- Verify signing key corresponds to sender address
- Re-build transaction if unsignedTxCbor was modified
- Check testnet-magic parameter matches network

---

### 'No ADA-only UTxO available for collateral. Plutus scripts require ADA-only collateral.' for minting transaction
**Cause:** Minting and Plutus transactions require a collateral UTxO
**Solution:**
- Use the `SetCollateral` action to automatically create a dedicated 5 ADA collateral UTxO
- Or ensure sender address has at least one UTxO with minimum 5 ADA

---

## References

- [Cardano Transaction Specification](https://github.com/IntersectMBO/cardano-ledger)
- [Ogmios Documentation](https://ogmios.dev/)
- [Cardano CLI Reference](https://github.com/IntersectMBO/cardano-cli)
- [Buildooor TX Library](https://github.com/HarmonicLabs/buildooor)

---

## Summary

ODATANO M2/M3 provides a complete transaction workflow with:

✅ **6 Transaction Types**: Simple ADA, Metadata, Multi-Asset, Minting, Plutus Smart Contract Spending, Collateral Setup
✅ **2 Builder Options**: CSL & Buildooor
✅ **Multi-Backend Support**: Ogmios + Blockfrost/Koios with automatic failover
✅ **External Signing**: Complete private key isolation
✅ **Full Audit Trail**: TransactionBuilds & TransactionSubmissions entities
✅ **Production Ready**: Comprehensive transaction tests

### M3 External Signing Additions (CardanoSignService at `/odata/v4/cardano-sign/`):

✅ **SigningRequests**: Persistent signing workflow with TTL expiration
✅ **SignatureVerifications**: Cryptographic verification with audit trail
✅ **CIP-30 Support**: Browser wallet integration (Nami, Eternl, Yoroi)
✅ **6 New Actions**: CreateSigningRequest, GetSigningRequest, VerifySignature, SubmitVerifiedTransaction, GetSigningRequestsByAddress, GetTransactionBuildsByAddress

---

**Document Version:** 2.0
**Last Updated:** February 5, 2026
**Milestone:** M2/M3 - Transaction Build, Sign & Submit
