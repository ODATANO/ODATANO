# ODATANO

## Making Blockchain Enterprise-Native with OData

**Whitepaper — Version 1.1 (Revised)**
**April 2026**
**Author:** Maximilian Weber
**Project:** ODATANO (Cardano Catalyst Fund 14)
**Repository:** https://github.com/ODATANO/ODATANO
**Package:** @odatano/core — v1.0.0
**License:** Apache 2.0

---

## Abstract

Enterprise blockchain integration remains unnecessarily complex. Public blockchains offer permissionless, trustless infrastructure, but the interface between enterprise software and blockchain systems still relies on wallet extensions, raw node APIs, provider-specific indexers, CBOR payloads, and custom SDKs. Enterprises need stable service contracts, typed data models, discoverable metadata, and integration patterns that fit existing workflows.

OData, an OASIS-standardized protocol, already solves these problems for business data: typed entities, navigable relationships, machine-readable metadata, and a uniform query language. SAP uses OData as the standard protocol for modern client applications, with CAP and SAP Fiori built around OData V4 semantics.

ODATANO applies this proven standard to Cardano. It exposes the chain through a CAP-based OData V4 interface, allowing blockchain data and transactions to be accessed using enterprise-native patterns. As of April 2026, ODATANO has shipped v1.0 with 1,285 tests at 99% statement coverage and completed three of four Catalyst Fund 14 milestones.

**Core thesis:** enterprise blockchain adoption will scale only when blockchains are accepted as an enterprise service layer, not through low-level tooling alone.

---

## Table of Contents

1. Why I Built ODATANO
2. Why OData Matters More Than Most Blockchain Projects Realize
3. Technical Background
4. The Missing Layer in Enterprise Blockchain
5. What ODATANO Actually Is
6. Security and Governance Model
7. Why This Approach Is Different
8. Why OData and Blockchain Matter in the Agentic Age
9. Why Cardano Is the Right Foundation
10. Where the Project Stands Today
11. Evidence and Verification
12. Why ODATANO Matters for Investors, Partners, and the Cardano Community
13. The Vision Beyond "Just an API"
14. Future Development
15. Conclusion

---

## 1. Why I Built ODATANO

I developed ODATANO to address a fundamental flaw in enterprise blockchain integration.

Most blockchain solutions expose nodes, SDKs, indexers, wallet flows, signing mechanisms, and provider-specific endpoints. While suitable for infrastructure, these do not meet enterprise requirements. Enterprise software relies on contracts, abstraction, governance, interoperability, and predictable integration.

In SAP environments, this is even more pronounced. SAP uses OData as its standard protocol for modern applications, particularly browser-based UIs and native mobile apps, with SAP Fiori relying on OData for data transfer. CAP also centers OData V4 semantics and recommends its annotations over older SAP-specific extensions. There is already a mature language for exposing business data and operations: OData, not raw blockchain RPC or a custom REST dialect.

This led me to a simple question:

*What if Cardano could be consumed the way enterprises already consume business services?*

ODATANO is the answer to that question.

---

## 2. Why OData Matters More Than Most Blockchain Projects Realize

Many view OData as just another API style. In reality, it is critical enterprise infrastructure.

The OASIS OData specification defines OData as a protocol for creating REST-based data services in which resources are identified by URLs, structured using an Entity Data Model, and published and edited via simple HTTP messages. The standard includes machine-readable metadata, formal data modeling, query semantics, and operations. OData solves a problem enterprises constantly face: the cost of ambiguity at the service boundary.

A typical REST API may return JSON, yet clients still require custom documentation for filtering, sorting, relationships, paging, operations, and semantics. OData standardizes these elements, giving consumers a discoverable model, uniform query conventions, and a metadata contract understood by tools and developers.

This is one reason SAP adopted it so deeply. SAP describes OData as the standard protocol for new client applications, noting that OData services provide efficient access to only the data requested. OData is used across Gateway, Fiori, and CAP-based developments. The key insight is this:

**OData is more than a transport format. It is a trusted enterprise integration model.**

For blockchain to progress beyond proofs of concept, it must adopt integration models that enterprises can govern effectively.

---

## 3. Technical Background

This section outlines the standards and technologies that underpin ODATANO: the OData protocol, the Cardano blockchain model, the Cardano Improvement Proposals (CIPs) that ODATANO implements, and SAP CAP as the service runtime.

OData v4.01 and CSDL are standardized by OASIS Open and published as an OASIS specification. OData is a web protocol that allows data to be accessed and managed over HTTP using standard options such as `$filter` (to filter results), `$select` (to choose specific columns), `$orderby` (to sort results), `$count` (to count results), `$top` (to limit the number of returned records), `$skip` (to skip records), and `$expand` (to include related data). The Common Schema Definition Language (CSDL) defines the service's entity model in a machine-readable way. This enables tools to automatically generate code and clients to access data without writing custom integration code.

OASIS notes that OData URL conventions are "recommended but not required," meaning implementations may vary in which query options and behaviors they support. ODATANO targets comprehensive OData V4 query support within the scope of what SAP CAP's OData runtime provides, and conformance is validated through client interoperability with SAP Fiori, SAP API Management, and standard OData client libraries.

Cardano's Extended UTxO model means it tracks funds as separate individual outputs, called "Unspent Transaction Outputs" (eUTxO), rather than as one balance per account. In this model, each transaction uses specific outputs as inputs and creates new outputs, ensuring predictable, local, and verifiable results without unknown changes from elsewhere in the system.

This model maps naturally to OData entities. Each UTxO is a discrete, addressable resource with typed fields (value, datum, address). Transactions are structured operations with explicit inputs and outputs. The deterministic nature of eUTxO aligns with OData's expectation that service operations have predictable, well-defined semantics.

### Cardano Improvement Proposals

ODATANO implements several Cardano standards:

- **CIP-30** defines a way for web applications to connect to Cardano wallets through a browser JavaScript interface, known as the dApp–wallet web bridge. It is the de facto standard for browser wallet integration on Cardano. ODATANO uses CIP-30 to allow enterprise applications in the browser to sign Cardano transactions externally, without exposing private keys directly to the application.
- **CIP-20** specifies how to add notes or details to Cardano transactions using a specific JSON format (the metadata label 674). ODATANO supports this format for attaching structured business information to transactions on the blockchain.
- **CIP-14** defines the user-facing asset fingerprint (`asset1...`) as a bech32-encoded Blake2b-160 digest of the policy ID concatenated with the asset name. ODATANO computes and returns CIP-14 fingerprints in transaction build responses for display and cross-referencing with block explorers.

SAP's Cloud Application Programming Model (CAP) is a framework for building enterprise data services using a shared, declarative data model (CDS, or Core Data Services). It handles data queries and allows for adding features through plugins. ODATANO installs as a CAP plugin: a single entry point file registers ODATANO's three OData services, and CAP merges ODATANO's data models into the SAP application at startup. Any SAP CAP project can enable Cardano blockchain functions by installing ODATANO and adding a configuration block, with no changes to existing application code.

To deploy ODATANO, several prerequisites should be met. The target environment should run SAP CAP version 9.0 or later, with Node.js 20.x or 22.x supported for runtime execution. ODATANO requires the underlying infrastructure to allow outbound HTTPS connections to Cardano network providers (such as Blockfrost, Koios, and Ogmios) and sufficient file system access for logging and configuration. npm or a compatible package manager is required to install the `@odatano/core` module. Optionally, Hardware Security Module (HSM) integration depends on PKCS#11-compatible drivers present in the system.

---

## 4. The Missing Layer in Enterprise Blockchain

The blockchain industry has improved consensus, wallets, developer tools, smart contracts, and infrastructure. Yet a gap remains between blockchain capability and enterprise adoption.

Enterprises usually need all of the following at once:

- structured, typed services
- clean read/write boundaries
- metadata-driven integration
- auditable operations
- support for role separation and external signing
- compatibility with existing UI and middleware stacks
- interfaces that do not require every SAP or ABAP developer to become a blockchain specialist

ODATANO is designed to fill that missing layer. It is an SAP CAP-based service that exposes the Cardano blockchain through a standardized OData V4 interface, enabling secure on-chain data access and transaction execution. It allows enterprise applications to use Cardano through familiar OData patterns, without requiring deep protocol knowledge.

**The goal: shift blockchain from an infrastructure specialty to a consumable enterprise service.**

---

## 5. What ODATANO Actually Is

ODATANO is not a generic blockchain dashboard and not a thin wrapper over a single provider API. It is an enterprise-oriented integration layer built on SAP CAP that maps Cardano into an OData-native service model.

The platform is composed of three OData V4 services that together cover the full enterprise lifecycle of blockchain interaction:

**Read Service** (`/odata/v4/cardano-odata`): 18 entities and 15 actions covering Cardano core components: network information, blocks, epochs, transactions and their inputs/outputs, addresses, UTxOs, assets, stake pools, accounts, DReps, and ledger protocol parameters. Targets comprehensive OData V4 query support, including `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`, and `$count`, within the scope of what SAP CAP's OData runtime provides.

**Transaction Service** (`/odata/v4/cardano-transaction`): 8 entities and 11 actions for the full Build → Sign → Submit lifecycle. Supports simple ADA transfers, multi-asset transfers, native token minting, CIP-20 metadata transactions, and Plutus V3 spend transactions, including collateral configuration. Built on a dual-builder architecture (Cardano Serialization Library + Buildooor) with Ogmios as a live backend for protocol parameters and UTxO queries.

**Signing Service** (`/odata/v4/cardano-sign`): 5 entities and 8 actions for controlled signing flows. Supports external signing through CIP-30 wallets and the Cardano CLI with full key separation (no private-key handling in the CAP service), as well as optional server-side signing via PKCS#11-compatible Hardware Security Modules.

**In total:** 31 entities and 34 actions across three services, built as a CAP plugin that can be dropped into any existing SAP CAP project with a single npm install. Multi-network support spans mainnet, preview, and preprod. Multi-provider failover covers Blockfrost, Koios, and Ogmios. Published as `@odatano/core` on npm under Apache 2.0.

The architecture behind these services is designed for enterprise reliability. A multi-backend orchestrator routes each request to the appropriate blockchain provider with automatic failover — if Blockfrost times out, the request is retried against Koios or Ogmios without consumer intervention. A lazy on-demand indexing layer fetches blockchain data only on cache miss and persists it locally via UPSERT with TTL-based refresh, keeping response times low without requiring a full chain sync. Transaction building uses a dual-builder architecture: the Cardano Serialization Library (CSL) and Buildooor operate as interchangeable backends, allowing the service to route around builder-specific limitations (for example, CSL's PlutusV3 scriptDataHash issue is avoided by falling back to Buildooor).

From a scalability perspective, ODATANO is designed to meet enterprise demands. The CAP-based service architecture supports both horizontal and vertical scaling: additional application instances can be deployed behind standard load balancers, while individual instances benefit from CAP's asynchronous service handling and stateless transaction building. The platform supports concurrent transaction flows and parallel blockchain queries. Measured performance on the Cardano Preview testnet shows sub-5 ms warm response times for cached entity reads and 52–64 ms average across all endpoints with the optimal backend configuration (Ogmios + Blockfrost). Full benchmark results are documented in Section 11.

---

## 6. Security and Governance Model

Enterprise blockchain adoption requires more than functional correctness. It requires a security and governance model that fits into existing enterprise controls. ODATANO addresses this through four design decisions.

### External Signing by Design

ODATANO never holds private keys. The CAP service builds unsigned transactions and returns them as CBOR hex. Signing happens externally. The signed transaction is returned to ODATANO via CIP-30 browser wallets, Cardano CLI, or an HSM for verification and submission.

The signing workflow follows an explicit state machine: `pending → signed → verified → submitted`, with `expired` and `failed` as terminal states. Each signing request carries a configurable TTL (default: 30 minutes). This separation means the service that builds transactions and the system that holds signing keys are architecturally distinct, a requirement in most enterprise security models.

### Optional HSM Integration

For server-side signing scenarios, ODATANO supports Hardware Security Modules through the PKCS#11 interface. Dedicated actions — `SignWithHsm`, `SignAndSubmitWithHsm`, and `GetHsmStatus` — expose HSM signing as OData operations. The integration is PKCS#11-compatible, meaning it works with any HSM that implements the standard. It is not mandatory; installations without HSM requirements simply do not configure the HSM provider.

### Service-Level Authorization

All three OData services enforce `@requires: 'authenticated-user'` through CAP's built-in authorization annotations. Beyond authentication, the signing service implements address ownership verification (IDOR protection): signing requests are validated against the authenticated user's registered addresses to prevent unauthorized transaction construction. Input payloads are validated with configurable size limits and JSON depth constraints as a defense against denial-of-service through oversized or deeply nested request bodies.

### Key Separation Principle

The governance model follows a clear separation: ODATANO builds, validates, and submits transactions but does not sign them (unless explicitly configured with an HSM). The CAP service can run in a standard application tier without access to cryptographic key material, reducing the attack surface and aligning with enterprise key management policies.

---

## 7. Why This Approach Is Different

ODATANO's distinction lies not only in integrating SAP and Cardano, but in the integration layer it targets.

Many projects integrate at the wallet layer. Some integrate at the SDK layer. Others integrate at the provider or node layer. Those are valid technical approaches, but they keep blockchain at the edge of enterprise architecture.

**ODATANO integrates at the service-contract layer.**

When blockchain data is exposed as queryable entities with metadata, and operations as structured service actions, integration becomes much easier for enterprise tools. The same patterns used in SAP for service consumption, UI generation, API management, and application composition can now apply to blockchain-backed use cases. This alignment is why OData matters in SAP and, by extension, for enterprise blockchain.

In simple terms: ODATANO does not require enterprise teams to approach integration as blockchain infrastructure engineers. It enables integration with Cardano using familiar enterprise patterns.

---

## 8. Why OData and Blockchain Matter in the Agentic Age

There is a second reason this architecture is important, extending beyond current enterprise integration patterns.

AI agents are becoming autonomous participants in software systems. They discover services, interpret data models, construct queries, and execute operations without a human writing each API call. For that to work reliably, agents need services that are self-describing, formally structured, and machine-readable without ambiguity. They need exactly what OData provides.

OData's metadata layer (CSDL) provides an AI agent with everything it needs to understand a service: entity types, relationships, available operations, parameter types, and query capabilities, all published as a machine-readable document at a standard endpoint. An agent does not need custom documentation, hand-written API wrappers, or provider-specific SDKs. It reads the `$metadata` endpoint, understands the service model, and starts working.

When combined with blockchain immutability, this creates a property that conventional APIs cannot offer: verifiable trust in the underlying data. When an AI agent queries an OData service backed by Cardano, the data it receives is not just structured — it is verifiable. Transactions are immutable. UTxO chains provide cryptographic provenance. On-chain records cannot be silently altered after the fact.

In a world where AI agents act on data to make decisions, trigger processes, or verify claims, the trustworthiness of the underlying data source becomes critical. An agent operating on mutable, centrally controlled data has no way to independently verify that the data has not been changed between reads. An agent operating on Cardano-backed OData data can.

This convergence — self-describing services that agents can autonomously discover and consume, backed by an immutable data layer that does not depend on the service operator — is where ODATANO's architecture extends beyond traditional enterprise integration.

ODATANO was not built specifically for AI agents. However, the same features that make OData effective for enterprise integration — metadata, typed models, standard query semantics, and discoverable operations — are also essential for agentic systems to operate autonomously and reliably. Similarly, Cardano's strengths — immutability, determinism, and cryptographic verifiability — make blockchain data trustworthy for autonomous agents. ODATANO operates at this intersection.

---

## 9. Why Cardano Is the Right Foundation

Cardano was chosen deliberately.

ODATANO does not add OData to any blockchain arbitrarily. Cardano was selected because it is structurally well-suited for long-lived enterprise systems: deterministic transaction design, UTxO-based traceability, strong emphasis on formal methods, clear transaction composition, and a culture focused on protocol correctness.

For enterprise use cases such as auditability, provenance, verifiable records, tokenization, or controlled smart contract execution, these properties are essential. Enterprises require systems whose behavior can be explained, reviewed, and verified over time. Cardano is one of the few ecosystems where these requirements are addressed natively.

ODATANO is funded under Cardano Catalyst Fund 14 as "SAP–Cardano OData V4 API with CAP & SAP-Cardano SDK." Catalyst is not just funding support — it is ecosystem validation. The Cardano community identified this enterprise integration gap as real and worth closing through its decentralized governance process.

---

## 10. Where the Project Stands Today

Transparency is a priority. As of April 2026, ODATANO has completed three of four Catalyst Fund 14 milestones, with the final milestone in progress.

**Milestone 1 — OData Service Foundation & Blockchain Read Access** ✅ Completed January 2026
Cardano read operations with multi-provider failover (Blockfrost → Koios), 18 entities defining Cardano core components, and 15 blockchain read actions with comprehensive input validation, full OData V4 query support, lazy on-demand indexing with TTL-based refresh, 340 tests across 11 test suites, CI/CD with Codecov integration.

**Milestone 2 — Transaction Build & Submit** ✅ Completed February 2026
Cardano transaction building with dual-builder architecture (CSL + Buildooor), four transaction types (simple transfers, token minting, multi-asset transfers, metadata), Ogmios live backend for protocol parameters and UTxO queries, six transaction actions with external signing workflow, full Build → Sign → Submit flow, 327 additional tests across 6 new test suites, end-to-end Preview testnet examples, and Postman collection.

**Milestone 3 — External Signing & SAP Integration** ✅ Completed March 2026
Extension of the transaction module and external workflow to export unsigned Cardano transactions via OData, enabling deterministic external signing (Cardano CLI, browser wallets via CIP-30, or HSM via PKCS#11) with full key separation and no private-key handling in the CAP service. Includes Plutus V3 smart contract support (`BuildPlutusSpendTransaction`, `SetCollateral`), end-to-end external signer integration, SAP S/4HANA business process examples, enterprise use cases, a sample Fiori wallet viewer app, and comprehensive automated integration and security tests.

**Final Milestone — Finalization, Advanced Use Cases & Project Close-Out** ⏳ In progress, April/May 2026
A demonstration-mode video of the Wallet Viewer Fiori App illustrating audit, compliance, and sustainability use cases, accompanied by transparent community announcements. The milestone is closed with a formal Catalyst close-out report, this whitepaper, an SAP Community contribution, and a short end-to-end video summarizing results, lessons learned, and future plans.

**Current technical footprint (`@odatano/core` v1.0.0):**

- 3 OData V4 services: read, transaction, signing
- 31 entities total (18 read + 8 transaction + 5 signing)
- 34 actions total (15 read + 11 transaction + 8 signing)
- 1,285 tests across 31 test suites, 99% statement coverage
- SAP CAP 9.x, TypeScript 5.9, Node.js 20.x/22.x
- Multi-network: mainnet, preview, preprod
- Multi-backend: Blockfrost, Koios, Ogmios
- Published as a CAP plugin on npm under Apache 2.0

---

## 11. Evidence and Verification

ODATANO is fully transparent: the architecture, code, and tests are public. Rather than relying on a closed-source implementation or private demo, the community is encouraged to review the code, run the tests, and verify that the service does what it claims to do.

### Test Suite Growth

The automated test suite has grown with each milestone, reflecting incremental feature delivery:

| Milestone | Tests | Suites | Scope |
|-----------|-------|--------|-------|
| M1 | 340 | 11 | Read entities, input validation, backend failover |
| M2 | 667 | 17 | Transaction building, dual-builder, Ogmios integration |
| M3 | 1,122 | 25 | External signing, Plutus V3, HSM actions, security |
| v1.0 | 1,285 | 31 | Code review hardening, authorization, DoS prevention |

### Coverage and CI/CD

The repository integrates Codecov with a project coverage target of 90%. As of v1.0.0, measured statement coverage is 99%. GitHub Actions runs the full test suite on every push and pull request. Codecov bot reports on each PR to confirm that all modified and coverable lines are covered by tests.

### Performance

To verify that the OData abstraction does not introduce unacceptable latency, ODATANO includes an automated performance benchmark suite (`scripts/perf/`) that measures response times across all service endpoints against the Cardano Preview testnet. The benchmark was run across 9 backend configurations with 5 rounds per endpoint (178 calls per configuration), repeated 3 times for stability. All measurements were taken on a local development machine against live Preview testnet providers — results reflect real-world latency including network round-trips to Blockfrost, Koios, and Ogmios endpoints, not isolated OData layer overhead alone.

**Multi-Backend Response Times** (average across 3 runs, 5 rounds each, Preview testnet):

| Backend Configuration | Avg Response (ms) |
|---|---|
| Ogmios + Blockfrost (CSL) | 52–64 |
| Ogmios + Blockfrost (Buildooor) | 57–68 |
| Blockfrost (CSL) | 58–70 |
| Blockfrost (Buildooor) | 66–73 |
| Ogmios + Koios (CSL) | 59–97 |
| Koios (Buildooor) | 111–160 |
| Koios (CSL) | 127–161 |

**Caching effect.** ODATANO's lazy on-demand indexing provides significant speedup on repeated queries. For example, `GetNetworkInformation` cold-start is 280 ms (first call hits the blockchain backend), while subsequent warm calls average under 5 ms — served directly from the local SQLite cache with TTL-based refresh.

**Transaction building.** Simple ADA transfers build in 95–170 ms average. Plutus V3 spend transactions — the most complex operation, requiring UTxO resolution, script evaluation, and collateral handling — build in 360–475 ms depending on backend configuration.

**Signing flow.** The full chained signing flow — `BuildSimpleAdaTransaction` followed by `CreateSigningRequest` and `GetSigningRequest` — completes in under 200 ms total for the signing service operations (excluding the initial build).

The benchmark suite, raw result data, and a multi-backend comparison tool are included in the repository at `scripts/perf/` for independent verification.

### Verifiable Artifacts

All of the following are publicly accessible:

- Source code and commit history: github.com/ODATANO/ODATANO
- Release tags and changelogs: GitHub Releases with detailed per-version notes
- npm package: `@odatano/core` with published version history
- CI/CD pipeline: GitHub Actions workflow logs
- Coverage reports: Codecov integration linked from the repository
- Catalyst milestone submissions: linked from the project Catalyst page

---

## 12. Why ODATANO Matters for Investors, Partners, and the Cardano Community

From an ecosystem perspective, ODATANO addresses a strategically important distribution challenge. Cardano offers robust infrastructure, protocol depth, and strong technical foundations. However, enterprise adoption depends on organizations being able to consume these capabilities within their existing systems while maintaining manageable complexity, security, and governance.

Current alternatives for enterprise blockchain integration typically fall into three categories: custom REST wrappers around provider APIs (Blockfrost, Koios), provider-specific SDKs that require blockchain expertise in every consuming application, or generic blockchain middleware platforms that offer broad chain support but no enterprise service contract model. None of these produce a discoverable, metadata-driven, OData-native interface that enterprise tools already know how to consume. ODATANO is purpose-built to fill this gap — integrating Cardano with SAP-centric enterprise environments using the established OData service contract model, requiring no custom connectors or bespoke workflow adaptation. This minimizes change management and accelerates adoption, especially in organizations already invested in SAP or similar platforms.

For the Cardano community, this means more than another tool. It means a credible bridge into SAP-centric enterprise landscapes, which remain some of the most process-heavy and economically important software environments in the world. For strategic partners and investors, it means exposure to a category that is still underbuilt: the enterprise interface layer between business software and blockchain infrastructure.

This interface layer is highly valuable because it addresses several intersecting enterprise needs:

- enterprise modernization
- API standardization
- blockchain-backed auditability
- tokenized business processes
- cross-company verification
- secure external signing and transaction governance

As blockchain use cases transition from experimentation to real business operations, this interface layer becomes increasingly valuable. ODATANO is designed to fulfill this role.

---

## 13. The Vision Beyond "Just an API"

ODATANO is not intended as a one-off API project, but as the foundation of an enterprise blockchain integration stack.

The platform functions as both a standalone CAP OData V4 API service and a plugin-style data layer that drops into any existing SAP CAP project. The TRACE example demonstrates how ODATANO can support a full-stack Fiori + CAP application for pharma supply chain scenarios, including batch NFT minting, chain of custody, document anchoring, and public verification. The ODATANO-WATCH project extends the model toward monitoring and event-driven verification. NIGHTGATE, a separate CAP-based indexer, brings the same OData-native model to the Midnight blockchain for privacy-preserving enterprise workflows.

This is the broader vision:

- ODATANO as the OData-native access and transaction layer
- NIGHTGATE as the OData layer for privacy-preserving chains
- Enterprise apps on top, from SAP to public verification portals
- Cardano underneath as the trust and execution layer

This stack represents the real long-term value.

---

## 14. Future Development

Beyond the current v1.0 release, ODATANO's roadmap focuses on two areas: deeper integration with enterprise systems and ongoing protocol evolution. Near-term priorities (v1.x) are event-driven integration and governance/compliance tooling. Medium-term targets include SAP BTP integration and cross-company verification extensions. Longer-term efforts — the multi-chain OData surface with NIGHTGATE and AI agent optimization — depend on ecosystem maturity and partner demand.

### Enterprise System Integrations

**SAP S/4HANA and ERP integration.** Procurement, logistics, and financial accounting in S/4HANA already consume OData services for master data and transactional workflows. Connecting ODATANO as an external OData source means purchase orders, goods receipts, or invoice verifications can trigger on-chain records that anchor critical business events on Cardano without changing the ERP workflow. A concrete target is the procurement-to-pay flow: purchase order creation triggers a blockchain-anchored commitment, goods receipt confirms delivery on-chain, and invoice verification closes the cycle with an immutable audit trail.

**SAP Business Technology Platform (BTP).** BTP's Integration Suite and API Management layer are designed to compose OData services into enterprise workflows. ODATANO as a managed OData destination on BTP would make Cardano accessible to any BTP-connected application, including SAP Build, SAP Analytics Cloud, and custom Fiori apps — all through the same service catalog enterprises already use for OData integrations.

**Cross-company verification and supply chain.** The TRACE pharma example points to a broader pattern: multi-party business processes in which each participant writes to Cardano via ODATANO and verifies counterparty records via the same OData interface. Planned extensions include industry-specific entity models for automotive supply chain (CATENA-X compatibility), pharmaceutical track-and-trace (EU FMD/DSCSA), and carbon credit certification.

**Non-SAP enterprise systems.** OData is not exclusive to SAP; platforms such as Microsoft Dynamics, Salesforce (via OData connectors), and ServiceNow can also consume OData services. Extending ODATANO's reach beyond SAP environments is a planned focus. The protocol remains unchanged; only the consuming system differs.

For example, Microsoft Dynamics 365 can register ODATANO as an external OData feed, allowing on-chain Cardano records to appear in Dynamics workflows such as invoice processing, asset tracking, or compliance reporting, without custom blockchain connectors. Similarly, Salesforce users can connect to ODATANO using standard OData connectors, enabling teams to verify transaction statuses, anchor customer agreements on Cardano, or automate compliance tasks directly within Salesforce.

### Protocol Evolution

**Event-driven integration.** The current model is request-response: applications query ODATANO or call actions. The next evolution is push-based: watching the on-chain state and emitting events when relevant changes occur — new transactions at a watched address, token transfers, datum updates, or state changes on smart contracts. This enables reactive enterprise workflows in which business processes respond to blockchain events in near real time rather than polling.

**Multi-chain OData surface.** NIGHTGATE already extends the OData model to Midnight for privacy-preserving workflows. The long-term direction is a unified OData surface that spans both chains — Cardano for public verifiability, Midnight for confidential computation — exposed through a single, consistent service contract. Enterprise consumers would interact with one OData interface regardless of which chain holds the data.

**AI agent optimization.** Building on the agentic capabilities described in Section 8, planned work includes optimized `$metadata` annotations that help AI agents understand not just the data model but the semantic meaning of operations — which actions are read-only, which trigger on-chain state changes, which require signing approval. The goal is to make ODATANO not just agent-compatible but agent-optimized.

**Governance and compliance tooling.** Enterprise blockchain adoption at scale will require built-in support for regulatory reporting, audit export, and compliance verification. The current ODATANO release (v1.0) includes foundational features: role-based access controls, address ownership verification, input validation, and comprehensive audit logging of all OData service actions. Compliance-focused extensions are planned for the v1.x series, including structured audit log entities, configurable retention policies, and export actions for generating compliance-ready reports from on-chain data. A detailed compliance rollout schedule will be maintained in the public repository.

---

## 15. Conclusion

I created ODATANO because enterprise blockchain integration requires a better abstraction.

OData has proven its value in the enterprise world. SAP relies on it for structured, metadata-driven, interoperable service consumption, with CAP and Fiori reinforcing this model. Cardano provides robust blockchain foundations for verifiable, auditable, and durable digital processes. ODATANO unites these strengths.

My position is straightforward:

**For blockchain to be relevant in an enterprise, it must become enterprise-native at the interface layer.**

That is what ODATANO is building: not a demo, not a wrapper, but a new integration model.

---

## References

1. OASIS OData Version 4.01 Specification — OASIS Standard, defining the OData protocol, Entity Data Model, and URL conventions. https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html
2. OData Common Schema Definition Language (CSDL) — OData v4.01 Part 3, defining machine-readable service metadata. https://docs.oasis-open.org/odata/odata-csdl-json/v4.01/odata-csdl-json-v4.01.html
3. SAP Cloud Application Programming Model (CAP) — SAP's framework for building OData V4 services with CDS modeling and plugin architecture. https://cap.cloud.sap/docs/
4. CIP-14: User-Facing Asset Fingerprint. https://cips.cardano.org/cip/CIP-0014
5. CIP-20: Transaction Message/Comment Metadata. https://cips.cardano.org/cip/CIP-0020
6. CIP-30: Cardano dApp-Wallet Web Bridge. https://cips.cardano.org/cip/CIP-0030
7. Cardano Extended UTxO Model — Cardano Developer Portal. https://developers.cardano.org/docs/about-cardano/learn/eutxo-explainer
8. Cardano Catalyst Fund 14 — ODATANO proposal. https://projectcatalyst.io/funds/14/cardano-use-cases-concept/sap-cardano-odata-v4-api-with-cap-and-sap-cardano-sdk
9. ODATANO Repository — source code, releases, and CI/CD. https://github.com/ODATANO/ODATANO
10. ODATANO npm Package — published CAP plugin. https://www.npmjs.com/package/@odatano/core

---

## Contact

**Maximilian Weber**
Project Lead, ODATANO
max@maxalexweber.de
https://github.com/ODATANO/ODATANO
https://www.npmjs.com/package/@odatano/core