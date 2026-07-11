/**
 * Unit tests for DuplicateDetectionHandler.
 *
 * Covers:
 *  - Registers itself with the EnrichmentHandlerRegistry on module init
 *  - process() delegates to DuplicateDetectionService.processMediaItem
 *  - process() no-ops (warn + return) when the job has no mediaItemId
 *  - Node-eligibility surface: nodeResultSchema is the shared package schema
 *  - persistNodeResult(): a canned, schema-valid node result DTO is narrowed
 *    and forwarded to DuplicateDetectionService.persistDuplicate with
 *    sharpnessScore: null (the node contract carries no sharpness)
 *  - persistNodeResult(): a schema-invalid payload throws and never reaches
 *    the service
 */

import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { duplicateDetectionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { DuplicateDetectionHandler } from './duplicate-detection.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { DuplicateDetectionService } from './duplicate-detection.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'duplicate_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 50,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: 'node-1',
    leaseExpiresAt: null,
    executor: 'node',
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

/** Canned, schema-valid node result payload (512-d embedding, decimal dHash). */
function makeNodeResult() {
  return {
    model: 'clip-vit-b32-q8',
    embedding: Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)),
    dHash: '12345678901234567890',
  };
}

describe('DuplicateDetectionHandler', () => {
  let handler: DuplicateDetectionHandler;
  let mockRegistry: { register: jest.Mock };
  let mockService: { processMediaItem: jest.Mock; persistDuplicate: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
      persistDuplicate: jest.fn().mockResolvedValue(undefined),
    };

    handler = new DuplicateDetectionHandler(
      mockRegistry as unknown as EnrichmentHandlerRegistry,
      mockService as unknown as DuplicateDetectionService,
    );
  });

  it('registers itself with the registry on module init', () => {
    handler.onModuleInit();
    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  describe('process', () => {
    it('delegates to processMediaItem with the job mediaItemId', async () => {
      await handler.process(makeJob());
      expect(mockService.processMediaItem).toHaveBeenCalledWith('media-1');
    });

    it('no-ops when the job has no mediaItemId', async () => {
      await handler.process(makeJob({ mediaItemId: null }));
      expect(mockService.processMediaItem).not.toHaveBeenCalled();
    });
  });

  describe('node-result surface', () => {
    it('exposes the shared package schema as nodeResultSchema', () => {
      expect(handler.nodeResultSchema).toBe(duplicateDetectionResultSchema);
      // Sanity: the schema accepts the canned payload used below.
      expect(() => handler.nodeResultSchema.parse(makeNodeResult())).not.toThrow();
    });

    it('persistNodeResult forwards the parsed payload to persistDuplicate with sharpnessScore null', async () => {
      const job = makeJob();
      const result = makeNodeResult();

      await handler.persistNodeResult(job, result);

      expect(mockService.persistDuplicate).toHaveBeenCalledTimes(1);
      expect(mockService.persistDuplicate).toHaveBeenCalledWith(job, {
        model: result.model,
        embedding: result.embedding,
        dHash: result.dHash,
        sharpnessScore: null,
      });
    });

    it('persistNodeResult rejects a schema-invalid payload without touching the service', async () => {
      const bad = { ...makeNodeResult(), embedding: [0.1, 0.2] }; // wrong length
      await expect(handler.persistNodeResult(makeJob(), bad)).rejects.toThrow();
      expect(mockService.persistDuplicate).not.toHaveBeenCalled();
    });
  });
});
