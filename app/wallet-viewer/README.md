# ODATANO Wallet Viewer

SAP Fiori/UI5 Sample Application for Cardano Wallet Integration demonstrating the M3 External Signing workflow.

## Overview

The Wallet Viewer is a proof-of-concept application that showcases ODATANO's external signing capabilities with CIP-30 compatible browser wallets. It provides a complete end-to-end workflow from connecting a wallet, viewing balances and transactions, to building, signing, and submitting ADA transfers.

## Implemented Features

### Wallet Connection (CIP-30)
- ✅ Automatic wallet detection (Nami, Eternl, Yoroi, Lace, Flint)
- ✅ Connect/Disconnect workflow
- ✅ Network detection (Preview, Preprod, Mainnet)
- ✅ Wallet icon and name display
- ✅ Connection state persistence

### Balance & Addresses
- ✅ ADA balance display (Lovelace + formatted)
- ✅ Primary address (first used address)
- ✅ All addresses panel (used/unused)
- ✅ Stake address display
- ✅ Copy-to-clipboard for all addresses

### Transaction History
- ✅ Last 20 transactions
- ✅ Transaction hash, block time, net amount
- ✅ Native assets in transactions
- ✅ Sorting by block time (descending)
- ✅ Transaction direction indicator (sent/received)

### Send ADA Workflow (M3 External Signing)
- ✅ Recipient address input with validation
- ✅ Amount input with balance check
- ✅ Build transaction via OData API (`BuildSimpleAdaTransaction`)
- ✅ Create signing request (`CreateSigningRequest`)
- ✅ Sign via CIP-30 wallet (`api.signTx()`)
- ✅ Submit via `SubmitVerifiedTransaction`
- ✅ Success/Error feedback with transaction hash

### OData Service Integration
- ✅ Main Service: `/odata/v4/cardano-odata/`
- ✅ TX Service: `/odata/v4/cardano-transaction/`
- ✅ `GetAddressByBech32` for on-demand indexing
- ✅ `BuildSimpleAdaTransaction` for transaction building
- ✅ `CreateSigningRequest` for external signing
- ✅ `SubmitVerifiedTransaction` for signature verification and submission

## TODOs bevor final Release (Roadmap)

### P1: Transaction Filtering & Sorting
- [ ] Date range filter
- [ ] Amount range filter
- [ ] Asset type filter
- [ ] Transaction direction filter (Sent/Received)
- [ ] Search by transaction hash

### P2: Token/Asset Inventory
- [ ] Dedicated token list view
- [ ] Token balances (not just in transactions)
- [ ] Policy ID tracking
- [ ] Asset metadata display (CIP-25/CIP-68)

### P3: Enhanced UX
- [ ] Pagination for transactions (> 20)
- [ ] Infinite scroll / load more
- [ ] Transaction detail view (expandable)
- [ ] Staking information panel
- [ ] Delegation status

### P4: Data Export
- [ ] Export transactions to CSV
- [ ] Export transactions to JSON
- [ ] Transaction report generation

## Project Structure

```
webapp/
├── Component.ts           # Main UI5 Component
├── manifest.json          # App Config & OData Models
├── controller/
│   ├── App.controller.ts
│   └── WalletDashboard.controller.ts
├── view/
│   ├── App.view.xml
│   ├── WalletDashboard.view.xml
│   └── fragment/
│       ├── SendAda.fragment.xml
│       └── SignTransaction.fragment.xml
├── model/
│   ├── formatter.ts
│   └── models.ts
├── wallet/
│   ├── WalletService.ts   # CIP-30 Integration
│   └── types/cip30.d.ts
├── css/style.css
└── i18n/i18n.properties
```

## Setup & Development

### Prerequisites
- Node.js 18+
- npm or yarn
- CIP-30 compatible browser wallet (Nami, Eternl, Yoroi, Lace, or Flint)
- ODATANO backend running locally or on BTP

### Installation

```bash
cd app/wallet-viewer
npm install
```

### Development Server

```bash
npm run start
```

Opens the app at http://localhost:8080 with live reload.

### Production Build

```bash
npm run build
```

Creates optimized bundles in `dist/` folder.

## OData Models

The application uses two OData V4 services:

| Model | Data Source | Purpose |
|-------|-------------|---------|
| `default` | `/odata/v4/cardano-odata/` | Read operations (addresses, transactions, blocks) |
| `tx` | `/odata/v4/cardano-transaction/` | Transaction building and signing operations |

## CIP-30 Wallet Integration

The app implements the CIP-30 dApp Connector standard:

```typescript
// Wallet detection
const wallets = window.cardano; // Lists available wallets

// Connection
const api = await window.cardano.nami.enable();

// Get addresses
const addresses = await api.getUsedAddresses();

// Sign transaction (external signing)
const witnessSet = await api.signTx(unsignedTxCbor, partialSign=true);
```

## External Signing Workflow

```
1. Build Transaction (Server)
   POST /cardano-transaction/BuildSimpleAdaTransaction
   → Returns buildId, unsignedTxCbor

2. Create Signing Request (Server)
   POST /cardano-transaction/CreateSigningRequest
   → Returns signingRequestId, signing instructions

3. Sign Externally (Browser Wallet)
   api.signTx(unsignedTxCbor, true)
   → Returns witness set CBOR

4. Verify & Submit (Server)
   POST /cardano-transaction/SubmitVerifiedTransaction
   → Verifies signature, submits to network, returns txHash
```
## Related Documentation

- [Transaction Workflow Guide](../../docs/guides/TRANSACTION_WORKFLOW.md)
- [External Signing Architecture](../../docs/concepts%20&%20architecture/INDEXING.md#m3-external-signing-indexing)
- [Error Handling](../../docs/concepts%20&%20architecture/ERROR_HANDLING.md)

## License

Apache-2.0
