/**
 * Unit tests — MediaOrientationEditService
 *
 * The service is built over the ports: the access port's `requireOwnerRole`, the object-store port's
 * `forLocation` (returning a stubbed provider), the object reprocessor and thumbnail pruner hooks, the jobs port
 * (a facade mock translating the enqueue shape) and the settings port.
 *
 * `@marinoscar/memoriahub-compute/image` is jest.mock()'d wholesale so this suite never touches the real sharp
 * binary — applyOrientationTransform's own behavior is covered separately (with a real sharp round-trip) in the
 * compute package.
 *
 * Covers:
 *  - Happy path: same storage key overwritten, MediaItem updated with orientation=1 and the swapped
 *    width/height, reprocessNow invoked, and the resolved return shape.
 *  - BadRequestException for non-photo / non-image media items.
 *  - NotFoundException for missing / soft-deleted / storageObject-less items.
 *  - requireOwnerRole called with the 'editor' role, and that a rejection from it propagates without touching
 *    storage or Prisma writes.
 *  - Face re-enqueue is best-effort: an enqueue failure must not fail editOrientation.
 *  - Issue #434: the metadata sync is AWAITED inside the request (so the MediaItem points at the new,
 *    content-addressed thumbnail key before the response returns) and the superseded thumbnail is pruned only
 *    afterwards.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { applyOrientationTransform } from '@marinoscar/memoriahub-compute/image';

import { MediaOrientationEditService } from '../../src/media/index.js';
import type { MemoriahubRequestUser } from '../../src/core/index.js';
import { createMockDb, type MockDb as MockPrismaService } from '../helpers/mock-db.js';
import { jobsPortOverFacade } from '../helpers/facade-jobs-port.js';
import { settingsPortFrom } from '../helpers/settings-port.js';

// The media type enum the web app's generated client carried (the package imports no generated client).
const MediaType = { photo: 'photo', video: 'video' } as const;

jest.mock('@marinoscar/memoriahub-compute/image', () => ({
  applyOrientationTransform: jest.fn(),
}));

const mockApplyOrientationTransform = applyOrientationTransform as jest.Mock;

/** The two storage provider calls an orientation edit makes. */
function createMockStorageProvider() {
  return { upload: jest.fn().mockResolvedValue({ key: 'k', bucket: 'b' }), download: jest.fn() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<MemoriahubRequestUser> = {}): MemoriahubRequestUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    roles: [],
    permissions: ['media:read', 'media:write'],
    isActive: true,
    ...overrides,
  } as MemoriahubRequestUser;
}

function makeStorageObject(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'obj-1',
    storageKey: 'originals/circle-1/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    mimeType: 'image/jpeg',
    size: BigInt(2048),
    status: 'ready',
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    deletedAt: null,
    type: MediaType.photo,
    storageObject:
      overrides.storageObject !== undefined
        ? overrides.storageObject
        : makeStorageObject(),
    ...overrides,
  };
}

describe('MediaOrientationEditService', () => {
  let service: MediaOrientationEditService;
  let mockPrisma: MockPrismaService;
  let mockOwnerAccessService: { requireOwnerRole: jest.Mock };
  let mockResolver: { forLocation: jest.Mock };
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockRecoveryService: { reprocessNow: jest.Mock };
  let mockMetadataSync: { syncFromStorageObject: jest.Mock };
  let mockThumbnailPrune: { pruneSupersededThumbnails: jest.Mock };
  /** Records sync-vs-prune ordering (issue #434). */
  let callOrder: string[];
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let settingsDoc: Record<string, unknown>;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = createMockDb();
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: unknown) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      if (typeof ops === 'function') return (ops as (tx: unknown) => unknown)(mockPrisma);
      return ops;
    });

    mockOwnerAccessService = {
      requireOwnerRole: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };

    mockStorageProvider = createMockStorageProvider();
    mockStorageProvider.download.mockResolvedValue(Readable.from([Buffer.from('original-bytes')]));

    mockResolver = { forLocation: jest.fn().mockResolvedValue(mockStorageProvider) };

    callOrder = [];
    mockRecoveryService = {
      reprocessNow: jest.fn().mockImplementation(async () => {
        callOrder.push('reprocess');
        return 'ready';
      }),
    };

    mockMetadataSync = {
      syncFromStorageObject: jest.fn().mockImplementation(async () => {
        callOrder.push('sync');
      }),
    };
    mockThumbnailPrune = {
      pruneSupersededThumbnails: jest.fn().mockImplementation(async () => {
        callOrder.push('prune');
        return 1;
      }),
    };

    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    settingsDoc = { features: { faceRecognition: true } };

    mockApplyOrientationTransform.mockResolvedValue({
      buffer: Buffer.from('transformed-bytes'),
      width: 200,
      height: 400,
    });

    service = new MediaOrientationEditService(
      mockPrisma as never,
      mockOwnerAccessService as never,
      mockResolver as never,
      mockRecoveryService,
      mockMetadataSync as never,
      mockThumbnailPrune,
      jobsPortOverFacade(mockEnrichmentJobService) as never,
      settingsPortFrom(() => settingsDoc) as never,
    );
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path (rotate_right)', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.storageObject.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeStorageObject()) // refreshed lookup before reprocess
        .mockResolvedValueOnce({ status: 'ready' }); // post-reprocess status lookup
    });

    it('uploads the transformed bytes to the SAME storage key (overwrite, not a new key)', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockStorageProvider.upload).toHaveBeenCalledTimes(1);
      const [key, , opts] = mockStorageProvider.upload.mock.calls[0];
      expect(key).toBe('originals/circle-1/photo.jpg');
      expect(opts).toMatchObject({ mimeType: 'image/jpeg' });
    });

    it('downloads original bytes via the resolved per-object provider', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockResolver.forLocation).toHaveBeenCalledWith('s3', 'test-bucket');
      expect(mockStorageProvider.download).toHaveBeenCalledWith(
        'originals/circle-1/photo.jpg',
      );
    });

    it('calls applyOrientationTransform with the downloaded bytes and requested op', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockApplyOrientationTransform).toHaveBeenCalledWith(
        Buffer.from('original-bytes'),
        'rotate_right',
      );
    });

    it('updates the MediaItem with orientation=1 and the swapped width/height from the transform result', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        data: { orientation: 1, width: 200, height: 400 },
      });
    });

    it('updates the StorageObject size/mimeType inside the same $transaction', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: 'obj-1' },
        data: { size: BigInt('transformed-bytes'.length), mimeType: 'image/jpeg' },
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('calls reprocessNow to regenerate the thumbnail', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockRecoveryService.reprocessNow).toHaveBeenCalledTimes(1);
    });

    // -----------------------------------------------------------------------
    // Issue #434 — the rotated photo must not keep its pre-rotation grid tile
    // -----------------------------------------------------------------------

    it('awaits syncFromStorageObject inside the request rather than relying on the fire-and-forget OBJECT_PROCESSED_EVENT listener', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockMetadataSync.syncFromStorageObject).toHaveBeenCalledWith('obj-1');
    });

    it('prunes the superseded thumbnail ONLY AFTER the MediaItem has been repointed at the new key', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockThumbnailPrune.pruneSupersededThumbnails).toHaveBeenCalledWith('obj-1');
      // Order is load-bearing: pruning first would delete bytes a concurrent
      // gallery request could still be signing. And the reprocess (which renders
      // the new content-addressed key) must come first (RETRO-D1b, #567).
      expect(callOrder).toEqual(['reprocess', 'sync', 'prune']);
    });

    it('resolves with { status, width, height } reflecting the post-reprocess status and transform dims', async () => {
      const result = await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(result).toEqual({ status: 'ready', width: 200, height: 400 });
    });
  });

  // -------------------------------------------------------------------------
  // Non-photo rejection
  // -------------------------------------------------------------------------

  describe('non-photo rejection', () => {
    it('throws BadRequestException for a video media item', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({
          type: MediaType.video,
          storageObject: makeStorageObject({ mimeType: 'video/mp4' }),
        }),
      );

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).rejects.toThrow(BadRequestException);

      expect(mockStorageProvider.download).not.toHaveBeenCalled();
      expect(mockApplyOrientationTransform).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the storage object mimeType is not an image type even if MediaType is photo', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({
          storageObject: makeStorageObject({ mimeType: 'application/pdf' }),
        }),
      );

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).rejects.toThrow(BadRequestException);

      expect(mockStorageProvider.upload).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // NotFoundException cases
  // -------------------------------------------------------------------------

  describe('NotFoundException cases', () => {
    it('throws when the media item does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.editOrientation('nonexistent', 'rotate_right', makeUser()),
      ).rejects.toThrow(NotFoundException);
      expect(mockOwnerAccessService.requireOwnerRole).not.toHaveBeenCalled();
    });

    it('throws when the media item is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws when the media item has no associated storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: null }),
      );

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).rejects.toThrow(NotFoundException);
      expect(mockOwnerAccessService.requireOwnerRole).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Collaborator role enforcement
  // -------------------------------------------------------------------------

  describe('collaborator role enforcement', () => {
    it('calls requireOwnerRole with the collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.storageObject.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeStorageObject())
        .mockResolvedValueOnce({ status: 'ready' });

      const user = makeUser();
      await service.editOrientation('media-1', 'rotate_right', user);

      expect(mockOwnerAccessService.requireOwnerRole).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'editor',
      );
    });

    it('propagates the error and performs no downstream writes when requireOwnerRole rejects', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      const accessError = new Error('Forbidden: collaborator role required');
      mockOwnerAccessService.requireOwnerRole.mockRejectedValue(accessError);

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).rejects.toThrow(accessError);

      expect(mockResolver.forLocation).not.toHaveBeenCalled();
      expect(mockStorageProvider.download).not.toHaveBeenCalled();
      expect(mockStorageProvider.upload).not.toHaveBeenCalled();
      expect(mockApplyOrientationTransform).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Best-effort face re-enqueue
  // -------------------------------------------------------------------------

  describe('best-effort face detection re-enqueue', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.storageObject.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeStorageObject())
        .mockResolvedValueOnce({ status: 'ready' });
    });

    it('resolves successfully even when EnrichmentJobService.enqueue throws', async () => {
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('queue unavailable'));

      const result = await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(result).toEqual({ status: 'ready', width: 200, height: 400 });
    });

    it('resolves successfully even when EnrichmentJobService.enqueue rejects and does not throw out of editOrientation', async () => {
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('boom'));

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).resolves.not.toThrow();
    });

    it('does not re-enqueue face detection when features.faceRecognition is off', async () => {
      settingsDoc = { features: { faceRecognition: false } };

      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('re-enqueues face_detection with priority 0 and reason rerun when the feature is on', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'face_detection',
          mediaItemId: 'media-1',
          circleId: 'circle-1',
          reason: 'rerun',
          priority: 0,
        }),
      );
    });
  });
});
