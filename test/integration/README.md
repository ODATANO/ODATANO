# Integration Tests (Blockfrost & Koios)

## Overview

The integration tests run against two backends: Blockfrost and Koios. Each
backend is started via its own entry file and shares a common test suite.

- Shared suite: core-test-suite.ts
- Backend helper: backend-test-helper.ts (fixtures, skip logic, env setup)
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

## Backend Limitations and Skip-Tests

Some functionality is backend-specific. Unsupported tests are automatically
skipped for the affected backend.

### Koios Limitations (Preview Network)

**Transaction Metadata:** Koios does not support metadata queries on the Preview
network. These tests are automatically skipped:

```ts
// core.koios.test.ts
createBackendTestSuite({
  name: "koios",
  enabled: true,
  skipTests: [
    "MetaData", // Koios does not support Metadata on preview
  ],
});
```

In test code, skip logic is handled via helper:

```ts
(shouldSkipTest(backendConfig, "MetaData") ? it.skip : it)(
  "...",
  async () => {
    // Test runs only if the backend supports this feature
  },
);
```

## Fixtures

Backend-specific test data is centrally defined:

```ts
const FIXTURE = getFixtures(backendConfig.name);
// e.g., FIXTURE.validTxHash, FIXTURE.validAddress, FIXTURE.validPoolId (differs per backend)
```

Example: For Blockfrost, `validPoolId` is a 56-character hex hash; for Koios,
it's a bech32 `pool1...`.
