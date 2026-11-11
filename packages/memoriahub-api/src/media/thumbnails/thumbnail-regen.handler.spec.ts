/**
 * Unit tests for ThumbnailRegenHandler.
 *
 * Verifies (a native platform JobHandler, RETRO-C3 #585): handler type, label
 * and profile; onModuleInit registers with the platform registry;
 * process() throws when the job is not about a media item, gracefully skips (no throw,
 * no reprocessNow call) when the item is missing/deleted/has no
 * storageObject, and on the happy path calls
 * ObjectReprocessService.reprocessNow with the exact
 * storageObject resolved from Prisma.
 *
 * No database required — all dependencies are fully mocked.
 */
import { randomUUID } from 'crypto';
import type { MemoriahubJob } from '../../ports/index.js';
import { ThumbnailRegenHandler } from './thumbnail-regen.handler.js';

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

/** The slice of the database client the handler reads. */
function createMockPrismaService() {
  return { mediaItem: { findUnique: jest.fn() } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  return {
    id: 'job-thumb-1',
    type: 'thumbnail_regen',
    subjectType: 'media_item',
    subjectId: randomUUID(),
    payload: { circleId: randomUUID() },
    reason: 'rerun',
    attempts: 1,
    orgId: 'org-1',
    status: 'running',
    ...overrides,
  };
}

function makeStorageObject(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    name: 'photo.jpg',
    size: BigInt(1024000),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    deletedAt: null,
    storageObject: makeStorageObject(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThumbnailRegenHandler', () => {
  let handler: ThumbnailRegenHandler;
  let mockJobs: { registerHandler: jest.Mock; runInJobScope: jest.Mock };
  let mockRecoveryService: { reprocessNow: jest.Mock };
  let mockThumbnailNodePersistService: { persistThumbnail: jest.Mock };
  let mockPrisma: MockPrismaService;

  beforeEach(() => {

    mockRecoveryService = {
      reprocessNow: jest.fn().mockResolvedValue(undefined),
    };

    mockThumbnailNodePersistService = {
      persistThumbnail: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma = createMockPrismaService();
    mockJobs = {
      registerHandler: jest.fn(),
      runInJobScope: jest.fn(async (_job: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('tx')),
    };

    handler = new ThumbnailRegenHandler(
      mockJobs as never,
      mockPrisma as never,
      mockRecoveryService as never,
      mockThumbnailNodePersistService as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant
  // =========================================================================

  describe('type', () => {
    it('has type === "thumbnail_regen"', () => {
      expect(handler.type).toBe('thumbnail_regen');
    });
  });

  // =========================================================================
  // onModuleInit — registers with the registry
  // =========================================================================

  describe('platform contract', () => {
    it('declares a label and the 10-minute, 3-attempt profile', () => {
      expect(handler.label).toBe('Thumbnail regeneration');
      expect(handler.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 3 });
    });
  });

  describe('onModuleInit', () => {
    it('registers itself with the queue on init', () => {
      handler.onModuleInit();
      expect(mockJobs.registerHandler).toHaveBeenCalledWith(handler);
    });

    it('registers exactly once per call', () => {
      const before = mockJobs.registerHandler.mock.calls.length;
      handler.onModuleInit();
      expect(mockJobs.registerHandler).toHaveBeenCalledTimes(before + 1);
    });
  });

  // =========================================================================
  // process
  // =========================================================================

  describe('process', () => {
    it('throws when the job is not about a media item', async () => {
      const job = makeJob({ subjectType: null, subjectId: null });

      await expect(handler.process(job)).rejects.toThrow(/not about a media item/i);
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      expect(mockRecoveryService.reprocessNow).not.toHaveBeenCalled();
    });

    it('settles as a no-op without calling reprocessNow when the MediaItem is gone', async () => {
      const job = makeJob();
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: job.subjectId } }),
      );
      expect(mockRecoveryService.reprocessNow).not.toHaveBeenCalled();
    });

    it('returns without calling reprocessNow when the MediaItem is soft-deleted', async () => {
      const job = makeJob();
      const item = makeMediaItem({ deletedAt: new Date() });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockRecoveryService.reprocessNow).not.toHaveBeenCalled();
    });

    it('returns without calling reprocessNow when the MediaItem has no storageObject', async () => {
      const job = makeJob();
      const item = makeMediaItem({ storageObject: null });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockRecoveryService.reprocessNow).not.toHaveBeenCalled();
    });

    it('calls reprocessNow with the exact storageObject on the happy path', async () => {
      const job = makeJob();
      const storageObject = makeStorageObject();
      const item = makeMediaItem({ storageObject });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockRecoveryService.reprocessNow).toHaveBeenCalledTimes(1);
      expect(mockRecoveryService.reprocessNow).toHaveBeenCalledWith(
        storageObject,
      );
    });

    it('propagates errors thrown by reprocessNow (worker records lastError and retries)', async () => {
      const job = makeJob();
      const item = makeMediaItem();
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockRecoveryService.reprocessNow.mockRejectedValue(
        new Error('S3 unavailable'),
      );

      await expect(handler.process(job)).rejects.toThrow('S3 unavailable');
    });

    it('propagates errors thrown by prisma.mediaItem.findUnique', async () => {
      const job = makeJob();
      mockPrisma.mediaItem.findUnique.mockRejectedValue(
        new Error('DB connection lost'),
      );

      await expect(handler.process(job)).rejects.toThrow(
        'DB connection lost',
      );
    });
  });

  // =========================================================================
  // nodeResultSchema / persistNodeResult (distributed node path)
  // =========================================================================

  describe('nodeResultSchema / persistNodeResult', () => {
    it('exposes a nodeResultSchema', () => {
      expect(handler.nodeResultSchema).toBeDefined();
    });

    it('parses a valid result payload and delegates to ThumbnailNodePersistService.persistThumbnail', async () => {
      const job = makeJob();
      mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem({ id: job.subjectId }) as any);
      const result = {
        storageKey: 'thumbnails/some-object-id.jpg',
        width: 400,
        height: 300,
        bytes: 12345,
      };

      await handler.persistNodeResult(job, result);

      expect(mockThumbnailNodePersistService.persistThumbnail).toHaveBeenCalledTimes(1);
      expect(mockThumbnailNodePersistService.persistThumbnail).toHaveBeenCalledWith(
        { id: job.id, mediaItemId: job.subjectId, circleId: (job.payload as { circleId: string }).circleId },
        result,
        expect.any(Function),
      );
    });

    it('rejects an invalid result payload without calling persistThumbnail', async () => {
      const job = makeJob();
      const invalidResult = { storageKey: '', width: 400, height: 300, bytes: 12345 };

      await expect(handler.persistNodeResult(job, invalidResult)).rejects.toThrow();
      expect(mockThumbnailNodePersistService.persistThumbnail).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // deriveOutputKey (where a node's thumbnail lands)
  // =========================================================================

  describe('deriveOutputKey', () => {
    const SOURCE_OBJECT_ID = '11111111-1111-4111-8111-111111111111';

    it('answers a versioned key in the source object thumbnail namespace', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ storageObjectId: SOURCE_OBJECT_ID } as any);

      const key = await handler.deriveOutputKey(makeJob());

      expect(key).toMatch(new RegExp(`^thumbnails/${SOURCE_OBJECT_ID}-[0-9a-f]{16}\\.jpg$`));
    });

    it('is idempotent per job and moves with a new job', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ storageObjectId: SOURCE_OBJECT_ID } as any);
      const job = makeJob();

      const first = await handler.deriveOutputKey(job);
      const again = await handler.deriveOutputKey(job);
      const other = await handler.deriveOutputKey(makeJob({ id: 'job-thumb-2' }));

      expect(again).toBe(first);
      expect(other).not.toBe(first);
    });

    it('refuses a media item with no storage object', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ storageObjectId: null } as any);

      await expect(handler.deriveOutputKey(makeJob())).rejects.toThrow(/no linked StorageObject/);
    });
  });
});
