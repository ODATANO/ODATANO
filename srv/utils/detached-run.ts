import cds from '@sap/cds';

/** none: never started in this process. cancelled: stopped on request, the work done so far is kept. */
export type RunStatus = 'none' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RunLifecycle {
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Longest error text a status keeps. */
const ERROR_TEXT_MAX = 500;

export interface RunControl<P> {
  /** Records progress of this run. */
  progress(p: Partial<P>): void;
  /** True once the run was asked to stop. */
  shouldStop(): boolean;
}

/** What a start hands back once its checks passed: the work, and the answer to the caller. */
export interface PreparedRun<P, A> {
  initial?: Partial<P>;
  run: (ctl: RunControl<P>) => Promise<Partial<P> | void>;
  answer: A;
  /** Name in the log line of a failure; default the run's own label. */
  label?: string;
}

// One long maintenance run per kind and process, run detached from the request that started it.
// A start marks the run as running before its first await, so a second start sees it busy.
export class DetachedRun<P extends object> {
  private state: P & RunLifecycle;
  private stopRequested = false;
  private readonly logger = cds.log('MaintenanceRun');

  constructor(
    readonly label: string,
    private readonly idle: P,
    /** Fields shown as text, like the Int64 values of the other answers. */
    private readonly textFields: ReadonlyArray<keyof P> = [],
  ) {
    this.state = { ...idle, status: 'none', startedAt: null, finishedAt: null, error: null };
  }

  isBusy(): boolean {
    return this.state.status === 'running';
  }

  /** The status fields of the last run; text fields as strings. */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(this.idle) as Array<keyof P & string>) {
      const value = this.state[key];
      out[key] = this.textFields.includes(key) && value != null ? String(value) : value;
    }
    for (const key of ['status', 'startedAt', 'finishedAt', 'error'] as const) out[key] = this.state[key];
    return out;
  }

  // Runs `prepare` for its checks, then the work detached. A check that throws leaves the previous
  // state in place and reaches the caller.
  async start<A>(prepare: () => Promise<PreparedRun<P, A>> | PreparedRun<P, A>): Promise<A> {
    if (this.isBusy()) throw new Error(`${this.label} is already running`);
    const previous = this.state;
    const current: P & RunLifecycle = { ...this.idle, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.state = current;
    this.stopRequested = false;
    let prepared: PreparedRun<P, A>;
    try {
      prepared = await prepare();
    } catch (err) {
      this.state = previous;
      throw err;
    }
    Object.assign(current, prepared.initial ?? {});
    const label = prepared.label ?? this.label;
    // cancelled only when the run saw the request: one that ended first is done
    let stopped = false;
    const ctl: RunControl<P> = {
      progress: (p) => { Object.assign(current, pickKnown(this.idle, p)); },
      shouldStop: () => (stopped ||= this.stopRequested && this.state === current),
    };
    // a run that throws before it returns a promise fails like one that rejects
    void Promise.resolve()
      .then(() => prepared.run(ctl))
      .then((result) => {
        Object.assign(current, pickKnown(this.idle, result ?? {}), {
          status: stopped ? 'cancelled' : 'done', finishedAt: new Date().toISOString(),
        });
        if (current.status === 'cancelled') this.logger.info(`${label} cancelled`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        Object.assign(current, { status: 'failed', finishedAt: new Date().toISOString(), error: message.slice(0, ERROR_TEXT_MAX) });
        this.logger.error(`${label} failed: ${message}`);
      });
    return prepared.answer;
  }

  /** Asks a running run to stop at its next check. False when nothing runs. */
  cancel(): boolean {
    if (!this.isBusy()) return false;
    this.stopRequested = true;
    return true;
  }
}

/** The fields of `p` the status declares; a result may carry more. */
function pickKnown<P extends object>(idle: P, p: Partial<P> | object): Partial<P> {
  const out: Partial<P> = {};
  for (const [key, value] of Object.entries(p)) {
    if (key in idle) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
