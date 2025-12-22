/**
 * Backend Test Helper
 * Utility to run the same integration tests against multiple backends (Blockfrost, Koios)
 */

export type BackendType = 'blockfrost' | 'koios';

export interface BackendTestConfig {
  name: BackendType;
  enabled: boolean;
  skipTests?: string[]; // Tests to skip for this backend
}

/**
 * Check if a test should be skipped for the current backend
 */
export function shouldSkipTest(backendConfig: BackendTestConfig, testName: string): boolean {
  return backendConfig.skipTests?.some(skip => testName.includes(skip)) || false;
}

/**
 * Configure environment for a specific backend test
 * This ensures only the specified backend is used as primary
 */
export function configureBackendForTest(
  backendConfig: BackendTestConfig,
  originalBlockfrostKey?: string
): void {
  if (backendConfig.name === 'koios') {
    // Only Koios backend
    process.env.BACKENDS = 'koios';
    delete process.env.BLOCKFROST_KEY;
  } else if (backendConfig.name === 'blockfrost') {
    // Only Blockfrost backend
    process.env.BACKENDS = 'blockfrost';
    if (originalBlockfrostKey) {
      process.env.BLOCKFROST_KEY = originalBlockfrostKey;
    }
  }
}

/**
 * Backend-specific test fixtures (preview network)
 */
const BASE_FIXTURE = {
  validTxHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
  txWithMetadata: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
  validAddress: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
  validBlockHash: 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39',
  validDrepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
  validStakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
  transactionMetadataLabel: '1990',
};

export const BACKEND_FIXTURES = {
  blockfrost: {
    ...BASE_FIXTURE,
    // Blockfrost expects a hex pool ID (without "pool1" prefix)
    validPoolId: 'b4fa12dfed65dce7a640cb95a81ac990651c1d613f392f4a3e517e20',
  },
  koios: {
    ...BASE_FIXTURE,
    // Koios expects a bech32 pool ID (pool1...)
    validPoolId: 'pool1p90428kec03mjdya3k4gv5d20w7lmed7ca0snknef5j977l3y8l',
  },
};

/**
 * Get fixtures for a specific backend
 */
export function getFixtures(backend: BackendType) {
  return BACKEND_FIXTURES[backend];
}
