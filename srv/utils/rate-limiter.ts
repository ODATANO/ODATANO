/**
 * In-memory sliding-window rate limiter, ported from NIGHTGATE
 * (srv/utils/rate-limiter.ts). Used for grant administration and for failed
 * agent-token attempts; nothing here touches the database.
 */

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  /** Max tracked keys (default 10 000). */
  maxKeys?: number;
  /** Stale-key sweep interval (default 60 000 ms). */
  sweepIntervalMs?: number;
  /**
   * Max distinct keys ONE group may hold (default 64). The group is the key up
   * to its first ':' (the principal in `principal:scope` keys). Bounds what a
   * single caller can do to the shared table: without it, made-up scopes under
   * one principal evicted every other caller's window.
   */
  maxKeysPerGroup?: number;
}

export interface RateCheckResult {
  allowed: boolean;
  retryAfterMs: number;
}

/** The group a key belongs to: everything before the first ':' (the principal). */
function groupOf(key: string): string {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
}

/**
 * Rate-limit key for a CAP request: the principal (user, else client address)
 * plus the scope. Batch parts carry no address and a proxy hides the real one,
 * so the address is the last resort only. The principal is the limiter's GROUP
 * (see maxKeysPerGroup), hence no ':' in it.
 */
export function principalRateKey(req: unknown, scope: string): string {
  const r = req as {
    user?: { id?: string };
    _?: { req?: { ip?: string } };
    http?: { req?: { ip?: string } };
    ip?: string;
  } | null;
  const user = r?.user?.id;
  const ip = r?._?.req?.ip ?? r?.http?.req?.ip ?? r?.ip;
  const principal = user ? `user=${String(user)}`
    : ip ? `ip=${String(ip).replace(/:/g, '.')}`
    : 'anonymous';
  return `${principal}:${scope}`;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxKeys: number;
  private readonly maxKeysPerGroup: number;
  private readonly groupCounts = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.maxRequests = opts.maxRequests;
    this.maxKeys = opts.maxKeys || 10_000;
    this.maxKeysPerGroup = opts.maxKeysPerGroup || 64;
    this.sweepTimer = setInterval(() => this.sweep(), opts.sweepIntervalMs || 60_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  check(key: string): RateCheckResult {
    return this.checkMany(key, 1);
  }

  /** Would ONE more hit fit? Records nothing. */
  peek(key: string): RateCheckResult {
    const now = Date.now();
    const inWindow = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (inWindow.length < this.maxRequests) return { allowed: true, retryAfterMs: 0 };
    const oldest = Math.min(...inWindow);
    return { allowed: false, retryAfterMs: Math.max(oldest + this.windowMs - now, 0) };
  }

  /** Forget every key (tests). */
  reset(): void {
    this.hits.clear();
    this.groupCounts.clear();
  }

  /**
   * Consume `count` slots atomically: either ALL fit into the window and are
   * recorded, or NONE are (a rejected caller has consumed nothing).
   */
  checkMany(key: string, count: number): RateCheckResult {
    if (count <= 0) return { allowed: true, retryAfterMs: 0 };
    const now = Date.now();
    const windowStart = now - this.windowMs;

    if (!this.hits.has(key)) {
      const group = groupOf(key);
      if ((this.groupCounts.get(group) ?? 0) >= this.maxKeysPerGroup) {
        return { allowed: false, retryAfterMs: this.windowMs };
      }
      // At capacity a NEW key evicts the least recently used one (the map is
      // insertion ordered and `set` below re-inserts on every hit).
      if (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.dropKey(oldest);
      }
      this.groupCounts.set(group, (this.groupCounts.get(group) ?? 0) + 1);
    }

    let timestamps = this.hits.get(key) || [];
    timestamps = timestamps.filter((t) => t > windowStart);
    this.hits.delete(key); // re-insert below = most recently used

    if (timestamps.length + count > this.maxRequests) {
      timestamps.sort((a, b) => a - b);
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow === undefined ? this.windowMs : oldestInWindow + this.windowMs - now;
      this.hits.set(key, timestamps);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    for (let i = 0; i < count; i++) timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  private dropKey(key: string): void {
    if (!this.hits.delete(key)) return;
    const group = groupOf(key);
    const n = (this.groupCounts.get(group) ?? 1) - 1;
    if (n <= 0) this.groupCounts.delete(group);
    else this.groupCounts.set(group, n);
  }

  /** Remove keys with no hits within the current window. */
  private sweep(): void {
    const windowStart = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (!timestamps.some((t) => t > windowStart)) this.dropKey(key);
    }
  }

  /** Stop the background sweep timer. */
  destroy(): void {
    clearInterval(this.sweepTimer);
  }
}
