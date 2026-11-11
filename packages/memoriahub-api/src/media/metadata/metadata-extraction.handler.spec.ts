/**
 * Unit tests for MetadataExtractionHandler (a native platform JobHandler,
 * RETRO-C3 #585).
 *
 * Tests: type, label and profile, onModuleInit registration with the platform
 * registry, process delegation with the media-item context and the job's write
 * scope, the deleted-subject no-op, rejection propagation, and the node pair.
 */

import { metadataExtractionResultSchema } from '@marinoscar/memoriahub-compute/dto';
import { MetadataExtractionHandler } from './metadata-extraction.handler.js';

const TEST_ORG_ID = 'org-1';
const job = (subjectType: string | null, subjectId: string | null, orgId: string | null = TEST_ORG_ID) => ({
  id: 'job-1',
  type: 'metadata_extraction',
  subjectType,
  subjectId,
  payload: { circleId: 'circle-1' },
  attempts: 1,
  orgId,
});
const makeJob = (mediaItemId = 'media-1') => job('media_item', mediaItemId);
const systemJob = () => job(null, null, null);
/** The database port: `media-1` exists, anything else does not. */
const subjectPrisma = () => ({
  mediaItem: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === 'media-1' ? { id: 'media-1', circleId: 'circle-1' } : null,
    ),
  },
});
const CONTEXT = { id: 'job-1', mediaItemId: 'media-1', circleId: 'circle-1' };

describe('MetadataExtractionHandler', () => {
  let handler: MetadataExtractionHandler;
  let registered: unknown[];
  let mockJobs: { registerHandler: jest.Mock; runInJobScope: jest.Mock };
  let mockMetadataExtractionService: { processMediaItem: jest.Mock; persistMetadata: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockMetadataExtractionService = {
      processMediaItem: jest.fn().mockResolvedValue(undefined),
      persistMetadata: jest.fn().mockResolvedValue(undefined),
    };
    registered = [];
    mockJobs = {
      registerHandler: jest.fn((h: unknown) => registered.push(h)),
      runInJobScope: jest.fn(async (_job: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx')),
    };

    handler = new MetadataExtractionHandler(mockJobs as never, subjectPrisma() as never, mockMetadataExtractionService as never);
    handler.onModuleInit();
  });

  describe('contract', () => {
    it("has type 'metadata_extraction', a label and the 5-minute profile", () => {
      expect(handler.type).toBe('metadata_extraction');
      expect(handler.label).toBe('Metadata extraction');
      expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
    });

    it('registers itself with the queue on module init', () => {
      expect(registered).toEqual([handler]);
    });

    it('is node-eligible: it declares the node pair', () => {
      expect(handler.nodeResultSchema).toBe(metadataExtractionResultSchema);
      expect(typeof handler.persistNodeResult).toBe('function');
    });
  });

  describe('process', () => {
    it('delegates to processMediaItem with the media-item context and the write scope of the job', async () => {
      const job = makeJob();

      await handler.process(job);

      expect(mockMetadataExtractionService.processMediaItem).toHaveBeenCalledWith(CONTEXT, expect.any(Function));
      const scope = mockMetadataExtractionService.processMediaItem.mock.calls[0][1];
      await expect(scope(async (tx: unknown) => tx)).resolves.toBe('tx');
      expect(mockJobs.runInJobScope).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', orgId: TEST_ORG_ID }), expect.any(Function));
    });

    it('still passes a write scope for a job with no organization (legacy row: the default organization, RETRO-D1)', async () => {
      await handler.process(job('media_item', 'media-1', null));
      expect(mockMetadataExtractionService.processMediaItem).toHaveBeenCalledWith(CONTEXT, expect.any(Function));
    });

    it('settles as a no-op when the media item no longer exists', async () => {
      await expect(handler.process(makeJob('gone'))).resolves.toBeUndefined();
      expect(mockMetadataExtractionService.processMediaItem).not.toHaveBeenCalled();
    });

    it('throws for a job that is not about a media item', async () => {
      await expect(handler.process(systemJob())).rejects.toThrow('not about a media item');
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
