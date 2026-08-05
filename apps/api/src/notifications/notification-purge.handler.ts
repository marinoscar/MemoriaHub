// =============================================================================
// Notification Purge Enrichment Handler (epic #240, issue #248)
// =============================================================================
//
// Global enrichment job that keeps the notifications table from growing without
// bound. Every other row-producing subsystem here has a retention story —
// job_history_purge for enrichment_jobs, trash_purge for trashed media,
// review_run_history_purge for review runs, picture_enhancement_purge for
// enhancement staging — and notifications otherwise accumulate per user, per
// circle, forever.
//
// -----------------------------------------------------------------------------
// WHAT GETS PURGED — AND THE DELIBERATE ASYMMETRY VS. job_history_purge
// -----------------------------------------------------------------------------
// Two disposal rules, both keyed on a RESOLUTION TIMESTAMP:
//
//   (a) dismissed_at IS NOT NULL AND dismissed_at < now() - retentionDays
//   (b) read_at      IS NOT NULL AND read_at      < now() - retentionDays
//
// UNREAD ROWS ARE NEVER DELETED BY AGE ALONE. This is NOT an oversight and NOT
// a gap to be "fixed" later by adding a created_at rule — it is the point.
// job_history_purge deletes purely by `finishedAt` age because an enrichment job
// row is a machine artifact nobody is waiting on. A notification is the exact
// opposite: an UNREAD one is by definition something the user has not dealt
// with yet, and silently deleting it defeats the entire feature. So it is
// read/dismissed STATE — not age — that makes a row disposable here; age only
// decides how long after that resolution the row is kept around for history.
//
// A user who never opens the bell therefore keeps their backlog indefinitely.
// That backlog is bounded by design at the WRITE path rather than here: #245's
// upsertState() keeps at most one live row per (user, circle, review_queue_*)
// type, and upsertCountedEvent() folds repeated upload/enrichment-failure
// occurrences into a single counted row. The producers cannot fan out, so
// "never purged while unread" cannot become unbounded growth.
//
// -----------------------------------------------------------------------------
// Server-only BY OMISSION — no nodeResultSchema / persistNodeResult. This is a
// pure SQL sweep with no per-item unit of work for a node (and no media bytes to
// stream), the same precedent as job_history_purge / trash_purge /
// review_run_history_purge. That omission is exactly what makes the type fall
// into EnrichmentHandlerRegistry.serverOnlyTypes(), and therefore into the
// ENRICHMENT_WORKER_MODE=system claim set, with no explicit pinning.
//
// Deletes in bounded 5,000-row batches so each DELETE stays short and never
// holds locks long enough to stall the worker's row claims — same bound as
// JobHistoryPurgeHandler. Runs via the shared enrichment worker queue (retries,
// visibility in /admin/jobs, dedup on `(type, mediaItemId IS NULL)`).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, Prisma } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/** Fallback when `notifications.retentionDays` is unset. */
const DEFAULT_RETENTION_DAYS = 30;

/** Rows deleted per batch — same bound as JobHistoryPurgeHandler. */
const BATCH_SIZE = 5000;

@Injectable()
export class NotificationPurgeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'notification_purge';

  private readonly logger = new Logger(NotificationPurgeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    // Re-checked here as well as in NotificationPurgeTask: the cron is not the
    // only way a job of this type can exist (a manual retry from /admin/jobs
    // re-runs an already-queued row), so the escape hatch has to hold at the
    // point of work, not only at the point of scheduling. Mirrors
    // JobHistoryPurgeHandler's jobs.history.purgeEnabled check.
    const enabled =
      (await this.systemSettings.getSettingValue<boolean>('notifications.purgeEnabled')) ?? true;

    if (!enabled) {
      this.logger.log('notification_purge: disabled via notifications.purgeEnabled; skipping');
      return;
    }

    const retentionDays =
      (await this.systemSettings.getSettingValue<number>('notifications.retentionDays')) ??
      DEFAULT_RETENTION_DAYS;

    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    this.logger.log(
      `notification_purge: starting — retentionDays=${retentionDays}, cutoff=${cutoff.toISOString()}`,
    );

    // Two passes rather than one OR'd predicate, so each is a clean single-column
    // range scan on the index that exists for it — `(dismissed_at, updated_at)`
    // and `(read_at)` respectively (both added by #244's migration for exactly
    // this sweep). A dismissed row that was also read is caught by the first
    // pass and simply no longer exists for the second; there is no double count.
    const dismissedWhere: Prisma.NotificationWhereInput = {
      dismissedAt: { not: null, lt: cutoff },
    };

    // Read but NOT dismissed. The `dismissedAt: null` clause keeps the two
    // passes strictly disjoint, and it also picks the RIGHT clock for the one
    // row shape where the two rules disagree: dismiss implies read and
    // backfills `read_at` when null, so `dismissed_at >= read_at` always, and a
    // row read long ago but dismissed yesterday should be retained from its
    // dismissal (the user's most recent interaction with it), not deleted on
    // the strength of the older read. Excluding dismissed rows here is
    // therefore the conservative reading of the two rules, never the looser one.
    const readWhere: Prisma.NotificationWhereInput = {
      dismissedAt: null,
      readAt: { not: null, lt: cutoff },
    };

    const dismissedDeleted = await this.purgeInBatches(dismissedWhere);
    const readDeleted = await this.purgeInBatches(readWhere);

    this.logger.log(
      `notification_purge: deleted ${dismissedDeleted + readDeleted} notification(s) past cutoff ` +
        `(${dismissedDeleted} dismissed, ${readDeleted} read); unread rows retained by design`,
    );
  }

  /**
   * Lock-safe batched delete: select a bounded id set, delete it, repeat until a
   * short batch signals the eligible set is exhausted. Same shape as
   * JobHistoryPurgeHandler / ReviewRunHistoryPurgeHandler — never loads the full
   * eligible set into memory, and each DELETE touches at most BATCH_SIZE rows.
   */
  private async purgeInBatches(where: Prisma.NotificationWhereInput): Promise<number> {
    let totalDeleted = 0;

    for (;;) {
      const batch = await this.prisma.notification.findMany({
        where,
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) break;

      const result = await this.prisma.notification.deleteMany({
        where: { id: { in: batch.map((row) => row.id) } },
      });
      totalDeleted += result.count;

      if (batch.length < BATCH_SIZE) break;
    }

    return totalDeleted;
  }
}
