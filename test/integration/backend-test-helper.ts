/**
 * Backend Test Helper
 * Utility to run the same integration tests against multiple backends (Blockfrost, Koios)
 */
export type BackendType = 'blockfrost' | 'koios';

export interface BackendTestConfig {
  name: BackendType;
  enabled: boolean;
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