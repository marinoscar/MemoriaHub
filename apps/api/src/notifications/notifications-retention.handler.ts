// =============================================================================
// The `retention.appNotifications` purge (epic #240 issue #248; RETRO-C8, #608)
// =============================================================================
//
// The native successor of the old `NotificationPurgeHandler` and its midnight
// task, under the same permanent type string `notification_purge`. The
// platform's 01:00 `RetentionPurgeTask` enqueues it while the policy is enabled.
// Three `runRetentionPolicyPurge` passes, each a 5 000-id batch loop:
//
//   (a) DISMISSED notifications whose `dismissed_at` is older than the window;
//   (b) READ, not dismissed, notifications whose `read_at` is older than it;
//   (c) channel delivery audit rows (`notification_deliveries`) whose
//       `created_at` is older than it (pure machine records: age alone decides).
//
// UNREAD ROWS ARE NEVER DELETED BY AGE ALONE. This is NOT an oversight: an
// unread notification is by definition something the user has not dealt with,
// so it is read/dismissed STATE, not age, that makes one disposable. The
// backlog of a user who never opens the bell is bounded at the WRITE path
// instead (`upsertState()` keeps one live row per user/circle/review queue;
// `upsertCountedEvent()` folds repeated events into one counted row).
//
// Two passes rather than one OR'd predicate, so each is a clean single-column
// range scan on the index that exists for it, `(dismissed_at, updated_at)` and
// `(read_at)`. Pass (b) excludes dismissed rows: dismiss implies read and
// backfills `read_at`, so `dismissed_at >= read_at` always, and a row read long
// ago but dismissed yesterday is kept from its dismissal (the conservative
// reading of the two rules).
//
// The policy is re-read per run and a disabled policy is a logged no-op (an
// admin re-run of an old row must not delete data the operator chose to keep).
// SERVER-ONLY (no node-result pair): a pure SQL sweep. RETRO-D3 removes this
// handler when the platform notifications slice owns these tables.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  runRetentionPolicyPurge,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import type { Prisma } from '@prisma/client';

import { readRetentionPolicy } from '../platform/jobs/run-engine-jobs';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  APP_NOTIFICATIONS_PURGE_TYPE,
  APP_NOTIFICATIONS_RETENTION_KEY,
  APP_NOTIFICATIONS_RETENTION_POLICY,
} from './notifications.retention';

/** (a) Dismissed notifications resolved before `cutoff`. */
export function dismissedNotificationsWhere(cutoff: Date): Prisma.MhLegacyNotificationWhereInput {
  return { dismissedAt: { not: null, lt: cutoff } };
}

/** (b) Read, NOT dismissed, notifications read before `cutoff`. Unread rows never match. */
export function readNotificationsWhere(cutoff: Date): Prisma.MhLegacyNotificationWhereInput {
  return { dismissedAt: null, readAt: { not: null, lt: cutoff } };
}

@Injectable()
export class NotificationsRetentionHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NotificationsRetentionHandler.name);

  readonly type = APP_NOTIFICATIONS_PURGE_TYPE;

  readonly label = 'Notification purge';

  /** Deletes only; thirty minutes covers millions of rows. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 1_800_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const policy = await readRetentionPolicy(this.systemSettings, APP_NOTIFICATIONS_RETENTION_POLICY);
    const setting = `retention.${APP_NOTIFICATIONS_RETENTION_KEY}`;

    const notificationPass = (what: string, where: (cutoff: Date) => Prisma.MhLegacyNotificationWhereInput) =>
      runRetentionPolicyPurge({
        job,
        logger: this.logger,
        policy,
        setting,
        what,
        rows: 'notification(s)',
        selectIds: async (cutoff, take) =>
          (
            await this.prisma.mhLegacyNotification.findMany({
              where: where(cutoff),
              select: { id: true },
              take,
            })
          ).map((row) => row.id),
        deleteIds: async (ids) =>
          (await this.prisma.mhLegacyNotification.deleteMany({ where: { id: { in: ids } } })).count,
      });

    await notificationPass('dismissed notification purge', dismissedNotificationsWhere);
    await notificationPass('read notification purge', readNotificationsWhere);

    await runRetentionPolicyPurge({
      job,
      logger: this.logger,
      policy,
      setting,
      what: 'notification delivery purge',
      rows: 'delivery record(s)',
      selectIds: async (cutoff, take) =>
        (
          await this.prisma.mhLegacyNotificationDelivery.findMany({
            where: { createdAt: { lt: cutoff } },
            select: { id: true },
            take,
          })
        ).map((row) => row.id),
      deleteIds: async (ids) =>
        (await this.prisma.mhLegacyNotificationDelivery.deleteMany({ where: { id: { in: ids } } })).count,
    });
  }
}
