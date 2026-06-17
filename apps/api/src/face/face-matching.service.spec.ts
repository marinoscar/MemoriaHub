/**
 * Unit tests for FaceMatchingService.
 *
 * Covers: cosineSimilarity math, computePersonCentroid, matchFaceToPerson,
 * matchFaceByExternalId, and threshold configuration from ConfigService.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  FaceMatchingService,
  DEFAULT_FACE_MATCH_THRESHOLD,
  DEFAULT_FACE_CLUSTER_THRESHOLD,
  DEFAULT_FACE_CLUSTER_MIN_SIZE,
} from './face-matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, string> = {}): { get: jest.Mock } {
  return {
    get: jest.fn((key: string) => overrides[key] ?? null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceMatchingService', () => {
  let service: FaceMatchingService;
  let mockPrisma: MockPrismaService;
  let mockConfig: { get: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockConfig = makeConfigService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceMatchingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<FaceMatchingService>(FaceMatchingService);
  });

  // -------------------------------------------------------------------------
  // cosineSimilarity
  // -------------------------------------------------------------------------

  describe('cosineSimilarity', () => {
    it('returns 1.0 for identical unit vectors [1,0]', () => {
      expect(service.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0, 10);
    });

    it('returns 0 for orthogonal unit vectors [1,0] and [0,1]', () => {
      expect(service.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    });

    it('returns -1.0 for opposite vectors [1,0] and [-1,0]', () => {
      expect(service.cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10);
    });

    it('computes dot product for known values: [0.6,0.8] · [0.6,0.8] = 1', () => {
      const result = service.cosineSimilarity([0.6, 0.8], [0.6, 0.8]);
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for empty arrays', () => {
      expect(service.cosineSimilarity([], [])).toBe(0);
    });

    it('returns 0 when array lengths differ', () => {
      expect(service.cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    });

    it('computes known cross-dot-product: [0.6,0.8] · [0,-1] = -0.8', () => {
      const result = service.cosineSimilarity([0.6, 0.8], [0, -1]);
      expect(result).toBeCloseTo(-0.8, 5);
    });
  });

  // -------------------------------------------------------------------------
  // computePersonCentroid
  // -------------------------------------------------------------------------

  describe('computePersonCentroid', () => {
    it('returns [1,0] (normalized) for a single face with embedding [1,0]', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { embedding: [1, 0] },
      ]);

      const centroid = await service.computePersonCentroid('person-1');

      expect(centroid).toHaveLength(2);
      expect(centroid[0]).toBeCloseTo(1, 5);
      expect(centroid[1]).toBeCloseTo(0, 5);
    });

    it('returns the normalized mean for two faces', async () => {
      // [1,0] and [0,1] → mean [0.5, 0.5] → normalized [1/√2, 1/√2]
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { embedding: [1, 0] },
        { embedding: [0, 1] },
      ]);

      const centroid = await service.computePersonCentroid('person-2');
      const expected = 1 / Math.sqrt(2);

      expect(centroid[0]).toBeCloseTo(expected, 5);
      expect(centroid[1]).toBeCloseTo(expected, 5);
    });

    it('returns [] when person has no faces', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      const centroid = await service.computePersonCentroid('person-empty');
      expect(centroid).toEqual([]);
    });

    it('returns [] when all faces have empty embeddings', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { embedding: [] },
        { embedding: [] },
      ]);

      const centroid = await service.computePersonCentroid('person-no-embed');
      expect(centroid).toEqual([]);
    });

    it('queries faces filtered by personId', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      await service.computePersonCentroid('person-xyz');

      expect(mockPrisma.face.findMany).toHaveBeenCalledWith({
        where: { personId: 'person-xyz' },
        select: { embedding: true },
      });
    });
  });

  // -------------------------------------------------------------------------
  // matchFaceToPerson
  // -------------------------------------------------------------------------

  describe('matchFaceToPerson', () => {
    it('returns best person when similarity >= matchThreshold', async () => {
      // Two persons in the circle
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([
        { id: 'person-a' },
        { id: 'person-b' },
      ]);

      // person-a: centroid [1,0], person-b: centroid [0,1]
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([{ embedding: [1, 0] }])   // centroid for person-a
        .mockResolvedValueOnce([{ embedding: [0, 1] }]);  // centroid for person-b

      // Query embedding close to person-a
      const result = await service.matchFaceToPerson('circle-1', [0.99, 0.14]);

      expect(result).not.toBeNull();
      expect(result!.personId).toBe('person-a');
      expect(result!.similarity).toBeGreaterThan(service.matchThreshold);
    });

    it('returns null when no person has similarity >= matchThreshold', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([
        { id: 'person-a' },
      ]);

      // person-a centroid [1,0]; query embedding nearly orthogonal [0.1, 0.995]
      // similarity ≈ 0.1 which is below 0.38
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([{ embedding: [1, 0] }]);

      const result = await service.matchFaceToPerson('circle-1', [0.1, 0.995]);

      expect(result).toBeNull();
    });

    it('returns null when person list is empty for the circle', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.matchFaceToPerson('circle-empty', [1, 0]);

      expect(result).toBeNull();
    });

    it('skips persons whose centroid is empty', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([
        { id: 'person-noface' },
      ]);

      // No faces → empty centroid
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.matchFaceToPerson('circle-1', [1, 0]);

      expect(result).toBeNull();
    });

    it('queries only active persons for the given circleId', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);

      await service.matchFaceToPerson('circle-xyz', [1, 0]);

      expect(mockPrisma.person.findMany).toHaveBeenCalledWith({
        where: {
          circleId: 'circle-xyz',
          deletedAt: null,
          mergedIntoId: null,
        },
        select: { id: true },
      });
    });
  });

  // -------------------------------------------------------------------------
  // matchFaceByExternalId
  // -------------------------------------------------------------------------

  describe('matchFaceByExternalId', () => {
    it('returns personId when face with matching externalFaceId is found', async () => {
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue({
        personId: 'person-delegated',
      });

      const result = await service.matchFaceByExternalId('circle-1', 'ext-abc');

      expect(result).toEqual({ personId: 'person-delegated' });
    });

    it('returns null when no face with that externalFaceId exists in the circle', async () => {
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.matchFaceByExternalId('circle-1', 'ext-notfound');

      expect(result).toBeNull();
    });

    it('returns null when the matching face has no personId', async () => {
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue({ personId: null });

      const result = await service.matchFaceByExternalId('circle-1', 'ext-orphan');

      expect(result).toBeNull();
    });

    it('queries face with circle scoping and active person filter', async () => {
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(null);

      await service.matchFaceByExternalId('circle-xyz', 'ext-123');

      expect(mockPrisma.face.findFirst).toHaveBeenCalledWith({
        where: {
          circleId: 'circle-xyz',
          externalFaceId: 'ext-123',
          personId: { not: null },
          person: {
            deletedAt: null,
            mergedIntoId: null,
          },
        },
        select: { personId: true },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Threshold configuration
  // -------------------------------------------------------------------------

  describe('threshold configuration', () => {
    it('uses DEFAULT_FACE_MATCH_THRESHOLD when env var is not set', () => {
      expect(service.matchThreshold).toBe(DEFAULT_FACE_MATCH_THRESHOLD);
    });

    it('reads FACE_MATCH_THRESHOLD from ConfigService when set', async () => {
      const customConfig = makeConfigService({ FACE_MATCH_THRESHOLD: '0.55' });
      const module = await Test.createTestingModule({
        providers: [
          FaceMatchingService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: customConfig },
        ],
      }).compile();

      const customService = module.get<FaceMatchingService>(FaceMatchingService);

      expect(customService.matchThreshold).toBe(0.55);
    });

    it('uses DEFAULT_FACE_CLUSTER_THRESHOLD when env var is not set', () => {
      expect(service.clusterThreshold).toBe(DEFAULT_FACE_CLUSTER_THRESHOLD);
    });

    it('uses DEFAULT_FACE_CLUSTER_MIN_SIZE when env var is not set', () => {
      expect(service.clusterMinSize).toBe(DEFAULT_FACE_CLUSTER_MIN_SIZE);
    });
  });
});
