/**
 * Unit tests for DuplicateDetectionHandler (native platform JobHandler, RETRO-C5).
 *
 * Covers:
 *  - registers itself with the platform JobHandlerRegistry on module init
 *  - label and profile
 *  - process() resolves the media-item subject and delegates to
 *    DuplicateDetectionService.processMediaItem
 *  - a media item gone since the job was queued settles as a no-op
 *  - a job about something other than a media item throws
 *  - node-eligibility surface: nodeResultSchema is the shared package schema
 *  - persistNodeResult(): a canned, schema-valid node result is narrowed and
 *    forwarded to persistDuplicate with sharpnessScore: null
 *  - persistNodeResult(): a schema-invalid payload throws and never reaches
 *    the service; a gone media item is a no-op
 */

import type { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import { duplicateDetectionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { DuplicateDetectionHandler } from './duplicate-detection.handler';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { circleJob, mediaItemJob, subjectPrisma } from '../../test/helpers/platform-job';

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
  let prisma: ReturnType<typeof subjectPrisma>;

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
      persistDuplicate: jest.fn().mockResolvedValue(undefined),
    };
    prisma = subjectPrisma();

    handler = new DuplicateDetectionHandler(
      mockRegistry as unknown as JobHandlerRegistry,
      prisma as unknown as PrismaService,
      mockService as unknown as DuplicateDetectionService,
    );
  });

  it('registers itself with the platform registry on module init', () => {
    handler.onModuleInit();
    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it('declares its label and a five-minute, three-attempt profile', () => {
    expect(handler.type).toBe('duplicate_detection');
    expect(handler.label).toBe('Duplicate detection');
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
  });

  describe('process', () => {
    it('delegates to processMediaItem with the subject media item', async () => {
      await handler.process(mediaItemJob('duplicate_detection'));
      expect(mockService.processMediaItem).toHaveBeenCalledWith('media-1');
    });

    it('settles as a no-op when the media item no longer exists', async () => {
      await handler.process(mediaItemJob('duplicate_detection', 'gone-1'));
      expect(mockService.processMediaItem).not.toHaveBeenCalled();
    });

    it('throws for a job that is not about a media item', async () => {
      await expect(handler.process(circleJob('duplicate_detection'))).rejects.toThrow(
        'not about a media item',
      );
      expect(mockService.processMediaItem).not.toHaveBeenCalled();
    });
  });

  describe('node-result surface', () => {
    it('exposes the shared package schema as nodeResultSchema', () => {
      expect(handler.nodeResultSchema).toBe(duplicateDetectionResultSchema);
      expect(() => handler.nodeResultSchema.parse(makeNodeResult())).not.toThrow();
    });

    it('persistNodeResult forwards the parsed payload to persistDuplicate with sharpnessScore null', async () => {
      const result = makeNodeResult();

      await handler.persistNodeResult(mediaItemJob('duplicate_detection', 'media-1', 'circle-1', { id: 'job-7' }), result);

      expect(mockService.persistDuplicate).toHaveBeenCalledTimes(1);
      expect(mockService.persistDuplicate).toHaveBeenCalledWith(
        { id: 'job-7', mediaItemId: 'media-1', circleId: 'circle-1' },
        { model: result.model, embedding: result.embedding, dHash: result.dHash, sharpnessScore: null },
      );
      // The persist half never re-runs the server compute (no download, no embed).
      expect(mockService.processMediaItem).not.toHaveBeenCalled();
    });

    it('persistNodeResult rejects a schema-invalid payload without touching the service', async () => {
      const bad = { ...makeNodeResult(), embedding: [0.1, 0.2] }; // wrong length
      await expect(handler.persistNodeResult(mediaItemJob('duplicate_detection'), bad)).rejects.toThrow();
      expect(mockService.persistDuplicate).not.toHaveBeenCalled();
    });

    it('persistNodeResult is a no-op when the media item no longer exists', async () => {
      await handler.persistNodeResult(mediaItemJob('duplicate_detection', 'gone-1'), makeNodeResult());
      expect(mockService.persistDuplicate).not.toHaveBeenCalled();
    });
  });
});
