/**
 * Unit tests for MetadataExtractionHandler.
 *
 * Tests: type constant, onModuleInit registration, process delegation,
 * and rejection propagation.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MetadataExtractionHandler } from './metadata.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { MetadataExtractionService } from './metadata.service';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'metadata_extraction',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.rerun,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetadataExtractionHandler', () => {
  let handler: MetadataExtractionHandler;
  let registry: EnrichmentHandlerRegistry;
  let mockMetadataExtractionService: { processMediaItem: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockMetadataExtractionService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetadataExtractionHandler,
        EnrichmentHandlerRegistry,
        { provide: MetadataExtractionService, useValue: mockMetadataExtractionService },
      ],
    }).compile();

    // NestJS calls onModuleInit automatically during compile/init
    await module.init();

    handler = module.get<MetadataExtractionHandler>(MetadataExtractionHandler);
    registry = module.get<EnrichmentHandlerRegistry>(EnrichmentHandlerRegistry);
  });

  // -------------------------------------------------------------------------
  // type constant
  // -------------------------------------------------------------------------

  describe('type', () => {
    it("has type 'metadata_extraction'", () => {
      expect(handler.type).toBe('metadata_extraction');
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit registration
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    it('registers itself with the registry on module init', () => {
      const registered = registry.get('metadata_extraction');
      expect(registered).toBe(handler);
    });
  });

  // -------------------------------------------------------------------------
  // process delegation
  // -------------------------------------------------------------------------

  describe('process', () => {
    it('delegates to MetadataExtractionService.processMediaItem with the job', async () => {
      const job = makeJob();

      await handler.process(job);

      expect(mockMetadataExtractionService.processMediaItem).toHaveBeenCalledWith(job);
    });

    it('propagates rejection from MetadataExtractionService.processMediaItem', async () => {
      mockMetadataExtractionService.processMediaItem.mockRejectedValue(new Error('fail'));

      await expect(handler.process(makeJob())).rejects.toThrow('fail');
    });
  });
});
