/**
 * backup/backup-scheduler.ts — Pull-based backup schedule poller (issue #318,
 * epic #308).
 *
 * The SERVER owns the schedule: cron parsing, timezone math, and rolling
 * `nextRunAt` forward all happen server-side (NodeBackupService rolls it
 * forward AT RUN START for trigger='scheduled'). This client never computes
 * cron — it only polls `GET /api/nodes/:id/backup/config` and fires a run
 * when the server-computed `nextRunAt` is due.
 *
 * Poll cadence: every `pollIntervalMs` (default 60 s), plus one IMMEDIATE
 * check when the scheduler starts. Offline-at-schedule self-heals for free:
 * a missed firing leaves `nextRunAt` in the past, and the next successful
 * poll — including the immediate one right after daemon start — fires it
 * then; the fired run's at-start roll-forward clears the past-due state.
 *
 * Failure posture: a failed poll is logged through the daemon logger and
 * polling continues; after `failureThreshold` (default 5) CONSECUTIVE
 * failures the cadence backs off to `backoffIntervalMs` (default 5 min)
 * until a poll succeeds again, which resets the cadence.
 *
 * `enabled: false` on the config is the kill switch — no future scheduled
 * run fires (an in-flight run is left alone to complete). A due schedule is
 * also skipped while a local run is already active (`isRunActive`); since
 * `nextRunAt` only rolls forward when a scheduled run STARTS, the still
 * past-due timestamp makes a later poll fire it once the active run ends.
 *
 * All timers are unref'd — the scheduler never keeps the daemon process
 * alive on its own.
 */

import type { NodeBackupConfigResult } from '../api.js';
import type { NodeLogger } from '../node/logger.js';

/** Normal poll cadence. */
export const SCHEDULER_POLL_INTERVAL_MS = 60_000;
/** Backed-off cadence after `SCHEDULER_FAILURE_THRESHOLD` consecutive failures. */
export const SCHEDULER_BACKOFF_INTERVAL_MS = 300_000;
/** Consecutive poll failures before backing off. */
export const SCHEDULER_FAILURE_THRESHOLD = 5;

/** The one API call the scheduler makes — mockable in tests. */
export interface BackupSchedulerApi {
  getNodeBackupConfig(nodeId: string): Promise<NodeBackupConfigResult>;
}

export interface BackupSchedulerOpts {
  nodeId: string;
  pollIntervalMs?: number;
  backoffIntervalMs?: number;
  failureThreshold?: number;
}

export interface BackupSchedulerDeps {
  api: BackupSchedulerApi;
  logger: NodeLogger;
  /** True while a local backup run is active — a due schedule is skipped. */
  isRunActive: () => boolean;
  /**
   * Fire a scheduled run. Guarded by `isRunActive` in the tick, but the
   * implementation must still tolerate a 'busy' race (log, never throw out).
   */
  startRun: (trigger: 'scheduled') => void;
  now?: () => number;
}

export class BackupScheduler {
  private readonly nodeId: string;
  private readonly pollIntervalMs: number;
  private readonly backoffIntervalMs: number;
  private readonly failureThreshold: number;
  private readonly deps: BackupSchedulerDeps;
  private readonly now: () => number;

  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private ticking = false;
  private consecutiveFailures = 0;

  constructor(opts: BackupSchedulerOpts, deps: BackupSchedulerDeps) {
    this.nodeId = opts.nodeId;
    this.pollIntervalMs = opts.pollIntervalMs ?? SCHEDULER_POLL_INTERVAL_MS;
    this.backoffIntervalMs = opts.backoffIntervalMs ?? SCHEDULER_BACKOFF_INTERVAL_MS;
    this.failureThreshold = opts.failureThreshold ?? SCHEDULER_FAILURE_THRESHOLD;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Start polling: one immediate check, then the timer chain. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runTickAndRearm();
  }

  /** Stop polling. An in-flight tick finishes; no further ticks are armed. */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Delay until the next poll — backed off after repeated failures. */
  nextDelayMs(): number {
    return this.consecutiveFailures >= this.failureThreshold
      ? this.backoffIntervalMs
      : this.pollIntervalMs;
  }

  /** Current consecutive-failure count (observable for tests/status). */
  get failures(): number {
    return this.consecutiveFailures;
  }

  private async runTickAndRearm(): Promise<void> {
    await this.tick();
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void this.runTickAndRearm();
    }, this.nextDelayMs());
    this.timer.unref?.();
  }

  /**
   * One poll: fetch the config and fire a scheduled run when due. Exposed
   * (rather than private) so tests can drive polls without real timers.
   * Never throws — poll failures are logged and counted.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { config } = await this.deps.api.getNodeBackupConfig(this.nodeId);
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.deps.logger.info('backup schedule poll recovered', {
          afterFailures: this.consecutiveFailures,
        });
      }
      this.consecutiveFailures = 0;

      // Kill switch: disabled config stops future scheduled runs entirely.
      if (!config || !config.enabled) return;

      const nextRunAt = typeof config.nextRunAt === 'string' ? config.nextRunAt : null;
      if (!nextRunAt) return;

      const dueAt = Date.parse(nextRunAt);
      if (!Number.isFinite(dueAt) || dueAt > this.now()) return;

      // A local run is already active: skip. nextRunAt stays past-due (it
      // only rolls forward when a SCHEDULED run starts), so a later poll
      // fires it once the active run ends.
      if (this.deps.isRunActive()) return;

      this.deps.logger.info('backup schedule due — starting scheduled run', { nextRunAt });
      try {
        this.deps.startRun('scheduled');
      } catch (err) {
        // 'busy' race or a start failure — log and let the next poll retry.
        this.deps.logger.warn('scheduled backup run failed to start', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      const backingOff = this.consecutiveFailures >= this.failureThreshold;
      this.deps.logger.warn('backup schedule poll failed', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
        ...(backingOff ? { backoffMs: this.backoffIntervalMs } : {}),
      });
    } finally {
      this.ticking = false;
    }
  }
}
