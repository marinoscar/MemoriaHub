// =============================================================================
// Enrichment Failure Notification Producer (epic #240, issue #247)
// =============================================================================
//
// Produces `enrichment_failed` rows when an enrichment job fails PERMANENTLY.
//
// WHERE THE HOOK IS — ENRICHMENT_JOB_SETTLED_EVENT, outcome 'failed'.
//   EnrichmentTerminalService already emits exactly one settlement event per
//   job, from exactly the two genuinely terminal branches:
//     - the rate-limit path only when `giveUp` (rateLimitHits >= RL_MAX_HITS),
//     - the normal-failure path only when `!shouldRetry`
//       (attempts >= ENRICHMENT_MAX_ATTEMPTS),
//   and NEVER on an intermediate retry or a rate-limit deferral (both of those
//   branches requeue the job to `pending` and skip emitSettled). Subscribing to
//   that event therefore gets the terminal-only semantics for free, from the
//   single chokepoint shared by the in-process worker AND node-reported
//   failures — with no edit to EnrichmentTerminalService, and no
//   NotificationsModule -> EnrichmentModule import (the event name is a plain
//   constant, not a provider). Hooking the service directly would have meant
//   re-deriving `giveUp`/`shouldRetry` at a second site that could drift.
//
//   `lastError` is not carried on the event, so the job row is re-read. That
//   read only ever happens on a terminal failure, and the event is emitted
//   AFTER the terminal write, so the value read is the final one.
//
// AUDIENCE — users holding the Admin system role, only.
//   The action link (`/admin/settings/jobs?status=failed`) is Admin-gated
//   (`jobs:read`/`jobs:write`), so a non-admin could not act on the row. The
//   admin set is resolved through `userRoles.some(role.name = 'admin')` — the
//   same predicate DoctorService uses for its admin-bootstrap check.
//
// VOLUME GUARD — one live row per (admin, jobType), NO time window.
//   A poison-pill batch that fails 400 `auto_tagging` jobs is ONE row with
//   `count: 400`, not 400 rows. Unlike `upload_completed` there is deliberately
//   no rolling window: an unnoticed failure backlog should keep accumulating
//   into the same row until an admin dismisses it, not silently split into a
//   new row every 15 minutes. Partitioning is by `data.jobType` (via
//   upsertCountedEvent's `matchData` JSONB containment predicate), so a
//   `geocode` backlog and an `auto_tagging` backlog stay separate rows.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JobStatus, NotificationType } from '@prisma/client';

import { ROLES } from '../../common/constants/roles.constants';
import {
  ENRICHMENT_JOB_SETTLED_EVENT,
  EnrichmentJobSettledEvent,
} from '../../enrichment/events/enrichment-job-settled.event';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications.service';

/**
 * TTL for the admin-user-id lookup. A poison-pill batch settles many failures
 * back to back; without this each one would re-run the same role join.
 */
const ADMIN_CACHE_TTL_MS = 60_000;

/** `lastError` is stored for context, not forensics — the job row has the full text. */
const MAX_LAST_ERROR_CHARS = 500;

@Injectable()
export class EnrichmentFailureNotificationListener {
  private readonly logger = new Logger(EnrichmentFailureNotificationListener.name);

  private adminCache: { ids: string[]; cachedAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * `async: true` matches WorkflowTriggerListener: the handler runs off the
   * emitter's synchronous path so a slow notification write can never delay the
   * job worker's next claim. Never throws — an unhandled rejection here would
   * surface as a process-level warning for something that is best-effort.
   */
  @OnEvent(ENRICHMENT_JOB_SETTLED_EVENT, { async: true })
  async handleJobSettled(event: EnrichmentJobSettledEvent): Promise<void> {
    if (event.outcome !== 'failed') return;

    try {
      // Re-read for `lastError`, and re-assert `failed` defensively: the event
      // is only emitted from terminal branches, but a row that has since been
      // retried by an admin is no longer a permanent failure worth reporting.
      const job = await this.prisma.enrichmentJob.findUnique({
        where: { id: event.jobId },
        select: { status: true, lastError: true },
      });
      if (!job || job.status !== JobStatus.failed) return;

      const adminIds = await this.loadAdminUserIds();
      if (adminIds.length === 0) return;

      const lastError = job.lastError
        ? job.lastError.slice(0, MAX_LAST_ERROR_CHARS)
        : null;

      for (const userId of adminIds) {
        await this.notifications.upsertCountedEvent({
          userId,
          // Global row: an enrichment failure is an operational concern, not a
          // circle one, and the admin dashboard it links to is app-wide.
          circleId: null,
          type: NotificationType.enrichment_failed,
          // `jobType` must be in BOTH matchData and data — matchData is the
          // JSONB containment predicate that finds this row again next time.
          matchData: { jobType: event.type },
          data: { jobType: event.type, lastError },
          // No window: accumulate until dismissed. See the header.
          windowMs: null,
          link: '/admin/settings/jobs?status=failed',
          buildTitle: (count) =>
            `${count} ${event.type} ${count === 1 ? 'job' : 'jobs'} failed permanently`,
          reunreadOnIncrement: true,
        });
      }
    } catch (err) {
      this.logger.warn(
        `enrichment_failed notification for job ${event.jobId} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** Active users holding the Admin system role, cached for ADMIN_CACHE_TTL_MS. */
  private async loadAdminUserIds(): Promise<string[]> {
    const now = Date.now();
    if (this.adminCache && now - this.adminCache.cachedAt < ADMIN_CACHE_TTL_MS) {
      return this.adminCache.ids;
    }

    const admins = await this.prisma.user.findMany({
      where: {
        isActive: true,
        userRoles: { some: { role: { name: ROLES.ADMIN } } },
      },
      select: { id: true },
    });

    const ids = admins.map((a) => a.id);
    this.adminCache = { ids, cachedAt: now };
    return ids;
  }
}
