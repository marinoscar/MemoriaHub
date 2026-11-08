import { Injectable, Logger } from '@nestjs/common';
import type { EnrichmentJob, JobReason, MhLegacyJobStatus } from '@prisma/client';
import {
  JobHandlerRegistry,
  ProviderThrottleService,
  RateLimitError as PlatformRateLimitError,
  type Job,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';

import type { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { RateLimitError as LegacyRateLimitError, classifyRateLimit } from '../../enrichment/rate-limit.error';
import { PrismaService } from '../../prisma/prisma.service';
import { ENRICHMENT_MAX_ATTEMPTS } from './queue-limits';
import { videoJobTimeoutMs } from './legacy-env';

// =============================================================================
// LegacyEnrichmentHandlerAdapter (RETRO-C1, #575)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-C3..C8): the 38 `EnrichmentHandler` classes keep
// their logic untouched; this adapter turns each into a platform `JobHandler`
// with the SAME `type` and registers it with `JobHandlerRegistry`, so the queue,
// the lease, the admin list and (from C2) the worker nodes see an ordinary
// handler. C3 to C8 convert the handler groups to native `JobHandler`s and the
// adapter shrinks to nothing (C11 deletes it).
//
// WHAT IT DOES THAT A HANDLER MUST NOT HAVE TO
//
//   * `Job` -> `EnrichmentJob` (`toEnrichmentJob`, the inverse of the facade's
//     mapping): the subject becomes `mediaItemId` / `circleId` again and the
//     `circleId` the facade stored in the payload of a media-item job is taken
//     out of it, so a handler sees exactly the row shape it always saw.
//   * the node pair is forwarded ONLY when the legacy handler has BOTH members:
//     eligibility is derived by the platform, never flagged, so a type that was
//     server-only stays server-only (`job-type-snapshot.spec.ts` pins this).
//   * a job whose SUBJECT no longer exists settles as a no-op success. The old
//     `enrichment_jobs` rows cascaded away with their media item or circle; the
//     platform `jobs` row has no foreign key to either (`subject_id` is text), so a
//     job queued for an item that was hard-deleted since would reach a handler that
//     throws "MediaItem ... not found" and fail three times. One primary-key lookup
//     per job, before the handler, covers all 38 handlers (and any added later)
//     without touching one of them.
//   * `canDelete` is forwarded (broadcast start/chunk).
//   * the three video types get the 20-minute execution profile that
//     `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` used to set; every other type takes the
//     deployment default (`JOBS_JOB_TIMEOUT_MS`).
//   * a legacy `RateLimitError`, or anything the legacy classifier recognises
//     (HTTP 429/529 shapes, AWS throttle names), is rethrown as the platform's
//     `RateLimitError(retryAfterMs)`, because the queue defers a job on that
//     class and nothing else.
//   * the provider throttle keys (`auto_tagging` / `video_auto_tagging` ->
//     `tagging`, `geocode` -> `geocode`) are registered with the platform
//     `ProviderThrottleService`, which replaces the app's gate.
//
// CONVERTED (no longer here): RETRO-C3 (#585) made `face_detection`,
// `video_face_detection`, `face_auto_archive_sweep`, `metadata_extraction`,
// `thumbnail_regen` and `thumbnail_repair` native `JobHandler`s; they register
// with `JobHandlerRegistry` themselves (and `face_detection` its own `face`
// throttle key), never through `EnrichmentHandlerRegistry`.
//
// The orchestration (claim, lease, retry, deferral, settle) is the platform's;
// none of it is reimplemented here.
// =============================================================================

/** Job types that call a rate-limited provider -> the throttle bucket they draw on. */
export const LEGACY_THROTTLE_KEYS: Readonly<Record<string, string>> = {
  auto_tagging: 'tagging',
  // Video tagging calls the SAME configured tagging provider, so it shares the photo path's gate.
  video_auto_tagging: 'tagging',
  geocode: 'geocode',
};

/**
 * The video job types still on the adapter: download + ffmpeg + per-frame
 * provider calls legitimately exceed 10 minutes. (`video_face_detection` is
 * native since RETRO-C3 and declares the same profile itself.)
 */
export const VIDEO_JOB_TYPES: ReadonlySet<string> = new Set([
  'social_media_detection',
  'video_auto_tagging',
]);

/** A `JsonValue` that is a plain object, or null. */
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The legacy row shape of a platform job (`EnrichmentJob`).
 *
 * `media_item` subject -> `mediaItemId` (+ the `circleId` stored in the payload);
 * `circle` subject -> `circleId`; no subject -> both null (a global job).
 */
export function toEnrichmentJob(job: Job): EnrichmentJob {
  let mediaItemId: string | null = null;
  let circleId: string | null = null;
  let payload: unknown = job.payload ?? null;

  if (job.subjectType === 'media_item') {
    mediaItemId = job.subjectId;
    const object = asObject(payload);
    if (object && typeof object['circleId'] === 'string') {
      circleId = object['circleId'];
      const { circleId: _circleId, ...rest } = object;
      payload = Object.keys(rest).length > 0 ? rest : null;
    }
  } else if (job.subjectType === 'circle') {
    circleId = job.subjectId;
  }

  return {
    id: job.id,
    type: job.type,
    mediaItemId,
    circleId,
    status: job.status as unknown as MhLegacyJobStatus,
    reason: job.reason as unknown as JobReason,
    priority: job.priority,
    providerKey: job.providerKey,
    modelVersion: job.modelVersion,
    payload: payload as EnrichmentJob['payload'],
    attempts: job.attempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    scheduledFor: job.scheduledFor,
    rateLimitedAt: job.rateLimitedAt,
    rateLimitHits: job.rateLimitHits,
    claimedByNodeId: job.claimedByNodeId,
    leaseExpiresAt: job.leaseExpiresAt,
    executor: job.executor,
  };
}

/** Whether the row a job is about still exists (a global job is about nothing, so it does). */
export type SubjectExists = (job: Job) => Promise<boolean>;

/** `process()` of the legacy handler, with its rate-limit errors translated for the queue. */
async function runLegacy(handler: EnrichmentHandler, job: Job, subjectExists?: SubjectExists): Promise<void> {
  try {
    if (subjectExists && !(await subjectExists(job))) {
      logger.log(
        `Job ${job.id} (type="${job.type}"): its ${job.subjectType} ${job.subjectId} no longer exists; settling as a no-op`,
      );
      return;
    }
    await handler.process(toEnrichmentJob(job));
  } catch (error) {
    const rateLimit = error instanceof LegacyRateLimitError ? error : classifyRateLimit(error);
    if (rateLimit) {
      throw new PlatformRateLimitError(rateLimit.message, rateLimit.retryAfterMs);
    }
    throw error;
  }
}

const logger = new Logger('LegacyEnrichmentHandlerAdapter');

/** The platform `JobHandler` for one legacy handler. */
export function toPlatformHandler(handler: EnrichmentHandler, subjectExists?: SubjectExists): JobHandler {
  const nodeEligible = handler.nodeResultSchema !== undefined && typeof handler.persistNodeResult === 'function';

  return {
    type: handler.type,
    process: (job) => runLegacy(handler, job, subjectExists),
    ...(VIDEO_JOB_TYPES.has(handler.type)
      ? { profile: { maxRuntimeMs: videoJobTimeoutMs(), maxAttempts: ENRICHMENT_MAX_ATTEMPTS } }
      : {}),
    ...(nodeEligible
      ? {
          nodeResultSchema: handler.nodeResultSchema,
          persistNodeResult: (job: Job, result: unknown) =>
            handler.persistNodeResult!(toEnrichmentJob(job), result),
        }
      : {}),
    ...(typeof handler.canDelete === 'function'
      ? { canDelete: (job: Job) => handler.canDelete!(toEnrichmentJob(job)) }
      : {}),
  };
}

/** Registers legacy handlers with the platform registry. */
@Injectable()
export class LegacyEnrichmentHandlerAdapter {
  private readonly logger = new Logger(LegacyEnrichmentHandlerAdapter.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly prisma: PrismaService,
  ) {}

  /** The subject check: a media item or a circle must still exist; anything else (global) does. */
  readonly subjectExists: SubjectExists = async (job) => {
    if (!job.subjectId) return true;
    if (job.subjectType === 'media_item') {
      return (await this.prisma.mediaItem.findUnique({ where: { id: job.subjectId }, select: { id: true } })) !== null;
    }
    if (job.subjectType === 'circle') {
      return (await this.prisma.circle.findUnique({ where: { id: job.subjectId }, select: { id: true } })) !== null;
    }
    return true;
  };

  register(handler: EnrichmentHandler): void {
    this.registry.register(toPlatformHandler(handler, this.subjectExists));
    const throttleKey = LEGACY_THROTTLE_KEYS[handler.type];
    if (throttleKey) this.throttle.registerProviderKey(handler.type, throttleKey);
    this.logger.log(`Registered legacy handler "${handler.type}" with the platform queue`);
  }
}
