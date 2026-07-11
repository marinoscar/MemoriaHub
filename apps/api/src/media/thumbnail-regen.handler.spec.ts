/**
 * Unit tests for ThumbnailRegenHandler.
 *
 * Verifies: handler type constant; onModuleInit registers with the registry;
 * process() throws when mediaItemId is missing, gracefully skips (no throw,
 * no reprocessObjectNow call) when the item is missing/deleted/has no
 * storageObject, and on the happy path calls
 * StorageProcessingRecoveryService.reprocessObjectNow with the exact
 * storageObject resolved from Prisma.
 *
 * No database required — all dependencies are fully mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ThumbnailRegenHandler } from './thumbnail-regen.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { ThumbnailNodePersistService } from './thumbnail-node-persist.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { randomUUID } from 'crypto';
import type { EnrichmentJob } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-thumb-1',
    type: 'thumbnail_regen',
    mediaItemId: randomUUID(),
    circleId: randomUUID(),
    status: 'running' as any,
    reason: 'rerun' as any,
    priority: 0,
    providerKey: null,
    modelVersion: null,
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
  } as EnrichmentJob;
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
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockRecoveryService: jest.Mocked<Pick<StorageProcessingRecoveryService, 'reprocessObjectNow'>>;
  let mockThumbnailNodePersistService: jest.Mocked<Pick<ThumbnailNodePersistService, 'persistThumbnail'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockRegistry = {
      register: jest.fn(),
    };

    mockRecoveryService = {
      reprocessObjectNow: jest.fn().mockResolvedValue(undefined),
    };

    mockThumbnailNodePersistService = {
      persistThumbnail: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailRegenHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: StorageProcessingRecoveryService,
          useValue: mockRecoveryService,
        },
        {
          provide: ThumbnailNodePersistService,
          useValue: mockThumbnailNodePersistService,
        },
      ],
    }).compile();

    handler = module.get<ThumbnailRegenHandler>(ThumbnailRegenHandler);
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

  describe('onModuleInit', () => {
    it('registers itself in the EnrichmentHandlerRegistry on init', () => {
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });

    it('registers exactly once per call', () => {
      const before = (mockRegistry.register as jest.Mock).mock.calls.length;
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledTimes(before + 1);
    });
  });

  // =========================================================================
  // process
  // =========================================================================

  describe('process', () => {
    it('throws when job.mediaItemId is null', async () => {
      const job = makeJob({ mediaItemId: null });

      await expect(handler.process(job)).rejects.toThrow(
        /missing mediaItemId/i,
      );
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      expect(mockRecoveryService.reprocessObjectNow).not.toHaveBeenCalled();
    });

    it('throws when job.mediaItemId is undefined', async () => {
      const job = makeJob({ mediaItemId: undefined as any });

      await expect(handler.process(job)).rejects.toThrow(
        /missing mediaItemId/i,
      );
      expect(mockRecoveryService.reprocessObjectNow).not.toHaveBeenCalled();
    });

    it('returns without calling reprocessObjectNow when the MediaItem is missing', async () => {
      const job = makeJob();
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: job.mediaItemId },
          select: expect.objectContaining({
            id: true,
            deletedAt: true,
            storageObject: true,
          }),
        }),
      );
      expect(mockRecoveryService.reprocessObjectNow).not.toHaveBeenCalled();
    });

    it('returns without calling reprocessObjectNow when the MediaItem is soft-deleted', async () => {
      const job = makeJob();
      const item = makeMediaItem({ deletedAt: new Date() });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockRecoveryService.reprocessObjectNow).not.toHaveBeenCalled();
    });

    it('returns without calling reprocessObjectNow when the MediaItem has no storageObject', async () => {
      const job = makeJob();
      const item = makeMediaItem({ storageObject: null });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockRecoveryService.reprocessObjectNow).not.toHaveBeenCalled();
    });

    it('calls reprocessObjectNow with the exact storageObject on the happy path', async () => {
      const job = makeJob();
      const storageObject = makeStorageObject();
      const item = makeMediaItem({ storageObject });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);

      await expect(handler.process(job)).resolves.toBeUndefined();

      expect(mockRecoveryService.reprocessObjectNow).toHaveBeenCalledTimes(1);
      expect(mockRecoveryService.reprocessObjectNow).toHaveBeenCalledWith(
        storageObject,
      );
    });

    it('propagates errors thrown by reprocessObjectNow (worker records lastError and retries)', async () => {
      const job = makeJob();
      const item = makeMediaItem();
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockRecoveryService.reprocessObjectNow.mockRejectedValue(
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
      const result = {
        storageKey: 'thumbnails/some-object-id.jpg',
        width: 400,
        height: 300,
        bytes: 12345,
      };

      await handler.persistNodeResult(job, result);

      expect(mockThumbnailNodePersistService.persistThumbnail).toHaveBeenCalledTimes(1);
      expect(mockThumbnailNodePersistService.persistThumbnail).toHaveBeenCalledWith(
        job,
        result,
      );
    });

    it('rejects an invalid result payload without calling persistThumbnail', async () => {
      const job = makeJob();
      const invalidResult = { storageKey: '', width: 400, height: 300, bytes: 12345 };

      await expect(handler.persistNodeResult(job, invalidResult)).rejects.toThrow();
      expect(mockThumbnailNodePersistService.persistThumbnail).not.toHaveBeenCalled();
    });
  });
});
