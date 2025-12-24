# Integration Tests (Blockfrost & Koios)

## Overview

The integration tests run against two backends: Blockfrost and Koios. Each
backend is started via its own entry file and shares a common test suite.

- Shared suite: core-test-suite.ts
- Backend helper: backend-test-helper.ts (env setup)
- Blockfrost entry: core.blockfrost.test.ts (runs only when `BLOCKFROST_KEY` is
  set)
- Koios entry: core.koios.test.ts (always runs, no API key required)

## Prerequisites

- Node.js 20+ (or 22+)
- SQLite (automatically used by CAP/Jest)
- For Blockfrost tests: `BLOCKFROST_KEY` environment variable
- For Koios tests: no additional variables needed. The URL is set to
  `https://preview.koios.rest/api/v1` in core.koios.test.ts if not already
  present.

## Running Tests

```bash
# Integration tests only (runs Koios always; Blockfrost only with BLOCKFROST_KEY)
npm run test:integration

# Full test suite (unit + integration)
npm test
```

Run a specific backend entry file:

```bash
# Blockfrost only
npm test -- --testPathPattern=core.blockfrost.test.ts

# Koios only
npm test -- --testPathPattern=core.koios.test.ts
```

## Koios Test Entry

```ts
// core.koios.test.ts
createBackendTestSuite({
  name: "koios",
  enabled: true,
});
```

## Fixtures

Backend-specific testing preview data

```ts
const FIXTURE = {
  // valid hash of a preview transaction
  validTxHash:
    "2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83",
  // valid preview hash of a preview transaction with metadata
  txWithMetadata:
    "95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1",
  // valid preview address
  validAddress:
    "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8",
  // valid preview block hash
  validBlockHash:
    "cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39",
  // valid preview drep id
  validDrepId: "drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0",
  // valid preview stake address
  validStakeAddress:
    "stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p",
  // valid Metadata label
  transactionMetadataLabel: "1990",
  //  valid preview pool id
  validPoolId: "pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r",
};
```
