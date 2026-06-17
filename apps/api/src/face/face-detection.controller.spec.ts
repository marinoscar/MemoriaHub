/**
 * Unit tests for FaceDetectionController.
 *
 * Verifies that each handler:
 *   - delegates RBAC enforcement to CircleMembershipService
 *   - returns the expected response shape
 *   - throws NotFoundException when the mediaItem does not exist
 *
 * All guards are overridden with canActivate: () => true.
 * No real HTTP or database.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { FaceDetectionController } from './face-detection.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { FaceJobReason, FaceJobStatus, MediaFaceStatusType, MediaType } from '@prisma/client';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCircleMembershipService = {
  assertCircleAccess: jest.fn(),
};

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

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  deletedAt: Date | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceDetectionController', () => {
  let controller: FaceDetectionController;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    // Default: assertCircleAccess resolves (access granted)
    mockCircleMembershipService.assertCircleAccess.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FaceDetectionController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
      ],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<FaceDetectionController>(FaceDetectionController);
  });

  // -------------------------------------------------------------------------
  // GET media/:id/faces
  // -------------------------------------------------------------------------

  describe('listFaces', () => {
    it('returns faces array when mediaItem exists and user has access', async () => {
      const mockFaces = [
        {
          id: 'face-1',
          boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          confidence: 0.9,
          landmarks: null,
          externalFaceId: null,
          providerKey: 'compreface',
          modelVersion: 'arcface-r100-v1',
          manuallyAssigned: false,
          personId: null,
          createdAt: new Date(),
        },
      ];

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue(mockFaces);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result).toEqual({ data: mockFaces });
    });

    it('calls circleMembershipService.assertCircleAccess with viewer role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      const user = makeUser();
      await controller.listFaces('media-1', user);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'viewer',
      );
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.listFaces('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(controller.listFaces('media-1', makeUser())).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // GET media/:id/faces/status
  // -------------------------------------------------------------------------

  describe('getFaceStatus', () => {
    it('returns status from DB when record exists', async () => {
      const mockStatus = {
        status: MediaFaceStatusType.processed,
        faceCount: 2,
        providerKey: 'compreface',
        modelVersion: 'arcface-r100-v1',
        processedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      };

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaFaceStatus.findUnique as jest.Mock).mockResolvedValue(mockStatus);

      const result = await controller.getFaceStatus('media-1', makeUser());

      expect(result).toEqual({ data: mockStatus });
    });

    it('returns default not_processed shape when no status row exists', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaFaceStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await controller.getFaceStatus('media-1', makeUser());

      expect(result.data.status).toBe(MediaFaceStatusType.not_processed);
      expect(result.data.faceCount).toBe(0);
      expect(result.data.providerKey).toBeNull();
      expect(result.data.modelVersion).toBeNull();
      expect(result.data.processedAt).toBeNull();
      expect(result.data.lastError).toBeNull();
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.getFaceStatus('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // POST media/:id/faces/rerun
  // -------------------------------------------------------------------------

  describe('rerunFaceDetection', () => {
    it('creates a FaceJob and returns { jobId, status }', async () => {
      const mockJob = {
        id: 'job-1',
        status: FaceJobStatus.pending,
      };

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.faceJob.create as jest.Mock).mockResolvedValue(mockJob);
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.rerunFaceDetection('media-1', makeUser());

      expect(result.data.jobId).toBe('job-1');
      expect(result.data.status).toBe(FaceJobStatus.pending);
    });

    it('creates FaceJob with reason: rerun', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.faceJob.create as jest.Mock).mockResolvedValue({ id: 'job-1', status: FaceJobStatus.pending });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunFaceDetection('media-1', makeUser());

      expect(mockPrisma.faceJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: FaceJobReason.rerun,
            status: FaceJobStatus.pending,
            attempts: 0,
          }),
        }),
      );
    });

    it('calls circleMembershipService.assertCircleAccess with collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.faceJob.create as jest.Mock).mockResolvedValue({ id: 'job-1', status: FaceJobStatus.pending });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      const user = makeUser();
      await controller.rerunFaceDetection('media-1', user);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'collaborator',
      );
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.rerunFaceDetection('nonexistent', makeUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('upserts MediaFaceStatus to pending on rerun', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.faceJob.create as jest.Mock).mockResolvedValue({ id: 'job-1', status: FaceJobStatus.pending });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunFaceDetection('media-1', makeUser());

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: 'media-1' },
          create: expect.objectContaining({ status: MediaFaceStatusType.pending }),
          update: expect.objectContaining({ status: MediaFaceStatusType.pending }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // POST face/backfill
  // -------------------------------------------------------------------------

  describe('backfillFaceDetection', () => {
    it('returns { queued: N } for N media items found', async () => {
      const mediaItems = [
        { id: 'media-1', circleId: 'circle-1' },
        { id: 'media-2', circleId: 'circle-1' },
      ];

      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      (mockPrisma.faceJob.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.backfillFaceDetection(
        { circleId: 'circle-1' },
        makeUser(),
      );

      expect(result.data.queued).toBe(2);
    });

    it('returns { queued: 0 } when no media items need processing', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      const result = await controller.backfillFaceDetection(
        { circleId: 'circle-1' },
        makeUser(),
      );

      expect(result.data.queued).toBe(0);
      expect(mockPrisma.faceJob.createMany).not.toHaveBeenCalled();
    });

    it('calls faceJob.createMany with backfill reason', async () => {
      const mediaItems = [{ id: 'media-1', circleId: 'circle-1' }];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      (mockPrisma.faceJob.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.backfillFaceDetection({ circleId: 'circle-1' }, makeUser());

      expect(mockPrisma.faceJob.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ reason: FaceJobReason.backfill }),
          ]),
        }),
      );
    });

    it('only queries photos with deletedAt=null when force is false (default)', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await controller.backfillFaceDetection({ circleId: 'circle-1' }, makeUser());

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: 'circle-1',
            type: MediaType.photo,
            deletedAt: null,
          }),
        }),
      );
    });
  });
});
