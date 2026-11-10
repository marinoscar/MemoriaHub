/**
 * The legacy handler adapter (RETRO-C1, #575): what a handler sees when the queue is the
 * platform's, and what the queue sees when a handler throws.
 */
import { ConfigService } from '@nestjs/config';
import {
  JobHandlerRegistry,
  ProviderThrottleService,
  RateLimitError as PlatformRateLimitError,
  type Job,
} from '@marinoscar/platform-api/jobs';

import { EnrichmentHandlerRegistry } from '../../src/enrichment/enrichment-handler.registry';
import type { EnrichmentHandler } from '../../src/enrichment/enrichment-handler.interface';
import { RateLimitError as LegacyRateLimitError } from '../../src/enrichment/rate-limit.error';
import {
  LegacyEnrichmentHandlerAdapter,
  LEGACY_THROTTLE_KEYS,
  VIDEO_JOB_TYPES,
  toEnrichmentJob,
} from '../../src/platform/jobs/legacy-handlers.adapter';
import { ALL_HANDLER_CLASSES } from './legacy-handlers.fixture';

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

describe('LegacyEnrichmentHandlerAdapter', () => {
  let platform: JobHandlerRegistry;
  let throttle: ProviderThrottleService;
  let prisma: { mediaItem: { findUnique: jest.Mock }; circle: { findUnique: jest.Mock } };
  let legacy: EnrichmentHandlerRegistry;

  function register(handler: Partial<EnrichmentHandler> & { type: string }): ReturnType<JobHandlerRegistry['get']> {
    legacy.register({ process: jest.fn().mockResolvedValue(undefined), ...handler } as EnrichmentHandler);
    return platform.get(handler.type);
  }

  beforeEach(() => {
    platform = new JobHandlerRegistry();
    throttle = new ProviderThrottleService(new ConfigService());
    prisma = {
      mediaItem: { findUnique: jest.fn().mockResolvedValue({ id: MEDIA_ID }) },
      circle: { findUnique: jest.fn().mockResolvedValue({ id: CIRCLE_ID }) },
    };
    legacy = new EnrichmentHandlerRegistry(
      new LegacyEnrichmentHandlerAdapter(platform, throttle, prisma as never),
    );
  });

  it('all 42 handler classes dispatch under their own type', () => {
    for (const HandlerClass of ALL_HANDLER_CLASSES) {
      legacy.register(new (HandlerClass as unknown as new () => EnrichmentHandler)());
    }
    expect(platform.types()).toHaveLength(42);
    expect(platform.types().sort()).toEqual(legacy.types().sort());
  });

  describe('process', () => {
    it('hands the handler the legacy row shape', async () => {
      const process = jest.fn().mockResolvedValue(undefined);
      const handler = register({ type: 'x_type', process });
      await handler!.process(job({ type: 'x_type', payload: { circleId: CIRCLE_ID } }));
      expect(process).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1', mediaItemId: MEDIA_ID, circleId: CIRCLE_ID, payload: null }),
      );
    });

    it('a job whose media item was hard-deleted settles as a no-op success (no crash loop)', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(null);
      const process = jest.fn();
      const handler = register({ type: 'x_type', process });
      await expect(handler!.process(job({ type: 'x_type' }))).resolves.toBeUndefined();
      expect(process).not.toHaveBeenCalled();
    });

    it('a job whose circle was deleted settles as a no-op success', async () => {
      prisma.circle.findUnique.mockResolvedValue(null);
      const process = jest.fn();
      const handler = register({ type: 'x_type', process });
      await expect(
        handler!.process(job({ type: 'x_type', subjectType: 'circle', subjectId: CIRCLE_ID })),
      ).resolves.toBeUndefined();
      expect(process).not.toHaveBeenCalled();
    });

    it('a global job needs no subject and always runs', async () => {
      const process = jest.fn().mockResolvedValue(undefined);
      const handler = register({ type: 'x_type', process });
      await handler!.process(job({ type: 'x_type', subjectType: null, subjectId: null }));
      expect(process).toHaveBeenCalledTimes(1);
      expect(prisma.mediaItem.findUnique).not.toHaveBeenCalled();
    });

    it('rethrows a legacy RateLimitError as the platform RateLimitError, keeping retryAfterMs', async () => {
      const handler = register({
        type: 'x_type',
        process: jest.fn().mockRejectedValue(new LegacyRateLimitError('slow down', 7_000, 'openai')),
      });
      const error = await handler!.process(job({ type: 'x_type' })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlatformRateLimitError);
      expect(error).toMatchObject({ message: 'slow down', retryAfterMs: 7_000 });
    });

    it('classifies an HTTP 429 from a provider SDK the way the old terminal service did', async () => {
      const handler = register({
        type: 'x_type',
        process: jest.fn().mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 })),
      });
      const error = await handler!.process(job({ type: 'x_type' })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlatformRateLimitError);
    });

    it('lets any other error through unchanged (the queue retries it)', async () => {
      const boom = new Error('boom');
      const handler = register({ type: 'x_type', process: jest.fn().mockRejectedValue(boom) });
      await expect(handler!.process(job({ type: 'x_type' }))).rejects.toBe(boom);
    });
  });

  describe('execution profile', () => {
    it('no video type is left on the adapter; everything takes the deployment default', () => {
      // social_media_detection (RETRO-C5) and video_auto_tagging (RETRO-C4) are native: they declare the profile themselves.
      expect(VIDEO_JOB_TYPES.has('social_media_detection')).toBe(false);
      expect(VIDEO_JOB_TYPES.has('video_auto_tagging')).toBe(false);
      for (const type of ['trash_purge']) {
        const handler = register({ type });
        if (VIDEO_JOB_TYPES.has(type)) {
          expect(handler!.profile).toEqual({ maxRuntimeMs: 1_200_000, maxAttempts: expect.any(Number) });
        } else {
          expect(handler!.profile).toBeUndefined();
        }
      }
    });
  });

  describe('provider throttle keys', () => {
    it('registers the buckets the old gate resolved', () => {
      for (const type of Object.keys(LEGACY_THROTTLE_KEYS)) register({ type });
      // auto_tagging / video_auto_tagging are native since RETRO-C4 and register `tagging` themselves;
      // geocode is native since RETRO-C6 and registers its own `geocode` key.
      expect(Object.keys(LEGACY_THROTTLE_KEYS)).not.toContain('auto_tagging');
      expect(Object.keys(LEGACY_THROTTLE_KEYS)).not.toContain('geocode');
      // face_detection is native since RETRO-C3 and registers its own `face` key.
      expect(Object.keys(LEGACY_THROTTLE_KEYS)).not.toContain('face_detection');
    });

    it('leaves every other type unthrottled', () => {
      register({ type: 'trash_purge' });
      expect(throttle.resolveKey('trash_purge')).toBeNull();
    });
  });

  describe('node pair and canDelete', () => {
    const schema = { parse: (v: unknown) => v } as never;

    it('forwards the node pair when the legacy handler has both members', () => {
      const handler = register({ type: 'x_type', nodeResultSchema: schema, persistNodeResult: jest.fn() });
      expect(handler!.nodeResultSchema).toBe(schema);
      expect(typeof handler!.persistNodeResult).toBe('function');
      expect(platform.serverOnlyTypes()).not.toContain('x_type');
    });

    it('never forwards half a pair: the type stays server-only', () => {
      const handler = register({ type: 'x_type', nodeResultSchema: schema });
      expect(handler!.nodeResultSchema).toBeUndefined();
      expect(platform.serverOnlyTypes()).toContain('x_type');
    });

    it('persistNodeResult receives the legacy row shape', async () => {
      const persist = jest.fn().mockResolvedValue(undefined);
      const handler = register({ type: 'x_type', nodeResultSchema: schema, persistNodeResult: persist });
      await handler!.persistNodeResult!(job({ type: 'x_type', payload: { circleId: CIRCLE_ID } }), { ok: true });
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ mediaItemId: MEDIA_ID, circleId: CIRCLE_ID }), { ok: true });
    });

    it('forwards canDelete with the legacy row shape', async () => {
      const canDelete = jest.fn().mockResolvedValue('still sending');
      const handler = register({ type: 'x_type', canDelete });
      await expect(handler!.canDelete!(job({ type: 'x_type' }))).resolves.toBe('still sending');
      expect(canDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', mediaItemId: MEDIA_ID }));
    });
  });
});
