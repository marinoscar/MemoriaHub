/**
 * Unit tests for MediaThumbnailRerunController.
 *
 * Mirrors metadata.controller.spec.ts's structure:
 *   - delegates RBAC to CircleMembershipService (collaborator role)
 *   - returns the expected response shape
 *   - throws NotFoundException when the media item / storage object is
 *     missing or the item is soft-deleted
 *
 * All guards are bypassed; no real HTTP or database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MediaThumbnailRerunController } from './media-thumbnail-rerun.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

const allowAllGuard = { canActivate: () => true };

const mockCircleMembershipService = {
  assertCircleAccess: jest.fn(),
};

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

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  deletedAt: Date | null;
  storageObject: Record<string, unknown> | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    deletedAt: null,
    storageObject: overrides.storageObject !== undefined ? overrides.storageObject : { id: 'obj-1', status: 'ready' },
    ...overrides,
  };
}

describe('MediaThumbnailRerunController', () => {
  let controller: MediaThumbnailRerunController;
  let mockPrisma: MockPrismaService;
  let mockReprocessObjectNow: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();
    mockCircleMembershipService.assertCircleAccess.mockResolvedValue(undefined);
    mockReprocessObjectNow = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaThumbnailRerunController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: StorageProcessingRecoveryService, useValue: { reprocessObjectNow: mockReprocessObjectNow } },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(allowAllGuard)
      .overrideGuard(RolesGuard).useValue(allowAllGuard)
      .overrideGuard(PermissionsGuard).useValue(allowAllGuard)
      .compile();

    controller = module.get<MediaThumbnailRerunController>(MediaThumbnailRerunController);
  });

  describe('rerunThumbnail', () => {
    it('calls reprocessObjectNow with the linked storage object', async () => {
      const mediaItem = makeMediaItem();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(mediaItem);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({ status: 'ready' });

      await controller.rerunThumbnail('media-1', makeUser());

      expect(mockReprocessObjectNow).toHaveBeenCalledWith(mediaItem.storageObject);
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      const mediaItem = makeMediaItem();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(mediaItem);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({ status: 'ready' });

      const user = makeUser();
      await controller.rerunThumbnail('media-1', user);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'collaborator',
      );
    });

    it('returns { data: { status } } reflecting the post-reprocess status', async () => {
      const mediaItem = makeMediaItem();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(mediaItem);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({ status: 'ready' });

      const result = await controller.rerunThumbnail('media-1', makeUser());

      expect(result).toEqual({ data: { status: 'ready' } });
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        controller.rerunThumbnail('nonexistent', makeUser()),
      ).rejects.toThrow(NotFoundException);
      expect(mockReprocessObjectNow).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(
        controller.rerunThumbnail('media-1', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the media item has no linked storage object', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: null }),
      );

      await expect(
        controller.rerunThumbnail('media-1', makeUser()),
      ).rejects.toThrow(NotFoundException);
      expect(mockReprocessObjectNow).not.toHaveBeenCalled();
    });
  });
});
