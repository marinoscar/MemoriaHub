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
  DEFAULT_FACE_ARCHIVE_MATCH_THRESHOLD,
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
  // matchFaceToArchived
  // -------------------------------------------------------------------------

  describe('matchFaceToArchived', () => {
    it('returns the archived face when similarity >= archiveMatchThreshold', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { id: 'archived-1', embedding: [1, 0] },
      ]);

      const result = await service.matchFaceToArchived('circle-1', [1, 0]);

      expect(result).toEqual({ faceId: 'archived-1', similarity: expect.any(Number) });
      expect(result!.similarity).toBeCloseTo(1, 10);
    });

    it('returns null when best similarity is below archiveMatchThreshold', async () => {
      // Orthogonal vectors -> similarity 0, well below the default 0.45 threshold.
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        { id: 'archived-1', embedding: [0, 1] },
      ]);

      const result = await service.matchFaceToArchived('circle-1', [1, 0]);

      expect(result).toBeNull();
    });

    it('returns null immediately for an empty embedding without querying prisma', async () => {
      const result = await service.matchFaceToArchived('circle-1', []);

      expect(result).toBeNull();
      expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    });

    it('returns null when the queried archived candidate set is empty', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.matchFaceToArchived('circle-1', [1, 0]);

      expect(result).toBeNull();
    });

    it('honors opts.candidates and never calls prisma', async () => {
      const result = await service.matchFaceToArchived('circle-1', [1, 0], {
        candidates: [{ id: 'supplied-1', embedding: [1, 0] }],
      });

      expect(result).toEqual({ faceId: 'supplied-1', similarity: expect.any(Number) });
      expect(result!.similarity).toBeCloseTo(1, 10);
      expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    });

    it('returns null when opts.candidates is an empty array, without querying prisma', async () => {
      const result = await service.matchFaceToArchived('circle-1', [1, 0], {
        candidates: [],
      });

      expect(result).toBeNull();
      expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    });

    it('honors a custom opts.threshold that rejects an otherwise-passing match', async () => {
      // similarity([1,0],[0.6,0.8]) = 0.6, which clears the default 0.45
      // threshold but not a custom 0.9 threshold.
      const result = await service.matchFaceToArchived('circle-1', [1, 0], {
        candidates: [{ id: 'supplied-1', embedding: [0.6, 0.8] }],
        threshold: 0.9,
      });

      expect(result).toBeNull();
    });

    it('honors a custom opts.threshold that accepts an otherwise-rejected match', async () => {
      // similarity([1,0],[0.6,0.8]) = 0.6, below default archiveMatchThreshold
      // only if default were > 0.6; use a low custom threshold to force accept.
      const result = await service.matchFaceToArchived('circle-1', [1, 0], {
        candidates: [{ id: 'supplied-1', embedding: [0.6, 0.8] }],
        threshold: 0.1,
      });

      expect(result).toEqual({ faceId: 'supplied-1', similarity: expect.any(Number) });
      expect(result!.similarity).toBeCloseTo(0.6, 5);
    });

    it('queries archived unassigned faces with the expected filter, ordering, and take cap', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      await service.matchFaceToArchived('circle-xyz', [1, 0]);

      expect(mockPrisma.face.findMany).toHaveBeenCalledWith({
        where: {
          circleId: 'circle-xyz',
          personId: null,
          hiddenAt: { not: null },
          embedding: { isEmpty: false },
        },
        select: { id: true, embedding: true },
        orderBy: { hiddenAt: 'desc' },
        take: service.archiveMaxCandidates,
      });
    });
  });

  // -------------------------------------------------------------------------
  // pgvector backend
  // -------------------------------------------------------------------------

  // NOTE: SQL correctness and recall parity between the pgvector KNN path and
  // the in-app cosine-scan path (i.e. whether the two paths actually agree on
  // real data against a live `faces.embedding_vec` HNSW index) is NOT verified
  // by this mocked unit suite — `$transaction`/`$queryRaw` are stubbed here, so
  // the raw SQL template strings themselves are never executed or type-checked
  // against a real Postgres/pgvector instance. `apps/api/test/integration/`
  // exists (e.g. `device-auth.integration.spec.ts`, `share.integration.spec.ts`)
  // and does hit a real test database via `.env.test`, but there is no
  // pgvector-specific integration test in this repo as of this writing. This
  // gap is documented rather than closed here — see the task report for what
  // was checked.
  describe('pgvector backend', () => {
    // A 128-length one-hot unit vector (L2 norm 1) at index `i`. Reused to
    // build query/centroid embeddings whose cosine similarity is exactly 1
    // (identical index) or exactly 0 (different index), so accept/reject
    // outcomes are unambiguous without needing real embedding data.
    function oneHot128(i: number): number[] {
      return new Array(128).fill(0).map((_, idx) => (idx === i ? 1 : 0));
    }

    function oneHot1024(i: number): number[] {
      return new Array(1024).fill(0).map((_, idx) => (idx === i ? 1 : 0));
    }

    // -----------------------------------------------------------------------
    // matchFaceToPerson pgvector routing
    // -----------------------------------------------------------------------

    describe('matchFaceToPerson', () => {
      it('routes 128-d probes through pgvector, de-dupes candidate person ids, and picks the best centroid', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        const query = oneHot128(0);
        const p1Centroid = oneHot128(0); // identical -> similarity 1.0
        const p2Centroid = oneHot128(1); // orthogonal -> similarity 0

        (mockPrisma.$transaction as unknown as jest.Mock).mockResolvedValue([
          undefined,
          [{ person_id: 'p1' }, { person_id: 'p1' }, { person_id: 'p2' }],
        ]);
        (mockPrisma.face.findMany as jest.Mock)
          .mockResolvedValueOnce([{ embedding: p1Centroid }])
          .mockResolvedValueOnce([{ embedding: p2Centroid }]);

        const result = await customService.matchFaceToPerson('circle-1', query);

        expect(result).not.toBeNull();
        expect(result!.personId).toBe('p1');
        expect(result!.similarity).toBeCloseTo(1, 10);
        expect(mockPrisma.$transaction).toHaveBeenCalled();
        expect(mockPrisma.person.findMany).not.toHaveBeenCalled();
      });

      it('returns null without querying centroids when the KNN query returns no candidate rows', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        (mockPrisma.$transaction as unknown as jest.Mock).mockResolvedValue([undefined, []]);

        const result = await customService.matchFaceToPerson('circle-1', oneHot128(0));

        expect(result).toBeNull();
        expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
      });

      it('returns null when the KNN candidate exists but its centroid similarity is below threshold', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        (mockPrisma.$transaction as unknown as jest.Mock).mockResolvedValue([
          undefined,
          [{ person_id: 'p1' }],
        ]);
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
          { embedding: oneHot128(1) }, // orthogonal to query -> similarity 0
        ]);

        const result = await customService.matchFaceToPerson('circle-1', oneHot128(0));

        expect(result).toBeNull();
      });

      it('falls back to the in-app path for a 1024-d ("human") embedding even with pgvector configured', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        const probe = oneHot1024(0);
        (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 'person-a' }]);
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([{ embedding: oneHot1024(0) }]);

        const result = await customService.matchFaceToPerson('circle-1', probe);

        expect(mockPrisma.person.findMany).toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result!.personId).toBe('person-a');
      });

      it('uses the in-app path when the backend is explicitly "app", regardless of a 128-d embedding', async () => {
        const appConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'app' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: appConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        const probe = oneHot128(0);
        (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 'person-a' }]);
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([{ embedding: oneHot128(0) }]);

        const result = await customService.matchFaceToPerson('circle-1', probe);

        expect(mockPrisma.person.findMany).toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result!.personId).toBe('person-a');
      });
    });

    // -----------------------------------------------------------------------
    // matchFaceToArchived pgvector routing
    // -----------------------------------------------------------------------

    describe('matchFaceToArchived', () => {
      it('honors opts.candidates via the in-app path regardless of a pgvector-configured backend', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        const result = await customService.matchFaceToArchived('circle-1', [1, 0], {
          candidates: [{ id: 'f1', embedding: [1, 0] }],
        });

        expect(result).toEqual({ faceId: 'f1', similarity: expect.any(Number) });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
      });

      it('routes a 128-d probe with no candidates through pgvector and accepts the nearest archived face', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        (mockPrisma.$transaction as unknown as jest.Mock).mockResolvedValue([
          undefined,
          [{ id: 'f1', similarity: 0.9 }],
        ]);

        const result = await customService.matchFaceToArchived('circle-1', oneHot128(0));

        expect(result).toEqual({ faceId: 'f1', similarity: 0.9 });
      });

      it('returns null when the nearest pgvector archived match is below threshold', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        (mockPrisma.$transaction as unknown as jest.Mock).mockResolvedValue([
          undefined,
          [{ id: 'f1', similarity: 0.1 }],
        ]);

        const result = await customService.matchFaceToArchived('circle-1', oneHot128(0));

        expect(result).toBeNull();
      });

      it('returns null when the pgvector KNN query returns no archived candidate rows', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        (mockPrisma.$transaction as unknown as jest.Mock).mockResolvedValue([undefined, []]);

        const result = await customService.matchFaceToArchived('circle-1', oneHot128(0));

        expect(result).toBeNull();
      });

      it('falls back to the in-app query path for a 1024-d probe with no candidates', async () => {
        const pgvectorConfig = makeConfigService({ FACE_VECTOR_BACKEND: 'pgvector' });
        const module: TestingModule = await Test.createTestingModule({
          providers: [
            FaceMatchingService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: ConfigService, useValue: pgvectorConfig },
          ],
        }).compile();
        const customService = module.get<FaceMatchingService>(FaceMatchingService);

        const probe = oneHot1024(0);
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
          { id: 'f1', embedding: oneHot1024(0) },
        ]);

        const result = await customService.matchFaceToArchived('circle-1', probe);

        expect(mockPrisma.face.findMany).toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result!.faceId).toBe('f1');
      });
    });
  });

  // -------------------------------------------------------------------------
  // findLiveMatchesAgainstArchived
  // -------------------------------------------------------------------------

  describe('findLiveMatchesAgainstArchived', () => {
    it('returns ids of live faces that match the archived reference set', async () => {
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'archived-1', embedding: [1, 0] }]) // archived set
        .mockResolvedValueOnce([
          { id: 'live-1', embedding: [1, 0] }, // matches
          { id: 'live-2', embedding: [0, 1] }, // does not match
        ]);

      const result = await service.findLiveMatchesAgainstArchived('circle-1');

      expect(result).toEqual(['live-1']);
    });

    it('returns [] when the archived reference set is empty (no live query performed)', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValueOnce([]);

      const result = await service.findLiveMatchesAgainstArchived('circle-1');

      expect(result).toEqual([]);
      expect(mockPrisma.face.findMany).toHaveBeenCalledTimes(1);
    });

    it('skips live faces with empty embeddings', async () => {
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'archived-1', embedding: [1, 0] }])
        .mockResolvedValueOnce([{ id: 'live-1', embedding: [] }]);

      const result = await service.findLiveMatchesAgainstArchived('circle-1');

      expect(result).toEqual([]);
    });

    it('honors supplied opts.archivedCandidates and opts.liveBatch without querying prisma', async () => {
      const result = await service.findLiveMatchesAgainstArchived('circle-1', {
        archivedCandidates: [{ id: 'archived-1', embedding: [1, 0] }],
        liveBatch: [{ id: 'live-1', embedding: [1, 0] }],
      });

      expect(result).toEqual(['live-1']);
      expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    });

    it('honors a custom opts.threshold', async () => {
      const result = await service.findLiveMatchesAgainstArchived('circle-1', {
        archivedCandidates: [{ id: 'archived-1', embedding: [0.6, 0.8] }],
        liveBatch: [{ id: 'live-1', embedding: [1, 0] }],
        threshold: 0.9, // similarity is 0.6, rejected at 0.9
      });

      expect(result).toEqual([]);
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

    it('uses DEFAULT_FACE_ARCHIVE_MATCH_THRESHOLD when env var is not set', () => {
      expect(service.archiveMatchThreshold).toBe(DEFAULT_FACE_ARCHIVE_MATCH_THRESHOLD);
    });

    it('reads FACE_ARCHIVE_MATCH_THRESHOLD from ConfigService when set', async () => {
      const customConfig = makeConfigService({ FACE_ARCHIVE_MATCH_THRESHOLD: '0.6' });
      const module = await Test.createTestingModule({
        providers: [
          FaceMatchingService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: customConfig },
        ],
      }).compile();

      const customService = module.get<FaceMatchingService>(FaceMatchingService);

      expect(customService.archiveMatchThreshold).toBe(0.6);
    });

    it('uses a default archiveMaxCandidates of 5000 when env var is not set', () => {
      expect(service.archiveMaxCandidates).toBe(5000);
    });

    it('reads FACE_ARCHIVE_MAX_CANDIDATES from ConfigService when set', async () => {
      const customConfig = makeConfigService({ FACE_ARCHIVE_MAX_CANDIDATES: '250' });
      const module = await Test.createTestingModule({
        providers: [
          FaceMatchingService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: customConfig },
        ],
      }).compile();

      const customService = module.get<FaceMatchingService>(FaceMatchingService);

      expect(customService.archiveMaxCandidates).toBe(250);
    });
  });
});
