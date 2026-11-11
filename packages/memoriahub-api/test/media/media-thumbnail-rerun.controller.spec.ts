/**
 * Unit tests for MediaThumbnailRerunController.
 *
 * Mirrors metadata.controller.spec.ts's structure:
 *   - delegates RBAC to the access port (collaborator role)
 *   - returns the expected response shape
 *   - throws NotFoundException when the media item / storage object is
 *     missing or the item is soft-deleted
 *
 * No real HTTP or database; the controller is built over the ports.
 */

import { NotFoundException } from '@nestjs/common';
import { MediaThumbnailRerunController } from '../../src/media/index.js';
import type { MemoriahubRequestUser } from '../../src/core/index.js';
import { createMockDb, type MockDb as MockPrismaService } from '../helpers/mock-db.js';

const mockOwnerAccessService = {
  requireOwnerRole: jest.fn(),
};

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
    mockPrisma = createMockDb();
    mockOwnerAccessService.requireOwnerRole.mockResolvedValue(undefined);
    mockReprocessObjectNow = jest.fn().mockResolvedValue(undefined);

    controller = new MediaThumbnailRerunController(
      mockPrisma as never,
      mockOwnerAccessService as never,
      { reprocessNow: mockReprocessObjectNow },
    );
  });

  describe('rerunThumbnail', () => {
    it('calls reprocessNow with the linked storage object', async () => {
      const mediaItem = makeMediaItem();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(mediaItem);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({ status: 'ready' });

      await controller.rerunThumbnail('media-1', makeUser());

      expect(mockReprocessObjectNow).toHaveBeenCalledWith(mediaItem.storageObject);
    });

    it('calls requireOwnerRole with collaborator role', async () => {
      const mediaItem = makeMediaItem();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(mediaItem);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({ status: 'ready' });

      const user = makeUser();
      await controller.rerunThumbnail('media-1', user);

      expect(mockOwnerAccessService.requireOwnerRole).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'editor',
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
