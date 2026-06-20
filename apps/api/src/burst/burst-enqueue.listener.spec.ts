/**
 * Unit tests for BurstEnqueueListener.
 *
 * Covers:
 *  - Happy path: photo + circle opt-in → enqueue called
 *  - Type guard: video → skip
 *  - Soft-deleted mediaItem → skip
 *  - No mediaItem → skip
 *  - BURST_DETECTION_ENABLED=false → skip all circles
 *  - circle.burstDetectionEnabled=false → skip
 *  - circle is null → skip
 *  - Error inside handler is swallowed (does not rethrow)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BurstEnqueueListener } from './burst-enqueue.listener';
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

describe('BurstEnqueueListener', () => {
  let listener: BurstEnqueueListener;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let originalEnvValue: string | undefined;

  beforeEach(async () => {
    originalEnvValue = process.env['BURST_DETECTION_ENABLED'];
    delete process.env['BURST_DETECTION_ENABLED']; // default: enabled

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

    // Default: circle has burstDetectionEnabled=true
    (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ burstDetectionEnabled: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BurstEnqueueListener,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    listener = module.get<BurstEnqueueListener>(BurstEnqueueListener);
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env['BURST_DETECTION_ENABLED'];
    } else {
      process.env['BURST_DETECTION_ENABLED'] = originalEnvValue;
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
          type: 'burst_detection',
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
  // BURST_DETECTION_ENABLED=false global kill-switch
  // -------------------------------------------------------------------------

  describe('BURST_DETECTION_ENABLED=false', () => {
    it('does NOT enqueue when global kill-switch is disabled', async () => {
      process.env['BURST_DETECTION_ENABLED'] = 'false';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('DOES enqueue when BURST_DETECTION_ENABLED is explicitly true', async () => {
      process.env['BURST_DETECTION_ENABLED'] = 'true';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('DOES enqueue when BURST_DETECTION_ENABLED is unset (default enabled)', async () => {
      delete process.env['BURST_DETECTION_ENABLED'];
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Per-circle opt-in gate
  // -------------------------------------------------------------------------

  describe('per-circle burstDetectionEnabled gate', () => {
    it('does NOT enqueue when circle.burstDetectionEnabled=false', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ burstDetectionEnabled: false });

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when circle is null', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleObjectProcessed(makeEvent());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('DOES enqueue when circle.burstDetectionEnabled=true', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ burstDetectionEnabled: true });

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
