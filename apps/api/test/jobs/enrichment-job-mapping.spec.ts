/**
 * The legacy row shape of a platform job (RETRO-C1, #575; the handler adapter is gone, the mapping stays
 * with the `EnrichmentJobService` facade).
 */
import type { Job } from '@marinoscar/platform-api/jobs';

import { toEnrichmentJob } from '../../src/platform/jobs/enrichment-job.mapping';

const MEDIA_ID = '00000000-0000-4000-8000-000000000001';
const CIRCLE_ID = '00000000-0000-4000-8000-000000000002';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'face_detection',
    subjectType: 'media_item',
    subjectId: MEDIA_ID,
    dedupKey: null,
    status: 'running',
    reason: 'upload',
    priority: 10,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    startedAt: new Date('2026-01-01T00:00:01Z'),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: 'server',
    claimToken: null,
    traceContext: null,
    orgId: null,
    ...overrides,
  } as Job;
}

describe('toEnrichmentJob (the inverse of the facade mapping)', () => {
  it('a media-item job gets mediaItemId and the circleId taken out of the payload', () => {
    const legacy = toEnrichmentJob(job({ payload: { circleId: CIRCLE_ID } }));
    expect(legacy.mediaItemId).toBe(MEDIA_ID);
    expect(legacy.circleId).toBe(CIRCLE_ID);
    expect(legacy.payload).toBeNull();
  });

  it('keeps the handler payload fields and only strips the stored circleId', () => {
    const legacy = toEnrichmentJob(job({ payload: { circleId: CIRCLE_ID, enhancementId: 'e1' } }));
    expect(legacy.payload).toEqual({ enhancementId: 'e1' });
    expect(legacy.circleId).toBe(CIRCLE_ID);
  });

  it('a circle job gets circleId and an untouched payload', () => {
    const legacy = toEnrichmentJob(job({ subjectType: 'circle', subjectId: CIRCLE_ID, payload: { runId: 'r1' } }));
    expect(legacy.mediaItemId).toBeNull();
    expect(legacy.circleId).toBe(CIRCLE_ID);
    expect(legacy.payload).toEqual({ runId: 'r1' });
  });

  it('a global job has neither, and carries the queue fields across', () => {
    const legacy = toEnrichmentJob(
      job({ subjectType: null, subjectId: null, rateLimitHits: 2, attempts: 3, status: 'pending', reason: 'backfill' }),
    );
    expect(legacy).toMatchObject({
      mediaItemId: null,
      circleId: null,
      rateLimitHits: 2,
      attempts: 3,
      status: 'pending',
      reason: 'backfill',
      priority: 10,
    });
  });
});
