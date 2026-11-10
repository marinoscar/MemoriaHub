import { JobReason } from '@prisma/client';

import { EnrichmentJobService, LegacyJobSettledBridge } from './enrichment-job.facade';
import { ENRICHMENT_JOB_SETTLED_EVENT } from '../../enrichment/events/enrichment-job-settled.event';

const ORG = '00000000-0000-4000-8000-0000000000d0';
const MEDIA = '00000000-0000-4000-8000-000000000001';
const CIRCLE = '00000000-0000-4000-8000-000000000002';

function platformJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: 'x',
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
    createdAt: new Date(),
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
  };
}

describe('EnrichmentJobService (the enqueue facade over JobsService)', () => {
  let jobs: { enqueue: jest.Mock; recordProvider: jest.Mock };
  let service: EnrichmentJobService;

  beforeEach(() => {
    jobs = {
      enqueue: jest.fn().mockImplementation(async (input) =>
        platformJob({
          type: input.type,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          payload: input.payload ?? null,
          reason: input.reason,
        }),
      ),
      recordProvider: jest.fn().mockResolvedValue(undefined),
    };
    service = new EnrichmentJobService(jobs as never, { get: async () => ORG } as never);
  });

  it('a media-item job: subject media_item, the circle rides in the payload, the default org', async () => {
    const result = await service.enqueue({
      type: 'face_detection',
      mediaItemId: MEDIA,
      circleId: CIRCLE,
      reason: JobReason.upload,
      priority: 10,
      payload: { foo: 1 },
    });

    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'face_detection',
      reason: 'upload',
      subjectType: 'media_item',
      subjectId: MEDIA,
      payload: { foo: 1, circleId: CIRCLE },
      priority: 10,
      scheduledFor: null,
      skipDedup: false,
      orgId: ORG,
    });
    // The caller gets the legacy row shape back.
    expect(result).toMatchObject({ id: 'job-1', mediaItemId: MEDIA, circleId: CIRCLE, payload: { foo: 1 } });
  });

  it('a media-item job without a circle stores no circleId and no payload', async () => {
    await service.enqueue({ type: 'geocode', mediaItemId: MEDIA, reason: JobReason.rerun });
    const input = jobs.enqueue.mock.calls[0][0];
    expect(input.payload).toBeUndefined();
    expect(input.subjectType).toBe('media_item');
  });

  it('a circle job (no media item): subject circle, payload untouched, the default org', async () => {
    await service.enqueue({
      type: 'memory_generation',
      circleId: CIRCLE,
      reason: JobReason.backfill,
      skipDedup: true,
      payload: { backfill: true },
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'circle',
        subjectId: CIRCLE,
        payload: { backfill: true },
        skipDedup: true,
        orgId: ORG,
      }),
    );
  });

  it('a global job: no subject and org null (housekeeping)', async () => {
    await service.enqueue({
      type: 'trash_purge',
      mediaItemId: null,
      circleId: null,
      reason: JobReason.backfill,
      priority: 100,
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: null, subjectId: null, orgId: null, priority: 100 }),
    );
  });

  it('passes scheduledFor through and omits priority when the caller gave none', async () => {
    const when = new Date('2027-01-01T00:00:00Z');
    await service.enqueue({ type: 'broadcast_start', reason: JobReason.backfill, scheduledFor: when });
    const input = jobs.enqueue.mock.calls[0][0];
    expect(input.scheduledFor).toBe(when);
    expect('priority' in input).toBe(false);
  });

  it('records the provider and model when the caller named them', async () => {
    await service.enqueue({
      type: 'auto_tagging',
      mediaItemId: MEDIA,
      reason: JobReason.upload,
      providerKey: 'openai',
      modelVersion: 'gpt-x',
    });
    expect(jobs.recordProvider).toHaveBeenCalledWith('job-1', 'openai', 'gpt-x');
  });

  it('does not touch the provider audit when neither was given', async () => {
    await service.enqueue({ type: 'geocode', mediaItemId: MEDIA, reason: JobReason.upload });
    expect(jobs.recordProvider).not.toHaveBeenCalled();
  });

  it('returns the existing job when the platform deduplicated the call', async () => {
    jobs.enqueue.mockResolvedValue(platformJob({ id: 'older', subjectType: 'media_item', subjectId: MEDIA }));
    const result = await service.enqueue({ type: 'geocode', mediaItemId: MEDIA, reason: JobReason.rerun });
    expect(result.id).toBe('older');
  });

  it('recordModel delegates to the platform and never throws', async () => {
    await service.recordModel('job-9', 'anthropic', 'claude-x');
    expect(jobs.recordProvider).toHaveBeenCalledWith('job-9', 'anthropic', 'claude-x');
  });
});

describe('EnrichmentJobService geocode payload (RETRO-C10)', () => {
  const jobs = {
    enqueue: jest.fn().mockImplementation(async (input) => platformJob({ type: input.type, payload: input.payload ?? null })),
    recordProvider: jest.fn(),
  };
  const org = { get: async () => ORG } as never;

  beforeEach(() => jobs.enqueue.mockClear());

  it('adds the item coordinates to a geocode job so a node can look them up', async () => {
    const prisma = { mediaItem: { findUnique: jest.fn().mockResolvedValue({ takenLat: 9.9, takenLng: -84.1 }) } };
    await new EnrichmentJobService(jobs as never, org, prisma as never).enqueue({
      type: 'geocode', mediaItemId: MEDIA, circleId: CIRCLE, reason: JobReason.rerun,
    });
    expect(jobs.enqueue.mock.calls[0][0].payload).toEqual({ lat: 9.9, lng: -84.1, circleId: CIRCLE });
  });

  it('leaves other types, an item without coordinates and a failed read alone', async () => {
    const prisma = { mediaItem: { findUnique: jest.fn().mockResolvedValue({ takenLat: null, takenLng: null }) } };
    const svc = new EnrichmentJobService(jobs as never, org, prisma as never);
    await svc.enqueue({ type: 'geocode', mediaItemId: MEDIA, circleId: CIRCLE, reason: JobReason.rerun });
    expect(jobs.enqueue.mock.calls[0][0].payload).toEqual({ circleId: CIRCLE });
    await svc.enqueue({ type: 'face_detection', mediaItemId: MEDIA, circleId: CIRCLE, reason: JobReason.upload });
    expect(prisma.mediaItem.findUnique).toHaveBeenCalledTimes(1);
    const failing = { mediaItem: { findUnique: jest.fn().mockRejectedValue(new Error('db')) } };
    await new EnrichmentJobService(jobs as never, org, failing as never).enqueue({
      type: 'geocode', mediaItemId: MEDIA, circleId: CIRCLE, reason: JobReason.rerun,
    });
    expect(jobs.enqueue.mock.calls[2][0].payload).toEqual({ circleId: CIRCLE });
  });
});

describe('LegacyJobSettledBridge', () => {
  it('re-emits a terminal platform event as the legacy enrichment event, with the legacy shape', () => {
    const emit = jest.fn();
    const bridge = new LegacyJobSettledBridge({ emit } as never);

    bridge.handle({
      status: 'failed',
      jobId: 'job-1',
      job: platformJob({
        type: 'auto_tagging',
        subjectType: 'media_item',
        subjectId: MEDIA,
        payload: { circleId: CIRCLE },
        reason: 'rerun',
        status: 'failed',
      }),
    } as never);

    expect(emit).toHaveBeenCalledWith(
      ENRICHMENT_JOB_SETTLED_EVENT,
      expect.objectContaining({
        jobId: 'job-1',
        type: 'auto_tagging',
        reason: 'rerun',
        mediaItemId: MEDIA,
        circleId: CIRCLE,
        outcome: 'failed',
      }),
    );
  });

  it('ignores a settle that is not terminal', () => {
    const emit = jest.fn();
    new LegacyJobSettledBridge({ emit } as never).handle({ status: 'pending', jobId: 'j', job: platformJob() } as never);
    expect(emit).not.toHaveBeenCalled();
  });

  it('never lets an emit failure escape', () => {
    const bridge = new LegacyJobSettledBridge({
      emit: () => {
        throw new Error('listener threw');
      },
    } as never);
    expect(() => bridge.handle({ status: 'succeeded', jobId: 'j', job: platformJob({ status: 'succeeded' }) } as never)).not.toThrow();
  });
});
