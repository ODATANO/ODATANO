# M2 Release Checklist – Transaction Build & Submit

**Delivery Month:** March 2026 | **Project Completion:** 60%

## Pre-Release Verification

### Transaction Builder Module

- [ ] Transaction builder module implemented in CAP service
- [ ] Supports basic ADA transfer transactions with optional metadata
- [ ] UTXO selection logic implemented and tested
- [ ] Fee calculation implemented using Cardano libraries
      (cardano-serialization-lib, mesh.js, lucid-evolution)
- [ ] Produces unsigned transactions in CBOR serialized format
- [ ] Unsigned transaction structure validated against Cardano protocol

### Transaction Submission Functionality

- [ ] Integration with Blockfrost or Koios submit endpoint
- [ ] Signed transactions can be submitted to Cardano preview testnet
- [ ] Network response handling implemented
- [ ] Transaction ID tracking implemented after submission
- [ ] Submission response properly logged and reported

### Protocol Compliance

- [ ] Transaction inputs cover outputs + fees correctly
- [ ] No invalid UTXO usage in built transactions
- [ ] CBOR format validated and correct
- [ ] Transactions pass Cardano CLI verification after signing

### Database & Schema – New Entities for M2

- [ ] TransactionSubmission entity created to store submission records
- [ ] Entity tracks transaction ID, status, timestamp, and metadata
- [ ] TransactionBuilder entity stores unsigned transaction details if needed
- [ ] Entity includes sender address, recipient address, amount, fees
- [ ] Entity includes submission timestamp and confirmation status
- [ ] Optional audit/log entity for transaction lifecycle events
- [ ] db/schema.cds updated with new entities
- [ ] Sample data in db/data/ provided for testing (if applicable)
- [ ] Database migrations documented (if upgrading from M1)
- [ ] Entities properly exposed through OData API

### Error Handling – 5 Scenarios Covered

- [ ] Insufficient funds error (clear message when balance can't cover amount +
      fees)
- [ ] Invalid input data error (malformed address, amount out of range returns
      400-level)
- [ ] Invalid signature error (wrong key or tampered tx returns failure)
- [ ] Network failure error (timeout/unreachable returns appropriate error, no
      crash)
- [ ] Duplicate/Replay error (already processed transaction handled gracefully)
- [ ] All error scenarios have defined error codes and documented messages

### Code Quality

- [ ] All tests passing locally
  - [ ] Unit tests for transaction builder pass
  - [ ] Integration tests for build-sign-submit flow pass
  - [ ] Error scenario tests all pass
- [ ] Code coverage meets threshold (>80%)
- [ ] TypeScript compilation without errors
- [ ] No console warnings or deprecated API usage

### Documentation – Transaction Focused

- [ ] Transaction Schema Specification documented (inputs, outputs, formats)
- [ ] Signing Workflow Guide created with examples (Cardano CLI, etc.)
- [ ] Error Codes documentation complete with troubleshooting section
- [ ] README.md updated with M2 transaction features
- [ ] DEVELOPER_GUIDE.md updated with transaction module details
- [ ] Examples of insufficient funds, invalid inputs, submission failures
      documented

### Dependencies

- [ ] Cardano library dependencies verified (cardano-serialization-lib, mesh.js,
      or lucid-evolution)
- [ ] package.json updated with new dependencies
- [ ] No known security vulnerabilities in added packages
- [ ] All peer dependencies installed

## Release Preparation

### Build & Artifacts

- [ ] Clean build successful: `npm run build`
- [ ] Build artifacts verified
- [ ] No build warnings or errors
- [ ] Package size acceptable

### Testing Before Release – Build/Submit Tests

- [ ] Unit tests for transaction builder pass
  - [ ] Test: construct transaction with known inputs
  - [ ] Test: verify transaction structure
  - [ ] Test: verify fee calculation
- [ ] Integration tests for submission pass
  - [ ] Test: simulate submission with dummy signature
  - [ ] Test: validate flow up to submission call
- [ ] Run full test suite: `npm test`
- [ ] Manual testing of build-sign-submit flow performed
- [ ] Error scenarios tested with known addresses/amounts

### End-to-End Example Scripts

- [ ] Reference implementation scripts provided
- [ ] Example: Call API to build transaction
- [ ] Example: External signing step documented
- [ ] Example: Call submit endpoint with signed transaction
- [ ] Scripts are reproducible and tested

### Version Management

- [ ] Version bumped in package.json (M2 milestone tag)
- [ ] CHANGELOG.md updated with transaction builder/submit features
- [ ] GitHub tag "v0.2-milestone2" created
- [ ] Version numbers consistent across files

## Release Execution

### Deployment

- [ ] Service deployable with transaction builder/submit modules
- [ ] Preview testnet connectivity verified
- [ ] No breaking changes from M1 features
- [ ] Backward compatibility maintained

### Post-Release

### Verification

- [ ] Transaction builder responds correctly to API calls
- [ ] Unsigned transactions generated in correct CBOR format
- [ ] Signed transactions successfully submitted to preview testnet
- [ ] Transaction IDs correctly tracked and returned
- [ ] No critical errors in logs
- [ ] Performance metrics acceptable (submission response time < 10 seconds)

### Evidence & Demonstration

- [ ] Test transaction built via API successfully signed
- [ ] Signed transaction confirmed on Cardano preview testnet
- [ ] Transaction visible on blockchain explorer (preview.cardanoscan.io)
- [ ] Demo scenario completed: Send ADA from Address A to Address B via API
- [ ] End-to-end build→sign→submit flow reproducible

### Communication & Publishing

- [ ] GitHub release "v0.2-milestone2" published
- [ ] Postman collection with Build/Submit requests provided
- [ ] Demo video recorded (~5 min: build→sign→submit flow)
- [ ] Demo video shows transaction on blockchain explorer
- [ ] Test results and logs documented
- [ ] Team notified of M2 completion

### Monitoring

- [ ] Error tracking configured for transaction failures
- [ ] Logging for build/submit operations active
- [ ] Performance monitoring for submission latency enabled

## Sign-Off & Evidence Checklist

### Required Evidence of Completion

1. **GitHub Repository Update**
   - [ ] New transaction builder module code committed
   - [ ] New transaction submission module code committed
   - [ ] Updated documentation in /docs folder
   - [ ] Commits associated with M2 features visible
   - [ ] Transaction workflow guides in documentation

2. **Blockchain Explorer Evidence**
   - [ ] Link to Cardano preview testnet transaction
   - [ ] Transaction built by system visible on blockchain
   - [ ] Transaction ID and timestamp recorded
   - [ ] Correct amount transferred verified

3. **Demo Video & Scripts**
   - [ ] Demo video recorded (~5 min: build→sign→submit)
   - [ ] Video shows OData API building transaction
   - [ ] Video shows external signing (Cardano CLI or wallet)
   - [ ] Video shows submit endpoint call
   - [ ] Video shows transaction on blockchain explorer
   - [ ] Postman collection provided with example requests
   - [ ] Build Transaction request example documented
   - [ ] Submit Transaction request example documented

4. **Test Results & Logs**
   - [ ] Test logs showing successful build with expected outputs
   - [ ] Coverage report for transaction module
   - [ ] Error scenario test snippets/logs documented
   - [ ] All 5 error scenarios tested and documented

5. **Milestone Release Tag**
   - [ ] GitHub release "v0.2-milestone2" created
   - [ ] Tag contains snapshot of code and documentation
   - [ ] Release notes document transaction features
   - [ ] Release is downloadable for review
