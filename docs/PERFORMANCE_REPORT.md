# ODATANO Performance Report

> **⚠️ Historical benchmark (v1.7.x, dual-builder era).** This report was measured on
> 2026-03-08 when ODATANO shipped both the CSL and Buildooor transaction builders.
> **CSL was removed in v1.8.0** — Buildooor is now the sole builder, so every "CSL" row,
> column, "winner", and "Recommended Configuration" below is no longer applicable.
> The backend-only numbers (Koios / Blockfrost / Ogmios response times) remain
> representative; the builder comparison is retained for historical reference only.
> A Buildooor-only re-benchmark is pending.

## Overview

**Test Date:** 2026-03-08
**Runs:** 3 independent runs (20:17, 20:30, 20:37 UTC)
**Configurations:** 8 (Koios, Blockfrost, Ogmios+Koios, Ogmios+Blockfrost — each × Buildooor and CSL)
**Benchmark:** 3 rounds × 38 endpoints × 8 configs = 864 calls per run
**Success Rate:** 100% (2592/2592 across all 3 runs)

## Test Environment

| Parameter | Value |
|-----------|-------|
| Node.js | v22.11.0 |
| Platform | Windows (MSYS_NT-10.0) |
| Database | SQLite in-memory (`@cap-js/sqlite`) |
| Network | Cardano Preview Testnet |
| Server | SAP CAP `cds watch` (localhost:4005) |
| Cache | SQLite wiped + redeployed between each configuration |

---

## 8-Way Comparison: Overall Summary

### Run 1 (20:17 UTC)

| Rank | Configuration | Avg Response (ms) | Startup (s) |
|------|---------------|------------------:|------------:|
| 1 | **Ogmios+BF CSL** | **63.6** | 7.2 |
| 2 | Ogmios+BF Buildooor | 68.0 | 7.2 |
| 3 | Blockfrost CSL | 69.7 | 7.2 |
| 4 | Blockfrost Buildooor | 73.0 | 7.3 |
| 5 | Ogmios+Koios CSL | 83.1 | 7.2 |
| 6 | Ogmios+Koios Buildooor | 97.8 | 7.2 |
| 7 | Koios Buildooor | 159.6 | 9.4 |
| 8 | Koios CSL | 160.8 | 7.5 |

### Run 2 (20:30 UTC)

| Rank | Configuration | Avg Response (ms) | Startup (s) |
|------|---------------|------------------:|------------:|
| 1 | **Ogmios+BF CSL** | **60.8** | 7.2 |
| 2 | Ogmios+BF Buildooor | 65.6 | 7.2 |
| 3 | Blockfrost CSL | 65.8 | 7.3 |
| 4 | Blockfrost Buildooor | 71.2 | 7.3 |
| 5 | Ogmios+Koios Buildooor | 85.9 | 8.2 |
| 6 | Ogmios+Koios CSL | 96.8 | 7.1 |
| 7 | Koios Buildooor | 122.7 | 7.3 |
| 8 | Koios CSL | 137.8 | 7.5 |

### Run 3 (20:37 UTC)

| Rank | Configuration | Avg Response (ms) | Startup (s) |
|------|---------------|------------------:|------------:|
| 1 | **Ogmios+BF CSL** | **63.9** | 7.2 |
| 2 | Ogmios+BF Buildooor | 64.3 | 7.1 |
| 3 | Blockfrost CSL | 64.4 | 7.2 |
| 4 | Blockfrost Buildooor | 71.7 | 7.2 |
| 5 | Ogmios+Koios CSL | 80.3 | 7.1 |
| 6 | Ogmios+Koios Buildooor | 87.8 | 7.2 |
| 7 | Koios CSL | 126.5 | 7.5 |
| 8 | Koios Buildooor | 129.6 | 8.3 |

### Reproducibility (3 Runs)

| Configuration | Run 1 | Run 2 | Run 3 | Avg | Max Variance |
|---------------|------:|------:|------:|----:|---------:|
| Ogmios+BF CSL | 63.6 ms | 60.8 ms | 63.9 ms | **62.8 ms** | ±3.2% |
| Ogmios+BF Buildooor | 68.0 ms | 65.6 ms | 64.3 ms | **65.9 ms** | ±3.2% |
| Blockfrost CSL | 69.7 ms | 65.8 ms | 64.4 ms | **66.6 ms** | ±4.7% |
| Blockfrost Buildooor | 73.0 ms | 71.2 ms | 71.7 ms | **71.9 ms** | ±1.5% |
| Ogmios+Koios CSL | 83.1 ms | 96.8 ms | 80.3 ms | **86.7 ms** | ±11.6% |
| Ogmios+Koios Buildooor | 97.8 ms | 85.9 ms | 87.8 ms | **90.5 ms** | ±8.1% |
| Koios CSL | 160.8 ms | 137.8 ms | 126.5 ms | **141.7 ms** | ±13.5% |
| Koios Buildooor | 159.6 ms | 122.7 ms | 129.6 ms | **137.3 ms** | ±16.2% |

Blockfrost and Ogmios+Blockfrost show < 5% variance. Koios shows up to 16% variance due to external API latency. Ranking is stable across all 3 runs.

**Winner: Ogmios+Blockfrost CSL** at **62.8 ms** — 6% faster than standalone Blockfrost CSL (66.6 ms), 56% faster than pure Koios (137-142 ms).

---

## Response Time Summary (Ogmios+Blockfrost CSL, 3-run avg)

### Read Actions (POST) — CardanoODataService

| Endpoint | Category | Avg (ms) | Min (ms) | Max (ms) |
|----------|----------|----------|----------|----------|
| GetNetworkInformation | Network | 12.9 | 2.5 | 35.1 |
| GetLedgerProtocolParameters | Network | 4.4 | 2.5 | 8.8 |
| GetLatestBlock | Block | 103.9 | 85.9 | 125.9 |
| GetBlockByHash | Block | 70.9 | 2.2 | 235.4 |
| GetLatestEpoch | Epoch | 11.8 | 7.9 | 17.9 |
| GetEpochByNumber | Epoch | 35.3 | 2.7 | 117.7 |
| GetPoolById | Pool | 4.7 | 2.0 | 9.8 |
| GetDrepById | DRep | 37.6 | 1.8 | 135.7 |
| GetAccountByStakeAddress | Account | 5.4 | 2.0 | 13.6 |
| GetTransactionByHash | Transaction | 116.3 | 1.7 | 364.8 |
| GetMetadataByTxHash | Metadata | 42.0 | 2.2 | 143.5 |
| GetAddressByBech32 | Address | 409.0 | 2.5 | 1290.7 |
| GetUTxOsByAddress | Address | 2.4 | 1.5 | 3.7 |
| GetAssetsByAddress | Address | 2.6 | 2.2 | 3.5 |
| GetLatestTransactionsByAddress | Address | 2.6 | 1.7 | 5.8 |

### Transaction Builds (POST) — CardanoTransactionService

| Endpoint | Category | Avg (ms) | Min (ms) | Max (ms) |
|----------|----------|----------|----------|----------|
| BuildSimpleAdaTransaction | TX Build | 112.6 | 95.8 | 133.2 |
| BuildTxWithMetadata | TX Build | 109.7 | 96.7 | 122.6 |
| BuildMultiAssetTx | TX Build | 111.1 | 99.7 | 125.3 |
| BuildMultiAssetTx+Datum | TX Build | 104.5 | 89.4 | 124.3 |
| SetCollateral(PLUTUS) | TX Build | 96.0 | 87.0 | 109.2 |
| SetCollateral(FUNDS) | TX Build | 92.2 | 78.9 | 100.2 |
| BuildMintTransaction | TX Build | 167.5 | 134.2 | 220.8 |
| BuildMintTx+RequiredSigners | TX Build | 159.5 | 139.2 | 177.3 |
| BuildPlutusSpendTx | TX Build | 432.6 | 408.9 | 478.9 |

### Signing (POST) — CardanoSignService

| Endpoint | Avg (ms) |
|----------|----------|
| GetHsmStatus | 1.6 |
| GetSigningReqsByAddress | 2.8 |
| GetBuildDetails → CreateSigningRequest → GetSigningRequest | **~17.7 total** |

---

## Full 8-Way Endpoint Comparison (3-run avg, ms)

### Read Actions

| Endpoint | Koios BDR | Koios CSL | BF BDR | BF CSL | O+K BDR | O+K CSL | O+BF BDR | O+BF CSL |
|----------|----------:|----------:|-------:|-------:|--------:|--------:|---------:|---------:|
| GetNetworkInfo | 19.5 | 14.2 | 14.3 | 10.9 | 12.9 | 12.0 | 21.4 | **12.9** |
| GetProtocolParams | 4.7 | 6.4 | 6.4 | 4.8 | 3.8 | 4.5 | 5.0 | **4.4** |
| GetLatestBlock | 689.7 | 513.3 | 193.2 | 191.0 | 381.8 | 363.6 | 104.0 | **103.9** |
| GetBlockByHash | 223.0 | 222.5 | 67.1 | 64.2 | 253.5 | 173.5 | 73.1 | **70.9** |
| GetLatestEpoch | 364.6 | 572.6 | 99.1 | 98.2 | 12.6 | 10.4 | 10.7 | **11.8** |
| GetEpochByNumber | 122.5 | 126.4 | 38.1 | 37.2 | 33.1 | 29.8 | 34.4 | **35.3** |
| GetPoolById | 277.7 | 124.1 | 61.1 | 36.9 | 6.1 | 4.7 | 4.8 | **4.7** |
| GetDrepById | 54.6 | 81.6 | 48.9 | 31.9 | 26.3 | 31.0 | 39.3 | **37.6** |
| GetAccountByStakeAddr | 1045.2 | 1217.3 | 387.2 | 345.2 | 5.7 | 5.3 | 5.0 | **5.4** |
| GetTransactionByHash | 43.7 | 82.9 | 111.4 | 95.8 | 110.2 | 107.3 | 106.8 | **116.3** |
| GetMetadataByTxHash | 30.2 | 52.9 | 35.6 | 33.6 | 34.9 | 35.1 | 34.1 | **42.0** |
| GetAddressByBech32 | 510.4 | 493.3 | 249.7 | 265.2 | 404.1 | 385.3 | 425.0 | **409.0** |
| GetUTxOsByAddress | 2.4 | 2.2 | 1.9 | 2.1 | 3.2 | 2.5 | 3.2 | **2.4** |
| GetAssetsByAddress | 3.1 | 2.6 | 2.6 | 2.5 | 3.7 | 2.6 | 2.5 | **2.6** |
| GetLatestTxsByAddr | 2.5 | 3.0 | 2.4 | 2.4 | 3.8 | 2.3 | 2.9 | **2.6** |

### Transaction Builds

| Endpoint | Koios BDR | Koios CSL | BF BDR | BF CSL | O+K BDR | O+K CSL | O+BF BDR | O+BF CSL |
|----------|----------:|----------:|-------:|-------:|--------:|--------:|---------:|---------:|
| BuildSimpleAdaTx | 154.5 | 189.4 | 108.4 | 96.5 | 183.0 | 135.4 | 111.5 | **112.6** |
| BuildTxWithMetadata | 150.4 | 158.1 | 102.6 | 102.0 | 159.0 | 132.7 | 113.1 | **109.7** |
| BuildMultiAssetTx | 155.9 | 155.0 | 98.4 | 94.3 | 163.1 | 148.8 | 98.8 | **111.1** |
| BuildMultiAssetTx+Datum | 147.5 | 147.4 | 101.0 | 98.9 | 151.4 | 139.3 | 103.7 | **104.5** |
| SetCollateral(PLUTUS) | 134.3 | 135.8 | 94.4 | 89.0 | 134.7 | 152.9 | 96.5 | **96.0** |
| SetCollateral(FUNDS) | 126.6 | 126.6 | 99.6 | 82.6 | 125.6 | 185.3 | 95.6 | **92.2** |
| BuildMintTx | 147.8 | 190.8 | 129.5 | 104.5 | 226.1 | 254.5 | 175.6 | **167.5** |
| BuildMintTx+ReqSigners | 163.5 | 139.7 | 107.9 | 94.8 | 250.6 | 189.6 | 165.1 | **159.5** |
| BuildPlutusSpendTx | 351.6 | 301.2 | 400.8 | 381.0 | 344.2 | 439.8 | 455.8 | **432.6** |

---

## Backend Comparison

### Ogmios Eliminates Slow Queries

| Endpoint | Pure Koios | Ogmios+Koios | Improvement | Pure BF | Ogmios+BF | Improvement |
|----------|----------:|-----------:|:-----------:|-------:|----------:|:-----------:|
| GetAccountByStakeAddr | 1131 ms | **5.5 ms** | **99.5%** | 366 ms | **5.2 ms** | **98.6%** |
| GetPoolById | 201 ms | **5.4 ms** | **97.3%** | 49 ms | **4.8 ms** | **90.2%** |
| GetLatestEpoch | 469 ms | **11.5 ms** | **97.5%** | 99 ms | **11.3 ms** | **88.6%** |
| GetLatestBlock | 602 ms | 373 ms | 38.0% | 192 ms | **104 ms** | 45.8% |

### Standalone: Koios vs Blockfrost

| Metric | Koios | Blockfrost | Diff |
|--------|------:|-----------:|-----:|
| Avg Response | 139.5 ms | 69.3 ms | **-50%** |
| Startup | 7.9s | 7.2s | -9% |

### Hybrid: Ogmios+Koios vs Ogmios+Blockfrost

| Metric | Ogmios+Koios | Ogmios+BF | Diff |
|--------|-------------:|----------:|-----:|
| Avg Response | 88.6 ms | 64.4 ms | **-27%** |
| Startup | 7.3s | 7.2s | ~same |

---

## TX Builder Comparison: Buildooor vs CSL (3-run avg)

### Blockfrost Backend

| Endpoint | Buildooor (ms) | CSL (ms) | Diff |
|----------|---------------:|---------:|-----:|
| BuildSimpleAdaTx | 108.4 | 96.5 | -11% |
| BuildMultiAssetTx | 98.4 | 94.3 | -4% |
| BuildMintTx | 129.5 | 104.5 | -19% |
| BuildPlutusSpendTx | 400.8 | 381.0 | -5% |
| **Avg (build endpoints)** | **149.8** | **138.9** | **-7%** |

### Ogmios+Blockfrost Backend

| Endpoint | Buildooor (ms) | CSL (ms) | Diff |
|----------|---------------:|---------:|-----:|
| BuildSimpleAdaTx | 111.5 | 112.6 | +1% |
| BuildMultiAssetTx | 98.8 | 111.1 | +12% |
| BuildMintTx | 175.6 | 167.5 | -5% |
| BuildPlutusSpendTx | 455.8 | 432.6 | -5% |
| **Avg (build endpoints)** | **174.8** | **171.1** | **-2%** |

**Conclusion:** Performance difference is minimal (~2-7%). Builder choice should be driven by **compatibility**: Buildooor handles PlutusV3 correctly, CSL has a known `PPViewHashesDontMatch` issue with Conway PlutusV3.

---

## Cache Effectiveness

| Metric | Value |
|--------|------:|
| Avg Cold Start (read endpoints) | 245 ms |
| Avg Warm Response (cached) | 2.7 ms |
| **Cold → Warm Improvement** | **98.9%** |

Once indexed in SQLite, all reads serve in **2-5ms** regardless of backend or builder.

---

## Key Findings

1. **Ogmios+Blockfrost CSL is fastest** — 62.8ms avg, 6% faster than standalone Blockfrost (66.6ms)
2. **Ogmios eliminates Koios's weakness** — GetAccountByStakeAddress drops from 1131ms to 5.5ms (99.5%)
3. **Blockfrost is 50% faster than Koios** standalone (69ms vs 140ms)
4. **TX builder choice is about compatibility, not speed** — CSL vs Buildooor differ by <7%
5. **SQLite cache equalizes all backends** — warm reads 2-5ms regardless of config (98.9% reduction)
6. **BuildPlutusSpendTx is the universal bottleneck** — 301-456ms (script evaluation dominates)
7. **Signing is pure local** — sub-4ms, full flow ~18ms
8. **Blockfrost configs show < 5% variance**, Koios up to 16% due to external API latency
9. **100% reliability** — 2592/2592 calls succeeded
---

## Caching Architecture

```
Request → OData Handler → Check SQLite Cache (TTL)
                            ├── HIT  → Return cached data (2-5ms)
                            └── MISS → Fetch from Backend → UPSERT → Return
                                        ├── Ogmios    (live: pools, accounts, epochs)
                                        ├── Blockfrost (historical: blocks, txs, addresses)
                                        └── Koios     (alternative to Blockfrost)
```

Cache TTL: 1 hour default (`indexTtlMs`). Request coalescing prevents cache stampede.

## Recommended Configuration

| Use Case | Configuration | Avg Response |
|----------|--------------|-------------:|
| **Production (Ogmios available)** | Ogmios+Blockfrost CSL | **62.8 ms** |
| **Production (no Ogmios)** | Blockfrost CSL | **66.6 ms** |
| **Plutus V3 transactions** | Ogmios+Blockfrost Buildooor | **65.9 ms** |
| **Free tier / no API keys** | Ogmios+Koios CSL | **86.7 ms** |

## How to Reproduce

```bash
# Full 8-way comparison (automated server start/stop, cache wipe between configs)
# Requires BLOCKFROST_API_KEY, KOIOS_API_KEY, and OGMIOS_URL in .env
npx tsx scripts/perf/perf-compare.ts
npx tsx scripts/perf/perf-compare.ts --rounds 5 --port 4006
```

### Raw Result Files

- [`perf-compare-results_run1.json`](../scripts/perf/perf-compare-results_run1.json) — Run 1 (20:17 UTC)
- [`perf-compare-results_run2.json`](../scripts/perf/perf-compare-results_run2.json) — Run 2 (20:30 UTC)
- [`perf-compare-results_run3.json`](../scripts/perf/perf-compare-results_run3.json) — Run 3 (20:37 UTC)
