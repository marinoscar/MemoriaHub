/**
 * Unit tests for FaceClusteringService.
 *
 * Covers: two-close-embedding clustering, singletons, three-face mixed scenario,
 * idempotency (already-assigned faces skipped), return values, and empty input.
 *
 * Uses a real FaceMatchingService (not mocked) so that cosineSimilarity and
 * threshold values are exercised realistically.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FaceClusteringService } from './face-clustering.service';
import { FaceMatchingService, DEFAULT_FACE_CLUSTER_THRESHOLD, DEFAULT_FACE_CLUSTER_MIN_SIZE } from './face-matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unit vector at angle θ (radians) — similarity between two such vectors = cos(θ1-θ2). */
function unitVec(theta: number): number[] {
  return [Math.cos(theta), Math.sin(theta)];
}

/** Two vectors with known similarity >= 0.45 (angle difference < ~63.3°). */
const CLOSE_A = unitVec(0);          // [1, 0]
const CLOSE_B = unitVec(0.3);        // cos(0.3) ≈ 0.955, sin(0.3) ≈ 0.296 — similarity ≈ 0.955

/** Vector orthogonal to CLOSE_A — similarity with CLOSE_A = 0.0 (far). */
const FAR_C = unitVec(Math.PI / 2);  // [0, 1]

function makeFaceRecord(id: string, embedding: number[]) {
  return { id, embedding };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceClusteringService', () => {
  let service: FaceClusteringService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceClusteringService,
        FaceMatchingService, // real, not mocked
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(null) }, // uses defaults
        },
      ],
    }).compile();

    service = module.get<FaceClusteringService>(FaceClusteringService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Verify clustering thresholds are correct for our test vectors
  // -------------------------------------------------------------------------

  it('sanity check: CLOSE_A and CLOSE_B have similarity >= clusterThreshold', () => {
    const matchingService = new FaceMatchingService(mockPrisma as any, { get: jest.fn().mockReturnValue(null) } as any);
    const sim = matchingService.cosineSimilarity(CLOSE_A, CLOSE_B);
    expect(sim).toBeGreaterThanOrEqual(DEFAULT_FACE_CLUSTER_THRESHOLD);
  });

  it('sanity check: CLOSE_A and FAR_C have similarity below clusterThreshold', () => {
    const matchingService = new FaceMatchingService(mockPrisma as any, { get: jest.fn().mockReturnValue(null) } as any);
    const sim = matchingService.cosineSimilarity(CLOSE_A, FAR_C);
    expect(sim).toBeLessThan(DEFAULT_FACE_CLUSTER_THRESHOLD);
  });

  // -------------------------------------------------------------------------
  // Two close embeddings → one cluster
  // -------------------------------------------------------------------------

  describe('two close embeddings', () => {
    it('creates one Person and assigns both faces', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRecord('face-a', CLOSE_A),
        makeFaceRecord('face-b', CLOSE_B),
      ]);

      (mockPrisma.person.create as jest.Mock).mockResolvedValue({ id: 'person-1' });
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.clusterUnknownFaces('circle-1', 'user-1');

      expect(result.clustersCreated).toBe(1);
      expect(result.facesAssigned).toBe(2);
      expect(mockPrisma.person.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.face.updateMany).toHaveBeenCalledTimes(1);
    });

    it('creates Person with circleId and addedById', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRecord('face-a', CLOSE_A),
        makeFaceRecord('face-b', CLOSE_B),
      ]);
      (mockPrisma.person.create as jest.Mock).mockResolvedValue({ id: 'person-1' });
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.clusterUnknownFaces('circle-x', 'user-y');

      expect(mockPrisma.person.create).toHaveBeenCalledWith({
        data: {
          circleId: 'circle-x',
          addedById: 'user-y',
          name: null,
        },
      });
    });

    it('assigns faces with manuallyAssigned: false', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRecord('face-a', CLOSE_A),
        makeFaceRecord('face-b', CLOSE_B),
      ]);
      (mockPrisma.person.create as jest.Mock).mockResolvedValue({ id: 'person-1' });
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.clusterUnknownFaces('circle-1', 'user-1');

      expect(mockPrisma.face.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { personId: 'person-1', manuallyAssigned: false },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Singleton (only 1 face) → no cluster created
  // -------------------------------------------------------------------------

  describe('singleton face', () => {
    it('creates no Person and returns clustersCreated: 0 when only one face', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRecord('face-a', CLOSE_A),
      ]);

      const result = await service.clusterUnknownFaces('circle-1', 'user-1');

      expect(result.clustersCreated).toBe(0);
      expect(result.facesAssigned).toBe(0);
      expect(mockPrisma.person.create).not.toHaveBeenCalled();
      expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Three faces: two close + one far
  // -------------------------------------------------------------------------

  describe('three faces: two close + one far', () => {
    it('clusters the two close faces and leaves the far one unassigned', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRecord('face-a', CLOSE_A),
        makeFaceRecord('face-b', CLOSE_B),
        makeFaceRecord('face-c', FAR_C),
      ]);

      (mockPrisma.person.create as jest.Mock).mockResolvedValue({ id: 'person-1' });
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.clusterUnknownFaces('circle-1', 'user-1');

      // Only one cluster (the pair), face-c remains unassigned (singleton)
      expect(result.clustersCreated).toBe(1);
      expect(result.facesAssigned).toBe(2);

      // Only one person created
      expect(mockPrisma.person.create).toHaveBeenCalledTimes(1);

      // The updateMany should include face-a and face-b (in any order)
      const updateCall = (mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateCall.where.id.in).toHaveLength(2);
      expect(updateCall.where.id.in).toContain('face-a');
      expect(updateCall.where.id.in).toContain('face-b');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency: faces already with personId != null are excluded
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('only loads faces with personId: null and hiddenAt: null (excludes archived faces)', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      await service.clusterUnknownFaces('circle-1', 'user-1');

      expect(mockPrisma.face.findMany).toHaveBeenCalledWith({
        where: {
          circleId: 'circle-1',
          personId: null,
          hiddenAt: null,
        },
        select: { id: true, embedding: true },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Empty eligible faces
  // -------------------------------------------------------------------------

  describe('empty eligible faces', () => {
    it('returns {clustersCreated: 0, facesAssigned: 0} when no faces returned', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.clusterUnknownFaces('circle-1', 'user-1');

      expect(result).toEqual({ clustersCreated: 0, facesAssigned: 0 });
      expect(mockPrisma.person.create).not.toHaveBeenCalled();
    });

    it('returns {clustersCreated: 0, facesAssigned: 0} when all faces have empty embeddings', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        makeFaceRecord('face-a', []),
        makeFaceRecord('face-b', []),
      ]);

      const result = await service.clusterUnknownFaces('circle-1', 'user-1');

      expect(result).toEqual({ clustersCreated: 0, facesAssigned: 0 });
      expect(mockPrisma.person.create).not.toHaveBeenCalled();
    });
  });
});
