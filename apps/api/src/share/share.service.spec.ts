/**
 * Unit tests for ShareService.
 *
 * Covers:
 *   - createShare: XOR validation, circleId resolution, assertCircleAccess call,
 *     idempotency (existing active share), token format.
 *   - resolvePublicShare: missing / revoked / expired → NotFoundException;
 *     media_item with deletedAt → NotFoundException; archived item (archivedAt
 *     set, deletedAt null) → resolves OK; album filters deleted members.
 *   - computeStatus (via createShare / resolvePublicShare flows): active /
 *     expired / revoked.
 *   - bulkAction: caller-owned scoping vs manage_any, affected count.
 *
 * No database required — PrismaService, CircleMembershipService,
 * MediaThumbnailService, ConfigService are all mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShareTargetType } from '@prisma/client';
import { ShareService } from './share.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const USER_ID = randomUUID();
const CIRCLE_ID = randomUUID();
const MEDIA_ITEM_ID = randomUUID();
const ALBUM_ID = randomUUID();
const SHARE_ID = randomUUID();
const SHARE_TOKEN = 'validtoken123_abcdefghijklmnopqrstuvwxyz_ABCDEF';

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    token: SHARE_TOKEN,
    targetType: ShareTargetType.media_item,
    mediaItemId: MEDIA_ITEM_ID,
    albumId: null,
    circleId: CIRCLE_ID,
    createdById: USER_ID,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ITEM_ID,
    circleId: CIRCLE_ID,
    type: 'photo',
    width: 1920,
    height: 1080,
    deletedAt: null,
    archivedAt: null,
    storageObject: {
      storageKey: 'uploads/photo.jpg',
      storageProvider: 's3',
      bucket: 'test-bucket',
      mimeType: 'image/jpeg',
    },
    ...overrides,
  };
}

function makeAlbum(overrides: Record<string, unknown> = {}) {
  return {
    id: ALBUM_ID,
    circleId: CIRCLE_ID,
    name: 'Test Album',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShareService', () => {
  let service: ShareService;
  let mockPrisma: MockPrismaService;
  let mockCircleMembership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>>;
  let mockThumbnailService: jest.Mocked<Pick<MediaThumbnailService, 'signThumb'>>;
  let mockConfigService: jest.Mocked<Pick<ConfigService, 'get'>>;

  const noPermissions: string[] = [];
  const managerPermissions: string[] = [PERMISSIONS.SHARES_MANAGE];
  const adminPermissions: string[] = [PERMISSIONS.SHARES_MANAGE, PERMISSIONS.SHARES_MANAGE_ANY];

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockCircleMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };

    mockThumbnailService = {
      signThumb: jest.fn().mockResolvedValue('https://cdn.example.com/thumb.jpg'),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue('http://localhost:3535'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembership },
        { provide: MediaThumbnailService, useValue: mockThumbnailService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ShareService>(ShareService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // createShare — XOR validation
  // =========================================================================

  describe('createShare — XOR validation', () => {
    it('throws BadRequest when targetType=media_item but mediaItemId is missing', async () => {
      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.media_item,
          // mediaItemId omitted
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequest when targetType=media_item and albumId is also provided', async () => {
      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.media_item,
          mediaItemId: MEDIA_ITEM_ID,
          albumId: ALBUM_ID,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequest when targetType=album but albumId is missing', async () => {
      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.album,
          // albumId omitted
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequest when targetType=album and mediaItemId is also provided', async () => {
      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.album,
          albumId: ALBUM_ID,
          mediaItemId: MEDIA_ITEM_ID,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // createShare — target resolution and access check
  // =========================================================================

  describe('createShare — target resolution and assertCircleAccess', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(makeShare());
    });

    it('resolves circleId from mediaItem and calls assertCircleAccess with collaborator', async () => {
      await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith({
        where: { id: MEDIA_ITEM_ID },
        select: { circleId: true, deletedAt: true },
      });

      expect(mockCircleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        managerPermissions,
        'collaborator',
      );
    });

    it('resolves circleId from album and calls assertCircleAccess with collaborator', async () => {
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(makeAlbum());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(makeShare({ targetType: ShareTargetType.album, mediaItemId: null, albumId: ALBUM_ID }));

      await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.album,
        albumId: ALBUM_ID,
      });

      expect(mockPrisma.album.findUnique).toHaveBeenCalledWith({
        where: { id: ALBUM_ID },
        select: { circleId: true },
      });

      expect(mockCircleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        managerPermissions,
        'collaborator',
      );
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.media_item,
          mediaItemId: MEDIA_ITEM_ID,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when trying to share a trashed media item', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.media_item,
          mediaItemId: MEDIA_ITEM_ID,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when album does not exist', async () => {
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createShare(USER_ID, managerPermissions, {
          targetType: ShareTargetType.album,
          albumId: ALBUM_ID,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // createShare — idempotency
  // =========================================================================

  describe('createShare — idempotency', () => {
    it('returns the existing active share without creating a new one', async () => {
      const existing = makeShare({ id: 'existing-share-id', token: 'old-token' });
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(mockPrisma.mediaShare.create).not.toHaveBeenCalled();
      expect(result.id).toBe('existing-share-id');
      expect(result.token).toBe('old-token');
    });

    it('creates a new share when no active share exists', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(makeShare());

      await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(mockPrisma.mediaShare.create).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // createShare — token format
  // =========================================================================

  describe('createShare — token format', () => {
    it('generates a base64url token of the expected length (43 chars for 32 bytes)', async () => {
      let capturedToken: string | undefined;

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.mediaShare.create as jest.Mock).mockImplementation(async ({ data }: any) => {
        capturedToken = data.token;
        return makeShare({ token: data.token });
      });

      await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(capturedToken).toBeDefined();
      // base64url of 32 bytes = 43 chars (no padding '=')
      expect(capturedToken!.length).toBe(43);
      // Only base64url characters: A-Z a-z 0-9 - _
      expect(capturedToken).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('generates a different token each call (no reuse)', async () => {
      const tokens: string[] = [];
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.mediaShare.create as jest.Mock).mockImplementation(async ({ data }: any) => {
        tokens.push(data.token);
        return makeShare({ token: data.token });
      });

      // Call twice; findFirst returns null each time to bypass idempotency
      await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });
      await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(tokens).toHaveLength(2);
      expect(tokens[0]).not.toBe(tokens[1]);
    });
  });

  // =========================================================================
  // resolvePublicShare — invalid token cases
  // =========================================================================

  describe('resolvePublicShare — invalid/expired/revoked', () => {
    it('throws NotFoundException for an unknown token', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resolvePublicShare('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when share is revoked (revokedAt is set)', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ revokedAt: new Date('2026-01-01T00:00:00Z') }),
      );

      await expect(service.resolvePublicShare(SHARE_TOKEN)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when share has expired (expiresAt in the past)', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ expiresAt: new Date(Date.now() - 60_000) }),
      );

      await expect(service.resolvePublicShare(SHARE_TOKEN)).rejects.toThrow(NotFoundException);
    });

    it('resolves successfully when expiresAt is in the future', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ expiresAt: new Date(Date.now() + 60_000) }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      const result = await service.resolvePublicShare(SHARE_TOKEN);
      expect(result.share.token).toBe(SHARE_TOKEN);
    });
  });

  // =========================================================================
  // resolvePublicShare — media_item share scenarios
  // =========================================================================

  describe('resolvePublicShare — media_item', () => {
    beforeEach(() => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(makeShare());
    });

    it('throws NotFoundException when the media item is trashed (deletedAt set)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(service.resolvePublicShare(SHARE_TOKEN)).rejects.toThrow(NotFoundException);
    });

    it('resolves successfully when the media item is archived (archivedAt set, deletedAt null)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ archivedAt: new Date(), deletedAt: null }),
      );

      const result = await service.resolvePublicShare(SHARE_TOKEN);

      expect(result.mediaItem).toBeDefined();
      expect(result.mediaItem!.type).toBe('photo');
    });

    it('resolves with correct storageObject fields', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      const result = await service.resolvePublicShare(SHARE_TOKEN);

      expect(result.mediaItem!.storageObject).toMatchObject({
        storageKey: 'uploads/photo.jpg',
        storageProvider: 's3',
        bucket: 'test-bucket',
        mimeType: 'image/jpeg',
      });
    });

    it('throws NotFoundException when media item does not exist at all', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resolvePublicShare(SHARE_TOKEN)).rejects.toThrow(NotFoundException);
    });

    it('does not expose description, tags, faces, camera or geo fields', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

      const result = await service.resolvePublicShare(SHARE_TOKEN);
      const itemKeys = Object.keys(result.mediaItem ?? {});

      expect(itemKeys).not.toContain('description');
      expect(itemKeys).not.toContain('tags');
      expect(itemKeys).not.toContain('faces');
      expect(itemKeys).not.toContain('cameraMake');
      expect(itemKeys).not.toContain('cameraModel');
      expect(itemKeys).not.toContain('geoCountry');
      expect(itemKeys).not.toContain('capturedAt');
      expect(itemKeys).not.toContain('originalFilename');
    });
  });

  // =========================================================================
  // resolvePublicShare — album share scenarios
  // =========================================================================

  describe('resolvePublicShare — album', () => {
    const ALBUM_ITEM_1_ID = randomUUID();
    const ALBUM_ITEM_2_ID = randomUUID();

    function makeAlbumResolved(items: any[]) {
      return { items };
    }

    function makeAlbumShareItem(mediaItem: any) {
      return { mediaItem };
    }

    beforeEach(() => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ targetType: ShareTargetType.album, mediaItemId: null, albumId: ALBUM_ID }),
      );
    });

    it('returns album items excluding deleted members', async () => {
      const liveItem = {
        id: ALBUM_ITEM_1_ID,
        type: 'photo',
        width: 800,
        height: 600,
        metadata: null,
        storageObject: {
          storageKey: 'uploads/photo1.jpg',
          storageProvider: 's3',
          bucket: 'test-bucket',
          mimeType: 'image/jpeg',
        },
      };
      // The deleted item is pre-filtered at the DB level via the where clause
      // in the Prisma query (where: { mediaItem: { deletedAt: null } })
      // so we model that by returning only the live item.
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(
        makeAlbumResolved([makeAlbumShareItem(liveItem)]),
      );

      const result = await service.resolvePublicShare(SHARE_TOKEN);

      expect(result.albumItems).toHaveLength(1);
      expect(result.albumItems![0].mediaItemId).toBe(ALBUM_ITEM_1_ID);
    });

    it('returns empty albumItems array when all album members are deleted', async () => {
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(
        makeAlbumResolved([]),
      );

      const result = await service.resolvePublicShare(SHARE_TOKEN);

      expect(result.albumItems).toHaveLength(0);
    });

    it('throws NotFoundException when album does not exist', async () => {
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resolvePublicShare(SHARE_TOKEN)).rejects.toThrow(NotFoundException);
    });

    it('extracts thumbnailStorageKey from item metadata', async () => {
      const itemWithThumb = {
        id: ALBUM_ITEM_2_ID,
        type: 'photo',
        width: 400,
        height: 300,
        metadata: { thumbnailStorageKey: 'thumbs/thumb1.jpg' },
        storageObject: {
          storageKey: 'uploads/photo2.jpg',
          storageProvider: 's3',
          bucket: 'test-bucket',
          mimeType: 'image/jpeg',
        },
      };
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(
        makeAlbumResolved([makeAlbumShareItem(itemWithThumb)]),
      );

      const result = await service.resolvePublicShare(SHARE_TOKEN);

      expect(result.albumItems![0].thumbnailStorageKey).toBe('thumbs/thumb1.jpg');
    });

    it('sets thumbnailStorageKey to null when metadata has no thumbnailStorageKey', async () => {
      const itemNoThumb = {
        id: ALBUM_ITEM_1_ID,
        type: 'photo',
        width: 400,
        height: 300,
        metadata: null,
        storageObject: {
          storageKey: 'uploads/photo3.jpg',
          storageProvider: 's3',
          bucket: 'test-bucket',
          mimeType: 'image/jpeg',
        },
      };
      (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue(
        makeAlbumResolved([makeAlbumShareItem(itemNoThumb)]),
      );

      const result = await service.resolvePublicShare(SHARE_TOKEN);

      expect(result.albumItems![0].thumbnailStorageKey).toBeNull();
    });
  });

  // =========================================================================
  // computeStatus (exercised via toShareWithStatus)
  // =========================================================================

  describe('computeStatus — status derivation', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
    });

    it('returns status=active for a share with no revokedAt and no expiresAt', async () => {
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(makeShare());

      const result = await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(result.status).toBe('active');
    });

    it('returns status=active for a share with expiresAt in the future', async () => {
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(
        makeShare({ expiresAt: new Date(Date.now() + 3600_000) }),
      );

      const result = await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(result.status).toBe('active');
    });

    it('returns status=expired for a share with expiresAt in the past', async () => {
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(
        makeShare({ expiresAt: new Date(Date.now() - 3600_000) }),
      );

      const result = await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(result.status).toBe('expired');
    });

    it('returns status=revoked for a share with revokedAt set (even if not expired)', async () => {
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(
        makeShare({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }),
      );

      const result = await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(result.status).toBe('revoked');
    });
  });

  // =========================================================================
  // bulkAction — scoping and affected count
  // =========================================================================

  describe('bulkAction', () => {
    const shareId1 = randomUUID();
    const shareId2 = randomUUID();
    const shareId3 = randomUUID();

    it('scopes revoke to caller-owned shares when user lacks manage_any', async () => {
      (mockPrisma.mediaShare.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.bulkAction(USER_ID, managerPermissions, {
        ids: [shareId1, shareId2],
        action: 'revoke',
      });

      expect(mockPrisma.mediaShare.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdById: USER_ID }),
        }),
      );
      expect(result.affected).toBe(1);
    });

    it('does NOT scope to caller when user has manage_any permission', async () => {
      (mockPrisma.mediaShare.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      const result = await service.bulkAction(USER_ID, adminPermissions, {
        ids: [shareId1, shareId2, shareId3],
        action: 'revoke',
      });

      // createdById should NOT be in the where clause for admin
      const calledWhere = (mockPrisma.mediaShare.updateMany as jest.Mock).mock.calls[0][0].where;
      expect(calledWhere).not.toHaveProperty('createdById');
      expect(result.affected).toBe(3);
    });

    it('returns affected=0 when none of the ids belong to caller (non-admin)', async () => {
      (mockPrisma.mediaShare.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.bulkAction(USER_ID, managerPermissions, {
        ids: [shareId1],
        action: 'revoke',
      });

      expect(result.affected).toBe(0);
    });

    it('calls updateMany for revoke action and sets revokedAt', async () => {
      (mockPrisma.mediaShare.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.bulkAction(USER_ID, managerPermissions, {
        ids: [shareId1, shareId2],
        action: 'revoke',
      });

      const call = (mockPrisma.mediaShare.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.data.revokedAt).toBeInstanceOf(Date);
    });

    it('calls updateMany for set_expiration and sets expiresAt', async () => {
      const newExpiry = new Date(Date.now() + 86400_000).toISOString();
      (mockPrisma.mediaShare.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.bulkAction(USER_ID, managerPermissions, {
        ids: [shareId1],
        action: 'set_expiration',
        expiresAt: newExpiry,
      });

      const call = (mockPrisma.mediaShare.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.data.expiresAt).toBeInstanceOf(Date);
    });

    it('calls deleteMany for delete action', async () => {
      (mockPrisma.mediaShare.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.bulkAction(USER_ID, managerPermissions, {
        ids: [shareId1, shareId2],
        action: 'delete',
      });

      expect(mockPrisma.mediaShare.deleteMany).toHaveBeenCalledTimes(1);
      expect(result.affected).toBe(2);
    });

    it('throws BadRequestException for an unknown action', async () => {
      await expect(
        service.bulkAction(USER_ID, managerPermissions, {
          ids: [shareId1],
          action: 'unknown_action' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // revokeShare
  // =========================================================================

  describe('revokeShare', () => {
    it('throws NotFoundException when share does not exist', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.revokeShare(USER_ID, managerPermissions, SHARE_ID)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when caller does not own the share and lacks manage_any', async () => {
      const otherUserId = randomUUID();
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ createdById: otherUserId }),
      );

      await expect(service.revokeShare(USER_ID, managerPermissions, SHARE_ID)).rejects.toThrow(ForbiddenException);
    });

    it('allows admin with manage_any to revoke any share', async () => {
      const otherUserId = randomUUID();
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ createdById: otherUserId }),
      );
      (mockPrisma.mediaShare.update as jest.Mock).mockResolvedValue(makeShare({ revokedAt: new Date(), createdById: otherUserId }));

      await expect(service.revokeShare(USER_ID, adminPermissions, SHARE_ID)).resolves.toBeUndefined();
    });

    it('sets revokedAt when share is not already revoked', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(makeShare());
      (mockPrisma.mediaShare.update as jest.Mock).mockResolvedValue(makeShare({ revokedAt: new Date() }));

      await service.revokeShare(USER_ID, managerPermissions, SHARE_ID);

      expect(mockPrisma.mediaShare.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('is idempotent: does not call update when share is already revoked', async () => {
      (mockPrisma.mediaShare.findUnique as jest.Mock).mockResolvedValue(
        makeShare({ revokedAt: new Date() }),
      );

      await service.revokeShare(USER_ID, managerPermissions, SHARE_ID);

      expect(mockPrisma.mediaShare.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // publicUrl shape
  // =========================================================================

  describe('publicUrl', () => {
    it('builds publicUrl using appUrl from ConfigService and the share token', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaShare.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.mediaShare.create as jest.Mock).mockResolvedValue(makeShare({ token: 'my-test-token' }));

      const result = await service.createShare(USER_ID, managerPermissions, {
        targetType: ShareTargetType.media_item,
        mediaItemId: MEDIA_ITEM_ID,
      });

      expect(result.publicUrl).toBe('http://localhost:3535/s/my-test-token');
    });
  });
});
