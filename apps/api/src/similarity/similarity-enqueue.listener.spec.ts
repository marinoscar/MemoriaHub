/**
 * Unit tests for SimilarityEnqueueListener.
 *
 * Covers:
 *  - Happy path: photo + circle opt-in → enqueue called with correct args
 *  - Type guard: video → skip
 *  - Soft-deleted mediaItem → skip
 *  - No mediaItem → skip
 *  - VISUAL_DEDUP_ENABLED=false global kill-switch → skip all circles
 *  - VISUAL_DEDUP_ENABLED=true → enqueue
 *  - VISUAL_DEDUP_ENABLED unset (default) → enqueue
 *  - circle.visualDedupEnabled=false → skip
 *  - circle is null → skip
 *  - circle.visualDedupEnabled=true → enqueue
 *  - DB error in findUnique → swallowed (does not rethrow)
 *  - enqueue throws → swallowed (does not rethrow)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SimilarityEnqueueListener } from './similarity-enqueue.listener';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { JobReason, JobStatus, MediaType } from '@prisma/client';
import { ObjectProcessedEvent } from '../storage/processing/events/object-processed.event';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeEvent(storageObjectId = 'storage-obj-1'): ObjectProcessedEvent {
  return { storageObjectId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SimilarityEnqueueListener', () => {
  let listener: SimilarityEnqueueListener;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let originalEnvValue: string | undefined;

  beforeEach(async () => {
    originalEnvValue = process.env['VISUAL_DEDUP_ENABLED'];
    delete process.env['VISUAL_DEDUP_ENABLED']; // default: enabled

    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { enqueue: jest.fn() };

    mockEnrichmentJobService.enqueue.mockResolvedValue({
      id: 'job-1',
      mediaItemId: 'media-1',
      circleId: 'circle-1',
      status: JobStatus.pending,
      reason: JobReason.upload,
      attempts: 0,
    });

    // Default: circle has visualDedupEnabled=true
    (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimilarityEnqueueListener,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    listener = module.get<SimilarityEnqueueListener>(SimilarityEnqueueListener);
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env['VISUAL_DEDUP_ENABLED'];
    } else {
      process.env['VISUAL_DEDUP_ENABLED'] = originalEnvValue;
    }
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('photo media item with circle opt-in', () => {
    it('calls enrichmentJobService.enqueue with correct type, reason, and priority', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'similarity_detection',
          mediaItemId: 'media-1',
          circleId: 'circle-1',
          reason: JobReason.upload,
          priority: 10,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Type guard: video
  // -------------------------------------------------------------------------

  describe('non-photo media type', () => {
    it('does NOT enqueue for video', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MediaType.video }),
      );

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Soft-deleted mediaItem
  // -------------------------------------------------------------------------

  describe('soft-deleted mediaItem', () => {
    it('does NOT enqueue when mediaItem has deletedAt set', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No mediaItem
  // -------------------------------------------------------------------------

  describe('no mediaItem', () => {
    it('does NOT enqueue when no mediaItem found for storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // VISUAL_DEDUP_ENABLED global kill-switch
  // -------------------------------------------------------------------------

  describe('VISUAL_DEDUP_ENABLED=false global kill-switch', () => {
    it('does NOT enqueue when global kill-switch is disabled', async () => {
      process.env['VISUAL_DEDUP_ENABLED'] = 'false';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('DOES enqueue when VISUAL_DEDUP_ENABLED is explicitly true', async () => {
      process.env['VISUAL_DEDUP_ENABLED'] = 'true';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('DOES enqueue when VISUAL_DEDUP_ENABLED is unset (default enabled)', async () => {
      delete process.env['VISUAL_DEDUP_ENABLED'];
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Per-circle opt-in gate
  // -------------------------------------------------------------------------

  describe('per-circle visualDedupEnabled gate', () => {
    it('does NOT enqueue when circle.visualDedupEnabled=false', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: false });

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when circle is null', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('DOES enqueue when circle.visualDedupEnabled=true', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling: swallowed exceptions
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('does NOT rethrow errors — swallows to avoid blocking event emission', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(listener.handleObjectProcessed(makeEvent())).resolves.toBeUndefined();
    });

    it('still returns undefined when enqueue throws', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('queue full'));

      await expect(listener.handleObjectProcessed(makeEvent())).resolves.toBeUndefined();
    });
  });
});
