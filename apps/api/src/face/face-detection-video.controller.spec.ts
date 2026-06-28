/**
 * Extension of FaceDetectionController tests — video face fields.
 *
 * Verifies that GET /api/media/:id/faces now includes:
 *   - `videoTimestampMs`  (null for photo faces, ms value for video faces)
 *   - `videoTimestamps`   (empty array for photos, populated array for videos)
 *   - `faceThumbnailUrl`  (null when frameThumbnailKey absent, signed URL when present)
 *
 * `MediaThumbnailService.signThumb` is mocked to return a predictable URL.
 * No real HTTP or database calls are made.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { FaceDetectionController } from './face-detection.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PeopleService } from './people.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCircleMembershipService = { assertCircleAccess: jest.fn() };
const mockEnrichmentJobService = { enqueue: jest.fn() };
const mockPeopleService = {};
const mockMediaThumbnailService = {
  signThumb: jest.fn(),
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

function makeMediaItem(overrides: Partial<{ id: string; circleId: string; deletedAt: Date | null }> = {}) {
  return { id: 'media-1', circleId: 'circle-1', deletedAt: null, ...overrides };
}

/** Build a face record as returned by Prisma (with optional video fields). */
function makeFaceRow(overrides: {
  id?: string;
  videoTimestampMs?: number | null;
  videoTimestamps?: number[];
  frameThumbnailKey?: string | null;
  personId?: string | null;
  person?: { name: string } | null;
} = {}) {
  return {
    id: overrides.id ?? 'face-1',
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    landmarks: null,
    externalFaceId: null,
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    manuallyAssigned: false,
    personId: overrides.personId ?? null,
    createdAt: new Date(),
    person: overrides.person ?? null,
    videoTimestampMs: overrides.videoTimestampMs ?? null,
    videoTimestamps: overrides.videoTimestamps ?? [],
    frameThumbnailKey: overrides.frameThumbnailKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FaceDetectionController — video face fields', () => {
  let controller: FaceDetectionController;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    mockCircleMembershipService.assertCircleAccess.mockResolvedValue(undefined);
    mockEnrichmentJobService.enqueue.mockResolvedValue({ id: 'job-1', status: 'pending' });
    // Default: signThumb returns a fixed URL
    mockMediaThumbnailService.signThumb.mockResolvedValue('https://cdn.example.com/signed-thumb.jpg');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FaceDetectionController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: PeopleService, useValue: mockPeopleService },
        { provide: MediaThumbnailService, useValue: mockMediaThumbnailService },
      ],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<FaceDetectionController>(FaceDetectionController);
  });

  // -------------------------------------------------------------------------
  // videoTimestampMs and videoTimestamps fields
  // -------------------------------------------------------------------------

  describe('videoTimestampMs and videoTimestamps', () => {
    it('returns videoTimestampMs: null for a photo face (null from DB)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ videoTimestampMs: null }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].videoTimestampMs).toBeNull();
    });

    it('returns videoTimestamps: [] for a photo face', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ videoTimestamps: [] }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].videoTimestamps).toEqual([]);
    });

    it('returns videoTimestampMs with ms value for a video face', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ videoTimestampMs: 5000 }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].videoTimestampMs).toBe(5000);
    });

    it('returns videoTimestamps array for a video face', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ videoTimestampMs: 5000, videoTimestamps: [5000, 15000, 25000] }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].videoTimestamps).toEqual([5000, 15000, 25000]);
    });

    it('returns videoTimestamps: [] even when DB returns null (nullish fallback)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      // Simulate old DB row where videoTimestamps is null
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { ...makeFaceRow(), videoTimestamps: null },
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].videoTimestamps).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // faceThumbnailUrl
  // -------------------------------------------------------------------------

  describe('faceThumbnailUrl', () => {
    it('returns faceThumbnailUrl: null when frameThumbnailKey is null', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ frameThumbnailKey: null }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].faceThumbnailUrl).toBeNull();
      expect(mockMediaThumbnailService.signThumb).not.toHaveBeenCalled();
    });

    it('returns a signed URL when frameThumbnailKey is set', async () => {
      const key = 'video-faces/media-1/abc.jpg';
      mockMediaThumbnailService.signThumb.mockResolvedValue('https://cdn.example.com/signed.jpg');

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ frameThumbnailKey: key }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data[0].faceThumbnailUrl).toBe('https://cdn.example.com/signed.jpg');
      expect(mockMediaThumbnailService.signThumb).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailStorageKey: key }),
      );
    });

    it('calls signThumb once per face that has a frameThumbnailKey', async () => {
      mockMediaThumbnailService.signThumb.mockResolvedValue('https://cdn.example.com/signed.jpg');

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ id: 'f1', frameThumbnailKey: 'video-faces/media-1/a.jpg' }),
        makeFaceRow({ id: 'f2', frameThumbnailKey: null }),
        makeFaceRow({ id: 'f3', frameThumbnailKey: 'video-faces/media-1/c.jpg' }),
      ]);

      await controller.listFaces('media-1', makeUser());

      // Only faces with a key should trigger signThumb
      expect(mockMediaThumbnailService.signThumb).toHaveBeenCalledTimes(2);
    });

    it('returns faceThumbnailUrl: null for all three faces when no keys are set', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({ id: 'f1', frameThumbnailKey: null }),
        makeFaceRow({ id: 'f2', frameThumbnailKey: null }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());

      expect(result.data.every((f) => f.faceThumbnailUrl === null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Combined video face response shape
  // -------------------------------------------------------------------------

  describe('full video face response shape', () => {
    it('returns all video fields in a single response', async () => {
      const key = 'video-faces/media-1/rep.jpg';
      mockMediaThumbnailService.signThumb.mockResolvedValue('https://cdn.example.com/rep.jpg');

      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRow({
          id: 'face-v1',
          videoTimestampMs: 12500,
          videoTimestamps: [2500, 7500, 12500],
          frameThumbnailKey: key,
        }),
      ]);

      const result = await controller.listFaces('media-1', makeUser());
      const face = result.data[0];

      expect(face.id).toBe('face-v1');
      expect(face.videoTimestampMs).toBe(12500);
      expect(face.videoTimestamps).toEqual([2500, 7500, 12500]);
      expect(face.faceThumbnailUrl).toBe('https://cdn.example.com/rep.jpg');
    });

    it('throws NotFoundException when mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.listFaces('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });
  });
});
