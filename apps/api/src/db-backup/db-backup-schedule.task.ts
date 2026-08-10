// =============================================================================
// Database Backup scheduling + staleness sweep (issue #342, epic #339)
// =============================================================================
//
// One never-throwing cron, two jobs per tick, in this order:
//
//   1. RELEASE STALE RUNS. Any `running` row whose `lastHeartbeatAt` has fallen
//      outside `databaseBackup.runStaleMinutes` is marked `stale` (+finishedAt)
//      and its partial storage object best-effort deleted.
//   2. FIRE A DUE BACKUP. Translate the friendly `databaseBackup.*` schedule to
//      a cron expression, compute the most recent fire boundary at/before now,
//      and start a run unless one already started at/after that boundary.
//
// Stale release runs FIRST so a run orphaned by a crash does not cost an extra
// 10-minute tick before the schedule can resume — the two jobs are independent,
// and the acceptance criterion ("the next tick marks it stale, and a subsequent
// backup can then start") is satisfied either way.
//
// THE DELIBERATE ASYMMETRY WITH THE ENRICHMENT QUEUE: a stale run is TERMINAL
// and is never requeued. Automatically restarting a multi-GB dump that just
// died — very possibly because it OOM-killed the process — is not obviously
// right, and the next scheduled tick is the natural retry. Do not "fix" this
// into an auto-restart.
//
// Why the sweep exists at all: this feature deliberately forgoes the enrichment
// queue's stuck-job recovery (#339), so without it ONE OOM-killed backup holds
// the `database_backup_runs_active_uniq_idx` slot forever and silently blocks
// every future backup — the worst failure mode this feature has.
//
// This task is INDEPENDENT of `ENRICHMENT_WORKER_MODE`: it is not a queue
// worker, so it must keep running under `ENRICHMENT_WORKER_MODE=off`. Its own
// kill-switch is `DB_BACKUP_SCHEDULE_ENABLED=false`, following the
// `THUMBNAIL_REPAIR_ENABLED` / `NOTIFICATIONS_RECONCILE_ENABLED` precedent.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { isValidCron, nextCronDate } from '../workflows/util/cron.util';
import { DatabaseBackupRunnerService } from './database-backup-runner.service';
import { DatabaseBackupRetentionService } from './database-backup-retention.service';
import { DatabaseBackupAlreadyRunningError } from './db-backup.errors';
import { buildCronExpression, DatabaseBackupFrequency } from './schedule.util';

/**
 * How far back `previousFireBoundary` searches for the last fire time. Must
 * exceed the longest gap any supported frequency can produce — 31 days for a
 * monthly schedule — with headroom.
 */
const BOUNDARY_LOOKBACK_DAYS = 40;

/** Hard bound on the boundary walk so a pathological cron cannot spin. */
const BOUNDARY_MAX_STEPS = 256;

/** Schema defaults (#340), used only when a setting is missing/garbage. */
const DEFAULT_RUN_STALE_MINUTES = 30;

interface DatabaseBackupScheduleConfig {
  enabled: boolean;
  frequency: DatabaseBackupFrequency;
  dayOfWeek: number;
  dayOfMonth: number;
  timeOfDay: string;
  timezone: string;
  runStaleMinutes: number;
}

@Injectable()
export class DatabaseBackupScheduleTask {
  private readonly logger = new Logger(DatabaseBackupScheduleTask.name);

  /**
   * In-process overlap guard (mirrors `NotificationReconcileTask`). A tick that
   * fires a backup can run for tens of minutes — far longer than the 10-minute
   * cron slot — so without this a single slow dump would stack ticks behind it.
   *
   * Single-process only, and sufficient: across replicas the real guard is the
   * partial unique index in the database, which turns a concurrent start into a
   * P2002 that this task treats as a no-op.
   */
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly runner: DatabaseBackupRunnerService,
    private readonly retention: DatabaseBackupRetentionService,
    private readonly providerResolver: StorageProviderResolver,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleTick(): Promise<void> {
    if (process.env['DB_BACKUP_SCHEDULE_ENABLED'] === 'false') {
      return;
    }

    if (this.sweepInFlight) {
      this.logger.debug('Database backup schedule tick already in flight; skipping');
      return;
    }
    this.sweepInFlight = true;

    try {
      const config = await this.readConfig();

      // (1) Free the single-active-run slot before (2) tries to claim it.
      await this.releaseStaleRuns(config.runStaleMinutes);

      // (2) Fire, if due.
      await this.fireDueBackup(config);
    } catch (err) {
      // A cron tick must never throw. Everything here is retried on the next
      // tick 10 minutes from now.
      this.logger.error('Database backup schedule tick failed', err as Error);
    } finally {
      this.sweepInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // (1) Staleness sweep — a direct port of NodeBackupStaleTask.markStaleRuns()
  // ---------------------------------------------------------------------------

  /**
   * Mark every `running` run whose heartbeat has gone quiet as `stale`, and
   * best-effort delete the partial object it was uploading.
   *
   * The row is transitioned FIRST: the row is the guard, and releasing it is
   * the load-bearing half. Object deletion is cleanup — if it fails, the row
   * keeps its `storageKey`, so the orphan is visible and fixable rather than
   * invisible and billable.
   *
   * Rows with a NULL `lastHeartbeatAt` are aged by `startedAt` instead — the
   * same defence `EnrichmentAdminService` applies to zombie rows that never got
   * their first progress write.
   */
  private async releaseStaleRuns(runStaleMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - runStaleMinutes * 60 * 1000);

    const candidates = await this.prisma.databaseBackupRun.findMany({
      where: {
        status: 'running',
        OR: [
          { lastHeartbeatAt: { lt: cutoff } },
          { lastHeartbeatAt: null, startedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, storageProvider: true, storageKey: true, bucket: true },
    });

    let released = 0;
    for (const run of candidates) {
      // Conditional update: if the run completed between the read and here, it
      // is no longer `running` and must not be stomped into `stale`.
      const { count } = await this.prisma.databaseBackupRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: {
          status: 'stale',
          finishedAt: new Date(),
          lastError:
            'Run released as stale: no heartbeat within databaseBackup.runStaleMinutes ' +
            '(the API process most likely died mid-dump). Not retried automatically; ' +
            'the next scheduled run is the retry.',
        },
      });
      if (count === 0) continue;

      released += 1;
      await this.deletePartialObject(run);
    }

    if (released > 0) {
      this.logger.warn(`Released ${released} stale database backup run(s)`);
    }
    return released;
  }

  private async deletePartialObject(run: {
    id: string;
    storageProvider: string | null;
    storageKey: string | null;
    bucket: string | null;
  }): Promise<void> {
    if (!run.storageProvider || !run.storageKey) return;
    try {
      const provider = await this.providerResolver.getProviderFor(
        run.storageProvider,
        run.bucket,
      );
      await provider.delete(run.storageKey);
      this.logger.log(
        `Deleted partial database backup object ${run.storageProvider}:${run.storageKey} from stale run ${run.id}`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not delete partial object ${run.storageKey} of stale run ${run.id}: ${errorMessage(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // (2) Fire a due backup
  // ---------------------------------------------------------------------------

  private async fireDueBackup(config: DatabaseBackupScheduleConfig): Promise<void> {
    if (!config.enabled) return;

    const expr = buildCronExpression(
      config.frequency,
      config.dayOfWeek,
      config.dayOfMonth,
      config.timeOfDay,
    );
    // `buildCronExpression` clamps its inputs so this should be unreachable;
    // it is here so a future field addition cannot feed a malformed expression
    // into CronTime (which throws) from inside a cron tick.
    if (!isValidCron(expr)) {
      this.logger.warn(`Refusing to schedule an invalid backup cron: "${expr}"`);
      return;
    }

    const now = new Date();
    const boundary = this.previousFireBoundary(expr, now, config.timezone);
    if (!boundary) return;

    // THE ANTI-DOUBLE-FIRE RULE. The tick fires every 10 minutes, so several
    // ticks fall after each boundary; comparing the most recent run's start
    // against the boundary — rather than against "did we fire recently" — is
    // what makes exactly one run happen per boundary, statelessly, with no
    // `lastRunAt` column to keep in sync and no drift after a restart.
    const latest = await this.prisma.databaseBackupRun.findFirst({
      where: { startedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });
    if (latest?.startedAt && latest.startedAt.getTime() >= boundary.getTime()) {
      return;
    }

    this.logger.log(
      `Starting scheduled database backup for boundary ${boundary.toISOString()} (cron "${expr}" @ ${config.timezone})`,
    );

    try {
      await this.runner.runBackup({ trigger: 'scheduled', createdById: null });
    } catch (err) {
      if (err instanceof DatabaseBackupAlreadyRunningError) {
        // NOT an error. Another replica (or a manual start) won the race for
        // the partial unique index — the guard did exactly its job, and the
        // backup this tick wanted is already happening.
        this.logger.debug(
          `Scheduled backup skipped: a run is already in progress (${err.activeRunId ?? 'unknown'})`,
        );
        return;
      }
      // The runner has already marked the run `failed`, deleted its partial
      // object and logged the cause; there is nothing to retry here. The next
      // boundary is the retry.
      this.logger.error(
        `Scheduled database backup failed: ${errorMessage(err)}`,
      );
      return;
    }

    // Only a SUCCESSFUL run prunes: retention keeps the newest N *good*
    // backups, so pruning after a failure could evict a good backup and
    // replace it with nothing.
    await this.retention.pruneAfterSuccessfulRun();
  }

  /**
   * The most recent fire time of `expr` at or before `now`, evaluated in
   * `timezone`, or null when the schedule has not fired within the lookback.
   *
   * `nextCronDate` only walks forward, so this steps forward from a point
   * safely before the previous fire and keeps the last time that is still
   * <= now. The walk is bounded (40 days back = at most ~40 steps for a daily
   * schedule) and capped besides.
   *
   * The timezone is passed EXPLICITLY as `nextCronDate`'s third argument, not
   * left to the `CronTime` constructor: `getNextDateFrom` derives its zone from
   * the start argument unless one is given, so omitting it would silently
   * evaluate "02:00" in the server's zone instead of the admin's.
   */
  private previousFireBoundary(
    expr: string,
    now: Date,
    timezone: string,
  ): Date | null {
    let cursor = new Date(now.getTime() - BOUNDARY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    let last: Date | null = null;

    for (let step = 0; step < BOUNDARY_MAX_STEPS; step++) {
      let next: Date;
      try {
        next = nextCronDate(expr, cursor, timezone);
      } catch (err) {
        // An unknown IANA zone makes CronTime throw. Log once and stand down
        // rather than firing at the wrong wall-clock time in a fallback zone.
        this.logger.warn(
          `Could not evaluate backup schedule "${expr}" in timezone "${timezone}": ${errorMessage(err)}`,
        );
        return null;
      }
      if (next.getTime() > now.getTime()) break;
      last = next;
      cursor = new Date(next.getTime() + 1000);
    }

    return last;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private async readConfig(): Promise<DatabaseBackupScheduleConfig> {
    const settings = (await this.systemSettings.getSettings()) as any;
    const cfg = settings?.databaseBackup ?? {};
    return {
      enabled: cfg.enabled === true,
      frequency: (cfg.frequency ?? 'daily') as DatabaseBackupFrequency,
      dayOfWeek: typeof cfg.dayOfWeek === 'number' ? cfg.dayOfWeek : 0,
      dayOfMonth: typeof cfg.dayOfMonth === 'number' ? cfg.dayOfMonth : 1,
      timeOfDay: typeof cfg.timeOfDay === 'string' ? cfg.timeOfDay : '02:00',
      timezone:
        typeof cfg.timezone === 'string' && cfg.timezone.trim().length > 0
          ? cfg.timezone
          : 'UTC',
      runStaleMinutes:
        typeof cfg.runStaleMinutes === 'number' && cfg.runStaleMinutes >= 1
          ? Math.trunc(cfg.runStaleMinutes)
          : DEFAULT_RUN_STALE_MINUTES,
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
