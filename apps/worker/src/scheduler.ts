import type { WorkerContext } from './context';

/**
 * A unit of recurring work.
 *
 * Jobs are plain async functions with a minimum interval. They must be
 * idempotent: the process can die at any point, and the next tick will simply
 * run them again.
 */
export interface Job {
  name: string;
  /** Minimum gap between the *end* of one run and the start of the next. */
  everyMs: number;
  /**
   * Returns a short summary for the log line, or nothing when there was no
   * work to do. Receives a signal that aborts on shutdown so long passes can
   * bail out early.
   */
  run(ctx: WorkerContext, signal: AbortSignal): Promise<Record<string, unknown> | void>;
}

type JobState = {
  job: Job;
  nextRunAt: number;
  runs: number;
  failures: number;
  lastError?: string;
  lastRunAt?: number;
  lastDurationMs?: number;
};

export interface SchedulerStatus {
  startedAt: number;
  lastTickAt: number | null;
  ticks: number;
  stopping: boolean;
  jobs: {
    name: string;
    runs: number;
    failures: number;
    lastRunAt: number | null;
    lastDurationMs: number | null;
    lastError: string | null;
  }[];
}

/**
 * Serial job runner.
 *
 * Deliberately one job at a time in a `while` loop rather than a set of
 * `setInterval`s: intervals overlap when a run takes longer than its period,
 * and overlapping maintenance passes on the same rows buy nothing. Sending
 * concurrency, when it arrives, comes from several worker *processes* claiming
 * rows with `for update skip locked` — not from racing timers inside one.
 *
 * A job that throws is logged and retried on its next slot. Nothing a job does
 * can stop the loop.
 */
export class Scheduler {
  private readonly states: JobState[];
  private readonly abort = new AbortController();
  private readonly startedAt = Date.now();
  private lastTickAt: number | null = null;
  private ticks = 0;
  private stopping = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly ctx: WorkerContext,
    jobs: Job[],
  ) {
    const now = Date.now();
    this.states = jobs.map((job) => ({ job, nextRunAt: now, runs: 0, failures: 0 }));
  }

  start(): void {
    if (this.loop) return;
    this.ctx.log.info('scheduler starting', {
      tickMs: this.ctx.env.WORKER_TICK_MS,
      jobs: this.states.map((s) => s.job.name),
    });
    this.loop = this.run();
  }

  /**
   * Stops scheduling new work and waits for the job in flight, up to
   * `graceMs`. Returning does not guarantee the loop finished — the caller
   * decides whether to exit anyway.
   */
  async stop(graceMs = 15_000): Promise<void> {
    if (!this.loop) return;
    this.stopping = true;
    this.abort.abort();

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), graceMs).unref(),
    );
    const result = await Promise.race([this.loop.then(() => 'done' as const), timeout]);
    if (result === 'timeout') {
      this.ctx.log.warn('scheduler did not drain in time', { graceMs });
    }
  }

  status(): SchedulerStatus {
    return {
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      ticks: this.ticks,
      stopping: this.stopping,
      jobs: this.states.map((s) => ({
        name: s.job.name,
        runs: s.runs,
        failures: s.failures,
        lastRunAt: s.lastRunAt ?? null,
        lastDurationMs: s.lastDurationMs ?? null,
        lastError: s.lastError ?? null,
      })),
    };
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      this.ticks += 1;
      this.lastTickAt = Date.now();

      for (const state of this.states) {
        if (this.stopping) break;
        if (Date.now() < state.nextRunAt) continue;
        await this.runOne(state);
      }

      await this.sleep(this.ctx.env.WORKER_TICK_MS);
    }
    this.ctx.log.info('scheduler stopped', { ticks: this.ticks });
  }

  private async runOne(state: JobState): Promise<void> {
    const started = Date.now();
    const log = this.ctx.log.child({ job: state.job.name });

    try {
      const summary = await state.job.run(this.ctx, this.abort.signal);
      state.runs += 1;
      state.lastError = undefined;
      // Only log when something actually happened — an idle worker should be
      // silent, so that the log is a record of activity and not of time.
      if (summary && Object.keys(summary).length > 0) {
        log.info('job did work', { ...summary, durationMs: Date.now() - started });
      }
    } catch (error) {
      state.failures += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      log.error('job failed', { error, durationMs: Date.now() - started });
    } finally {
      state.lastRunAt = started;
      state.lastDurationMs = Date.now() - started;
      // Schedule from completion, not from the slot, so a slow job cannot
      // build up a backlog it then tries to run back-to-back.
      state.nextRunAt = Date.now() + state.job.everyMs;
    }
  }

  /** Sleep that wakes immediately on shutdown. */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const signal = this.abort.signal;

    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
