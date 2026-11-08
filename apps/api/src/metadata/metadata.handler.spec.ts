/**
 * Unit tests for MetadataExtractionHandler (a native platform JobHandler,
 * RETRO-C3 #585).
 *
 * Tests: type, label and profile, onModuleInit registration with the platform
 * registry, process delegation with the media-item context and the job's write
 * scope, the deleted-subject no-op, rejection propagation, and the node pair.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobHandlerRegistry, JobScope } from '@marinoscar/platform-api/jobs';
import { metadataExtractionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { MetadataExtractionHandler } from './metadata.handler';
import { MetadataExtractionService } from './metadata.service';
import { PrismaService } from '../prisma/prisma.service';
import { mediaItemJob, subjectPrisma, systemJob, TEST_ORG_ID } from '../../test/helpers/platform-job';

const makeJob = (mediaItemId = 'media-1') => mediaItemJob('metadata_extraction', mediaItemId);
const CONTEXT = { id: 'job-1', mediaItemId: 'media-1', circleId: 'circle-1' };

describe('MetadataExtractionHandler', () => {
  let handler: MetadataExtractionHandler;
  let registry: JobHandlerRegistry;
  let mockMetadataExtractionService: { processMediaItem: jest.Mock; persistMetadata: jest.Mock };
  let mockJobScope: { run: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockMetadataExtractionService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
      persistMetadata: jest.fn().mockResolvedValue(undefined),
    };
    mockJobScope = { run: jest.fn(async (_job: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx')) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetadataExtractionHandler,
        JobHandlerRegistry,
        { provide: JobScope, useValue: mockJobScope },
        { provide: PrismaService, useValue: subjectPrisma() },
        { provide: MetadataExtractionService, useValue: mockMetadataExtractionService },
      ],
    }).compile();

    // NestJS calls onModuleInit automatically during init
    await module.init();

    handler = module.get<MetadataExtractionHandler>(MetadataExtractionHandler);
    registry = module.get<JobHandlerRegistry>(JobHandlerRegistry);
  });

  describe('contract', () => {
    it("has type 'metadata_extraction', a label and the 5-minute profile", () => {
      expect(handler.type).toBe('metadata_extraction');
      expect(handler.label).toBe('Metadata extraction');
      expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
    });

    it('registers itself with the platform registry on module init', () => {
      expect(registry.get('metadata_extraction')).toBe(handler);
    });

    it('is node-eligible: the platform does not list it server-only', () => {
      expect(registry.serverOnlyTypes()).not.toContain('metadata_extraction');
      expect(handler.nodeResultSchema).toBe(metadataExtractionResultSchema);
    });
  });

  describe('process', () => {
    it('delegates to processMediaItem with the media-item context and a JobScope write scope', async () => {
      const job = makeJob();

      await handler.process(job);

      expect(mockMetadataExtractionService.processMediaItem).toHaveBeenCalledWith(CONTEXT, expect.any(Function));
      const scope = mockMetadataExtractionService.processMediaItem.mock.calls[0][1];
      await expect(scope(async (tx: unknown) => tx)).resolves.toBe('tx');
      expect(mockJobScope.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', orgId: TEST_ORG_ID }), expect.any(Function));
    });

    it('passes no scope for a job with no organization (legacy row)', async () => {
      await handler.process(mediaItemJob('metadata_extraction', 'media-1', 'circle-1', { orgId: null }));
      expect(mockMetadataExtractionService.processMediaItem).toHaveBeenCalledWith(CONTEXT, undefined);
    });

    it('settles as a no-op when the media item no longer exists', async () => {
      await expect(handler.process(makeJob('gone'))).resolves.toBeUndefined();
      expect(mockMetadataExtractionService.processMediaItem).not.toHaveBeenCalled();
    });

    it('throws for a job that is not about a media item', async () => {
      await expect(handler.process(systemJob('metadata_extraction'))).rejects.toThrow('not about a media item');
    });

    it('propagates rejection from MetadataExtractionService.processMediaItem', async () => {
      mockMetadataExtractionService.processMediaItem.mockRejectedValue(new Error('fail'));

      await expect(handler.process(makeJob())).rejects.toThrow('fail');
    });
  });

  describe('persistNodeResult', () => {
    const result = { exif: { width: 10, height: 20 }, probe: null };

    it('forwards the parsed { exif, probe } with the job write scope', async () => {
      await handler.persistNodeResult(makeJob(), result);

      expect(mockMetadataExtractionService.persistMetadata).toHaveBeenCalledWith(
        CONTEXT,
        { exif: result.exif, probe: null },
        expect.any(Function),
      );
    });

    it('rejects a schema-invalid payload without touching the service', async () => {
      await expect(handler.persistNodeResult(makeJob(), { exif: 'nope' })).rejects.toThrow();
      expect(mockMetadataExtractionService.persistMetadata).not.toHaveBeenCalled();
    });
  });
});
