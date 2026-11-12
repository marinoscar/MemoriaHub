// =============================================================================
// Enrichment Failure Notification Producer (epic #240, issue #247; RETRO-J10 #624)
// =============================================================================
//
// Raises `media.enrichment_failed` (through `MEMORIAHUB_NOTIFY`) when a background job fails
// PERMANENTLY. The platform's own `jobs.job_failed` is suppressed in the default policy so one failure
// is one bell.
//
// WHERE THE HOOK IS: the jobs port's `onSettled`, status `failed`. The port reports a job only when it
// settles for good (a retry or a rate-limit deferral requeues it and reports nothing), so a listener on it
// inherits the terminal-only semantics from the one chokepoint the in-process worker and node-reported
// failures share, and the event carries `lastError`, so the job row is never re-read.
//
// AUDIENCE: the deployment's administrators, as the identity port names them (`adminUserIds`). The action
// link (`/admin/settings/jobs?status=failed`) is administrator-gated, so anyone else could not act on it.
//
// VOLUME GUARD: one live row per (administrator, job type), NO time window. A poison-pill batch that fails
// 400 `auto_tagging` jobs is ONE row with `count: 400`. Unlike `upload_completed` there is deliberately no
// rolling window: an unnoticed failure backlog keeps accumulating into the same row until an administrator
// dismisses it, not silently splitting every 15 minutes. The partition is `match: { jobType }`, so a
// `geocode` backlog and an `auto_tagging` backlog stay separate rows.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  MEMORIAHUB_IDENTITY,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_NOTIFY,
  type MemoriahubIdentityPort,
  type MemoriahubJobSettledEvent,
  type MemoriahubJobsPort,
  type MemoriahubNotifyPort,
} from '../../ports/index.js';

/**
 * The event key the producer raises. Persisted on every row: never rename it. The host declares the event
 * (template, channels, kind `counted`).
 *
 * @stability experimental
 */
export const ENRICHMENT_FAILED_EVENT_KEY = 'media.enrichment_failed';

/** TTL of the administrator id lookup: a poison-pill batch settles many failures back to back. */
const ADMIN_CACHE_TTL_MS = 60_000;

/** `lastError` is stored for context, not forensics: the job row has the full text. */
const MAX_LAST_ERROR_CHARS = 500;

/**
 * Notifies the administrators of a permanent job failure.
 *
 * @stability experimental
 */
@Injectable()
export class EnrichmentFailureNotificationListener implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentFailureNotificationListener.name);

  private adminCache: { ids: readonly string[]; cachedAt: number } | null = null;

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_IDENTITY) private readonly identity: MemoriahubIdentityPort,
    @Inject(MEMORIAHUB_NOTIFY) private readonly notify: MemoriahubNotifyPort,
  ) {}

  /** Subscribes to settled jobs. */
  onModuleInit(): void {
    this.jobs.onSettled((event) => {
      void this.handleJobSettled(event);
    });
  }

  /**
   * Raises the counted row of every administrator for one settled job. Never throws: an unhandled
   * rejection here would surface as a process-level warning for something best-effort.
   *
   * @param event - the settled job.
   */
  async handleJobSettled(event: MemoriahubJobSettledEvent): Promise<void> {
    if (event.status !== 'failed') return;

    try {
      const adminIds = await this.loadAdminUserIds();
      if (adminIds.length === 0) return;

      const lastError = event.lastError ? event.lastError.slice(0, MAX_LAST_ERROR_CHARS) : null;

      for (const userId of adminIds) {
        // COUNTED, deployment-wide (no scope), partitioned by job type, no window.
        this.notify.notifyCounted(
          ENRICHMENT_FAILED_EVENT_KEY,
          userId,
          { jobType: event.type, lastError },
          { scopeId: null, match: { jobType: event.type } },
        );
      }
    } catch (err) {
      this.logger.warn(
        `enrichment_failed notification for job ${event.jobId} failed: ` + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** The administrator ids, cached for {@link ADMIN_CACHE_TTL_MS}. Empty when the host names none. */
  private async loadAdminUserIds(): Promise<readonly string[]> {
    if (!this.identity.adminUserIds) return [];
    const now = Date.now();
    if (this.adminCache && now - this.adminCache.cachedAt < ADMIN_CACHE_TTL_MS) return this.adminCache.ids;
    const ids = await this.identity.adminUserIds();
    this.adminCache = { ids, cachedAt: now };
    return ids;
  }
}
