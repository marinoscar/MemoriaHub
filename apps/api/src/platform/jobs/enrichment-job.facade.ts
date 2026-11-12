import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { EnrichmentJob, JobReason } from '@prisma/client';
import {
  JOB_SETTLED_EVENT,
  JobsService,
  type JobSettledEvent,
  type JobsInputJsonObject,
} from '@marinoscar/platform-api/jobs';

import { DefaultOrgId } from '../../common/tenancy/default-org-id';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ENRICHMENT_JOB_SETTLED_EVENT,
  EnrichmentJobSettledEvent,
} from '../../enrichment/events/enrichment-job-settled.event';
import { toEnrichmentJob } from './enrichment-job.mapping';

// =============================================================================
// EnrichmentJobService: the enqueue facade over the platform queue (RETRO-C1, #575)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-C9/C11): `EnrichmentJobService.enqueue` keeps its
// signature, so the ~60 enqueue call sites (uploads, reruns, backfills, the
// crons) change in ONE place, and now writes the platform `jobs` table through
// `JobsService.enqueue`. C9 (cron remediation) and C3 to C8 (native handlers)
// move callers to `JobsService` directly; C11 deletes this file.
//
// THE MAPPING (the inverse of `toEnrichmentJob`)
//
//   mediaItemId set            -> subject ('media_item', mediaItemId); a circleId
//                                 given with it is stored as `payload.circleId`
//   no media item, circleId    -> subject ('circle', circleId)
//   neither                    -> a global (system) job with no subject, org null
//   orgId                      -> the default organization for a job with a
//                                 subject, null for a global one
//   skipDedup / scheduledFor / priority / reason / payload -> the same fields
//
// DEDUP. The platform dedups on `buildDedupKey(type, subjectType, subjectId)`
// over the partial unique index `jobs_active_dedup_uniq_idx`, decided by the
// database, so it reproduces today's rule: one pending/running job per
// (type, media item), and one per type for a global job. One deliberate
// narrowing: a job scoped to a CIRCLE (no media item) now dedups per
// (type, circle); before, `(type, mediaItemId IS NULL)` collapsed every circle's
// job of that type into one unless the caller passed `skipDedup`. The callers
// that pass `skipDedup` still do, and the per-circle callers that did not
// (their per-circle guards read the queue first) were relying on this, so nothing
// is lost.
//
// A deduplicated call returns the EXISTING job (the platform's contract), exactly
// as the old `findFirst` did.
// =============================================================================

export interface EnqueueInput {
  type: string;
  mediaItemId?: string | null;
  circleId?: string | null;
  reason: JobReason;
  priority?: number;
  providerKey?: string;
  modelVersion?: string;
  payload?: Record<string, unknown>;
  /**
   * When true, the normal idempotency/dedup check is skipped entirely: the job
   * is queued even when an identical one is pending or running. Set it for any
   * job type that enqueues several distinct jobs against the same (or no)
   * subject in one batch (`storage_migration`, one per object; the per-circle
   * `memory_generation` shards).
   */
  skipDedup?: boolean;
  /**
   * Earliest time the job may be claimed (the claim query skips
   * `scheduled_for > now()`). Omit for "eligible immediately". Used to schedule
   * work for later durably, e.g. a scheduled broadcast's start job.
   */
  scheduledFor?: Date;
}

@Injectable()
export class EnrichmentJobService {
  private readonly logger = new Logger(EnrichmentJobService.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly defaultOrg: DefaultOrgId,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async enqueue(input: EnqueueInput): Promise<EnrichmentJob> {
    const {
      type,
      mediaItemId = null,
      circleId = null,
      reason,
      priority,
      providerKey,
      modelVersion,
      payload,
      skipDedup = false,
      scheduledFor,
    } = input;

    const subjectType = mediaItemId ? 'media_item' : circleId ? 'circle' : null;
    const geocodePayload = type === 'geocode' && mediaItemId ? await this.geocodeCoordinates(mediaItemId) : undefined;
    const subjectId = mediaItemId ?? circleId ?? null;
    const withCoordinates = geocodePayload ? { ...(payload ?? {}), ...geocodePayload } : payload;
    const storedPayload =
      mediaItemId && circleId ? { ...(withCoordinates ?? {}), circleId } : (withCoordinates ?? undefined);

    const job = await this.jobs.enqueue({
      type,
      reason,
      subjectType,
      subjectId,
      payload: storedPayload as JobsInputJsonObject | undefined,
      ...(priority !== undefined ? { priority } : {}),
      scheduledFor: scheduledFor ?? null,
      skipDedup,
      orgId: subjectType ? await this.defaultOrg.get() : null,
    });

    if (providerKey !== undefined || modelVersion !== undefined) {
      await this.jobs.recordProvider(job.id, providerKey ?? null, modelVersion ?? null);
    }

    this.logger.log(
      `Enqueued job type="${type}" subject="${subjectType ?? 'global'}:${subjectId ?? '-'}" ` +
        `reason="${reason}" priority=${priority ?? 0} id=${job.id}`,
    );
    return toEnrichmentJob(job);
  }

  /**
   * A `geocode` job carries the item's coordinates (RETRO-C10, #616): a worker node holds no database
   * access, so the payload is the only place it can learn where to look up. The handler still re-reads
   * the item when it runs on the server. Best-effort: a failed read enqueues the job without them.
   */
  private async geocodeCoordinates(mediaItemId: string): Promise<{ lat: number; lng: number } | undefined> {
    if (!this.prisma) return undefined;
    try {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: mediaItemId },
        select: { takenLat: true, takenLng: true },
      });
      if (item && Number.isFinite(item.takenLat) && Number.isFinite(item.takenLng)) {
        return { lat: item.takenLat as number, lng: item.takenLng as number };
      }
    } catch (err) {
      this.logger.warn(`Could not read coordinates for geocode job of ${mediaItemId}: ${String(err)}`);
    }
    return undefined;
  }

  /**
   * Record which provider/model processed a job, so the admin jobs dashboard and
   * historical job rows show the model used. Best-effort: never throws.
   */
  async recordModel(jobId: string, providerKey: string | null, modelVersion: string | null): Promise<void> {
    await this.jobs.recordProvider(jobId, providerKey, modelVersion);
  }
}

/**
 * Re-emits the platform's `job.settled` as the legacy `enrichment.job.settled`
 * event (same payload as before), so the three listeners that subscribe to it
 * (workflow trigger, enrichment-failure notification, broadcast failure) keep
 * working until they are re-pointed at the platform event (C3 to C8, D3).
 *
 * Only a TERMINAL job settles; the platform emits from the same two branches the
 * old terminal service did (succeeded, or failed with no retry or deferral left).
 * No I/O: the body is a translation and an emit.
 */
@Injectable()
export class LegacyJobSettledBridge {
  private readonly logger = new Logger(LegacyJobSettledBridge.name);

  constructor(private readonly events: EventEmitter2) {}

  @OnEvent(JOB_SETTLED_EVENT)
  handle(event: JobSettledEvent): void {
    if (event.status !== 'succeeded' && event.status !== 'failed') return;
    try {
      const legacy = toEnrichmentJob(event.job);
      this.events.emit(
        ENRICHMENT_JOB_SETTLED_EVENT,
        new EnrichmentJobSettledEvent(
          legacy.id,
          legacy.type,
          legacy.reason,
          legacy.mediaItemId,
          legacy.circleId,
          event.status,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to re-emit ${ENRICHMENT_JOB_SETTLED_EVENT} for job ${event.jobId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
