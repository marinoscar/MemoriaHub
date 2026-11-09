// =============================================================================
// The media-item subject of a native job handler (RETRO-C3, #585)
// =============================================================================
//
// A native platform `JobHandler` receives the platform `Job` row: the subject is
// `subjectType` / `subjectId`, and the facade (`enrichment-job.facade.ts`) keeps
// the circle of a media-item job in `payload.circleId`. The domain services the
// media/face handlers call were written against the legacy `EnrichmentJob` and
// read only three fields of it (`id`, `mediaItemId`, `circleId`), so this file
// gives them exactly that, as `MediaJobContext`, resolved from a `Job`:
//
//   * `resolveMediaItemJob`: the media item the job is about. A job whose subject
//     is not a media item is malformed and THROWS (the queue records the message);
//     a media item that no longer exists (hard-deleted after the job was queued:
//     `jobs.subject_id` is text, nothing cascades) is a no-op and answers null.
//   * `resolveCircleJob`: the same for a circle-subject sweep.
//   * `withPlatformRateLimits`: a legacy `RateLimitError`, or an error the legacy
//     classifier recognises (HTTP 429/529 shapes, AWS throttle names), rethrown as
//     the platform's `RateLimitError(retryAfterMs)`, the only class the queue
//     defers on. This was the adapter's job while these handlers were legacy.
//
// Shared on purpose: the other handler groups (RETRO-C4..C8) converting a
// media-item handler can use it as is.
// =============================================================================

import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { resolveJobOrgId } from '@marinoscar/platform-api/identity';
import { RateLimitError as PlatformRateLimitError, type Job, type JobScope } from '@marinoscar/platform-api/jobs';

import { RateLimitError as LegacyRateLimitError, classifyRateLimit } from '../../enrichment/rate-limit.error';

/** What the media domain services read of a job: its id and its subject. */
export interface MediaJobContext {
  readonly id: string;
  readonly mediaItemId: string | null;
  readonly circleId: string | null;
}

/** A media-item job whose media item exists: both ids are known. */
export interface MediaItemJobContext extends MediaJobContext {
  readonly mediaItemId: string;
  readonly circleId: string;
}

/** The minimal Prisma surface the resolvers read. */
export interface MediaJobPrisma {
  mediaItem: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; circleId: true };
    }): Promise<{ id: string; circleId: string } | null>;
  };
  circle: {
    findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
}

/** `payload.circleId` of a job, when the facade stored one. */
export function payloadCircleId(job: Pick<Job, 'payload'>): string | null {
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
 * @throws Error when the job is not a media-item job (a malformed row).
 */
export async function resolveMediaItemJob(
  prisma: MediaJobPrisma,
  job: Job,
  logger: Pick<Logger, 'debug'>,
): Promise<MediaItemJobContext | null> {
  if (job.subjectType !== 'media_item' || !job.subjectId) {
    throw new Error(
      `${job.type} job ${job.id} is not about a media item (subjectType=${String(job.subjectType)})`,
    );
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
 * @throws Error when the job is not a circle job (a malformed row).
 */
export async function resolveCircleJob(
  prisma: MediaJobPrisma,
  job: Job,
  logger: Pick<Logger, 'debug'>,
): Promise<string | null> {
  if (job.subjectType !== 'circle' || !job.subjectId) {
    throw new Error(`${job.type} job ${job.id} is not about a circle (subjectType=${String(job.subjectType)})`);
  }
  const row = await prisma.circle.findUnique({ where: { id: job.subjectId }, select: { id: true } });
  if (!row) {
    logger.debug(`${job.type} job ${job.id}: circle ${job.subjectId} no longer exists; settling as a no-op`);
    return null;
  }
  return row.id;
}

/** Runs `fn`, rethrowing any provider throttle signal as the platform `RateLimitError`. */
export async function withPlatformRateLimits<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PlatformRateLimitError) throw error;
    const rateLimit = error instanceof LegacyRateLimitError ? error : classifyRateLimit(error);
    if (rateLimit) throw new PlatformRateLimitError(rateLimit.message, rateLimit.retryAfterMs);
    throw error;
  }
}

/**
 * Runs a short unit of writes to org (row-level-security) tables. A handler
 * passes `(fn) => jobScope.run(job, fn)` (the platform `JobScope`: one
 * transaction whose first statement sets `app.org_id` to the job's
 * organization); a caller with no job falls back to the plain client.
 *
 * Keep it SHORT: no download, no provider call, no ffmpeg inside it. It holds
 * an interactive transaction open.
 */
export type OrgWriteScope = <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;

/**
 * The write scope of a job: the platform `JobScope` (its organization).
 *
 * A row queued before the facade stamped `orgId` (or a hand-inserted one) has
 * `orgId` null. Since RETRO-D1 it runs in the organization `resolveJobOrgId`
 * answers, exactly as the platform's own handlers do: the default organization
 * in single-organization mode (a refusal naming the job in multi mode). The
 * lookup happens when the scope is first used, so a caller that writes nothing
 * reads nothing.
 */
export function jobWriteScope(
  jobScope: Pick<JobScope, 'run'>,
  job: Job,
  prisma: Parameters<typeof resolveJobOrgId>[0],
): OrgWriteScope {
  return <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) =>
    (async () => {
      const orgId = job.orgId ?? (await resolveJobOrgId(prisma, job));
      return jobScope.run<R, Prisma.TransactionClient>({ ...job, orgId }, fn);
    })();
}
