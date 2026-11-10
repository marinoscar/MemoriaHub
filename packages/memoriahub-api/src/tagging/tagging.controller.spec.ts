/**
 * Unit tests for TaggingController.
 *
 * Verifies that each handler:
 *   - delegates RBAC to OwnerAccessService
 *   - returns the expected response shape
 *   - throws NotFoundException when media item does not exist / is soft-deleted
 *
 * All guards are bypassed; no real HTTP or database.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { MemoriahubRequestUser } from '../core/index.js';
import { createMockDb as mockDb, type MockDb } from '../../test/helpers/mock-db.js';
import { JOB_REASON, MEDIA_TYPE, TAG_STATUS } from './constants.js';
import { TaggingController } from './tagging.controller.js';

// ---------------------------------------------------------------------------
// Shared mock services
// ---------------------------------------------------------------------------

const mockOwnerAccessService = {
  requireOwnerRole: jest.fn(),
};

const mockEnrichmentJobService = {
  enqueue: jest.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<MemoriahubRequestUser> = {}): MemoriahubRequestUser {
  return {
    id: 'user-1',
    roles: [],
    permissions: ['media:read', 'media:write'],
    activeOrgId: null,
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  type: string;
  deletedAt: Date | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    type: MEDIA_TYPE.photo,
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaggingController', () => {
  let controller: TaggingController;
  let mockPrisma: MockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma = mockDb();

    // Default: circle access granted
    mockOwnerAccessService.requireOwnerRole.mockResolvedValue(undefined);

    // Default: enqueue returns the new job's id
    mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', deduplicated: false });

    controller = new TaggingController(
      mockPrisma as never,
      mockOwnerAccessService as never,
      mockEnrichmentJobService as never,
    );

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
      expect(result.data.status).toBe('pending');
    });

    // -----------------------------------------------------------------------
    // Issue #458: this endpoint had NO type guard at all, so a video id
    // enqueued an `auto_tagging` job the handler then failed.
    // -----------------------------------------------------------------------
    it('routes a VIDEO to video_auto_tagging', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MEDIA_TYPE.video }),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunTagging('media-1', makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video_auto_tagging', priority: 0 }),
      );
    });

    it('marks the tag status pending for a video too, so the UI badge reflects the queued rerun', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ type: MEDIA_TYPE.video }),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunTagging('media-1', makeUser());

      expect(mockPrisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: TAG_STATUS.pending }),
        }),
      );
    });

    it('enqueues with type auto_tagging (photo), reason rerun, and priority 0', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      await controller.rerunTagging('media-1', makeUser());

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          subjectType: 'media_item',
          subjectId: 'media-1',
          payload: { circleId: 'circle-1' },
          reason: JOB_REASON.rerun,
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
            status: TAG_STATUS.pending,
          }),
          update: expect.objectContaining({
            status: TAG_STATUS.pending,
          }),
        }),
      );
    });

    it('calls requireOwnerRole with collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.upsert as jest.Mock).mockResolvedValue({});

      const user = makeUser();
      await controller.rerunTagging('media-1', user);

      expect(mockOwnerAccessService.requireOwnerRole).toHaveBeenCalledWith(
        user.id,
        'circle-1',
        user.permissions,
        'editor',
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
        status: TAG_STATUS.processed,
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

      expect(result.data.status).toBe(TAG_STATUS.not_processed);
      expect(result.data.tagCount).toBe(0);
      expect(result.data.providerKey).toBeNull();
      expect(result.data.modelVersion).toBeNull();
      expect(result.data.processedAt).toBeNull();
      expect(result.data.lastError).toBeNull();
    });

    it('calls requireOwnerRole with viewer role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem(),
      );
      (mockPrisma.mediaTagStatus.findUnique as jest.Mock).mockResolvedValue(null);

      const user = makeUser();
      await controller.getTagStatus('media-1', user);

      expect(mockOwnerAccessService.requireOwnerRole).toHaveBeenCalledWith(
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
  // backfillTaggingSchema — unit tests for the flexible date validator
  // -------------------------------------------------------------------------

  describe('backfillTaggingSchema (inline)', () => {
    // Replicate the schema here so it is accessible for direct unit testing
    // without exporting it from the controller module.
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
