import type { Logger } from '@nestjs/common';

import type {
  MemoriahubEnqueueResult,
  MemoriahubJob,
  MemoriahubJobsPort,
} from '../../ports/index.js';

// =============================================================================
// Enqueueing and resolving per-item enrichment jobs (RETRO-J10, #624)
// =============================================================================
//
// The web app's `EnrichmentJobService.enqueue` stored a job's subject as the media item when there is
// one, else the circle, else none, and added `circleId` to the payload when both were given (a handler
// reads it back with `resolveMediaItemJob`). The slices that moved out of the app enqueue through the
// jobs port with the same convention, so a job row is byte-for-byte what the app wrote before.
// =============================================================================

/**
 * What a slice enqueues.
 *
 * @stability experimental
 */
export interface EnrichmentEnqueueInput {
  /** The job type. Permanent. */
  type: string;
  /** The media item the job is about; its job is a `media_item` job. */
  mediaItemId?: string | null;
  /** The owner scope (library); a `circle` job when there is no media item. */
  circleId?: string | null;
  /** Why (`upload`, `rerun`, `backfill`). */
  reason: string;
  /** The queue priority (lower runs first). */
  priority?: number;
  /** The deployment-wide provider bucket the job draws on, when it has one. */
  providerKey?: string;
  /** Extra payload. */
  payload?: Record<string, unknown>;
  /** Skips the one-pending-per-subject dedup. */
  skipDedup?: boolean;
  /** The earliest time the job may be claimed. */
  scheduledFor?: Date;
}

/**
 * Queues a job with the media-item / circle / global subject convention of the enrichment queue.
 *
 * @param jobs - the jobs port.
 * @param input - what to queue.
 * @returns the port's result (the job id and whether it was folded into an active one).
 * @stability experimental
 */
export async function enqueueEnrichmentJob(
  jobs: MemoriahubJobsPort,
  input: EnrichmentEnqueueInput,
): Promise<MemoriahubEnqueueResult> {
  const { type, mediaItemId = null, circleId = null, reason, priority, providerKey, payload, skipDedup, scheduledFor } = input;
  const subjectId = mediaItemId ?? circleId ?? undefined;
  const subjectType = mediaItemId ? 'media_item' : circleId ? 'circle' : undefined;
  const stored = mediaItemId && circleId ? { ...(payload ?? {}), circleId } : (payload ?? {});
  return jobs.enqueue({
    type,
    reason,
    ...(subjectType !== undefined ? { subjectType, subjectId: subjectId as string } : {}),
    payload: stored,
    ...(priority !== undefined ? { priority } : {}),
    ...(skipDedup === true ? { skipDedup: true } : {}),
    ...(scheduledFor !== undefined ? { scheduledFor } : {}),
    ...(providerKey !== undefined ? { throttleKey: providerKey } : {}),
  });
}

/**
 * The media item a `media_item` job is about, with the circle its payload names (or the item's own).
 *
 * @stability experimental
 */
export interface MediaItemJobContext {
  /** The job id. */
  readonly id: string;
  /** The media item. */
  readonly mediaItemId: string;
  /** The owner scope of the item. */
  readonly circleId: string;
}

/**
 * `payload.circleId` of a job, when the enqueue stored one.
 *
 * @param job - the job.
 * @stability experimental
 */
export function payloadCircleId(job: Pick<MemoriahubJob, 'payload'>): string | null {
  const payload = job.payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const circleId = (payload as Record<string, unknown>)['circleId'];
    if (typeof circleId === 'string' && circleId.length > 0) return circleId;
  }
  return null;
}

/**
 * The media item a `media_item` job is about, or null when it no longer exists (the job settles as a no-op).
 *
 * @param prisma - anything with `mediaItem.findUnique`.
 * @param job - the job.
 * @param logger - receives the no-op note.
 * @throws Error when the job is not a media-item job (a malformed row).
 * @stability experimental
 */
export async function resolveMediaItemJob(
  prisma: { mediaItem: { findUnique(args: any): Promise<{ id: string; circleId: string } | null> } },
  job: MemoriahubJob,
  logger: Pick<Logger, 'debug'>,
): Promise<MediaItemJobContext | null> {
  if (job.subjectType !== 'media_item' || !job.subjectId) {
    throw new Error(`${job.type} job ${job.id} is not about a media item (subjectType=${String(job.subjectType)})`);
  }
  const row = await prisma.mediaItem.findUnique({ where: { id: job.subjectId }, select: { id: true, circleId: true } });
  if (!row) {
    logger.debug(`${job.type} job ${job.id}: media item ${job.subjectId} no longer exists; settling as a no-op`);
    return null;
  }
  return { id: job.id, mediaItemId: row.id, circleId: payloadCircleId(job) ?? row.circleId };
}
