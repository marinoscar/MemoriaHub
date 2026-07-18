/**
 * Unit tests for FaceDetectionCore.persistAndMatchFaces — the auto-archive
 * branch in particular.
 *
 * Covers:
 *  - A created face that does NOT match a person but DOES match an archived
 *    face is batch-archived (hiddenAt set, hiddenReason='auto_archive_match').
 *  - A created face that matches neither a person nor an archived face is
 *    left untouched (no archive updateMany entry for it).
 *  - features.faceAutoArchive=false -> no archive updateMany call at all.
 *  - process.env.FACE_AUTO_ARCHIVE='false' overrides a true feature flag ->
 *    no archive updateMany call.
 *  - A face that DOES match a person is never auto-archived, even if it would
 *    also match the archived pool.
 *  - A face with an empty embedding and no externalFaceId is skipped
 *    entirely: no matching calls, no archive attempt, no crash.
 *  - pgvector routing (usesPgvectorFor=true): NO archived-candidates preload
 *    query and matchFaceToArchived is called WITHOUT candidates; the app
 *    backend keeps the preload+candidates in-loop reuse.
 *  - A person match invalidates that person's cached centroid.
 *
 * FaceProviderRegistry, FaceSettingsService, FaceMatchingService, and
 * SystemSettingsService are all replaced with mocks — no transitive
 * dependencies, no real DB.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  FaceDetectionCore,
  NormalizedFace,
  VideoFaceFields,
} from './face-detection-core.service';
import { PrismaService } from '../prisma/prisma.service';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { FaceMatchingService } from './face-matching.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-1';
const MEDIA_ID = 'media-1';

type TestFace = NormalizedFace & VideoFaceFields;

function makeFace(overrides: Partial<TestFace> = {}): TestFace {
  return {
    boundingBox: { x: 0, y: 0, w: 1, h: 1 },
    confidence: 0.9,
    landmarks: undefined,
    embedding: [1, 0],
    externalFaceId: undefined,
    ...overrides,
  } as TestFace;
}

/** Settings shape returned by SystemSettingsService.getSettings() */
function makeSettings(
  faceAutoArchive: boolean,
  matchThreshold = 0.45,
): Record<string, unknown> {
  return {
    features: { faceAutoArchive },
    face: { autoArchive: { matchThreshold } },
  };
}

describe('FaceDetectionCore — persistAndMatchFaces (auto-archive)', () => {
  let service: FaceDetectionCore;
  let mockPrisma: MockPrismaService;
  let mockFaceSettingsService: Record<string, unknown>;
  let mockRegistry: { get: jest.Mock };
  let mockMatchingService: {
    matchFaceByExternalId: jest.Mock;
    matchFaceToPerson: jest.Mock;
    matchFaceToArchived: jest.Mock;
    usesPgvectorFor: jest.Mock;
    invalidateCentroid: jest.Mock;
    archiveMaxCandidates: number;
  };
  let mockSystemSettings: { getSettings: jest.Mock };
  let originalFaceAutoArchiveEnv: string | undefined;
  let createCounter: number;

  beforeAll(() => {
    originalFaceAutoArchiveEnv = process.env['FACE_AUTO_ARCHIVE'];
  });

  afterAll(() => {
    if (originalFaceAutoArchiveEnv === undefined) {
      delete process.env['FACE_AUTO_ARCHIVE'];
    } else {
      process.env['FACE_AUTO_ARCHIVE'] = originalFaceAutoArchiveEnv;
    }
  });

  beforeEach(async () => {
    delete process.env['FACE_AUTO_ARCHIVE'];
    createCounter = 0;

    mockPrisma = createMockPrismaService();
    mockFaceSettingsService = {};
    mockRegistry = {
      get: jest.fn().mockReturnValue({
        capabilities: { delegatedRecognize: false },
        detect: jest.fn(),
      }),
    };
    mockMatchingService = {
      matchFaceByExternalId: jest.fn().mockResolvedValue(null),
      matchFaceToPerson: jest.fn().mockResolvedValue(null),
      matchFaceToArchived: jest.fn().mockResolvedValue(null),
      // Default to the app-backend (preload+candidates) path; individual
      // tests flip this to true to exercise the pgvector KNN path.
      usesPgvectorFor: jest.fn().mockReturnValue(false),
      invalidateCentroid: jest.fn(),
      archiveMaxCandidates: 5000,
    };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue(makeSettings(false)),
    };

    // Echo back the create() input as the "created" row (id + embedding +
    // externalFaceId are the only fields the service reads back via select).
    (mockPrisma.face.create as jest.Mock).mockImplementation(
      ({ data }: { data: { embedding: number[]; externalFaceId: string | null } }) => {
        const id = `face-${createCounter++}`;
        return Promise.resolve({
          id,
          embedding: data.embedding,
          externalFaceId: data.externalFaceId ?? null,
        });
      },
    );
    (mockPrisma.face.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceDetectionCore,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FaceSettingsService, useValue: mockFaceSettingsService },
        { provide: FaceProviderRegistry, useValue: mockRegistry },
        { provide: FaceMatchingService, useValue: mockMatchingService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<FaceDetectionCore>(FaceDetectionCore);
  });

  // -------------------------------------------------------------------------
  // No-op cases
  // -------------------------------------------------------------------------

  it('returns 0 and creates nothing when faces array is empty', async () => {
    const count = await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [],
      isVideo: false,
    });

    expect(count).toBe(0);
    expect(mockPrisma.face.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Auto-archive: happy path
  // -------------------------------------------------------------------------

  it('auto-archives a face that does not match a person but matches the archived pool (faceAutoArchive=true)', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));

    // No person match for either face.
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);

    // Archived candidate pool is non-empty.
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
      { id: 'archived-ref-1', embedding: [0.9, 0.1] },
    ]);

    // Only the [0.9, 0.1] face matches the archived pool.
    mockMatchingService.matchFaceToArchived.mockImplementation(
      (_circleId: string, embedding: number[]) => {
        if (embedding[0] === 0.9 && embedding[1] === 0.1) {
          return Promise.resolve({ faceId: 'archived-ref-1', similarity: 0.5 });
        }
        return Promise.resolve(null);
      },
    );

    const matchedFace = makeFace({ embedding: [0.9, 0.1] }); // face-0
    const nonMatchedFace = makeFace({ embedding: [0, 1] }); // face-1

    const count = await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [matchedFace, nonMatchedFace],
      isVideo: false,
    });

    expect(count).toBe(2);
    expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['face-0'] },
        circleId: CIRCLE_ID,
        personId: null,
        hiddenAt: null,
      },
      data: { hiddenAt: expect.any(Date), hiddenReason: 'auto_archive_match' },
    });
  });

  it('does not archive a face that matches neither a person nor the archived pool', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
      { id: 'archived-ref-1', embedding: [0.9, 0.1] },
    ]);
    mockMatchingService.matchFaceToArchived.mockResolvedValue(null);

    const face = makeFace({ embedding: [0, 1] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  it('never queries or archives when the archived candidate pool is empty', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockMatchingService.matchFaceToArchived).not.toHaveBeenCalled();
    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Auto-archive: pgvector path (no candidate preload)
  // -------------------------------------------------------------------------

  it('skips the archived-candidates preload and calls matchFaceToArchived WITHOUT candidates on the pgvector path', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);
    mockMatchingService.usesPgvectorFor.mockReturnValue(true);
    mockMatchingService.matchFaceToArchived.mockResolvedValue({
      faceId: 'archived-ref-1',
      similarity: 0.6,
    });

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'compreface',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    // No preload query for the archived reference set.
    expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    // KNN routing: called with threshold only — NO candidates key.
    expect(mockMatchingService.matchFaceToArchived).toHaveBeenCalledWith(
      CIRCLE_ID,
      [1, 0],
      { threshold: 0.45 },
    );
    // The match still lands in the batch archive.
    expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['face-0'] },
        circleId: CIRCLE_ID,
        personId: null,
        hiddenAt: null,
      },
      data: { hiddenAt: expect.any(Date), hiddenReason: 'auto_archive_match' },
    });
  });

  it('does not archive on the pgvector path when the KNN finds no archived match', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);
    mockMatchingService.usesPgvectorFor.mockReturnValue(true);
    mockMatchingService.matchFaceToArchived.mockResolvedValue(null);

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'compreface',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  it('preserves the preload+candidates behavior on the app backend (usesPgvectorFor=false)', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);
    mockMatchingService.usesPgvectorFor.mockReturnValue(false);

    const archivedPool = [{ id: 'archived-ref-1', embedding: [0.9, 0.1] }];
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValue(archivedPool);
    mockMatchingService.matchFaceToArchived.mockResolvedValue(null);

    const faceA = makeFace({ embedding: [1, 0] });
    const faceB = makeFace({ embedding: [0, 1] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [faceA, faceB],
      isVideo: false,
    });

    // Preloaded exactly once for the whole job (in-loop reuse) …
    expect(mockPrisma.face.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.face.findMany).toHaveBeenCalledWith({
      where: {
        circleId: CIRCLE_ID,
        personId: null,
        hiddenAt: { not: null },
        embedding: { isEmpty: false },
      },
      select: { id: true, embedding: true },
      orderBy: { hiddenAt: 'desc' },
      take: 5000,
    });
    // … and every probe passes the preloaded set as candidates.
    expect(mockMatchingService.matchFaceToArchived).toHaveBeenCalledTimes(2);
    expect(mockMatchingService.matchFaceToArchived).toHaveBeenCalledWith(
      CIRCLE_ID,
      [1, 0],
      { threshold: 0.45, candidates: archivedPool },
    );
  });

  // -------------------------------------------------------------------------
  // Centroid cache invalidation on person assignment
  // -------------------------------------------------------------------------

  it('invalidates the matched person\'s cached centroid after assigning a face', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(false));
    mockMatchingService.matchFaceToPerson.mockResolvedValue({ personId: 'person-1' });

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockPrisma.face.update).toHaveBeenCalledWith({
      where: { id: 'face-0' },
      data: { personId: 'person-1' },
    });
    expect(mockMatchingService.invalidateCentroid).toHaveBeenCalledWith('person-1');
  });

  it('does not invalidate any centroid when no person match occurs', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(false));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockMatchingService.invalidateCentroid).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gating: feature flag off
  // -------------------------------------------------------------------------

  it('does not auto-archive when features.faceAutoArchive is false', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(false));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);
    // Even if the archived pool would match, the gate should prevent lookup.
    mockMatchingService.matchFaceToArchived.mockResolvedValue({
      faceId: 'archived-ref-1',
      similarity: 0.9,
    });

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    expect(mockMatchingService.matchFaceToArchived).not.toHaveBeenCalled();
    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gating: env kill-switch
  // -------------------------------------------------------------------------

  it('does not auto-archive when process.env.FACE_AUTO_ARCHIVE=\'false\' even if the feature flag is true', async () => {
    process.env['FACE_AUTO_ARCHIVE'] = 'false';
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue(null);

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Person match takes priority
  // -------------------------------------------------------------------------

  it('never auto-archives a face that was matched to a person', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));
    mockMatchingService.matchFaceToPerson.mockResolvedValue({ personId: 'person-1' });
    // Archived-match mock deliberately returns a match too, to prove the
    // person-match branch short-circuits before the archive check ever runs.
    mockMatchingService.matchFaceToArchived.mockResolvedValue({
      faceId: 'archived-ref-1',
      similarity: 0.9,
    });

    const face = makeFace({ embedding: [1, 0] });

    await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(mockPrisma.face.update).toHaveBeenCalledWith({
      where: { id: 'face-0' },
      data: { personId: 'person-1' },
    });
    expect(mockMatchingService.matchFaceToArchived).not.toHaveBeenCalled();
    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Empty-embedding / external-id-only face is skipped
  // -------------------------------------------------------------------------

  it('skips matching entirely for a face with an empty embedding and no externalFaceId', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.45));

    const face = makeFace({ embedding: [], externalFaceId: undefined });

    const count = await service.persistAndMatchFaces({
      mediaItemId: MEDIA_ID,
      circleId: CIRCLE_ID,
      providerKey: 'human',
      modelVersion: 'v1',
      faces: [face],
      isVideo: false,
    });

    expect(count).toBe(1);
    expect(mockMatchingService.matchFaceToPerson).not.toHaveBeenCalled();
    expect(mockMatchingService.matchFaceByExternalId).not.toHaveBeenCalled();
    expect(mockMatchingService.matchFaceToArchived).not.toHaveBeenCalled();
    expect(mockPrisma.face.update).not.toHaveBeenCalled();
    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });
});
