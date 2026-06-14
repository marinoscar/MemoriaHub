import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CircleRole } from '@prisma/client';

import { ObjectsService } from '../../src/storage/objects/objects.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockPrismaService, MockPrismaService } from '../mocks/prisma.mock';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { CircleMembershipService } from '../../src/circles/circle-membership.service';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCLE_1 = 'circle-1-0000-0000-0000-000000000001';
const UPLOADER_ID = 'user-uploader-0000-0000-00000000001';
const OTHER_USER_ID = 'user-other-00000-0000-00000000002';
const MEMBER_ID = 'user-member-0000-0000-00000000003';
const ADMIN_ID = 'user-admin-00000-0000-00000000004';

const ownPerms = [PERMISSIONS.MEDIA_READ, PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE];
const superAdminPerms = [
  ...ownPerms,
  PERMISSIONS.MEDIA_READ_ANY,
  PERMISSIONS.MEDIA_WRITE_ANY,
  PERMISSIONS.MEDIA_DELETE_ANY,
];
const noPerms: string[] = [];

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeStorageObjectWithMedia(overrides: Partial<any> = {}) {
  return {
    id: 'obj-001',
    name: 'photo.jpg',
    size: BigInt(1024000),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready' as const,
    s3UploadId: null,
    uploadedById: UPLOADER_ID,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    mediaItem: {
      id: 'media-001',
      circleId: CIRCLE_1,
    },
    ...overrides,
  };
}

function makeInProgressStorageObject(overrides: Partial<any> = {}) {
  return {
    id: 'obj-in-progress',
    name: 'uploading.jpg',
    size: BigInt(0),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/in-progress.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready' as const, // status check is separate — we test auth here
    s3UploadId: 'upload-abc',
    uploadedById: UPLOADER_ID,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    mediaItem: null, // No linked MediaItem → in-progress upload
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Storage Download Auth Matrix (ObjectsService unit)', () => {
  let service: ObjectsService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockConfig: jest.Mocked<ConfigService>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();
    mockConfig = { get: jest.fn().mockReturnValue(3600) } as any;
    mockEventEmitter = { emit: jest.fn() } as any;
    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'viewer' as CircleRole, isSuperAdmin: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObjectsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
      ],
    }).compile();

    service = module.get<ObjectsService>(ObjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getDownloadUrl — linked MediaItem (circle-scoped)
  // =========================================================================

  describe('getDownloadUrl — object linked to a MediaItem (circle-gated access)', () => {
    it('viewer who is a circle member can download a blob they did NOT upload', async () => {
      const storageObject = makeStorageObjectWithMedia({ uploadedById: UPLOADER_ID });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      // Member → assertCircleAccess resolves with viewer role
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: 'viewer' as CircleRole,
        isSuperAdmin: false,
      });

      const result = await service.getDownloadUrl('obj-001', MEMBER_ID, undefined, ownPerms);

      expect(result.url).toBe('https://mock-presigned-url.com/download');
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        MEMBER_ID,
        CIRCLE_1,
        ownPerms,
        'viewer',
      );
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        storageObject.storageKey,
        expect.objectContaining({ expiresIn: expect.any(Number) }),
      );
    });

    it('non-member gets ForbiddenException when downloading a circle-linked object', async () => {
      const storageObject = makeStorageObjectWithMedia();
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('You are not a member of this circle'),
      );

      await expect(
        service.getDownloadUrl('obj-001', 'non-member', undefined, noPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('assertCircleAccess is called with the mediaItem circleId, not the upload owner', async () => {
      const storageObject = makeStorageObjectWithMedia({
        uploadedById: UPLOADER_ID,
        mediaItem: { id: 'media-001', circleId: CIRCLE_1 },
      });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);

      await service.getDownloadUrl('obj-001', MEMBER_ID, undefined, ownPerms);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        MEMBER_ID,
        CIRCLE_1,         // circle from the MediaItem, not the uploader
        ownPerms,
        'viewer',
      );
    });
  });

  // =========================================================================
  // getDownloadUrl — in-progress upload (no MediaItem → owner-only)
  // =========================================================================

  describe('getDownloadUrl — in-progress upload (no linked MediaItem)', () => {
    it('uploader (owner) can access their own in-progress upload', async () => {
      const storageObject = makeInProgressStorageObject({ uploadedById: UPLOADER_ID });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      // Circle membership service is NOT called for in-progress uploads

      const result = await service.getDownloadUrl('obj-in-progress', UPLOADER_ID, undefined, ownPerms);

      expect(result.url).toBe('https://mock-presigned-url.com/download');
      // assertCircleAccess must NOT be called — no circle context for in-progress uploads
      expect(mockCircleMembershipService.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('non-owner gets ForbiddenException for an in-progress upload', async () => {
      const storageObject = makeInProgressStorageObject({ uploadedById: UPLOADER_ID });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);

      await expect(
        service.getDownloadUrl('obj-in-progress', OTHER_USER_ID, undefined, ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockCircleMembershipService.assertCircleAccess).not.toHaveBeenCalled();
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getDownloadUrl — super-admin bypasses circle membership
  // =========================================================================

  describe('getDownloadUrl — super-admin can download any object', () => {
    it('super-admin with media:read_any can download from any circle without membership', async () => {
      const storageObject = makeStorageObjectWithMedia();
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: null,
        isSuperAdmin: true,
      });

      const result = await service.getDownloadUrl('obj-001', ADMIN_ID, undefined, superAdminPerms);

      expect(result.url).toBe('https://mock-presigned-url.com/download');
      // assertCircleAccess is still called (service delegates to it; the mock returns isSuperAdmin: true)
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        ADMIN_ID,
        CIRCLE_1,
        superAdminPerms,
        'viewer',
      );
    });
  });

  // =========================================================================
  // Object not found
  // =========================================================================

  describe('getDownloadUrl — object not found', () => {
    it('throws NotFoundException when object does not exist', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.getDownloadUrl('nonexistent-id', UPLOADER_ID, undefined, ownPerms),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // delete — circle member / non-member
  // =========================================================================

  describe('delete — access control', () => {
    it('circle collaborator can delete a circle-linked object', async () => {
      const storageObject = makeStorageObjectWithMedia();
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: 'collaborator' as CircleRole,
        isSuperAdmin: false,
      });
      mockPrisma.storageObject.delete.mockResolvedValue(storageObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await expect(service.delete('obj-001', MEMBER_ID, ownPerms)).resolves.toBeUndefined();

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(storageObject.storageKey);
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({ where: { id: 'obj-001' } });
    });

    it('non-member gets ForbiddenException when deleting a circle-linked object', async () => {
      const storageObject = makeStorageObjectWithMedia();
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('You are not a member of this circle'),
      );

      await expect(service.delete('obj-001', 'non-member', noPerms)).rejects.toThrow(ForbiddenException);

      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.delete).not.toHaveBeenCalled();
    });

    it('viewer (rank below collaborator) is denied delete on circle-linked object', async () => {
      const storageObject = makeStorageObjectWithMedia();
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('This action requires collaborator role or higher'),
      );

      await expect(service.delete('obj-001', MEMBER_ID, ownPerms)).rejects.toThrow(ForbiddenException);
    });

    it('non-owner gets ForbiddenException when deleting an in-progress upload', async () => {
      const storageObject = makeInProgressStorageObject({ uploadedById: UPLOADER_ID });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);

      await expect(service.delete('obj-in-progress', OTHER_USER_ID, ownPerms)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
