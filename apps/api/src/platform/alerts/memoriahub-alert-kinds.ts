// =============================================================================
// MemoriaHub's own alert rule kinds (RETRO-H5, #609)
// =============================================================================
//
// Two kinds the five built-ins cannot express:
//
//   * `memoriahub_queue_stalled`: "more than N claimable jobs are pending AND no
//     job succeeded in the last W seconds". `metric_threshold` reads ONE metric
//     per rule and compares ONE aggregate, so the conjunction of the queue-depth
//     gauge and the settled counter is not a metric rule. It reads the `jobs`
//     table directly (two indexed counts).
//   * `memoriahub_db_backup_stale`: "scheduled backups are on and the newest
//     completed backup is older than `intervalMultiplier` schedule intervals".
//     The db-backup slice exposes no metric or event for "the last success is too
//     old" (its `backup.schedule` Doctor check is on demand only), so this reads
//     the `databaseBackup` settings and `database_backup_runs`.
//
// Kind ids are PERMANENT once rules of the kind exist (the platform's rule), and
// the platform's id pattern is `^[a-z][a-z0-9_]*$` (no dot), hence the `_`
// prefix rather than the `memoriahub.` the issue sketched.
//
// Both are READ-ONLY (counts and `findFirst`s, no write) and cheap (well under
// the evaluation budget). They read the tables through `ctx.db`, the same
// `PLATFORM_PRISMA` client the slice evaluates with: the context types it as
// the slice's own narrow `AlertsPrisma`, so `appTables()` checks for the two
// delegates it needs and fails the rule with a clear `lastError` otherwise
// (see the `AlertEvaluationContext.db` row of local-exceptions.md).
//
// Registered at import time by `app-registrations/alerts.ts` (the kind registry
// freezes at bootstrap).
// =============================================================================

import { z } from 'zod';
import {
  alertRuleKindRegistry,
  registerAlertRuleKind,
  type AlertEvaluationContext,
  type AlertObservation,
  type AlertRuleKind,
} from '@marinoscar/platform-api/alerts';

/** Permanent kind ids. */
export const MEMORIAHUB_ALERT_KIND_IDS = {
  QUEUE_STALLED: 'memoriahub_queue_stalled',
  DB_BACKUP_STALE: 'memoriahub_db_backup_stale',
} as const;

/** The system-settings row the settings slice stores the global document in (`settings.config.ts`). */
export const SYSTEM_SETTINGS_ROW_KEY = 'global';

const HOUR_MS = 3_600_000;

/** Hours between two scheduled backups, by `databaseBackup.frequency`. `cron` uses the rule's `cronIntervalHours`. */
export const BACKUP_FREQUENCY_HOURS: Readonly<Record<string, number>> = {
  daily: 24,
  weekly: 24 * 7,
  monthly: 24 * 31,
};

// --- The tables the two kinds read (structural; a subset of the Prisma client) ---

interface CountDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

interface BackupRunDelegate {
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, 'asc' | 'desc'>;
    select: Record<string, true>;
  }): Promise<{ createdAt: Date; finishedAt: Date | null } | null>;
}

interface SystemSettingsDelegate {
  findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: unknown } | null>;
}

/** The part of the Prisma client the MemoriaHub kinds read. */
export interface MemoriaHubAlertTables {
  job: CountDelegate;
  databaseBackupRun: BackupRunDelegate;
  systemSettings: SystemSettingsDelegate;
}

/**
 * The app tables behind `ctx.db`. PLATFORM-ADOPTION-SHIM(#609): the context
 * declares only the slice's own tables; at runtime it is the full client.
 *
 * @throws Error when the client lacks a delegate (a test double, a wrong binding).
 */
export function appTables(ctx: AlertEvaluationContext): MemoriaHubAlertTables {
  const db = ctx.db as unknown as Partial<MemoriaHubAlertTables>;
  for (const delegate of ['job', 'databaseBackupRun', 'systemSettings'] as const) {
    if (!db[delegate]) {
      throw new Error(`The alert evaluation client has no "${delegate}" table; MemoriaHub's kinds need the application's Prisma client.`);
    }
  }
  return db as MemoriaHubAlertTables;
}

// --- memoriahub_queue_stalled ---

export const queueStalledConfigSchema = z
  .object({
    /** Breached only while MORE than this many claimable jobs are pending. */
    minPending: z.number().int().min(1).max(10_000_000).default(500),
    /** ...and none succeeded in this many seconds. */
    windowSeconds: z.number().int().min(60).max(86_400).default(1800),
  })
  .strict();
export type QueueStalledConfig = z.infer<typeof queueStalledConfigSchema>;

export const queueStalledKind: AlertRuleKind<QueueStalledConfig> = {
  id: MEMORIAHUB_ALERT_KIND_IDS.QUEUE_STALLED,
  label: 'Enrichment queue stalled',
  description: 'Many jobs are waiting and none has succeeded for a while: the workers are stopped, wedged or crash-looping.',
  configSchema: queueStalledConfigSchema,
  async evaluate(ctx, rule): Promise<AlertObservation[]> {
    const { job } = appTables(ctx);
    const { minPending, windowSeconds } = rule.config;
    const since = new Date(ctx.now.getTime() - windowSeconds * 1000);
    const [pending, succeeded] = await Promise.all([
      // Claimable only: a job in backoff (`scheduledFor` in the future) is waiting on purpose.
      job.count({ where: { status: 'pending', OR: [{ scheduledFor: null }, { scheduledFor: { lte: ctx.now } }] } }),
      job.count({ where: { status: 'succeeded', finishedAt: { gte: since } } }),
    ]);
    const breached = pending > minPending && succeeded === 0;
    const minutes = Math.round(windowSeconds / 60);
    return [
      {
        labels: {},
        value: pending,
        breached,
        summary: breached
          ? `${rule.name}: ${pending} jobs pending and none succeeded in ${minutes} min`
          : `${rule.name}: ${pending} pending, ${succeeded} succeeded in ${minutes} min`,
      },
    ];
  },
  describe: (rule) =>
    `More than ${rule.config.minPending} jobs pending and none succeeded in ${Math.round(rule.config.windowSeconds / 60)} min`,
};

// --- memoriahub_db_backup_stale ---

export const dbBackupStaleConfigSchema = z
  .object({
    /** Breached when the newest completed backup is older than this many schedule intervals. */
    intervalMultiplier: z.number().min(1).max(30).default(2),
    /** The interval assumed for `frequency: 'cron'` (the expression's own gaps are not computed). */
    cronIntervalHours: z.number().int().min(1).max(24 * 31).default(24),
  })
  .strict();
export type DbBackupStaleConfig = z.infer<typeof dbBackupStaleConfigSchema>;

interface BackupSchedule {
  enabled: boolean;
  frequency: string;
}

/** The `databaseBackup` namespace of the stored settings document, read defensively (absent means off). */
export function readBackupSchedule(value: unknown): BackupSchedule {
  const ns = (value && typeof value === 'object' ? (value as Record<string, unknown>).databaseBackup : undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    enabled: ns?.enabled === true,
    frequency: typeof ns?.frequency === 'string' ? ns.frequency : 'daily',
  };
}

export const dbBackupStaleKind: AlertRuleKind<DbBackupStaleConfig> = {
  id: MEMORIAHUB_ALERT_KIND_IDS.DB_BACKUP_STALE,
  label: 'Database backup stale',
  description: 'Scheduled database backups are on, but the newest completed backup is older than the schedule allows.',
  configSchema: dbBackupStaleConfigSchema,
  async evaluate(ctx, rule): Promise<AlertObservation[]> {
    const { databaseBackupRun, systemSettings } = appTables(ctx);
    const row = await systemSettings.findUnique({ where: { key: SYSTEM_SETTINGS_ROW_KEY }, select: { value: true } });
    const schedule = readBackupSchedule(row?.value);
    if (!schedule.enabled) {
      return [{ labels: {}, value: null, breached: false, summary: `${rule.name}: scheduled backups are off` }];
    }
    const intervalHours = BACKUP_FREQUENCY_HOURS[schedule.frequency] ?? rule.config.cronIntervalHours;
    const maxAgeMs = intervalHours * rule.config.intervalMultiplier * HOUR_MS;
    const cutoff = new Date(ctx.now.getTime() - maxAgeMs);
    const select = { createdAt: true, finishedAt: true } as const;
    const lastCompleted = await databaseBackupRun.findFirst({
      where: { status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select,
    });
    const limitHours = Math.round(intervalHours * rule.config.intervalMultiplier);
    if (!lastCompleted) {
      // Never completed: only stale once the schedule has had its window, judged by
      // the oldest attempt (a schedule switched on an hour ago is not late yet).
      const oldest = await databaseBackupRun.findFirst({ where: {}, orderBy: { createdAt: 'asc' }, select });
      const breached = oldest !== null && oldest.createdAt.getTime() < cutoff.getTime();
      return [
        {
          labels: {},
          value: null,
          breached,
          summary: breached
            ? `${rule.name}: no backup has ever completed (first attempt ${oldest!.createdAt.toISOString()})`
            : `${rule.name}: waiting for the first scheduled backup`,
        },
      ];
    }
    const at = lastCompleted.finishedAt ?? lastCompleted.createdAt;
    const ageHours = (ctx.now.getTime() - at.getTime()) / HOUR_MS;
    const breached = at.getTime() < cutoff.getTime();
    return [
      {
        labels: {},
        value: Math.round(ageHours * 10) / 10,
        breached,
        summary: breached
          ? `${rule.name}: the last completed backup is ${Math.floor(ageHours)} h old (limit ${limitHours} h, ${schedule.frequency} schedule)`
          : `${rule.name}: last completed backup ${Math.floor(ageHours)} h ago`,
      },
    ];
  },
  describe: (rule) => `The last completed database backup is older than ${rule.config.intervalMultiplier} schedule intervals`,
};

/** The MemoriaHub kinds, in registration order. */
export const MEMORIAHUB_ALERT_KINDS: readonly AlertRuleKind[] = [queueStalledKind, dbBackupStaleKind];

/** Registers the MemoriaHub kinds. Idempotent (a second import registers nothing twice). */
export function registerMemoriaHubAlertKinds(): void {
  for (const kind of MEMORIAHUB_ALERT_KINDS) {
    if (!alertRuleKindRegistry.has(kind.id)) registerAlertRuleKind(kind);
  }
}
