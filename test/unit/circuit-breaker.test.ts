import { CircuitBreakerManager } from '../../srv/blockchain/circuit-breaker';

describe('CircuitBreakerManager', () => {
  let cb: CircuitBreakerManager;

  beforeEach(() => {
    cb = new CircuitBreakerManager({
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeoutMs: 1000,
    });
  });

  // ==========================================================================
  // Initial State
  // ==========================================================================

  describe('Initial State', () => {
    it('should allow attempts for unknown backends (default closed)', () => {
      expect(cb.shouldAttempt('koios')).toBe(true);
      expect(cb.getState('koios')).toBe('closed');
    });

    it('should allow attempts for multiple backends independently', () => {
      expect(cb.shouldAttempt('koios')).toBe(true);
      expect(cb.shouldAttempt('blockfrost')).toBe(true);
      expect(cb.shouldAttempt('ogmios')).toBe(true);
    });
  });

  // ==========================================================================
  // Closed → Open Transition
  // ==========================================================================

  describe('Closed → Open Transition', () => {
    it('should remain closed below failure threshold', () => {
      cb.recordFailure('koios');
      cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('closed');
      expect(cb.shouldAttempt('koios')).toBe(true);
    });

    it('should open after reaching failure threshold', () => {
      cb.recordFailure('koios');
      cb.recordFailure('koios');
      cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('open');
      expect(cb.shouldAttempt('koios')).toBe(false);
    });

    it('should reset failure count on success', () => {
      cb.recordFailure('koios');
      cb.recordFailure('koios');
      cb.recordSuccess('koios');
      cb.recordFailure('koios'); // should be 1 again, not 3
      expect(cb.getState('koios')).toBe('closed');
      expect(cb.shouldAttempt('koios')).toBe(true);
    });
  });

  // ==========================================================================
  // Open → Half-Open Transition
  // ==========================================================================

  describe('Open → Half-Open Transition', () => {
    it('should block attempts while open', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      expect(cb.shouldAttempt('koios')).toBe(false);
    });

    it('should transition to half-open after reset timeout', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('open');

      // Wait for reset timeout
      await new Promise(r => setTimeout(r, 1100));

      expect(cb.getState('koios')).toBe('half-open');
      expect(cb.shouldAttempt('koios')).toBe(true);
    });
  });

  // ==========================================================================
  // Half-Open → Closed (Recovery)
  // ==========================================================================

  describe('Half-Open → Closed (Recovery)', () => {
    it('should close after enough successes in half-open', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      await new Promise(r => setTimeout(r, 1100));

      // Trigger half-open via shouldAttempt
      expect(cb.shouldAttempt('koios')).toBe(true);

      cb.recordSuccess('koios');
      cb.recordSuccess('koios');
      expect(cb.getState('koios')).toBe('closed');
    });

    it('should allow normal operation after recovery', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      await new Promise(r => setTimeout(r, 1100));
      cb.shouldAttempt('koios'); // trigger half-open

      cb.recordSuccess('koios');
      cb.recordSuccess('koios');

      // Should behave like fresh closed state
      expect(cb.shouldAttempt('koios')).toBe(true);
      cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('closed'); // 1 failure, not at threshold
    });
  });

  // ==========================================================================
  // Half-Open → Open (Re-failure)
  // ==========================================================================

  describe('Half-Open → Open (Re-failure)', () => {
    it('should re-open on failure during half-open', async () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      await new Promise(r => setTimeout(r, 1100));
      cb.shouldAttempt('koios'); // trigger half-open

      cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('open');
      expect(cb.shouldAttempt('koios')).toBe(false);
    });
  });

  // ==========================================================================
  // Per-Backend Independence
  // ==========================================================================

  describe('Per-Backend Independence', () => {
    it('should track backends independently', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('open');
      expect(cb.getState('blockfrost')).toBe('closed');
      expect(cb.shouldAttempt('blockfrost')).toBe(true);
    });

    it('should not affect other backends when one opens', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      cb.recordFailure('blockfrost');

      expect(cb.getState('koios')).toBe('open');
      expect(cb.getState('blockfrost')).toBe('closed');
    });
  });

  // ==========================================================================
  // Half-Open Probe Requests
  // ==========================================================================

  describe('Half-Open Probe Requests', () => {
    it('should allow subsequent probe requests in half-open state', async () => {
      // Transition to open
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('open');

      // Wait for reset timeout
      await new Promise(r => setTimeout(r, 1100));

      // First shouldAttempt transitions to half-open
      expect(cb.shouldAttempt('koios')).toBe(true);
      expect(cb.getState('koios')).toBe('half-open');

      // Second shouldAttempt in half-open should still return true (line 68)
      expect(cb.shouldAttempt('koios')).toBe(true);
      expect(cb.getState('koios')).toBe('half-open');
    });
  });

  // ==========================================================================
  // Reset
  // ==========================================================================

  describe('Reset', () => {
    it('should clear all circuit states', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('koios');
      expect(cb.getState('koios')).toBe('open');

      cb.reset();
      expect(cb.getState('koios')).toBe('closed');
      expect(cb.shouldAttempt('koios')).toBe(true);
    });
  });

  // ==========================================================================
  // Default Config
  // ==========================================================================

  describe('Default Config', () => {
    it('should use defaults when no config provided', () => {
      const defaultCb = new CircuitBreakerManager();
      // Default threshold is 5
      for (let i = 0; i < 4; i++) defaultCb.recordFailure('test');
      expect(defaultCb.getState('test')).toBe('closed');
      defaultCb.recordFailure('test');
      expect(defaultCb.getState('test')).toBe('open');
    });
  });
});
