/**
 * Unit tests — MediaOrientationEditService
 *
 * Mirrors the mocking conventions used by media-thumbnail-rerun.controller.spec.ts
 * (CircleMembershipService.assertCircleAccess mock, createMockPrismaService) and
 * media-reprocess.service.spec.ts (StorageProviderResolver.getProviderFor
 * returning a stubbed provider, jest.fn()-based dependency mocks assembled via
 * Test.createTestingModule).
 *
 * `image-orientation.util` is jest.mock()'d wholesale so this suite never
 * touches the real sharp binary — applyOrientationTransform's own behavior is
 * covered separately (with a real sharp round-trip) in
 * image-orientation.util.spec.ts.
 *
 * Covers:
 *  - Happy path: same storage key overwritten, MediaItem updated with
 *    orientation=1 and the swapped width/height, reprocessObjectNow invoked,
 *    and the resolved return shape.
 *  - BadRequestException for non-photo / non-image media items.
 *  - NotFoundException for missing / soft-deleted / storageObject-less items.
 *  - assertCircleAccess called with the 'collaborator' role, and that a
 *    rejection from it propagates without touching storage or Prisma writes.
 *  - Face re-enqueue is best-effort: an EnrichmentJobService.enqueue failure
 *    must not fail editOrientation.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { Readable } from 'stream';

import { MediaOrientationEditService } from './media-orientation-edit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../test/mocks/storage-provider.mock';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { applyOrientationTransform } from '../storage/processing/image-orientation.util';

jest.mock('../storage/processing/image-orientation.util', () => ({
  applyOrientationTransform: jest.fn(),
}));

const mockApplyOrientationTransform = applyOrientationTransform as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    roles: [],
    permissions: ['media:read', 'media:write'],
    isActive: true,
    ...overrides,
  };
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
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockRecoveryService: { reprocessObjectNow: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: unknown) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      if (typeof ops === 'function') return (ops as (tx: unknown) => unknown)(mockPrisma);
      return ops;
    });

    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };

    mockStorageProvider = createMockStorageProvider();
    mockStorageProvider.download.mockResolvedValue(Readable.from([Buffer.from('original-bytes')]));

    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };

    mockRecoveryService = { reprocessObjectNow: jest.fn().mockResolvedValue(undefined) };

    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({ features: { faceRecognition: true } }),
    };

    mockApplyOrientationTransform.mockResolvedValue({
      buffer: Buffer.from('transformed-bytes'),
      width: 200,
      height: 400,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaOrientationEditService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: StorageProcessingRecoveryService, useValue: mockRecoveryService },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<MediaOrientationEditService>(MediaOrientationEditService);
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

      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'test-bucket');
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

    it('calls reprocessObjectNow to regenerate the thumbnail', async () => {
      await service.editOrientation('media-1', 'rotate_right', makeUser());

      expect(mockRecoveryService.reprocessObjectNow).toHaveBeenCalledTimes(1);
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
      expect(mockCircleMembershipService.assertCircleAccess).not.toHaveBeenCalled();
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
      expect(mockCircleMembershipService.assertCircleAccess).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Collaborator role enforcement
  // -------------------------------------------------------------------------

  describe('collaborator role enforcement', () => {
    it('calls assertCircleAccess with the collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.storageObject.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeStorageObject())
        .mockResolvedValueOnce({ status: 'ready' });

      const user = makeUser();
      await service.editOrientation('media-1', 'rotate_right', user);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'collaborator',
      );
    });

    it('propagates the error and performs no downstream writes when assertCircleAccess rejects', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      const accessError = new Error('Forbidden: collaborator role required');
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(accessError);

      await expect(
        service.editOrientation('media-1', 'rotate_right', makeUser()),
      ).rejects.toThrow(accessError);

      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
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
      mockSystemSettings.getSettings.mockResolvedValue({ features: { faceRecognition: false } });

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
