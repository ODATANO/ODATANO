# Project Close-Out Report

## Name of Project and Project URL

**ODATANO — SAP Cardano OData V4 API with CAP and SAP Cardano SDK**

https://projectcatalyst.io/funds/14/sponsored-by-leftovers/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk

## Project Number

1400109

## Name of Project Manager

Maximilian Weber

## Date Project Started

November 2025

## Date Project Completed

April 2026

## List of Challenge KPIs and How the Project Addressed Them

**Challenge:** Enabling enterprise adoption of Cardano through a open source ODATA V4 API deployable in SAP BTP via Cloud Foundry. 

| Challenge KPI | How Addressed |
|--------------|---------------|
| Open-source tooling for Cardano | Published under Apache 2.0 on GitHub and npm (`@odatano/core`) |
| Enterprise integration capability | Built on SAP CAP(Cloud Application Model) which provides managed Services, high availability, and easy integration with SAP solutions across multi-Cloud infrastructre |
| Developer accessibility | Standard OData V4 protocol with Cardano specific Entitys & Actions. SAP developers need zero Blockchain knowledge to acess Cardano specific Data and perform Cardano specific Actions  |
| Production readiness | 1285 automated tests, 99% statement coverage, Integration tests running against preview network |
| Community engagement | Milestone demo videos, public repository, Catalyst milestone reviews, Homepage, X Account SAP Blog Article and more |

## List of Project KPIs and How the Project Addressed Them

| Project KPI | Target | Achieved |
|------------|--------|----------|
| OData entities defined | 15+ | **29 CDS entities** |
| Read action endpoints | 10+ | **15 read actions** across 9 categories |
| Transaction actions | 5+ | **8 transaction build actions** + 8 signing actions |
| Blockchain backends | 2+ | **3 backends** (Blockfrost, Koios, Ogmios) with automatic failover |
| Automated tests | 100+ | **1285 tests** (unit + integration) |
| Code coverage | 70%+ | **99% statement coverage** |
| Warm response time | < 500ms | **< 5ms avg** (96.5% cache speedup) |
| Network support | 2+ | **3 networks** (mainnet, preview, preprod) |
| Smart contract support | Basic | **Full Plutus V3** — mint, spend, parameterized validators, inline datums etc. |
| Documentation | Setup guide | **10+ guides** (Quick Start, User Guide, Developer Guide, Security, Production Deployment, Docker, SAP Integration, Backend Config, Transaction Workflow) |

## Key Achievements

**Milestone 1: Read Operations (January 2026)**
- Fully functional OData V4 service with 18 entities and 15 read actions
- Multi-backend architecture with Blockfrost (primary) and Koios (fallback) with fallback logic 
- Lazy on-demand indexing into SQLite (dev) & SAP HANA (prod) with TTL-based cache refresh
- Standalone Docker deployment, CI/CD pipeline with multi-Node.js version testing
- 340 automated tests with 96% code coverage

**Milestone 2: Transaction Building (February 2026)**
- Build → Sign → Submit transaction flow for ADA and native assets
- Dual transaction builder support implementation (Cardano Serialization Library + Harmoniclabs Buildooor)
- Fee estimation, coin selection, multi-asset transfers
- Plutus smart contract support (lock, spend, mint with parameterized validators)
- 740 automated tests with 97% code coverage

**Milestone 3: External Signing & Wallet Integration (March 2026)**
- CardanoSignService with 8 signing actions for CIP-30 browser wallets, CLI, and HSM
- Signing request state machine (pending → verified → submitted)
- HSM integration via PKCS#11 for enterprise hardware security modules
- Fiori Wallet Viewer application with real-time wallet visualization
- ABAP integration examples (8 classes) for SAP ERP systems
- 1285 automated tests with 99% code coverage

**Cross-Cutting Achievements:**
- Published on npm as `@odatano/core` — installable as a CAP plugin with a single `npm install`
- N+1 query optimization reducing test runtime by 37% (request coalescing, batch backend calls)
- Code review: all 31 findings resolved (5 critical, 7 high, 11 medium, 8 low)
- Authentication: `@requires: 'authenticated-user'` on all services, XSUAA for production
- Performance monitoring via `@cap-js/telemetry` OpenTelemetry integration

## Impact

### Measurable Data

| Metric | Value |
|--------|-------|
| Total automated tests | 1,285 |
| Statement coverage | 99% |
| OData endpoints | 23 (15 actions + 8 entity reads) |
| CDS entities | 29 |
| Avg warm response time | 3.93 ms |
| Cache speedup (cold → warm) | 96.5% |
| Blockchain backends supported | 3 (Blockfrost, Koios, Ogmios) |
| Cardano networks supported | 3 (preview, preprod, mainnet) |
| Documentation guides | 10+ |
| ABAP integration examples | 8 classes |
| Postman collections | 3 (one per Service & Milestone) |
| npm package | @odatano/core (public) |

### Enterprise Use Cases Enabled

- **Audit & Compliance:** Query transaction history, metadata, and block confirmations via standard OData filters
- **Supply Chain Tracking:** Mint NFTs with inline datums, transfer custody with Plutus spend validators
- **Sustainability Reporting:** Track on-chain carbon credit tokens, query asset holdings by address
- **Payment Processing:** Build, sign, and submit ADA/token transfers from SAP workflows
- **SAP ERP Integration:** ABAP classes for direct Cardano access from SAP non Cloud Systems

## Why Is This Project Important?

ODATANO bridges two worlds that have never been connected before: the SAP enterprise ecosystem used by 77% of the world's transaction revenue and the Cardano blockchain.

Before ODATANO, an SAP developer who wanted to read a Cardano address details or submit a payment had to learn Cardano-specific APIs, handle CBOR serialization, manage blockchain providers, build custom caching layers, and learn specific Input/Output logic for building Transactions. This is a months-long effort that most enterprise teams cannot justify to integrate Cardano into there SAP workflows.

With ODATANO, that same developer writes a standard OData query, the same protocol they use every day for SAP data. A transaction lookup is `GET /Transactions('hash')`. A wallet balance check is `POST /GetAddressByBech32`. Building and submitting a payment is just three OData calls. (Build/Sign/Submit). No deep blockchain knowledge required.

This matters for Cardano adoption because:

1. **Scale of reach:** SAP serves 400,000+ customers globally. ODATANO makes Cardano accessible to every SAP developer through a protocol they already know.
2. **Production-grade:** 1285 tests, 99% coverage, HSM signing, XSUAA authentication. ODATANO is enterprise-ready, not just a proof of concept.
3. **Zero friction:** `npm install @odatano/core` and add three lines of config. The CAP plugin auto-registers services, auto-discovers models, and handles all blockchain complexity internally.
4. **Open standard:** OData V4 is an OASIS/ISO standard. ODATANO doesn't lock enterprises into a proprietary SDK any OData client (SAP, Microsoft, Salesforce, or any custom OData Consumer) can consume the API.

The Cardano community should be excited because ODATANO opens the door to real enterprise transaction volume on Cardano, not just through theoretical whitepapers, but through production-ready tooling that speaks the language enterprises already use.

## Links to Relevant Project Sources and Documents

### Repository & Package
- **GitHub:** https://github.com/ODATANO/ODATANO
- **npm:** https://www.npmjs.com/package/@odatano/core
- **License:** Apache 2.0

### Documentation
- Quick Start Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/QUICK_START.md
- User Guide (API Reference): https://github.com/ODATANO/ODATANO/blob/main/docs/guides/USER_GUIDE.md
- Developer Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/DEVELOPER_GUIDE.md
- Transaction Workflow: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/TRANSACTION_WORKFLOW.md
- Security Guide: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/SECURITY_GUIDE.md
- Production Deployment: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/PRODUCTION_DEPLOYMENT.md
- Docker Deployment: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/DOCKER_DEPLOYMENT.md
- Backend Configuration: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/BACKEND_CONFIGURATION.md
- SAP Integration Examples: https://github.com/ODATANO/ODATANO/blob/main/docs/guides/SAP_INTEGRATION_EXAMPLES.md
- Performance Report: https://github.com/ODATANO/ODATANO/blob/main/docs/PERFORMANCE_REPORT.md

### Milestone Deliverables
- Milestone 1 (Read Operations): https://milestones.projectcatalyst.io/projects/1400109/milestones/1
- Milestone 2 (Transaction Building): https://milestones.projectcatalyst.io/projects/1400109/milestones/2
- Milestone 3 (External Signing): https://milestones.projectcatalyst.io/projects/1400109/milestones/3
- Milestone 4 (Final Close-Out): https://milestones.projectcatalyst.io/projects/1400109/milestones/4

### Demo Videos
- Milestone 1 Demo: https://www.youtube.com/watch?v=jDw6MXgbfR0
- Milestone 2 Demo: https://www.youtube.com/watch?v=oFUJ-tN1QCE
- Milestone 3 Demo (Wallet Viewer & Signing): https://youtu.be/TzIXRoPZDqA

### Test Evidence
- CI/CD Pipeline: https://github.com/ODATANO/ODATANO/actions/workflows/test.yaml
- Code Coverage: https://codecov.io/gh/ODATANO/ODATANO

## Link to Close-Out Video

<!-- TODO: Replace with YouTube/Vimeo link after recording -->
