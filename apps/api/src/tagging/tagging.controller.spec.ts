/**
 * Unit tests for TaggingController.
 *
 * Verifies that each handler:
 *   - delegates RBAC to CircleMembershipService
 *   - returns the expected response shape
 *   - throws NotFoundException when media item does not exist / is soft-deleted
 *   - throws BadRequestException for backfill when autoTaggingEnabled=false
 *
 * All guards are bypassed; no real HTTP or database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TaggingController } from './tagging.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import {
  JobReason,
  JobStatus,
  MediaTagStatusType,
  MediaType,
} from '@prisma/client';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// ---------------------------------------------------------------------------
// Shared mock services
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

describe('TaggingController', () => {
  let controller: TaggingController;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    // Default: circle access granted
    mockCircleMembershipService.assertCircleAccess.mockResolvedValue(undefined);

    // Default: enqueue returns a minimal pending job
    mockEnrichmentJobService.enqueue.mockResolvedValue({
      id: 'job-1',
      status: JobStatus.pending,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaggingController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: CircleMembershipService,
          useValue: mockCircleMembershipService,
        },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    })
      .overrideGuard(
        require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object,
      )
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TaggingController>(TaggingController);
  });

  // -------------------------------------------------------------------------
  // POST media/:id/tags/rerun
  // -------------------------------------------------------------------------

  describe('rerunTagging', () => {
    it('returns { data: { jobId, status } } on success', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.rerunTagging('media-1', makeUser());

      expect(result.data.jobId).toBe('job-1');
      expect(result.data.status).toBe(JobStatus.pending);
    });

    it('enqueues with type auto_tagging, reason rerun, and priority 0', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunTagging('media-1', makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: 'media-1',
          reason: JobReason.rerun,
          priority: 0,
        }),
      );
    });

    it('upserts MediaTagStatus to pending', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunTagging('media-1', makeUser());

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: 'media-1' },
          create: expect.objectContaining({
            status: MediaTagStatusType.pending,
          }),
          update: expect.objectContaining({
            status: MediaTagStatusType.pending,
          }),
        }),
      );
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      const user = makeUser();
      await controller.rerunTagging('media-1', user);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'collaborator',
      );
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        controller.rerunTagging('nonexistent', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(
        controller.rerunTagging('media-1', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // GET media/:id/tags/status
  // -------------------------------------------------------------------------

  describe('getTagStatus', () => {
    it('returns the status row when it exists', async () => {
      const mockStatus = {
        mediaItemId: 'media-1',
        circleId: 'circle-1',
        status: MediaTagStatusType.processed,
        tagCount: 3,
        providerKey: 'openai',
        modelVersion: 'gpt-4o',
        processedAt: new Date(),
        lastError: null,
      };

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.findUnique as jest.Mock).mockResolvedValue(
        mockStatus,
      );

      const result = await controller.getTagStatus('media-1', makeUser());

      expect(result).toEqual({ data: mockStatus });
    });

    it('returns default not_processed shape when no status row exists', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await controller.getTagStatus('media-1', makeUser());

      expect(result.data.status).toBe(MediaTagStatusType.not_processed);
      expect(result.data.tagCount).toBe(0);
      expect(result.data.providerKey).toBeNull();
      expect(result.data.modelVersion).toBeNull();
      expect(result.data.processedAt).toBeNull();
      expect(result.data.lastError).toBeNull();
    });

    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const user = makeUser();
      await controller.getTagStatus('media-1', user);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'viewer',
      );
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        controller.getTagStatus('nonexistent', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // POST tagging/backfill
  // -------------------------------------------------------------------------

  describe('backfillTagging', () => {
    beforeEach(() => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({
        autoTaggingEnabled: true,
      });
    });

    it('returns { data: { enqueued: N } } for N items found', async () => {
      const mediaItems = [
        { id: 'media-1', circleId: 'circle-1' },
        { id: 'media-2', circleId: 'circle-1' },
      ];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.backfillTagging(
        { circleId: 'circle-1', force: false } as any,
        makeUser(),
      );

      expect(result.data.enqueued).toBe(2);
    });

    it('returns { data: { enqueued: 0 } } when no items need processing', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      const result = await controller.backfillTagging(
        { circleId: 'circle-1', force: false } as any,
        makeUser(),
      );

      expect(result.data.enqueued).toBe(0);
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues with type auto_tagging, reason backfill, priority 100 per item', async () => {
      const mediaItems = [{ id: 'media-1', circleId: 'circle-1' }];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.backfillTagging(
        { circleId: 'circle-1', force: false } as any,
        makeUser(),
      );

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: 'media-1',
          reason: JobReason.backfill,
          priority: 100,
        }),
      );
    });

    it('throws BadRequestException when circle.autoTaggingEnabled=false', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({
        autoTaggingEnabled: false,
      });

      await expect(
        controller.backfillTagging(
          { circleId: 'circle-1', force: false } as any,
          makeUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when circle does not exist', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        controller.backfillTagging(
          { circleId: 'circle-1', force: false } as any,
          makeUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      const user = makeUser();
      await controller.backfillTagging(
        { circleId: 'circle-1', force: false } as any,
        user,
      );

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'collaborator',
      );
    });

    it('queries only photos with deletedAt=null when force is false', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await controller.backfillTagging(
        { circleId: 'circle-1', force: false } as any,
        makeUser(),
      );

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

    it('upserts MediaTagStatus to pending for each item', async () => {
      const mediaItems = [
        { id: 'media-1', circleId: 'circle-1' },
        { id: 'media-2', circleId: 'circle-1' },
      ];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue(mediaItems);
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.backfillTagging(
        { circleId: 'circle-1', force: false } as any,
        makeUser(),
      );

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(2);
      for (const call of (mockPrisma.mediaTagStatus.upsert as jest.Mock).mock.calls) {
        expect(call[0].create.status).toBe(MediaTagStatusType.pending);
        expect(call[0].update.status).toBe(MediaTagStatusType.pending);
      }
    });
  });
});
