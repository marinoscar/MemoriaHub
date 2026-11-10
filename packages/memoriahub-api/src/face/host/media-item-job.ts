import type { Logger } from '@nestjs/common';

import { MemoriahubRateLimitError, type MemoriahubJob } from '../../ports/index.js';
import type { FaceDb } from './face-db.js';

// =============================================================================
// The media-item subject of a face job handler
// =============================================================================
//
// A handler receives the queue's job: the subject is `subjectType` / `subjectId`, and
// the circle of a media-item job is `payload.circleId` (see `FaceJobs.enqueue`). The face
// services read three fields of it (`id`, `mediaItemId`, `circleId`), so this gives them
// exactly that, resolved from a job. A job whose subject is not a media item is malformed
// and THROWS; a media item that no longer exists (hard-deleted after the job was queued)
// settles the job as a no-op and answers null.
// =============================================================================

/**
 * What the face services read of a job.
 *
 * @stability experimental
 */
export interface MediaJobContext {
  /** The job id. */
  readonly id: string;
  /** The media item, or null for a malformed context. */
  readonly mediaItemId: string | null;
  /** The circle (owner scope) of the item. */
  readonly circleId: string | null;
}

/**
 * A media-item job whose media item exists.
 *
 * @stability experimental
 */
export interface MediaItemJobContext extends MediaJobContext {
  /** The media item. */
  readonly mediaItemId: string;
  /** The circle. */
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
 * @param prisma - the database client.
 * @param job - the job.
 * @param logger - where the no-op is logged.
 * @throws Error when the job is not a media-item job (a malformed row).
 * @stability experimental
 */
export async function resolveMediaItemJob(
  prisma: Pick<FaceDb, 'mediaItem'>,
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

/**
 * The circle a `circle` job is about, or null when it no longer exists.
 *
 * @param scopeExists - answers whether a circle (owner scope) still exists.
 * @param job - the job.
 * @param logger - where the no-op is logged.
 * @throws Error when the job is not a circle job (a malformed row).
 * @stability experimental
 */
export async function resolveCircleJob(
  scopeExists: (scopeId: string) => Promise<boolean>,
  job: MemoriahubJob,
  logger: Pick<Logger, 'debug'>,
): Promise<string | null> {
  if (job.subjectType !== 'circle' || !job.subjectId) {
    throw new Error(`${job.type} job ${job.id} is not about a circle (subjectType=${String(job.subjectType)})`);
  }
  if (!(await scopeExists(job.subjectId))) {
    logger.debug(`${job.type} job ${job.id}: circle ${job.subjectId} no longer exists; settling as a no-op`);
    return null;
  }
  return job.subjectId;
}

const AWS_THROTTLE_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'SlowDown',
]);

/**
 * The throttle bucket of the face provider's quota: a cooldown on one face job holds the others.
 *
 * @stability experimental
 */
export const FACE_THROTTLE_KEY = 'face';

function retryAfterOf(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as Record<string, unknown>;
  const raw = h['retry-after'] ?? h['Retry-After'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const asInt = parseInt(trimmed, 10);
  if (!isNaN(asInt) && String(asInt) === trimmed) return Math.max(0, asInt * 1000);
  const parsed = Date.parse(trimmed);
  return isNaN(parsed) ? undefined : Math.max(0, parsed - Date.now());
}

/**
 * Classifies a provider throttle signal (HTTP 429 or 529, or an AWS throttle name) as the rate-limit
 * error the queue defers on, or `null` when the error is not a throttle.
 *
 * @param error - the thrown value.
 * @returns the rate-limit error, or `null`.
 * @stability experimental
 */
export function classifyFaceRateLimit(error: unknown): MemoriahubRateLimitError | null {
  if (error instanceof MemoriahubRateLimitError) return error;
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const response = e['response'] && typeof e['response'] === 'object' ? (e['response'] as Record<string, unknown>) : undefined;
  const meta = e['$metadata'] && typeof e['$metadata'] === 'object' ? (e['$metadata'] as Record<string, unknown>) : undefined;

  const retryAfterMs = retryAfterOf(response?.['headers']) ?? retryAfterOf(e['headers']);
  const status =
    (typeof e['status'] === 'number' ? e['status'] : undefined) ??
    (typeof response?.['status'] === 'number' ? (response['status'] as number) : undefined) ??
    (typeof meta?.['httpStatusCode'] === 'number' ? (meta['httpStatusCode'] as number) : undefined);

  if (status === 429 || status === 529) {
    const message = typeof e['message'] === 'string' ? e['message'] : `Provider rate limit exceeded (HTTP ${status})`;
    return new MemoriahubRateLimitError(FACE_THROTTLE_KEY, retryAfterMs, message);
  }

  const name = typeof e['name'] === 'string' ? e['name'] : undefined;
  const code = typeof e['Code'] === 'string' ? e['Code'] : typeof meta?.['Code'] === 'string' ? (meta['Code'] as string) : undefined;
  if ((name && AWS_THROTTLE_NAMES.has(name)) || (code && AWS_THROTTLE_NAMES.has(code))) {
    const message = typeof e['message'] === 'string' ? e['message'] : `AWS throttle: ${name ?? code ?? 'unknown'}`;
    return new MemoriahubRateLimitError(FACE_THROTTLE_KEY, retryAfterMs, message);
  }
  return null;
}

/**
 * Runs `fn`, rethrowing any provider throttle signal as the queue's rate-limit error (so the job is
 * deferred, not failed).
 *
 * @param fn - the work.
 * @returns what `fn` returns.
 * @stability experimental
 */
export async function withRateLimits<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    const rateLimit = classifyFaceRateLimit(error);
    if (rateLimit) throw rateLimit;
    throw error;
  }
}
