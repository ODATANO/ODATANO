import cds from '@sap/cds';
import { WORKER_LEASE_TTL_MS } from './job-store';

const logger = cds.log('CardanoWalletWorker');

/**
 * Keeps a per-wallet lease alive for as long as a job execution runs.
 *
 * Building and signing a transaction can easily outlast WORKER_LEASE_TTL_MS (a
 * multi-backend build plus an HSM round-trip); a single renewal before the build
 * is therefore not enough. Without a heartbeat the lease silently expires
 * mid-execution, another instance adopts the wallet, fails this executor's row as
 * orphaned and starts the next job — two executors on one wallet, which is exactly
 * what the per-wallet lease exists to prevent.
 *
 * Renewals run at a third of the TTL, so two consecutive misses (slow DB, event
 * loop hiccup) are tolerated before the lease can lapse. A process that is truly
 * wedged stops beating and correctly loses the wallet.
 *
 * Two failure semantics, on purpose:
 *  - the periodic `beat` is lenient: a DB error is logged and retried next tick,
 *    only a definitive "not yours" marks the lease lost.
 *  - `fence()` is strict: it is called right before an irreversible step, where
 *    "cannot prove ownership" must be treated as "not ours". Aborting there is
 *    free (nothing has been sent yet); guessing wrong is a double spend.
 */
export const LEASE_HEARTBEAT_INTERVAL_MS = Math.floor(WORKER_LEASE_TTL_MS / 3);

export class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lost = false;

  /**
   * @param renew   renews the lease and reports whether it is (still) ours
   * @param label   what the lease covers, for log messages
   */
  constructor(
    private readonly renew: () => Promise<boolean>,
    private readonly label: string,
    private readonly intervalMs: number = LEASE_HEARTBEAT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.beat(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** True once a renewal proved the lease is no longer ours — abort the execution. */
  isLost(): boolean {
    return this.lost;
  }

  /** Renew now; false means "do not touch this wallet any further". */
  async fence(): Promise<boolean> {
    if (this.lost) return false;
    try {
      const held = await this.renew();
      if (!held) this.markLost();
      return held;
    } catch (err) {
      logger.warn(`Lease fence for ${this.label} could not be verified — treating the lease as lost:`, err);
      this.lost = true;
      return false;
    }
  }

  private async beat(): Promise<void> {
    if (this.lost) return;
    try {
      if (!(await this.renew())) this.markLost();
    } catch (err) {
      logger.debug(`Lease renewal for ${this.label} failed (retrying next beat):`, err);
    }
  }

  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.stop();
    logger.warn(`Lease for ${this.label} was taken over by another instance — this executor must stand down`);
  }
}
