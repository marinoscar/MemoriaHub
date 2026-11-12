import type { EnrichmentJob, JobReason, MhLegacyJobStatus } from '@prisma/client';
import type { Job } from '@marinoscar/platform-api/jobs';

// =============================================================================
// The legacy row shape of a platform job (RETRO-C1, #575)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-C11): `toEnrichmentJob` is the inverse of the
// `EnrichmentJobService` facade's mapping. The facade returns it from `enqueue`
// and `LegacyJobSettledBridge` builds the legacy `enrichment.job.settled` event
// from it; both leave with the facade. (It used to live in
// `legacy-handlers.adapter.ts`, whose handler adapter is gone: every handler is a
// native `JobHandler`.)
// =============================================================================

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
