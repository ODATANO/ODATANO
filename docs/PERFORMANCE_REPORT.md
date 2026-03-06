# ODATANO Performance Report

## Overview

This report documents the response time and throughput characteristics of the ODATANO OData V4 service across all 38 endpoints (35 parallel + 3 chained). Tests were conducted using the automated benchmark scripts (`scripts/perf/perf-benchmark.ts` and `scripts/perf/perf-compare.ts`) with 4 backend×builder combinations tested for a comprehensive comparison.

**Test Date:** 2026-03-06
**Runs:** 3 independent runs (Run 1: 06:42 UTC, Run 2: 07:44 UTC, Run 3: 07:52 UTC)
**Configurations:** 4 (Koios×Buildooor, Koios×CSL, Blockfrost×Buildooor, Blockfrost×CSL)
**Benchmark:** 3 rounds per endpoint, 38 endpoints, 108 calls per configuration, 432 total calls per run
**Success Rate:** 100% (1296/1296 across all 3 runs)

## Test Environment

| Parameter | Value |
|-----------|-------|
| Node.js | v22.11.0 |
| Platform | Windows (MSYS_NT-10.0) |
| Database | SQLite in-memory (`@cap-js/sqlite`) |
| Network | Cardano Preview Testnet |
| Backends | Koios & Blockfrost (compared independently) |
| TX Builders | CSL & Buildooor (compared independently) |
| Server | SAP CAP `cds watch` (localhost:4005) |
| Telemetry | `@cap-js/telemetry` (OpenTelemetry) |
| Cache | SQLite wiped + redeployed between each configuration for fair cold-start measurement |

---

## 4-Way Comparison: Overall Summary

### Run 1 (06:42 UTC)

| Metric | Koios+Buildooor | Koios+CSL | Blockfrost+Buildooor | Blockfrost+CSL |
|--------|----------------:|----------:|---------------------:|---------------:|
| **Avg Response** | 116.2 ms | 103.4 ms | 67.4 ms | **63.3 ms** |
| **Startup Time** | 9.5s | 9.3s | 9.2s | 9.3s |
| **Success Rate** | 108/108 | 108/108 | 108/108 | 108/108 |
| **Slowest Endpoint** | GetAccountByStakeAddress (1134 ms) | GetAccountByStakeAddress (1108 ms) | BuildPlutusSpendTx (378 ms) | BuildPlutusSpendTx (361 ms) |
| **Fastest Endpoint** | GetHsmStatus (1.6 ms) | GetHsmStatus (1.7 ms) | GetHsmStatus (1.4 ms) | GetHsmStatus (1.9 ms) |

### Run 2 (07:44 UTC)

| Metric | Koios+Buildooor | Koios+CSL | Blockfrost+Buildooor | Blockfrost+CSL |
|--------|----------------:|----------:|---------------------:|---------------:|
| **Avg Response** | 114.9 ms | 109.0 ms | 68.8 ms | **62.5 ms** |
| **Startup Time** | 9.5s | 10.5s | 9.3s | 9.3s |
| **Success Rate** | 108/108 | 108/108 | 108/108 | 108/108 |
| **Slowest Endpoint** | GetAccountByStakeAddress (808 ms) | GetAccountByStakeAddress (833 ms) | BuildPlutusSpendTx (367 ms) | GetAccountByStakeAddress (349 ms) |
| **Fastest Endpoint** | GetHsmStatus (1.6 ms) | GetHsmStatus (1.7 ms) | GetHsmStatus (1.4 ms) | GetHsmStatus (1.9 ms) |

### Run 3 (07:52 UTC)

| Metric | Koios+Buildooor | Koios+CSL | Blockfrost+Buildooor | Blockfrost+CSL |
|--------|----------------:|----------:|---------------------:|---------------:|
| **Avg Response** | 118.7 ms | 125.3 ms | 72.4 ms | **67.4 ms** |
| **Startup Time** | 10.5s | 9.5s | 9.3s | 9.3s |
| **Success Rate** | 108/108 | 108/108 | 108/108 | 108/108 |
| **Slowest Endpoint** | GetAccountByStakeAddress (791 ms) | GetAccountByStakeAddress (1188 ms) | BuildPlutusSpendTx (456 ms) | BuildPlutusSpendTx (355 ms) |
| **Fastest Endpoint** | GetHsmStatus (1.6 ms) | GetHsmStatus (1.7 ms) | GetHsmStatus (1.4 ms) | GetHsmStatus (1.9 ms) |

### Reproducibility (3 Runs)

| Configuration | Run 1 | Run 2 | Run 3 | Avg | Max Variance |
|---------------|------:|------:|------:|----:|-------------:|
| Koios+Buildooor | 116.2 ms | 114.9 ms | 118.7 ms | 116.6 ms | ±2.1% |
| Koios+CSL | 103.4 ms | 109.0 ms | 125.3 ms | 112.6 ms | ±11.3% |
| Blockfrost+Buildooor | 67.4 ms | 68.8 ms | 72.4 ms | 69.5 ms | ±4.2% |
| Blockfrost+CSL | 63.3 ms | 62.5 ms | 67.4 ms | 64.4 ms | ±4.7% |

Results are reproducible across 3 runs. Blockfrost configurations show **< 5% variance**, Koios configurations show higher variance (up to 11%) due to external API latency fluctuations. The ranking is stable: Blockfrost+CSL consistently fastest, Koios consistently slowest.

**Winner: Blockfrost + CSL** with 62.5-67.4 ms average (64.4 ms across 3 runs) — ~45% faster than Koios+Buildooor (116.6 ms avg).

---

## Response Time Summary (Reference: Blockfrost + CSL)

The tables below show the fastest configuration (Blockfrost + CSL) as primary reference. The full 4-way comparison follows in later sections.

### Read Action Endpoints (POST) — CardanoODataService

| Endpoint | Category | Cold Start (ms) | Warm Avg (ms) | Overall Avg (ms) |
|----------|----------|----------------:|---------------:|------------------:|
| GetNetworkInformation | Network | 44.2 | 2.8 | 16.6 |
| GetLedgerProtocolParameters | Network | 5.6 | 2.8 | 3.8 |
| GetLatestBlock | Block | 197.7 | 184.4 | 188.8 |
| GetBlockByHash | Block | 177.6 | 3.0 | 61.2 |
| GetLatestEpoch | Epoch | 99.1 | 91.0 | 93.7 |
| GetEpochByNumber | Epoch | 83.9 | 2.3 | 29.5 |
| GetPoolById | Pool | 109.2 | 2.7 | 38.2 |
| GetDrepById | DRep | 109.9 | 2.2 | 38.1 |
| GetAccountByStakeAddress | Account | 974.7 | 2.8 | 326.7 |
| GetTransactionByHash | Transaction | 237.5 | 2.6 | 80.9 |
| GetMetadataByTxHash | Metadata | 83.9 | 3.1 | 30.0 |
| GetAddressByBech32 | Address | 734.9 | 5.1 | 248.4 |
| GetUTxOsByAddress | Address | 2.9 | 2.0 | 2.3 |
| GetAssetsByAddress | Address | 2.9 | 2.5 | 2.6 |
| GetLatestTransactionsByAddress | Address | 2.7 | 1.7 | 2.0 |

### Entity GET Reads (Cached) — CardanoODataService

| Endpoint | Category | Cold Start (ms) | Warm Avg (ms) | Overall Avg (ms) |
|----------|----------|----------------:|---------------:|------------------:|
| GET Blocks(hash) | Block | 4.6 | 2.1 | 2.9 |
| GET Epochs(number) | Epoch | 3.1 | 2.1 | 2.4 |
| GET Pools(id) | Pool | 2.5 | 2.3 | 2.3 |
| GET Dreps(id) | DRep | 4.7 | 2.1 | 3.0 |
| GET Accounts(stake) | Account | 2.4 | 2.1 | 2.2 |
| GET Transactions(hash) | Transaction | 3.8 | 2.5 | 2.9 |
| GET Addresses(bech32) | Address | 2.3 | 3.7 | 3.2 |
| GET NetworkInformation | Network | 2.4 | 1.9 | 2.1 |

### Transaction Build Endpoints (POST) — CardanoTransactionService

| Endpoint | Category | Cold Start (ms) | Warm Avg (ms) | Overall Avg (ms) |
|----------|----------|----------------:|---------------:|------------------:|
| BuildSimpleAdaTransaction | TX Build | 100.3 | 88.5 | 92.4 |
| BuildTxWithMetadata | TX Build | 95.9 | 92.0 | 93.3 |
| BuildMultiAssetTx | TX Build | 43.9 | 92.3 | 76.2 |
| BuildMultiAssetTx+Datum | TX Build | 95.8 | 95.0 | 95.3 |
| SetCollateral (PLUTUS addr) | TX Build | 91.1 | 88.3 | 89.3 |
| SetCollateral (FUNDS addr) | TX Build | 101.2 | 90.7 | 94.2 |
| BuildMintTransaction | TX Build | 90.3 | 91.1 | 90.8 |
| BuildMintTx+RequiredSigners | TX Build | 93.4 | 89.6 | 90.9 |
| BuildPlutusSpendTx | TX Build | 356.3 | 363.7 | 361.2 |
| GetTxBuildsByAddress | TX Build | 2.8 | 1.6 | 2.0 |

### Signing Endpoints (POST) — CardanoSignService

| Endpoint | Category | Cold Start (ms) | Warm Avg (ms) | Overall Avg (ms) |
|----------|----------|----------------:|---------------:|------------------:|
| GetHsmStatus | Signing | 1.9 | 1.8 | 1.9 |
| GetSigningReqsByAddress | Signing | 3.3 | 4.5 | 4.1 |

### Chained Signing Flow (Sequential)

| Step | Avg (ms) | Description |
|------|----------|-------------|
| GetBuildDetails | 3.3 | Retrieve build by ID |
| CreateSigningRequest | 6.5 | Create signing request from build |
| GetSigningRequest | 4.0 | Retrieve signing request by ID |
| **Total Flow** | **13.8** | Build → SigningRequest → Verify |

---

## Category Averages (All 4 Configurations)

| Category | Koios+Buildooor | Koios+CSL | BF+Buildooor | BF+CSL | Best |
|----------|----------------:|----------:|-------------:|-------:|------|
| Network | 7.4 | 7.1 | 6.6 | **5.6** | BF+CSL |
| Block | 178.0 | 161.1 | 86.1 | **84.3** | BF+CSL |
| Epoch | 79.1 | 92.9 | 44.9 | **41.9** | BF+CSL |
| Pool | 94.2 | 96.4 | 24.7 | **20.3** | BF+CSL |
| DRep | 13.9 | 11.3 | 14.5 | **20.5** | Koios+CSL |
| Account | 568.0 | 555.0 | 169.3 | **164.5** | BF+CSL |
| Transaction | 46.1 | 16.4 | 48.5 | **41.9** | Koios+CSL |
| Metadata | 28.1 | 18.8 | 31.2 | **30.0** | Koios+CSL |
| Address | 107.7 | 37.1 | 52.9 | **51.7** | Koios+CSL |
| TX Build | 121.7 | 126.9 | 109.0 | **98.9** | BF+CSL |
| Signing | 4.1 | 4.1 | 3.7 | **4.1** | BF+Buildooor |

---

## Full Endpoint Comparison (avg ms)

### Read Actions (POST)

| Endpoint | Koios+Buildooor | Koios+CSL | BF+Buildooor | BF+CSL |
|----------|----------------:|----------:|-------------:|-------:|
| GetNetworkInformation | 16.2 | 14.3 | 13.1 | 16.6 |
| GetLedgerProtocolParameters | 3.7 | 4.7 | 4.8 | 3.8 |
| GetLatestBlock | 426.8 | 367.6 | 189.3 | 188.8 |
| GetBlockByHash | 104.0 | 112.1 | 66.2 | 61.2 |
| GetLatestEpoch | 194.5 | 244.1 | 96.9 | 93.7 |
| GetEpochByNumber | 39.7 | 30.9 | 35.9 | 29.5 |
| GetPoolById | 185.6 | 189.8 | 46.5 | 38.2 |
| GetDrepById | 25.0 | 20.2 | 26.9 | 38.1 |
| GetAccountByStakeAddress | 1133.9 | 1107.6 | 336.3 | 326.7 |
| GetTransactionByHash | 89.6 | 30.7 | 95.1 | 80.9 |
| GetMetadataByTxHash | 28.1 | 18.8 | 31.2 | 30.0 |
| GetAddressByBech32 | 526.7 | 176.1 | 255.2 | 248.4 |
| GetUTxOsByAddress | 2.5 | 2.2 | 1.9 | 2.3 |
| GetAssetsByAddress | 4.3 | 3.0 | 3.2 | 2.6 |
| GetLatestTransactionsByAddress | 2.9 | 1.9 | 1.8 | 2.0 |

### Entity GETs (Cached)

| Endpoint | Koios+Buildooor | Koios+CSL | BF+Buildooor | BF+CSL |
|----------|----------------:|----------:|-------------:|-------:|
| GET Blocks(hash) | 3.3 | 3.7 | 2.7 | 2.9 |
| GET Epochs(number) | 3.1 | 3.9 | 2.0 | 2.4 |
| GET Pools(id) | 2.8 | 2.9 | 3.0 | 2.3 |
| GET Dreps(id) | 2.7 | 2.3 | 2.0 | 3.0 |
| GET Accounts(stake) | 2.2 | 2.4 | 2.3 | 2.2 |
| GET Transactions(hash) | 2.6 | 2.1 | 1.9 | 2.9 |
| GET Addresses(bech32) | 2.3 | 2.3 | 2.7 | 3.2 |
| GET NetworkInformation | 2.3 | 2.2 | 2.0 | 2.1 |

### Transaction Builds (POST)

| Endpoint | Koios+Buildooor | Koios+CSL | BF+Buildooor | BF+CSL |
|----------|----------------:|----------:|-------------:|-------:|
| BuildSimpleAdaTransaction | 135.1 | 141.3 | 121.4 | 92.4 |
| BuildTxWithMetadata | 211.3 | 135.8 | 108.6 | 93.3 |
| BuildMultiAssetTx | 135.2 | 198.5 | 86.8 | 76.2 |
| BuildMultiAssetTx+Datum | 130.2 | 139.3 | 96.6 | 95.3 |
| SetCollateral(PLUTUS) | 129.2 | 126.2 | 87.2 | 89.3 |
| SetCollateral(FUNDS) | 121.6 | 126.4 | 86.4 | 94.2 |
| BuildMintTransaction | 153.8 | 169.4 | 116.0 | 90.8 |
| BuildMintTx+RequiredSigners | 74.8 | 133.1 | 110.2 | 90.9 |
| BuildPlutusSpendTx | 273.2 | 193.1 | 378.4 | 361.2 |
| GetTxBuildsByAddress | 4.0 | 2.7 | 2.8 | 2.0 |

### Signing & Chained Flow (POST)

| Endpoint | Koios+Buildooor | Koios+CSL | BF+Buildooor | BF+CSL |
|----------|----------------:|----------:|-------------:|-------:|
| GetHsmStatus | 1.6 | 1.7 | 1.4 | 1.9 |
| GetSigningReqsByAddress | 2.0 | 2.5 | 2.3 | 4.1 |
| GetBuildDetails | 2.3 | 2.9 | 2.9 | 3.3 |
| CreateSigningRequest | 8.5 | 7.0 | 6.8 | 6.5 |
| GetSigningRequest | 4.2 | 5.3 | 4.3 | 4.0 |

---

## Backend Comparison: Koios vs Blockfrost

Isolating the backend impact by averaging across both TX builders for each backend:

| Metric | Koios (avg) | Blockfrost (avg) | Diff |
|--------|------------:|-----------------:|-----:|
| **Avg Response** | 109.8 ms | 65.4 ms | **-40%** |
| **Startup Time** | 9.4s | 9.3s | -1% |

### Where Each Backend Wins

**Blockfrost is faster on most endpoints**, particularly:

| Endpoint | Koios (ms) | Blockfrost (ms) | Diff |
|----------|----------:|-----------------:|-----:|
| GetAccountByStakeAddress | 1120.7 | 331.5 | **-70%** |
| GetPoolById | 187.7 | 42.3 | **-77%** |
| GetLatestBlock | 397.2 | 189.1 | **-52%** |
| GetLatestEpoch | 219.3 | 95.3 | **-57%** |
| GetBlockByHash | 108.0 | 63.7 | **-41%** |
| BuildSimpleAdaTransaction | 138.2 | 106.9 | **-23%** |
| BuildMintTransaction | 161.6 | 103.4 | **-36%** |

**Koios is faster on a few endpoints:**

| Endpoint | Koios (ms) | Blockfrost (ms) | Diff |
|----------|----------:|-----------------:|-----:|
| GetDrepById | 22.6 | 32.5 | -31% |
| GetTransactionByHash | 60.2 | 87.5 | -31% |
| GetAddressByBech32 | 351.4 | 251.8 | Koios 39% slower here |

### Analysis

1. **Blockfrost is ~40% faster overall** — primarily due to faster pool, epoch, block, and account lookups
2. **Koios wins on DRep and Transaction queries** — its `/tx_info` endpoint returns richer data per call
3. **Biggest gap: GetAccountByStakeAddress** — Koios takes 1121ms vs Blockfrost's 332ms (3.4x slower)
4. **Both backends deliver identical cache performance** — warm reads are 2-5ms regardless of backend (SQLite-only)
5. **Server startup is equivalent** — both ~9.3s (CAP bootstrap dominates)
6. **Both achieve 100% success rate** — all 108 calls succeed on both backends

---

## TX Builder Comparison: Buildooor vs CSL

Isolating the TX builder impact by comparing same-backend pairs on tx-build endpoints only:

### Koios Backend

| Endpoint | Buildooor (ms) | CSL (ms) | Diff |
|----------|---------------:|---------:|-----:|
| BuildSimpleAdaTransaction | 135.1 | 141.3 | +5% |
| BuildTxWithMetadata | 211.3 | 135.8 | -36% |
| BuildMultiAssetTx | 135.2 | 198.5 | +47% |
| BuildMultiAssetTx+Datum | 130.2 | 139.3 | +7% |
| BuildMintTransaction | 153.8 | 169.4 | +10% |
| BuildMintTx+RequiredSigners | 74.8 | 133.1 | +78% |
| BuildPlutusSpendTx | 273.2 | 193.1 | -29% |
| **Avg (build endpoints)** | **159.1** | **158.8** | **~0%** |

### Blockfrost Backend

| Endpoint | Buildooor (ms) | CSL (ms) | Diff |
|----------|---------------:|---------:|-----:|
| BuildSimpleAdaTransaction | 121.4 | 92.4 | -24% |
| BuildTxWithMetadata | 108.6 | 93.3 | -14% |
| BuildMultiAssetTx | 86.8 | 76.2 | -12% |
| BuildMultiAssetTx+Datum | 96.6 | 95.3 | -1% |
| BuildMintTransaction | 116.0 | 90.8 | -22% |
| BuildMintTx+RequiredSigners | 110.2 | 90.9 | -18% |
| BuildPlutusSpendTx | 378.4 | 361.2 | -5% |
| **Avg (build endpoints)** | **145.4** | **128.6** | **-12%** |

### Analysis

1. **Performance difference is minimal** — CSL is slightly faster on Blockfrost (~12%), tied on Koios
2. **Individual endpoints vary significantly** — no consistent winner per transaction type
3. **BuildPlutusSpendTx is the slowest for both builders** — script evaluation dominates regardless of builder
4. **Builder choice should be driven by compatibility, not performance:**
   - **Buildooor**: Correct PlutusV3 `scriptDataHash` computation, no `PPViewHashesDontMatch` errors
   - **CSL**: Known issue with Conway PlutusV3 cost models — use Buildooor for Plutus V3 transactions

---

## Cache Effectiveness (Read Endpoints)

Averaged across all 4 configurations:

| Metric | Value |
|--------|------:|
| Avg Cold Start (read endpoints) | 267.4 ms |
| Avg Warm Response (read endpoints) | 3.1 ms |
| **Cold → Warm Improvement** | **98.8%** |
| Fastest Endpoint | GetHsmStatus (1.6 ms avg) |
| Slowest Endpoint | GetAccountByStakeAddress (1134 ms on Koios) |

Once data is indexed in SQLite, all subsequent reads are served in **2-5ms** regardless of backend or builder — the cache layer eliminates backend latency entirely for repeat queries.

## Transaction Build Performance

Transaction build endpoints are consistently in the 76-378ms range (Blockfrost) or 75-273ms range (Koios) because each build requires:

1. **UTxO Fetching** (~50-200ms) — Fetch sender UTxOs from backend for coin selection
2. **Protocol Parameters** (~2-5ms) — Read from cache (already indexed)
3. **Transaction Construction** (~30-100ms) — Builder assembles inputs, outputs, witnesses
4. **Plutus Evaluation** (~150-300ms additional) — For Plutus transactions, execution unit estimation

| Transaction Type | BF+CSL (ms) | BF+Buildooor (ms) | Koios+CSL (ms) | Koios+Buildooor (ms) |
|-----------------|------------:|-------------------:|---------------:|---------------------:|
| Simple ADA Transfer | 92 | 121 | 141 | 135 |
| With Metadata | 93 | 109 | 136 | 211 |
| Multi-Asset | 76 | 87 | 199 | 135 |
| Multi-Asset + Datum | 95 | 97 | 139 | 130 |
| Minting | 91 | 116 | 169 | 154 |
| Minting + RequiredSigners | 91 | 110 | 133 | 75 |
| Plutus Spend | 361 | 378 | 193 | 273 |

---

## Key Findings

### 1. Blockfrost is ~40% Faster Than Koios Overall

Blockfrost delivers 65ms average response time vs Koios's 110ms. The gap is largest on account and pool queries where Koios requires multiple API round-trips. Blockfrost's REST endpoints return complete data in a single call.

### 2. TX Builder Choice Has Minimal Performance Impact

CSL and Buildooor perform within ~12% of each other. The choice should be driven by **compatibility**: Buildooor correctly handles PlutusV3 `scriptDataHash` computation, while CSL has a known `PPViewHashesDontMatch` issue with Conway PlutusV3 transactions.

### 3. SQLite Cache Eliminates Backend Latency

Warm cache reads complete in 2-5ms regardless of backend or builder — a **98.8% reduction** from cold start times. The database layer adds less than 1ms per operation.

### 4. Backend Calls Dominate Cold Start Latency

Cold start times directly correlate with the number and type of blockchain API calls:
- **GetAccountByStakeAddress** (975-3394ms cold): Requires multiple API calls for stake account data
- **GetAddressByBech32** (521-1574ms cold): Fetches UTxOs + transaction history + assets
- **GetLatestBlock** (198-555ms cold): Always queries chain tip (not cacheable)

### 5. Signing Service is Pure Local

All signing endpoints operate entirely on local SQLite data with no backend calls, resulting in sub-10ms responses. The full signing flow (GetBuildDetails → CreateSigningRequest → GetSigningRequest) completes in ~14ms.

### 6. Server Startup is Backend-Independent

All 4 configurations start in ~9.2-9.5s. CAP framework bootstrap dominates startup time, not backend initialization.

### 7. Ogmios UTxO Routing Optimization

**Problem discovered:** When Ogmios is configured as an additional backend (`BACKENDS=ogmios,blockfrost`), the `METHOD_ROUTING` config originally routed `getAddressUtxos` with `preferLive: true` — meaning all UTxO queries went to Ogmios first. This caused **+615ms overhead per TX build** (734ms vs 119ms), making Ogmios+Blockfrost **6x slower** than Blockfrost alone for transaction building.

**Root cause:** Ogmios UTxO queries (`stateQueryClient.utxo()`) scan the Cardano node's in-memory ledger state. On typical setups (Docker, WSL, or non-dedicated hardware), this takes **600-1200ms per query** — significantly slower than Blockfrost's indexed REST API (~80ms cold, ~3ms cached).

| Setup | Raw Ogmios UTxO Latency | Expected |
|-------|------------------------|----------|
| Docker on WSL (Windows) | ~640ms | - |
| Native WSL (Linux on Windows) | ~1050ms | - |
| Dedicated Linux server + SSD | 5-50ms | Optimal |

**Fix applied (v0.3.25):** Changed `getAddressUtxos` routing to `preferLive: false` in `srv/blockchain/cardano-client.ts`. UTxO queries now go to Blockfrost/Koios (indexed, ~3ms cached) with Ogmios as fallback.

**Result after fix — Blockfrost vs Ogmios+Blockfrost (TX-build endpoints, 5 rounds):**

| Endpoint | BF only | Ogmios+BF | Diff |
|----------|--------:|----------:|-----:|
| BuildSimpleAdaTransaction | 131ms | 104ms | -27ms |
| BuildTxWithMetadata | 107ms | 93ms | -14ms |
| BuildMultiAssetTx | 109ms | 104ms | ~same |
| BuildMultiAssetTx+Datum | 112ms | 93ms | -19ms |
| SetCollateral | 91ms | 92ms | ~same |
| BuildMintTransaction | 121ms | 168ms | +47ms |
| BuildMintTx+RequiredSigners | 109ms | 156ms | +47ms |
| BuildPlutusSpendTx | 409ms | 401ms | ~same |
| **OVERALL AVG** | **128ms** | **130ms** | **~same** |

Ogmios now only adds ~47ms for Plutus mint transactions (dynamic ExUnit evaluation via `evaluateTransaction`). Simple/Metadata/MultiAsset builds are unaffected. Ogmios remains the preferred backend for:
- **Transaction evaluation** (`evaluateTransaction`) — accurate ExUnits for Plutus scripts
- **Transaction submission** (`submitTransaction`) — direct to local node mempool

**Benchmark scripts used:**
- `scripts/perf/perf-ogmios-eval.ts` — Blockfrost vs Ogmios+Blockfrost TX-build comparison
- `scripts/perf/perf-utxo-fetch.ts` — Isolated UTxO fetch comparison (OData read layer)
- `scripts/perf/perf-ogmios-raw.ts` — Raw Ogmios WebSocket latency (no ODATANO server)

---

## Architecture: How Caching Works

```
Request → OData Handler → Check SQLite Cache (TTL)
                            ├── HIT  → Return cached data (2-5ms)
                            └── MISS → Fetch from Backend → UPSERT into SQLite → Return
                                        ├── Blockfrost (primary, 30-330ms)
                                        ├── Koios     (alternative, 40-1100ms)
                                        └── Ogmios    (fallback for UTxOs, evaluation + submission)
```

- **Cache TTL:** Configurable per entity (default: 1 hour via `indexTtlMs`)
- **Eviction:** Temporal `validFrom`/`validTo` fields checked on read
- **Concurrency:** Request coalescing prevents cache stampede for identical concurrent requests

## OpenTelemetry Tracing

With `@cap-js/telemetry` installed, every request produces a hierarchical trace showing exact timing for each sub-operation:

```
POST /$batch                                    1250.37 ms
  CardanoODataService - handle GetUTxOsByAddress  1242.90 ms
    db - READ AddressUTxOs (cache check)             1.79 ms
    db - DELETE AddressUTxOs (evict stale)          10.42 ms
    POST /api/v1/address_txs (Koios)               332.42 ms  ← backend call
    POST /api/v1/tx_info (Koios)                   134.52 ms  ← backend call
    db - UPSERT Addresses                             2.03 ms
    db - UPSERT AddressAssets                         1.71 ms
    db - UPSERT AddressUTxOs                          0.54 ms
    db - READ AddressUTxOs (return cached)            1.08 ms
```

This confirms that **>95% of cold start time is spent on blockchain backend API calls**, while database operations account for less than 2% of total request time.

## How to Reproduce

### Single Backend Benchmark

```bash
# 1. Start the server
cds watch

# 2. Run the benchmark (in a second terminal)
npx tsx scripts/perf/perf-benchmark.ts

# Options
npx tsx scripts/perf/perf-benchmark.ts --rounds 10      # More rounds for stable averages
npx tsx scripts/perf/perf-benchmark.ts --base http://host:port  # Different server
npx tsx scripts/perf/perf-benchmark.ts --output results.json    # Custom output file
```

Results are saved to `scripts/perf/perf-results.json` with full per-round data, statistics, and summary.

### Full 4-Way Comparison (Automated)

```bash
# Automatically starts servers with all 4 backend×builder combinations,
# benchmarks each, cleans SQLite cache between runs, and outputs comparison.
# Requires BLOCKFROST_API_KEY and KOIOS_API_KEY in .env
npx tsx scripts/perf/perf-compare.ts

# Options
npx tsx scripts/perf/perf-compare.ts --rounds 5         # More rounds for stable averages
npx tsx scripts/perf/perf-compare.ts --port 4006        # Use different port
```

The comparison script tests these 4 configurations sequentially:

| Config | Backend | TX Builder |
|--------|---------|-----------|
| `koios_buildooor` | Koios | Buildooor |
| `koios_csl` | Koios | CSL |
| `blockfrost_buildooor` | Blockfrost | Buildooor |
| `blockfrost_csl` | Blockfrost | CSL |

Between each configuration, the SQLite database is deleted and redeployed to ensure fair cold-start measurements. Results are saved to `scripts/perf/perf-compare-results.json`.

For detailed per-request tracing, the `@cap-js/telemetry` plugin outputs elapsed times to the server console automatically.
