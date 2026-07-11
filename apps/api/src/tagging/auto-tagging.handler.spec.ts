/**
 * Unit tests for AutoTaggingHandler.
 *
 * Covers the node-eligibility surface (distributed workers):
 *   - type constant and registration
 *   - nodeResultSchema is the shared autoTaggingResultSchema from
 *     @memoriahub/enrichment-compute/dto
 *   - persistNodeResult re-parses the payload and delegates to
 *     AutoTaggingService.persistAutoTagging (the PERSIST half of the split)
 *   - persistNodeResult rejects a payload that fails nodeResultSchema
 *     (schema validation happens in NodesService.submitJobResult before this
 *     is ever reached in production, but the handler re-parses defensively —
 *     mirrors DuplicateDetectionHandler's precedent).
 *   - process() delegates to AutoTaggingService.processMediaItem (the
 *     in-process compute+persist path).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { z } from 'zod';
import { autoTaggingResultSchema } from '@memoriahub/enrichment-compute/dto';
import { AutoTaggingHandler } from './auto-tagging.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { AutoTaggingService } from './auto-tagging.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'auto_tagging',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 20,
    providerKey: 'anthropic',
    modelVersion: 'claude-3-5-sonnet',
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: 'node-1',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    executor: 'node',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('AutoTaggingHandler', () => {
  let handler: AutoTaggingHandler;
  let mockAutoTaggingService: { processMediaItem: jest.Mock; persistAutoTagging: jest.Mock };

  beforeEach(async () => {
    mockAutoTaggingService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
      persistAutoTagging: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoTaggingHandler,
        EnrichmentHandlerRegistry,
        { provide: AutoTaggingService, useValue: mockAutoTaggingService },
      ],
    }).compile();

    await module.init();

    handler = module.get<AutoTaggingHandler>(AutoTaggingHandler);
  });

  describe('type', () => {
    it("has type 'auto_tagging'", () => {
      expect(handler.type).toBe('auto_tagging');
    });
  });

  describe('nodeResultSchema', () => {
    it('is the shared autoTaggingResultSchema from @memoriahub/enrichment-compute/dto', () => {
      expect(handler.nodeResultSchema).toBe(autoTaggingResultSchema);
    });

    it('accepts a { rawText } payload', () => {
      expect(() => handler.nodeResultSchema.parse({ rawText: 'hello' })).not.toThrow();
    });

    it('rejects a payload missing rawText', () => {
      expect(() => handler.nodeResultSchema.parse({})).toThrow(z.ZodError);
    });

    it('rejects a payload where rawText is not a string', () => {
      expect(() => handler.nodeResultSchema.parse({ rawText: 123 })).toThrow(z.ZodError);
    });
  });

  describe('onModuleInit', () => {
    it('registers itself in the EnrichmentHandlerRegistry', async () => {
      const module = await Test.createTestingModule({
        providers: [
          AutoTaggingHandler,
          EnrichmentHandlerRegistry,
          { provide: AutoTaggingService, useValue: mockAutoTaggingService },
        ],
      }).compile();

      await module.init();

      const registry = module.get<EnrichmentHandlerRegistry>(EnrichmentHandlerRegistry);
      expect(registry.get('auto_tagging')).toBeDefined();
    });
  });

  describe('process', () => {
    it('delegates to AutoTaggingService.processMediaItem with the job', async () => {
      const job = makeJob();
      await handler.process(job);

      expect(mockAutoTaggingService.processMediaItem).toHaveBeenCalledWith(job);
      expect(mockAutoTaggingService.persistAutoTagging).not.toHaveBeenCalled();
    });
  });

  describe('persistNodeResult', () => {
    it('parses the payload and delegates to AutoTaggingService.persistAutoTagging', async () => {
      const job = makeJob();

      await handler.persistNodeResult(job, { rawText: '{"tags":["Beach"],"description":"Sand."}' });

      expect(mockAutoTaggingService.persistAutoTagging).toHaveBeenCalledWith(job, {
        rawText: '{"tags":["Beach"],"description":"Sand."}',
      });
      expect(mockAutoTaggingService.processMediaItem).not.toHaveBeenCalled();
    });

    it('throws (does not call persistAutoTagging) when the payload fails schema validation', async () => {
      const job = makeJob();

      await expect(handler.persistNodeResult(job, { rawText: 123 })).rejects.toThrow();
      expect(mockAutoTaggingService.persistAutoTagging).not.toHaveBeenCalled();
    });

    it('throws when rawText is missing entirely', async () => {
      const job = makeJob();

      await expect(handler.persistNodeResult(job, {})).rejects.toThrow();
      expect(mockAutoTaggingService.persistAutoTagging).not.toHaveBeenCalled();
    });
  });
});
