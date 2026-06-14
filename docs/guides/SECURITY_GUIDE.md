# ODATANO Security & Authentication Guide

**Version:** v1.9 | **Last Updated:** June 2026

---

## Table of Contents

1. [Security Architecture](#security-architecture)
2. [Authentication (XSUAA)](#authentication-xsuaa)
3. [Authorization & Roles](#authorization--roles)
4. [API & Transport Security](#api--transport-security)
5. [Secret Management](#secret-management)
6. [Transaction Signing Security](#transaction-signing-security)
7. [Input Validation](#input-validation)
8. [Audit Trail](#audit-trail)
9. [Production Security Checklist](#production-security-checklist)

---

## Security Architecture

### Design Principles

- **Private key isolation** — The server NEVER handles, stores, or has access to private keys. All signing is external.
- **Defense in depth** — Multiple independent layers: authentication, authorization, input validation, transport encryption, audit logging.
- **Least privilege** — Role-based access restricts operations to authorized scopes.
- **Fail-secure** — Invalid/expired requests and missing auth result in explicit rejection.

### Security Layers

```
Layer 1: Transport Security (TLS/HTTPS)
Layer 2: SAP AppRouter (Reverse Proxy + CSRF)
Layer 3: XSUAA Authentication (JWT Validation)
Layer 4: CDS Authorization (@requires + Scopes)
Layer 5: Input Validation (validators.ts + const.ts limits)
Layer 6: Transaction Integrity (Signature Verification + Body Hash Matching)
Layer 7: Audit Trail (SigningRequests + SignatureVerifications + TransactionSubmissions)
```

### Service Separation

| Service | Purpose | Risk Profile |
|---------|---------|--------------|
| `CardanoODataService` | Read-only blockchain queries | Low — no state mutation |
| `CardanoTransactionService` | Transaction building, signing, submission | Medium — involves funds movement preparation |
| `CardanoSignService` | Transaction signing | High — involves private key operations |

This enables independent security policies per service.

---

## Authentication (XSUAA)

ODATANO uses SAP BTP's XSUAA for production authentication. In development, auth is disabled for local testing.

### Profile Configuration

```json
{
  "cds": {
    "requires": {
      "[production]": {
        "db": { "kind": "hana" },
        "auth": "xsuaa"
      }
    }
  }
}
```

- **Development** (`cds watch`): No authentication, all endpoints open.
- **Production** (`[production]` profile): XSUAA enforced, every request needs a valid JWT.

### xs-security.json

```json
{
  "scopes": [
    { "name": "$XSAPPNAME.Read", "description": "Read Cardano blockchain data" },
    { "name": "$XSAPPNAME.Transact", "description": "Build and submit Cardano transactions" },
    { "name": "$XSAPPNAME.Sign", "description": "Sign transactions and manage HSM" }
  ],
  "role-templates": [
    {
      "name": "CardanoReader",
      "description": "Read Cardano blockchain data",
      "scope-references": ["$XSAPPNAME.Read"]
    },
    {
      "name": "CardanoUser",
      "description": "Full access to Cardano services",
      "scope-references": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign"]
    }
  ],
  "authorities": ["$XSAPPNAME.Read", "$XSAPPNAME.Transact", "$XSAPPNAME.Sign"]
}
```

### Setup on BTP

```bash
cf create-service xsuaa application odatano-uaa -c xs-security.json
cf bind-service odatano odatano-uaa
```

---

## Authorization & Roles

SAP CAP provides declarative authorization via `@requires` annotations in CDS.

### CDS Annotations

All three services require an authenticated user at the service level:

```cds
@requires: 'authenticated-user'
service CardanoODataService { ... }

@requires: 'authenticated-user'
service CardanoTransactionService { ... }

@requires: 'authenticated-user'
service CardanoSignService { ... }
```

The `@requires: 'authenticated-user'` annotation ensures that every request must carry a valid JWT. The scopes (`Read`, `Transact`, `Sign`) in `xs-security.json` can be used for AppRouter-level route protection if needed.

### BTP Role Collections

| Role Collection | Role Template | Intended Users |
|-----------------|---------------|----------------|
| ODATANO Reader | CardanoReader | Analysts, dashboards, monitoring |
| ODATANO User | CardanoUser | Application backends, dApp frontends, operators |

Create role collections in the SAP BTP Cockpit and assign them to users.

---

## API & Transport Security

### TLS/HTTPS

All production traffic must use TLS. SAP BTP provides automatic TLS termination. For Docker, configure a reverse proxy (NGINX, HAProxy) for TLS.

### AppRouter as Reverse Proxy

```
Internet --> AppRouter (auth + CSRF) --> CAP Server (internal only)
```

The AppRouter provides TLS termination, JWT validation, CSRF protection, and session management. The CAP server should NOT be directly internet-accessible.

### CSRF Protection

Enabled in `xs-app.json` routes via `"csrfProtection": true`. Clients must:
1. Fetch token via `GET` with `X-CSRF-Token: Fetch` header
2. Include token in `X-CSRF-Token` header on state-changing requests (POST/PUT/DELETE)

### CORS

Restrict allowed origins in production (no wildcards):

```json
{
  "cors": {
    "allowedOrigins": [{ "host": "your-domain.com" }],
    "allowedMethods": ["GET", "POST", "OPTIONS"],
    "allowedHeaders": ["Authorization", "Content-Type", "X-CSRF-Token"]
  }
}
```

### Recommended Security Headers

| Header | Value |
|--------|-------|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; ...` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |

## Secret Management

### Sensitive Variables

| Variable | Sensitivity | Notes |
|----------|-------------|-------|
| `BLOCKFROST_API_KEY` | High | Grants API access, counts toward quota |
| `KOIOS_API_KEY` | Medium | Free tier available without key too|
| `OGMIOS_URL` | Medium | Exposes local node endpoint |
| `HSM_PIN` | Critical | PKCS#11 authentication |

### Best Practices

- **Never** commit secrets to version control
- `.gitignore` must include: `.env`, `*.skey`, `*.vkey`, `*.pem`, `credentials*.json`
- **Local dev**: Use `.env` files
- **BTP Production**: Use SAP Credential Store or User-Provided Services:

```bash
cf create-user-provided-service odatano-secrets -p '{
  "BLOCKFROST_API_KEY": "your-production-key",
  "KOIOS_API_KEY": "your-koios-key"
}'
cf bind-service odatano odatano-secrets
```

### API Key Rotation

Rotate keys every 90 days. With multi-backend failover, rotate without downtime:
1. Rotate Blockfrost key → Koios handles requests during restart
2. Rotate Koios key → Blockfrost handles requests during restart

---

## Transaction Signing Security

This is the most critical security boundary. **Private keys NEVER touch the server.**

### External Signing Architecture

![alt text](<../assets/architecture & flow diagramms/signflow-ad.png>)

The server only sees: unsigned CBOR, signed CBOR (public witnesses, NOT keys), and transaction body hashes.

### Signing Methods

| Method | Key Location | Security Level | Use Case |
|--------|-------------|----------------|----------|
| CIP-30 Browser Wallet | Browser extension | Very High | Web dApps, Fiori apps |
| Cardano CLI | File system (`.skey`) | High | Backend automation |
| Hardware Wallet | Dedicated device | Maximum | High-value transactions |
| HSM (PKCS#11) | HSM chip | Maximum | Enterprise server-side automation |

For signing code examples, see [TRANSACTION_WORKFLOW.md](TRANSACTION_WORKFLOW.md#signing-methods).

### HSM (PKCS#11) Integration

ODATANO supports server-side signing via PKCS#11-compatible HSMs.

**Configuration:**
```bash
HSM_ENABLED=true
HSM_PKCS11_MODULE=/usr/lib/pkcs11/yubihsm_pkcs11.so
HSM_SLOT=0
HSM_PIN=                      # Set via credential store in production
HSM_KEY_LABEL=cardano-signing-key
HSM_KEY_ID=0x0001
```
**Security properties:** Key generated inside HSM with `CKA_EXTRACTABLE=false`, signing via `CKM_EDDSA` (Ed25519), PIN-based session auth. HSM failure is non-fatal — app starts without HSM, other signing methods still work.

**Verify HSM status:**
```bash
curl -X POST http://localhost:4004/odata/v4/cardano-sign/GetHsmStatus \
  -H "Content-Type: application/json" -d '{}'
```

### Verification Checks

1. **CBOR parsing** — Valid, parseable CBOR
2. **Body hash matching** — Detects tampering between build and sign
3. **Witness presence** — At least one VKey witness present
4. **Required signers** — Specific key hashes present if required
5. **Ed25519 verification** — Cryptographic signature check per witness

### Signing Request TTL

Signing requests expire after 30 minutes (default). Expired requests are rejected even with valid signatures, preventing replay attacks with stale UTxO data.

---

## Input Validation

All inputs are validated before processing via `srv/utils/validators.ts` with limits from `srv/utils/const.ts`.

### Validators

| Validator | Format | Purpose |
|-----------|--------|---------|
| `isTxHash(s)` | 64 hex chars | Transaction/block hashes |
| `isValidBech32Address(s)` | Bech32 `addr`/`addr_test` | Payment addresses (network-aware) |
| `isValidBech32StakeAddress(s)` | Bech32 `stake`/`stake_test` | Stake addresses |
| `isValidPoolId(s)` | Bech32 `pool`, 28-byte payload | Stake pool IDs |
| `isValidDrepId(s)` | Bech32 `drep`, 29-byte payload | DRep IDs |
| `isAssetUnit(s)` | 56-192 hex chars | Native asset identifiers |
| `isValidCbor(s)` | Even-length hex | Transaction CBOR |
| `validateTransactionInputs()` | Composite | Multi-field validation |
| `validateJsonWithLimits()` | JSON + complexity | DoS prevention |

### JSON Complexity Limits (DoS Prevention)

| Limit | Value | Purpose |
|-------|-------|---------|
| Max JSON size | 1 MB | Prevents memory exhaustion |
| Max nesting depth | 10 | Prevents stack overflow |
| Max object keys | 100 | Prevents hash collision attacks |
| Max array length | 1,000 | Prevents excessive iteration |
| Max string length | 65,536 | Prevents oversized values |

### Network-Aware Address Validation

Addresses are validated against the configured `NETWORK`. A `preview` address (`addr_test1...`) is rejected on `mainnet`, and vice versa.

---

## Audit Trail

ODATANO records every step of the transaction lifecycle via OData-queryable entities.

### Tracked Entities

| Entity | Records | Key Fields |
|--------|---------|------------|
| `TransactionBuilds` | Every build request | senderAddress, fee, unsignedTxCbor, txBodyHash |
| `SigningRequests` | Signing lifecycle | status (`pending`→`verified`→`submitted`), signerType, hsmKeyId, expiresAt |
| `SignatureVerifications` | Every verification attempt | isValid, witnessCount, signerKeyHashes, errorMessage |
| `TransactionSubmissions` | Every submission attempt | txHash, status, errorCode, retryCount |

### Querying

```http
# Signing requests for an address
POST /odata/v4/cardano-sign/GetSigningRequestsByAddress
{"address": "addr_test1qq..."}

# Filtered queries with OData
GET /odata/v4/cardano-sign/SigningRequests
    ?$filter=status eq 'verified'&$orderby=createdAt desc&$expand=verifications,build

# Failed submissions
GET /odata/v4/cardano-sign/TransactionSubmissions
    ?$filter=status eq 'failed'
```
## References

- [SAP CAP Security Guide](https://cap.cloud.sap/docs/guides/security/)
- [SAP XSUAA Documentation](https://help.sap.com/docs/btp/sap-business-technology-platform/what-is-sap-authorization-and-trust-management-service)
- [ODATANO Transaction Workflow](TRANSACTION_WORKFLOW.md) — Signing methods and code examples
- [ODATANO Developer Guide](DEVELOPER_GUIDE.md) — Architecture reference
- [CIP-30 Cardano Wallet API](https://cips.cardano.org/cip/CIP-30/)

---
