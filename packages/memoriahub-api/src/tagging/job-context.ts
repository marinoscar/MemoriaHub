import type { Logger } from '@nestjs/common';

import { type MemoriahubJob } from '../ports/index.js';
import type { TaggingDb } from './data/tagging-db.js';

// =============================================================================
// The media-item subject of a tagging job (RETRO-J7, #618)
// =============================================================================
//
// A job row carries its subject as `subjectType` / `subjectId`, and the circle of a media-item job
// in `payload.circleId`. The services read only three fields of a job (`id`, `mediaItemId`,
// `circleId`), so this gives them exactly that, resolved from a {@link MemoriahubJob}:
//
//   * a job whose subject is not a media item is malformed and THROWS (the queue records the message);
//   * a media item that no longer exists (hard-deleted after the job was queued: `jobs.subject_id` is
//     text, nothing cascades) is a no-op and answers null.
// =============================================================================

/**
 * What the tagging services read of a job: its id and its subject.
 *
 * @stability experimental
 */
export interface MediaJobContext {
  /** The job id. */
  readonly id: string;
  /** The media item the job is about, or null for a malformed context. */
  readonly mediaItemId: string | null;
  /** The circle (owner scope) of the media item. */
  readonly circleId: string | null;
}

/**
 * A media-item job whose media item exists: both ids are known.
 *
 * @stability experimental
 */
export interface MediaItemJobContext extends MediaJobContext {
  /** The media item. */
  readonly mediaItemId: string;
  /** Its circle. */
  readonly circleId: string;
}

/** `payload.circleId` of a job, when the enqueue stored one. */
function payloadCircleId(job: Pick<MemoriahubJob, 'payload'>): string | null {
  const payload = job.payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const circleId = (payload as Record<string, unknown>)['circleId'];
    if (typeof circleId === 'string' && circleId.length > 0) return circleId;
  }
  return null;
}

/**
 * The media item a `media_item` job is about, or null when it no longer exists.
 *
 * @param prisma - the database port.
 * @param job - the job row.
 * @param logger - where the no-op is noted.
 * @returns the job's context, or null.
 * @throws Error when the job is not a media-item job (a malformed row).
 * @stability experimental
 */
export async function resolveMediaItemJob(
  prisma: Pick<TaggingDb, 'mediaItem'>,
  job: MemoriahubJob,
  logger: Pick<Logger, 'debug'>,
): Promise<MediaItemJobContext | null> {
  if (job.subjectType !== 'media_item' || !job.subjectId) {
    throw new Error(`${job.type} job ${job.id} is not about a media item (subjectType=${String(job.subjectType)})`);
  }
  const row = await prisma.mediaItem.findUnique({
    where: { id: job.subjectId },
    select: { id: true, circleId: true },
  });
  if (!row) {
    logger.debug(`${job.type} job ${job.id}: media item ${job.subjectId} no longer exists; settling as a no-op`);
    return null;
  }
  return { id: job.id, mediaItemId: row.id, circleId: payloadCircleId(job) ?? row.circleId };
}
