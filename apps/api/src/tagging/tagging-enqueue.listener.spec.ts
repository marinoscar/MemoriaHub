/**
 * Unit tests for TaggingEnqueueListener.
 *
 * Verifies that the OBJECT_PROCESSED_EVENT handler:
 *   - skips non-photo media items
 *   - skips soft-deleted media items
 *   - skips when AUTO_TAG_ENABLED=false
 *   - skips when circle.autoTaggingEnabled=false
 *   - enqueues and upserts status to pending when all gates pass
 *   - never rethrows on internal errors
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TaggingEnqueueListener } from './tagging-enqueue.listener';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { JobReason, JobStatus, MediaTagStatusType, MediaType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_OBJECT_ID = 'storage-obj-1';

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  type: MediaType;
  deletedAt: Date | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    type: MediaType.photo,
    deletedAt: null,
    ...overrides,
  };
}

function makeCircle(autoTaggingEnabled = true) {
  return { autoTaggingEnabled };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaggingEnqueueListener', () => {
  let listener: TaggingEnqueueListener;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset env before each test
    process.env = { ...originalEnv };
    delete process.env['AUTO_TAG_ENABLED'];

    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'job-1',
        status: JobStatus.pending,
      }),
    };

    // Default: mediaItem found, is a photo, not deleted
    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
      makeMediaItem(),
    );

    // Default: circle has autoTaggingEnabled=true
    (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
      makeCircle(true),
    );

    (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaggingEnqueueListener,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    listener = module.get<TaggingEnqueueListener>(TaggingEnqueueListener);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // Happy path: enqueues when all gates pass
  // -------------------------------------------------------------------------

  describe('happy path: all gates pass', () => {
    it('enqueues an auto_tagging job with reason upload and priority 20', async () => {
      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: 'media-1',
          circleId: 'circle-1',
          reason: JobReason.upload,
          priority: 20,
        }),
      );
    });

    it('upserts MediaTagStatus to pending after enqueuing', async () => {
      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: 'media-1' },
          create: expect.objectContaining({
            status: MediaTagStatusType.pending,
          }),
          update: expect.objectContaining({
            status: MediaTagStatusType.pending,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Skip: no mediaItem for storageObject
  // -------------------------------------------------------------------------

  describe('skip: no mediaItem found', () => {
    it('does nothing when no MediaItem has the given storageObjectId', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Skip: non-photo
  // -------------------------------------------------------------------------

  describe('skip: non-photo type', () => {
    it('skips video media items without enqueuing', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.video }),
      );

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Skip: soft-deleted
  // -------------------------------------------------------------------------

  describe('skip: soft-deleted media item', () => {
    it('skips soft-deleted media items without enqueuing', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Skip: AUTO_TAG_ENABLED=false kill-switch
  // -------------------------------------------------------------------------

  describe('skip: AUTO_TAG_ENABLED=false', () => {
    it('skips enqueue when AUTO_TAG_ENABLED env var is "false"', async () => {
      process.env['AUTO_TAG_ENABLED'] = 'false';

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
    });

    it('proceeds when AUTO_TAG_ENABLED is not set (defaults to enabled)', async () => {
      // env var absent
      delete process.env['AUTO_TAG_ENABLED'];

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalled();
    });

    it('proceeds when AUTO_TAG_ENABLED is "true"', async () => {
      process.env['AUTO_TAG_ENABLED'] = 'true';

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Skip: circle.autoTaggingEnabled=false
  // -------------------------------------------------------------------------

  describe('skip: circle.autoTaggingEnabled=false', () => {
    it('skips when circle has autoTaggingEnabled=false', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircle(false),
      );

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTagStatus.upsert).not.toHaveBeenCalled();
    });

    it('skips when circle is not found (null)', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID });

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Never rethrows on internal error
  // -------------------------------------------------------------------------

  describe('error resilience: never rethrows', () => {
    it('does not throw when enrichmentJobService.enqueue rejects', async () => {
      mockEnrichmentJobService.enqueue.mockRejectedValue(
        new Error('Database connection lost'),
      );

      // Must not throw — listener is fire-and-forget
      await expect(
        listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when prisma.mediaItem.findUnique rejects', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockRejectedValue(
        new Error('DB error'),
      );

      await expect(
        listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID }),
      ).resolves.toBeUndefined();
    });

    it('does not throw when mediaTagStatus.upsert rejects', async () => {
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockRejectedValue(
        new Error('Upsert failed'),
      );

      await expect(
        listener.handleObjectProcessed({ storageObjectId: STORAGE_OBJECT_ID }),
      ).resolves.toBeUndefined();
    });
  });
});
