import cds from '@sap/cds';

const logger = cds.log('CircuitBreaker');

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** Number of successes in half-open before closing (default: 2) */
  successThreshold: number;
  /** Time in ms before transitioning from open to half-open (default: 30000) */
  resetTimeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 30_000,
};

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  /** Probe slots handed out while half-open (released on success/failure) */
  halfOpenProbes: number;
}

/**
 * Circuit Breaker for backend failover.
 * Tracks per-backend failure counts and prevents hammering unhealthy backends.
 *
 * States:
 *   closed    → normal operation, requests pass through
 *   open      → backend is unhealthy, requests are skipped
 *   half-open → probe period, limited requests allowed to test recovery
 */
export class CircuitBreakerManager {
  private circuits = new Map<string, CircuitEntry>();
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a backend should be attempted.
   * Transitions open → half-open if reset timeout has elapsed.
   */
  shouldAttempt(backendName: string): boolean {
    const entry = this.circuits.get(backendName);
    if (!entry) return true; // no history = closed

    if (entry.state === 'closed') return true;

    if (entry.state === 'open') {
      const elapsed = Date.now() - entry.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        entry.state = 'half-open';
        entry.successes = 0;
        entry.halfOpenProbes = 1; // this caller takes the first probe slot
        logger.debug(`Circuit half-open for ${backendName} after ${elapsed}ms`);
        return true;
      }
      return false;
    }

    // half-open: cap in-flight probes at successThreshold — previously a burst
    // of concurrent requests all probed a barely-recovering backend at once
    if (entry.halfOpenProbes >= this.config.successThreshold) {
      return false;
    }
    entry.halfOpenProbes++;
    return true;
  }

  /** Record a successful call to a backend. */
  recordSuccess(backendName: string): void {
    const entry = this.circuits.get(backendName);
    if (!entry) return;

    if (entry.state === 'half-open') {
      entry.halfOpenProbes = Math.max(0, entry.halfOpenProbes - 1); // release probe slot
      entry.successes++;
      if (entry.successes >= this.config.successThreshold) {
        entry.state = 'closed';
        entry.failures = 0;
        entry.successes = 0;
        entry.halfOpenProbes = 0;
        logger.info(`Circuit closed for ${backendName} (recovered)`);
      }
    } else if (entry.state === 'closed') {
      // Reset failure count on success
      entry.failures = 0;
    }
  }

  /** Record a failed call to a backend. */
  recordFailure(backendName: string): void {
    let entry = this.circuits.get(backendName);
    if (!entry) {
      entry = { state: 'closed', failures: 0, successes: 0, lastFailureTime: 0, halfOpenProbes: 0 };
      this.circuits.set(backendName, entry);
    }

    entry.failures++;
    entry.lastFailureTime = Date.now();

    if (entry.state === 'half-open') {
      // Any failure in half-open reopens the circuit
      entry.state = 'open';
      entry.successes = 0;
      entry.halfOpenProbes = 0;
      logger.warn(`Circuit re-opened for ${backendName} (failed during probe)`);
    } else if (entry.state === 'closed' && entry.failures >= this.config.failureThreshold) {
      entry.state = 'open';
      logger.warn(`Circuit opened for ${backendName} after ${entry.failures} failures`);
    }
  }

  /** Get the current state of a backend's circuit. */
  getState(backendName: string): CircuitState {
    const entry = this.circuits.get(backendName);
    if (!entry) return 'closed';

    // Check for auto-transition to half-open
    if (entry.state === 'open') {
      const elapsed = Date.now() - entry.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) return 'half-open';
    }
    return entry.state;
  }

  /** Reset all circuit states (for testing). */
  reset(): void {
    this.circuits.clear();
  }
}
