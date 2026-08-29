/**
 * Unit tests for VideoAutoTaggingHandler (epic #452, issue #455).
 *
 * Covers the registration surface and the node-result path. The persist half
 * is deliberately delegated to AutoTaggingService, so what these tests protect
 * is that the delegation actually happens (and in the right order) rather than
 * a second copy of parsing/vocabulary validation growing here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { videoAutoTaggingResultSchema } from '@memoriahub/enrichment-compute/dto';
import { VideoAutoTaggingHandler } from './video-auto-tagging.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { AutoTaggingService } from './auto-tagging.service';
import { VideoAutoTaggingService } from './video-auto-tagging.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'video_auto_tagging',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 20,
    providerKey: 'openai',
    modelVersion: 'gpt-4o',
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('VideoAutoTaggingHandler', () => {
  let handler: VideoAutoTaggingHandler;
  let registry: { register: jest.Mock };
  let videoService: { processMediaItem: jest.Mock; persistNodeTranscript: jest.Mock };
  let autoTaggingService: { persistAutoTagging: jest.Mock };

  beforeEach(async () => {
    registry = { register: jest.fn() };
    videoService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
      persistNodeTranscript: jest.fn().mockResolvedValue(undefined),
    };
    autoTaggingService = { persistAutoTagging: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoAutoTaggingHandler,
        { provide: EnrichmentHandlerRegistry, useValue: registry },
        { provide: VideoAutoTaggingService, useValue: videoService },
        { provide: AutoTaggingService, useValue: autoTaggingService },
      ],
    }).compile();

    handler = module.get(VideoAutoTaggingHandler);
  });

  it('registers itself under a job type DISTINCT from auto_tagging', () => {
    handler.onModuleInit();

    // The distinct type is what gives video jobs the 20-minute timeout bucket
    // and the ffmpeg node requirement without imposing either on photos.
    expect(handler.type).toBe('video_auto_tagging');
    expect(handler.type).not.toBe('auto_tagging');
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('exposes the shared node result schema', () => {
    expect(handler.nodeResultSchema).toBe(videoAutoTaggingResultSchema);
  });

  it('delegates process() to VideoAutoTaggingService', async () => {
    const job = makeJob();
    await handler.process(job);

    expect(videoService.processMediaItem).toHaveBeenCalledWith(job);
  });

  it('persists a node result through the SAME persist half the photo path uses', async () => {
    const job = makeJob();

    await handler.persistNodeResult(job, {
      rawText: '{"tags":["Beach"],"description":"d"}',
      frameCount: 6,
      sampledTimestampsMs: [2500, 7500],
    });

    expect(autoTaggingService.persistAutoTagging).toHaveBeenCalledWith(job, {
      rawText: '{"tags":["Beach"],"description":"d"}',
    });
  });

  it('persists a node-submitted transcript BEFORE the tags, so the embedding includes it', async () => {
    const order: string[] = [];
    videoService.persistNodeTranscript.mockImplementation(async () => {
      order.push('transcript');
    });
    autoTaggingService.persistAutoTagging.mockImplementation(async () => {
      order.push('tags');
    });

    await handler.persistNodeResult(makeJob(), {
      rawText: '{}',
      frameCount: 2,
      sampledTimestampsMs: [0, 1000],
      transcript: { text: 'happy birthday', leadSeconds: 30 },
    });

    expect(order).toEqual(['transcript', 'tags']);
  });

  it('rejects a payload that fails nodeResultSchema before touching the database', async () => {
    await expect(
      handler.persistNodeResult(makeJob(), { rawText: 123, frameCount: 'six' }),
    ).rejects.toThrow();

    expect(autoTaggingService.persistAutoTagging).not.toHaveBeenCalled();
  });

  it('accepts a visual-only result (no transcript key at all)', async () => {
    await expect(
      handler.persistNodeResult(makeJob(), {
        rawText: '{}',
        frameCount: 3,
        sampledTimestampsMs: [0, 1000, 2000],
      }),
    ).resolves.toBeUndefined();
  });
});
