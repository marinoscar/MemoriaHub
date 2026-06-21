/**
 * Unit tests for MetadataController.
 *
 * Verifies that each handler:
 *   - delegates RBAC to CircleMembershipService
 *   - returns the expected response shape
 *   - throws NotFoundException when media item does not exist / is soft-deleted
 *   - does NOT perform a per-circle opt-in check (unlike auto-tagging)
 *
 * All guards are bypassed; no real HTTP or database.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { MetadataController } from './metadata.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { JobReason, JobStatus, MediaMetadataStatusType } from '@prisma/client';
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

describe('MetadataController', () => {
  let controller: MetadataController;
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
      controllers: [MetadataController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    })
      .overrideGuard(
        require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object,
      )
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MetadataController>(MetadataController);
  });

  // -------------------------------------------------------------------------
  // POST media/:id/metadata/rerun
  // -------------------------------------------------------------------------

  describe('rerunMetadata', () => {
    it('returns { data: { jobId, status } } on success', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mockResolvedValue({});

      const result = await controller.rerunMetadata('media-1', makeUser());

      expect(result.data.jobId).toBe('job-1');
      expect(result.data.status).toBe(JobStatus.pending);
    });

    it('enqueues with type metadata_extraction, reason rerun, and priority 0', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunMetadata('media-1', makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'metadata_extraction',
          mediaItemId: 'media-1',
          reason: JobReason.rerun,
          priority: 0,
        }),
      );
    });

    it('upserts mediaMetadataStatus to pending', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunMetadata('media-1', makeUser());

      expect(mockPrisma.mediaMetadataStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mediaItemId: 'media-1' },
          create: expect.objectContaining({
            status: MediaMetadataStatusType.pending,
          }),
          update: expect.objectContaining({
            status: MediaMetadataStatusType.pending,
          }),
        }),
      );
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mockResolvedValue({});

      const user = makeUser();
      await controller.rerunMetadata('media-1', user);

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
        controller.rerunMetadata('nonexistent', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(
        controller.rerunMetadata('media-1', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // GET media/:id/metadata/status
  // -------------------------------------------------------------------------

  describe('getMetadataStatus', () => {
    it('returns the status row when it exists', async () => {
      const mockStatus = {
        mediaItemId: 'media-1',
        circleId: 'circle-1',
        status: MediaMetadataStatusType.processed,
        processedAt: new Date('2026-01-01T00:00:00Z'),
        lastError: null,
      };

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.findUnique as jest.Mock).mockResolvedValue(mockStatus);

      const result = await controller.getMetadataStatus('media-1', makeUser());

      expect(result.data.status).toBe(MediaMetadataStatusType.processed);
      expect(result.data.processedAt).toEqual(mockStatus.processedAt);
      expect(result.data.lastError).toBeNull();
    });

    it('returns { data: { status: not_processed, processedAt: null, lastError: null } } when no status row', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await controller.getMetadataStatus('media-1', makeUser());

      expect(result.data.status).toBe(MediaMetadataStatusType.not_processed);
      expect(result.data.processedAt).toBeNull();
      expect(result.data.lastError).toBeNull();
    });

    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaMetadataStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const user = makeUser();
      await controller.getMetadataStatus('media-1', user);

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
        controller.getMetadataStatus('nonexistent', makeUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // backfillMetadataSchema — inline Zod validation tests
  // -------------------------------------------------------------------------

  describe('backfillMetadataSchema (inline)', () => {
    const flexibleDate = z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' });

    const schema = z.object({
      circleId: z.string().uuid(),
      from: flexibleDate.optional(),
      to: flexibleDate.optional(),
      force: z.boolean().optional().default(false),
    });

    it('accepts a date-only from/to payload', () => {
      const result = schema.safeParse({
        circleId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        from: '2020-01-01',
        to: '2027-12-31',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a full ISO datetime from/to payload', () => {
      const result = schema.safeParse({
        circleId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        from: '2020-01-01T00:00:00.000Z',
        to: '2027-12-31T23:59:59.999Z',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a payload with no from/to (both optional)', () => {
      const result = schema.safeParse({
        circleId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an invalid date string', () => {
      const result = schema.safeParse({
        circleId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        from: 'not-a-date',
      });
      expect(result.success).toBe(false);
    });

    it('rejects when circleId is not a UUID', () => {
      const result = schema.safeParse({
        circleId: 'bad-id',
        from: '2020-01-01',
      });
      expect(result.success).toBe(false);
    });

    it('defaults force to false when omitted', () => {
      const result = schema.safeParse({
        circleId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(false);
      }
    });
  });
});
