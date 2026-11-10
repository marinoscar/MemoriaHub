/**
 * A platform `jobs` row for handler unit tests (RETRO-C3, #585).
 *
 * Native `JobHandler`s receive the platform `Job`: the subject is
 * `subjectType` / `subjectId`, and the enqueue facade keeps a media-item job's
 * circle in `payload.circleId`. `mediaItemJob` builds exactly that shape;
 * `circleJob` and `systemJob` build the other two subjects.
 */

import type { Job } from '@marinoscar/platform-api/jobs';

/** The default organization id the facade stamps on a job with a subject. */
export const TEST_ORG_ID = '00000000-0000-4000-8000-0000000000aa';

export function platformJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'test_job',
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'pending',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    claimToken: null,
    traceContext: null,
    orgId: null,
    ...overrides,
  } as Job;
}

/** A job about one media item, as the facade enqueues it. */
export function mediaItemJob(
  type: string,
  mediaItemId = 'media-1',
  circleId: string | null = 'circle-1',
  overrides: Partial<Job> = {},
): Job {
  return platformJob({
    type,
    subjectType: 'media_item',
    subjectId: mediaItemId,
    payload: circleId ? { circleId } : null,
    orgId: TEST_ORG_ID,
    ...overrides,
  });
}

/** A job about one circle (a per-circle sweep). */
export function circleJob(type: string, circleId = 'circle-1', overrides: Partial<Job> = {}): Job {
  return platformJob({ type, subjectType: 'circle', subjectId: circleId, orgId: TEST_ORG_ID, ...overrides });
}

/** A global (system) job: no subject, no organization. */
export function systemJob(type: string, overrides: Partial<Job> = {}): Job {
  return platformJob({ type, ...overrides });
}

/** A Prisma double answering the media-item subject lookup of `resolveMediaItemJob`. */
export function subjectPrisma(
  existing: { mediaItems?: Record<string, string> } = {
    mediaItems: { 'media-1': 'circle-1' },
  },
) {
  const mediaItems = existing.mediaItems ?? {};
  return {
    mediaItem: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id in mediaItems ? { id: where.id, circleId: mediaItems[where.id] } : null,
      ),
    },
  };
}

/** The scope directory double the `circle` job resolvers read (`OwnerScopeSweepService.exists`). */
export function subjectScopes(circles: string[] = ['circle-1']) {
  const known = new Set(circles);
  return { exists: jest.fn(async (id: string) => known.has(id)) };
}
