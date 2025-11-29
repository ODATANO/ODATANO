# 📍 Project Milestones

This document outlines the key milestones, deliverables, and progress tracking
for my **ODATANO - SAP–Cardano OData V4 API with CAP & SAP-Cardano SDK**
project. These milestones can also be found in the offical Catalyst milestone
module: https://milestones.projectcatalyst.io/projects/1400109

**Total Estimated Cost:** 85,000 ₳\
**Total Duration:** 6 Months\
**License:** Apache 2.0\

## 🧩 Milestone 1 – OData Service Foundation & Blockchain Read Access

**Delivery Month:** Januar 2025 **Cost:** 25,500 ₳ **Project Completion:** 30%

### 🎯 Outputs

1. **Project Infrastructure & Repository Setup:** Public GitHub repository with
   Apache 2.0 license initialized with SAP CAP project structure, continuous
   integration setup, basic README, and issue tracker for project tasks.
2. **CAP OData Service Read Operations Implemented:** A basic OData V4 service
   using SAP Cloud Application Programming Model, defining entities/endpoints
   for Transactions, Addresses & Metadata. The service runs on a lokal CAP
   server and responds to requests.
3. **Blockchain Data Integration Layer:** Integration of the CAP service with
   Cardano blockchain data sources (using Blockfrost and Koios APIs with
   fallback) to support real-time read operations. At least three example read
   endpoints are connected to cardano preview network (e.g. retrieving a
   transaction by hash, querying an address balance or token metadata) and maps
   the response to the OData entity schema.
4. **Automated Test Suite (Read Operations):** A set of automated
   unit/integration tests covering the core OData endpoints and scenarios
   including successful data retrieval, schema validation, and error cases (e.g.
   invalid queries, network errors). Tests are configured to run in CI, ensuring
   new changes don’t break core functionality.
5. **Documentation Package:** Comprehensive documentation in the repo’s /docs
   folder, including a Developer Guide (project architecture, data models/EDMX
   schema, setup instructions for the CAP service, integration details for
   Cardano APIs) and a User Guide (how to deploy the service, how to query the
   OData API from SAP or Postman, example queries and expected outputs and known
   limitations).

### ✅ Acceptance Criteria

1. **Deployment & Accessibility:** The OData service is deployable on a SAP CAP
   development environment running locally with cds watch or on a SAP BTP Env.
   and is accessible via a standard OData V4 endpoint
   (http://localhost:4004/odata/v4/...). A health-check or metadata document
   ($metadata ) is reachable, confirming the service is up.
2. **Blockchain Read Functionality:** At least three key read endpoints are
   functional against the Cardano preview-testnet:
   - (1) Transaction Lookup: Given a transaction hash, the service returns the
     transaction details (inputs, outputs, metadata).
   - (2) Address Balance: Given a Cardano address, the service returns the
     current ADA balance and asset list for that address.
   - (3) Metadata Query: Given an identifier (e.g. transaction hash or asset
     ID), the service returns associated metadata (transaction metadata or token
     metadata as applicable).
   - Each of these queries returns correct data from the blockchain through the
     OData API, demonstrating end-to-end connectivity.
3. **Schema Compliance:** All OData responses conform to the defined EDMX
   (Odata) schema and include all required fields for their entity type. For
   example, a transaction query returns fields like transaction hash, timestamp,
   inputs/outputs, etc., matching the documentation. Any filtering or pagination
   follows OData standards.
4. **Error Handling:** The service handles error conditions with clear,
   standardized responses. At minimum, five distinct error scenarios are
   covered:
   - (1) invalid input format (e.g. malformed address or hash) results in an
     HTTP 400 response with descriptive error message;
   - (2) data not found (e.g. unknown transaction hash) returns a 404-style
     OData error;
   - (3) Cardano API connectivity failure (timeout or API down) returns a 503
     error with retry advice;
   - (4) unauthorized access (if endpoints are secured) returns HTTP 401/403;
   - (5) any internal server error is trapped and returns a generic error
     response without crashing the service.
5. **Open Source Code Availability:** The codebase is publicly available in the
   GitHub repository under the Apache 2.0 license. Repository includes a clear
   commit history and issues/README indicating this milestone’s completion.
6. **Test Coverage:** Automated tests cover at least 70% of the code relevant to
   this milestone’s functionality. The test suite includes at least 15 test
   cases that cover typical successful queries (e.g. valid transaction fetch),
   edge cases (e.g. empty results, large responses), and error scenarios (as
   listed above). All tests pass in continuous integration, providing objective
   evidence of correctness.
7. **Demonstration Query:** A sample end-to-end demonstration (for instance,
   querying a known test transaction via the OData service) succeeds with the
   expected result. The query completes within an acceptable time (< 5 seconds)
   and the returned data matches the actual blockchain data, confirming the
   integration works in real time.

### 📁 Evidence of Completion

1. **Source Code Repository:** Link to the public GitHub repository showing the
   CAP project code, configuration, and documentation. The repository will
   include the /docs directory with the Developer Guide and User Guide, as well
   as a clearly marked Apache 2.0 LICENSE file.
2. **API Endpoint Verification:** A screenshot or output snippet from an OData
   client (e.g. Postman or SAP BTP) demonstrating a successful call to the
   service. For example, a GET request to .../odata/v4/Tansactions(<testTxHash>)
   returning the expected JSON response with Cardano preview data. This proves
   the service is running and retrieving blockchain information.
3. **Test Reports:** Output from the automated test suite run, such as a CI
   pipeline log or generated coverage report. This evidence will highlight the
   percentage of code covered by tests (meeting the 70% threshold) and show
   passing test cases for both happy-path and error scenarios. Reviewers can see
   specific tests (e.g. a test for invalid address returning 400) and their pass
   status.
4. **Demo Video:** A short video (approximately 5 minutes) walkthrough
   demonstrating the milestone deliverables. In the video, i will deploy the CAP
   OData service, show it running (e.g. via command line output or BTP
   deployment logs), then perform an example query from an SAP context on BTP or
   a other REST client to retrieve blockchain data, and finally show how errors
   are handled. This visual proof helps confirm that the development works as
   described in real conditions.
5. **Tagged Release:** A GitHub release labeled “v0.1-milestone1” containing the
   snapshot of code and documentation for this milestone. This provides a fixed
   reference point for reviewers to check that all promised outputs (code, docs,
   tests) for M1 are delivered and frozen at completion of the milestone.

## ⚙️ Milestone 2 – Transaction Build & Submit

**Delivery Month:** March 2026 **Cost:** 20,500 ₳ **Project Completion:** 60%

### 🎯 Outputs

1. Transaction Builder Module: Implementation of a server-side module within the
   CAP service that can construct a raw Cardano transaction from given API
   inputs. This builder supports at least basic ADA transfer transactions with
   optional metadata. It handles UTXO selection and fee calculation using
   existing Cardano libraries (cardano-serialization-lib , mesh.js,
   lucid-evolution etc. ). The output of this module is an unsigned transaction
   in CBOR serialized format ready to be signed.
2. Transaction Submission Functionality: Integration with the Cardano-Connector
   Module from M1 to submit a signed transaction. Using a preview API
   (Blockfrost or Koios’s submit endpoint), the service can take a signed
   transaction blob and broadcast it to the Cardano preview testnet. This output
   includes handling the network response and tracking the submission result
   (transaction ID).
3. End-to-End Example Scripts: Reference implementation or scripts that
   demonstrate the full build–sign–submit flow. For instance, a sample script
   that calls the OData API to build a transaction, then invokes an external
   signing step (outside the CAP service), and calls the submit endpoint of the
   API to broadcast the transaction.
4. Extended Documentation: Updates to the documentation (/docs) focusing on
   transaction handling. This includes a Transaction Schema Specification (what
   inputs are required for transaction building, format of the unsigned
   transaction), a Signing Workflow Guide (how an external party should sign the
   transaction), with examples using Cardano CLI or similar , and a
   Troubleshooting & Error Codes section for common issues like insufficient
   funds, invalid inputs or other submission failures.
5. Test Cases for Build/Submit: Additional automated tests are developed to
   validate the transaction builder logic. One or more unit test to construct a
   transaction with known inputs and verify the structure or fee, and an
   integration test simulating submission with a dummy signature to ensure the
   flow is working up to the submission call.

### ✅ Acceptance Criteria

1. **Transaction Construction:** The API is capable of constructing a Cardano
   transaction from specified input parameters. At minimum, given a destination
   address and an ADA amount (and optionally metadata), the system produces a
   well-formed unsigned transaction. The transaction includes correct inputs and
   outputs and a valid fee, such that it passes basic validation from Cardano
   CLI’s transaction verification.
2. **Protocol Compliance:** The constructed unsigned transaction adheres to
   Cardano protocol rules. This means, for example, the sum of inputs covers
   outputs + fees, no invalid UTXO usage, and the CBOR format is correct.
   Verification: gets acepted after signed and submitted.
3. **External Signing & Submission:** A signed transaction (produced by signing
   the API’s unsigned transaction externally) is successfully submitted to the
   Cardano testnet and achieves confirmation. Specifically, at least one preview
   test transaction built by the system, when signed with a valid key, is
   accepted by the network (appearing on a Cardano testnet explorer with ≥1
   confirmation).
4. **Error Handling (Transaction Flow):** The system handles transaction-related
   errors with clear outcomes. At minimum, five error scenarios are implemented
   and documented:
   - (1) Insufficient funds – if the provided UTXOs or source address balance
     can’t cover the transaction amount and fees, the build process fails with a
     clear error message;
   - (2) Invalid input data – e.g. malformed address or amount out of range
     yields a 400-level error; Invalid signature – if a submitted transaction is
     signed with the wrong key or tampered, the submit action returns a failure
     (and the error is logged/reported);
   - (4) Network failure – if the submission endpoint times out or is
     unreachable, the service returns an error indicating a submit failure (and
     does not crash);
   - (5) Duplicate or Replay – if the same transaction is submitted twice, the
     service handles the error from the node (already processed transaction).
   - All such conditions have corresponding error codes/messages defined in the
     docs
5. **Open Source & Transparency:** All new code for the transaction builder and
   submitter is committed to the public repository (Apache 2.0). The
   documentation in the repo is updated to reflect the Milestone 2 features
   (transaction building/signing/submission). Reviewers can find a clear
   changelog or milestone tag indicating what was added. Demonstration Scenario:
   A demo scenario is executed to validate this milestone: for example, “Send 10
   ADA on preview testnet from Address A to Address B.” Using the API, a
   transaction is built, externally signed, then submitted. Acceptance is
   achieved if the transaction is visible on the testnet blockchain (with the
   correct amount transferred) and the OData service/API reflects a successful
   submission. The entire process should be reproducible using the provided
   scripts or instructions

### 📁 Evidence of Completion

1. **GitHub Repository Update:** Link to the repository showing the new modules
   transaction builder & submission module and updated documentation. A reviewer
   can navigate the repo to see, for example, a tx-builder.js tx-submit.js or
   similar, and the commits associated with Milestone 2. The /doc folder should
   contain the new transaction guidelines for the Transaction Workflow
2. **Transaction Confirmation:** A direct link to a Cardano preview testnet
   blockchain explorer (e.g. preview.cardanoscan.io ) showing the details of a
   transaction that was built by the system, submitted, and confirmed. The
   transaction ID and timestamp should correspond to the demonstration
   described.
3. **Demo Video of Build→Sign→Submit:** A video demonstration(~ 5min) showing
   the full process in action. For example, the video would show invoking an
   OData API from a SAP BTP System call or CLI script to build a transaction,
   then using an external tool like Cardano CLI or a signing wallet like Eternl
   outside the app to sign the transaction, and finally calling the submit
   endpoint with the signed tx CBOR. The video will show the transaction
   appearing on the explorer as confirmation. This proves that the system output
   unsigned tx can be successfully used to submit a blockchain transaction.
4. **Postman Collection / Scripts:** Provided examples that reviewers can use to
   mimic the process. For instance, a Postman collection with requests for
   “Build Transaction”, “Submit Transaction” along with instructions on how to
   supply a signature.
5. **Test Results & Logs:** Logs or reports from running tests related to
   transaction building. For example, a test log showing a successful build with
   expected outputs, or a coverage report focusing on the transaction module. A
   snippet of the tested error scenarios were log or screenshots inside the
   documentation showing those tests (e.g., a test that attempts to build a
   transaction with insufficient funds and verifies the error).
6. **Milestone Release Tag:** A GitHub release (“v0.2-milestone2”) that bundles
   the state of the code/documentation after completing Milestone 2. This allows
   reviewers to download or browse the exact snapshot that includes the
   transaction build & submit features, separate from later changes

## 🔗 Milestone 3 – External Signing & SAP Integration

**Delivery Month:** May 2026 **Cost:** 19,000 ₳ **Project Completion:** 90%

### 🎯 Outputs

1. **Unsigned Transaction Export Interface:** Extension of the transaction
   module to support exporting unsigned transactions for external signing. The
   OData Action BuildTransaction returns a vailid payload containing a
   deterministic reference id, hash placeholder and timestamp. This enables
   third-party signers (Cardano CLI, Browser Wallets etc.) to sign externally –
   no private keys handled in the CAP service.
2. **External Signer Integration Module:** Implementation of the external
   signing workflow using the Cardano CLI as reference signer. Flow: Unsigned TX
   → External Sign → Verify → Assemble → Submit. Demonstrates full round-trip
   signing with complete key separation and no private-key exposure.
3. **SAP Business Process Integration Examples:** Examples for Integration of
   the Cardano OData API into an SAP S/4HANA process (for example, a Purchase
   Order posting triggers a Cardano transaction or retrieves on-chain data).
4. **Extended Enterprise Use Cases:** Exampels of advanced real-world SAP
   scenarios based on the integration: (e.g., sustainability tracking of CO₂
   certificates, tokenized inter-company settlements, audit-trail reporting for
   FI/CO documents). Each use case includes ABAP examples and SAP/Explorer
   screenshots.
5. **Basic Wallet Viewer Fiori Sample App:** A lightweight SAPUI5/Fiori
   application that visualizes wallet information from the OData API which
   demonstrates how easy it is to build simple apps based on the Odataservices /
   CAP definitions and can be used as a reference in future applications.
6. **Automated Integration & Security Tests:** ≥ 15 automated tests covering
   external signing, signature validation, SAP integration, and error
   conditions.

### ✅ Acceptance Criteria

1. **End-to-End External Signing Flow Validated:** Unsigned TX can be exported,
   signed externally, verified, and successfully submitted to Cardano preview
   testnet
2. **Private-Key Isolation Confirmed:** CAP service never stores or uses private
   key material (code review + architecture evidence).
3. **SAP Integration Operational:** An SAP process can trigger an API call and
   receive data or transaction confirmation within 10 seconds.
4. **Wallet Viewer App Functional:** Working SAP Fiori application that displays
   wallet information through OData services, including filtered views for
   balances, tokens, and transaction history.
5. **Integration Tests Passing:** ≥ 90 % coverage and 100 % pass rate for
   designed test cases.
6. **Open-Source Compliance:** All code published under Apache 2.0 with release
   tag v0.3-milestone3

### 📁 Evidence of Completion

1. **Public GitHub Repository:** New modules for external signing and SAP
   integration (tag v0.3-milestone3).
2. **CI/Test Logs:** Console outputs showing unsigned → signed → submitted
   transaction flow and error-case tests.
3. **SAP Integration Proof:** Screenshots of SAP execution (ABAP report output
   or Fiori UI showing Cardano data).
4. **Blockchain Explorer Evidence:** Link to Cardano preview testnet
   transactions triggered from SAP. Demo Video External Signing (~5 min): Shows
   how the API build unsigned TX, external signing with Cardano CLI, submission,
   and SAP integration on Cardano preview testnet.
5. **Demo Video Wallet Viewer Fiori Sample App (~5 min):** Shows walk through to
   the App demonstrating its features and explaining the underlying OData
   services and their implementations.
6. **Documentation:** Architecture diagram highlighting key separation and
   verification flow.
7. **Test Summary:** Execution logs and reports from automated tests verifying
   the external signing and SAP integration workflow. Includes successful
   transaction cycles (unsigned → signed → submitted) with expected outputs, as
   well as negative test scenarios demonstrating proper error handling.

---

## 🏁 Final Milestone – Finalization, Advanced Use Cases & Project Close-Out

**Delivery Month:** June 2026 **Cost:** 20,000 ₳ **Progress:** 100 %

### 🎯 Outputs

1. **Wallet Viewer Fiori App – Demonstration Mode Video:** Presentation of the
   existing Fiori Wallet Viewer App in demonstration mode to illustrate real use
   cases (e.g., Audit & Compliance View, Sustainability View).
2. **Community Announcement & Transparency:** Forum and social-media
   announcements linking the final release, documentation, and video to the
   Cardano community
3. **Final close-out report:** Formal report summarizing project scope,
   achievements, budget use, lessons learned, and future plans. Submitted to
   Catalyst and published in repo
4. **Final closeout video (~5min)** showing end-to-end integration (SAP → OData
   → Cardano → SAP), short Wallet Viewer demo, and highlighting key impacts for
   enterprise adoption

### ✅ Acceptance Criteria

1. **Wallet Viewer App Demonstration Mode Video:** Shows filtered views by
   metadata and Explorer integration for real transactions.
2. **Performance Report:** Table summarizing response times and throughput under
   load tests published in /docs folder.
3. **Documentation Reproducible:** Third parties can deploy and test integration
   following the guides alone.
4. **Open-Source Release v1.0 Complete:** Includes code, SDK, UI example app,
   and documentation
5. **Catalyst Close-Out Delivered:** Report and Video published and publicly
   accessible

### 📁 Evidence of Completion

1. **Final GitHub Release:** Tag v1.0 with complete source code, SDK, Wallet
   Viewer App, and all documentation.
2. **Extended Use-Case Screenshots & Logs:** SAP and Explorer evidence showing
   end-to-end flows for sustainability or audit cases.
3. **Performance Report:** Table summarizing response times and throughput under
   load testing available on GitHub .
4. **Catalyst Close-Out Video:** Includes SAP integration examples and Wallet
   Viewer App walk-through.
5. **Catalyst Close-Out Report:** Document in repo and submitted to Catalyst
   portal Community Announcement: Cardano Forum post and social media
   announcement linking v1.0 release

---
