import cds from '@sap/cds';
import { WORKER_LEASE_TTL_MS } from './job-store';

const logger = cds.log('CardanoWalletWorker');

/**
 * Keeps a per-wallet lease alive while a job executes (build+sign can outlast the TTL).
 * Renews at a third of the TTL, so two consecutive misses are tolerated. `beat` is lenient
 * (DB error → retry next tick); `fence()` is strict (unprovable ownership = lost, before irreversible steps).
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

  /** True once a renewal proved the lease is not ours anymore — abort the execution. */
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
