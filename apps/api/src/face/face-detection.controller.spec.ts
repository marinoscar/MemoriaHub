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
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { FaceDetectionController } from './face-detection.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { JobReason, JobStatus, MediaFaceStatusType, MediaType } from '@prisma/client';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCircleMembershipService = {
  assertCircleAccess: jest.fn(),
};

const mockEnrichmentJobService = {
  enqueue: jest.fn(),
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

    // Default: enqueue returns a minimal job
    mockEnrichmentJobService.enqueue.mockResolvedValue({
      id: 'job-1',
      status: JobStatus.pending,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FaceDetectionController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
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
    it('enqueues a job and returns { data: { jobId, status } }', async () => {
      const mockJob = {
        id: 'job-1',
        status: JobStatus.pending,
      };

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      mockEnrichmentJobService.enqueue.mockResolvedValue(mockJob);
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.rerunFaceDetection('media-1', makeUser());

      expect(result.data.jobId).toBe('job-1');
      expect(result.data.status).toBe(JobStatus.pending);
    });

    it('calls enrichmentJobService.enqueue with reason: rerun and type: face_detection', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', status: JobStatus.pending });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunFaceDetection('media-1', makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'face_detection',
          mediaItemId: 'media-1',
          reason: JobReason.rerun,
        }),
      );
    });

    it('calls circleMembershipService.assertCircleAccess with collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', status: JobStatus.pending });
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
      mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', status: JobStatus.pending });
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
    beforeEach(() => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
    });

    it('returns { data: { queued: N } } for N media items found', async () => {
      const mediaItems = [
        { id: 'media-1', circleId: 'circle-1' },
        { id: 'media-2', circleId: 'circle-1' },
      ];

      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', status: JobStatus.pending });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.backfillFaceDetection(
        { circleId: 'circle-1' },
        makeUser(),
      );

      expect(result.data.queued).toBe(2);
    });

    it('returns { data: { queued: 0 } } when no media items need processing', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      const result = await controller.backfillFaceDetection(
        { circleId: 'circle-1' },
        makeUser(),
      );

      expect(result.data.queued).toBe(0);
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('calls enrichmentJobService.enqueue with backfill reason for each item', async () => {
      const mediaItems = [{ id: 'media-1', circleId: 'circle-1' }];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', status: JobStatus.pending });
      (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.backfillFaceDetection({ circleId: 'circle-1' }, makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'face_detection',
          mediaItemId: 'media-1',
          reason: JobReason.backfill,
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

  // -------------------------------------------------------------------------
  // DELETE face/biometrics
  // -------------------------------------------------------------------------

  describe('deleteAllBiometrics', () => {
    it('throws BadRequestException when circleId query param is empty string', async () => {
      await expect(controller.deleteAllBiometrics('', makeUser())).rejects.toThrow(BadRequestException);
    });

    it('calls circleMembershipService.assertCircleAccess with circle_admin role', async () => {
      const user = makeUser({ permissions: ['face_settings:write'] });
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(5);
        (mockPrisma.person.count as jest.Mock).mockResolvedValue(2);
        (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });
        (mockPrisma.person.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
        (mockPrisma.enrichmentJob.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.mediaFaceStatus.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });
        (mockPrisma.circle.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await controller.deleteAllBiometrics('circle-1', user);
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id, 'circle-1', user.permissions, 'circle_admin'
      );
    });

    it('deletes faces, people, enrichment jobs, and MediaFaceStatus inside a transaction', async () => {
      const user = makeUser();
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(5);
        (mockPrisma.person.count as jest.Mock).mockResolvedValue(2);
        (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });
        (mockPrisma.person.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
        (mockPrisma.enrichmentJob.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
        (mockPrisma.mediaFaceStatus.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });
        (mockPrisma.circle.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await controller.deleteAllBiometrics('circle-1', user);
      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({ where: { circleId: 'circle-1' } });
      expect(mockPrisma.person.deleteMany).toHaveBeenCalledWith({ where: { circleId: 'circle-1' } });
      expect(mockPrisma.enrichmentJob.deleteMany).toHaveBeenCalledWith({
        where: { circleId: 'circle-1', type: 'face_detection' },
      });
    });

    it('sets faceRecognitionEnabled=false on the circle', async () => {
      const user = makeUser();
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.enrichmentJob.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.mediaFaceStatus.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.circle.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await controller.deleteAllBiometrics('circle-1', user);
      expect(mockPrisma.circle.update).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
        data: { faceRecognitionEnabled: false },
      });
    });

    it('writes a face:biometrics_delete audit event', async () => {
      const user = makeUser();
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(3);
        (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);
        (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });
        (mockPrisma.person.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
        (mockPrisma.enrichmentJob.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.mediaFaceStatus.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });
        (mockPrisma.circle.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await controller.deleteAllBiometrics('circle-1', user);
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'face:biometrics_delete', targetId: 'circle-1' }),
        }),
      );
    });

    it('returns { data: { deletedFaces, deletedPeople } }', async () => {
      const user = makeUser();
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(7);
        (mockPrisma.person.count as jest.Mock).mockResolvedValue(3);
        (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: 7 });
        (mockPrisma.person.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });
        (mockPrisma.enrichmentJob.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.mediaFaceStatus.deleteMany as jest.Mock).mockResolvedValue({ count: 7 });
        (mockPrisma.circle.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      const result = await controller.deleteAllBiometrics('circle-1', user);
      expect(result).toEqual({ data: { deletedFaces: 7, deletedPeople: 3 } });
    });
  });

  // -------------------------------------------------------------------------
  // backfillFaceDetection — opt-in gate
  // -------------------------------------------------------------------------

  describe('backfillFaceDetection — opt-in gate', () => {
    it('throws NotFoundException when circle does not exist', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        controller.backfillFaceDetection({ circleId: 'circle-1' }, makeUser())
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when circle faceRecognitionEnabled is false', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: false });
      await expect(
        controller.backfillFaceDetection({ circleId: 'circle-1' }, makeUser())
      ).rejects.toThrow(BadRequestException);
    });

    it('proceeds when circle faceRecognitionEnabled is true', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
      const result = await controller.backfillFaceDetection({ circleId: 'circle-1' }, makeUser());
      expect(result.data.queued).toBe(0);
    });
  });
});
