/**
 * Unit tests for DuplicateDetectionService.
 *
 * Covers:
 *  - Guards: non-photo, deleted, archived items are skipped entirely
 *  - Guards: item in a PENDING burst group is skipped entirely (burst review
 *    may soft-delete/reshuffle members concurrently)
 *  - Link-rule matrix: embedding-only match, hash-only match, both, neither
 *  - Degraded mode: embedding model unavailable — hash-only linking still
 *    works because the KNN query naturally returns zero rows
 *  - Compute/persist split: download-on-demand (only when hash or embedding
 *    is missing), download-error semantics, and persistDuplicate (the entry
 *    point the node result-ingestion path will call)
 *  - Union-find grouping: no existing group -> create; one existing group ->
 *    join (+ mediaCount increment via recomputeGroupMeta); multiple existing
 *    groups -> merge into the oldest and delete the emptied groups
 *  - Burst-overlap exclusions: candidates sharing the subject's burstGroupId
 *    are excluded from hash-candidate query filters
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { DuplicateDetectionService, DuplicateComputeResult } from './duplicate-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { VisualEmbeddingService } from './visual-embedding.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { BurstGroupStatus, EnrichmentJob, MediaType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-1';
const SUBJECT_ID = 'media-subject';

const DEDUP_CONFIG = { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20 };

function makeSubjectItem(overrides: Partial<{
  id: string;
  type: MediaType;
  deletedAt: Date | null;
  archivedAt: Date | null;
  circleId: string;
  capturedAt: Date | null;
  perceptualHash: string | null;
  storageObjectId: string | null;
  burstGroupId: string | null;
  duplicateGroupId: string | null;
}> = {}) {
  return {
    id: SUBJECT_ID,
    type: MediaType.photo,
    deletedAt: null,
    archivedAt: null,
    circleId: CIRCLE_ID,
    capturedAt: new Date('2026-06-15T14:32:00Z'),
    perceptualHash: '12345',
    storageObjectId: 'storage-obj-1',
    burstGroupId: null,
    duplicateGroupId: null,
    ...overrides,
  };
}

describe('DuplicateDetectionService', () => {
  let service: DuplicateDetectionService;
  let mockPrisma: MockPrismaService;
  let mockResolver: { getProviderFor: jest.Mock };
  let mockProvider: { download: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockVisualEmbeddingService: {
    isAvailable: jest.Mock;
    hasEmbedding: jest.Mock;
    embedImage: jest.Mock;
    persistEmbedding: jest.Mock;
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockProvider = { download: jest.fn() };
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockProvider) };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({ dedup: DEDUP_CONFIG }),
    };
    // Defaults model the steady state: model available, subject already has
    // an embedding row (so no byte download is needed).
    mockVisualEmbeddingService = {
      isAvailable: jest.fn().mockReturnValue(true),
      hasEmbedding: jest.fn().mockResolvedValue(true),
      embedImage: jest.fn().mockResolvedValue(null),
      persistEmbedding: jest.fn().mockResolvedValue(undefined),
    };

    // Default: no KNN candidates, no hash candidates, nothing to link.
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuplicateDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: VisualEmbeddingService, useValue: mockVisualEmbeddingService },
      ],
    }).compile();

    service = module.get<DuplicateDetectionService>(DuplicateDetectionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  describe('guards', () => {
    it('returns early (no-op) when the mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.hasEmbedding).not.toHaveBeenCalled();
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    });

    it('returns early when the mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ deletedAt: new Date() }),
      );

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.hasEmbedding).not.toHaveBeenCalled();
    });

    it('returns early when the mediaItem is archived', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ archivedAt: new Date() }),
      );

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.hasEmbedding).not.toHaveBeenCalled();
    });

    it('returns early when the mediaItem is not a photo', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ type: MediaType.video }),
      );

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.hasEmbedding).not.toHaveBeenCalled();
    });

    it('skips entirely when the item is in a PENDING burst group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ burstGroupId: 'burst-1' }),
      );
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        status: BurstGroupStatus.pending,
      });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.hasEmbedding).not.toHaveBeenCalled();
    });

    it('proceeds when the item is in a RESOLVED (non-pending) burst group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ burstGroupId: 'burst-1' }),
      );
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        status: BurstGroupStatus.resolved,
      });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.hasEmbedding).toHaveBeenCalledWith(SUBJECT_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Link-rule matrix
  // -------------------------------------------------------------------------

  describe('link-rule matrix', () => {
    function setupNoLinkBase() {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]); // KNN candidates
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]); // hash candidates
    }

    it('neither embedding nor hash match -> no group created', async () => {
      setupNoLinkBase();

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).not.toHaveBeenCalled();
    });

    it('embedding-only match (sim >= threshold, no hash candidates) -> creates a group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        { id: 'media-embed-match', sim: 0.99 },
      ]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        // hash candidates (subject has no matching hash candidates)
        .mockResolvedValueOnce([])
        // linkedCandidates lookup for the matched KNN id
        .mockResolvedValueOnce([
          { id: 'media-embed-match', duplicateGroupId: null, capturedAt: new Date('2026-06-15T14:31:00Z') },
        ])
        // recomputeGroupMeta members
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date('2026-06-15T14:32:00Z') },
          { id: 'media-embed-match', capturedAt: new Date('2026-06-15T14:31:00Z') },
        ]);
      (mockPrisma.duplicateGroup.create as jest.Mock).mockResolvedValue({ id: 'group-new' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ circleId: CIRCLE_ID, mediaCount: 2 }),
        }),
      );
    });

    it('embedding similarity BELOW threshold does not link', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'media-close-not-enough', sim: 0.90 }, // below 0.96 threshold
      ]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]); // no hash candidates

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).not.toHaveBeenCalled();
    });

    it('hash-only match (Hamming distance <= max, no embedding candidates) -> creates a group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: '0' }),
      );
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]); // no KNN candidates
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'media-hash-match', perceptualHash: '2' }]) // hash candidates (distance=1)
        .mockResolvedValueOnce([
          { id: 'media-hash-match', duplicateGroupId: null, capturedAt: new Date('2026-06-15T14:31:00Z') },
        ]) // linkedCandidates
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date('2026-06-15T14:32:00Z') },
          { id: 'media-hash-match', capturedAt: new Date('2026-06-15T14:31:00Z') },
        ]); // recomputeGroupMeta members
      (mockPrisma.duplicateGroup.create as jest.Mock).mockResolvedValue({ id: 'group-new' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ circleId: CIRCLE_ID, mediaCount: 2 }),
        }),
      );
    });

    it('hash Hamming distance ABOVE max does not link', async () => {
      // Subject hash '0'; candidate hash all-bits-set -> distance 64, exceeds max 6
      const maxUint64 = ((1n << 64n) - 1n).toString();
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: '0' }),
      );
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'media-too-far', perceptualHash: maxUint64 },
      ]);

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).not.toHaveBeenCalled();
    });

    it('BOTH embedding and hash match the same candidate -> still creates exactly one group (dedup via Set)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: '0' }),
      );
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'media-both', sim: 0.99 }]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'media-both', perceptualHash: '1' }]) // hash candidates (distance=1)
        .mockResolvedValueOnce([
          { id: 'media-both', duplicateGroupId: null, capturedAt: new Date('2026-06-15T14:31:00Z') },
        ]) // linkedCandidates — should only contain 'media-both' once
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date('2026-06-15T14:32:00Z') },
          { id: 'media-both', capturedAt: new Date('2026-06-15T14:31:00Z') },
        ]);
      (mockPrisma.duplicateGroup.create as jest.Mock).mockResolvedValue({ id: 'group-new' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.duplicateGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ mediaCount: 2 }) }),
      );
    });

    it('matched candidate list never includes the subject itself (self-match guard)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      // Degenerate case: KNN accidentally returns the subject's own id (should be excluded by the SQL
      // WHERE m.id != subject in production; here we assert the in-memory Set delete safety net).
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: SUBJECT_ID, sim: 0.999 }]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Degraded mode: visual embedding unavailable
  // -------------------------------------------------------------------------

  describe('degraded mode (VisualEmbeddingService unavailable)', () => {
    it('still links via hash-only matching when the embedding model is unavailable', async () => {
      mockVisualEmbeddingService.isAvailable.mockReturnValue(false);
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: '0' }),
      );
      // Degraded mode: no embedding row for the subject -> KNN inner join yields zero rows
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'media-hash-match', perceptualHash: '1' }])
        .mockResolvedValueOnce([
          { id: 'media-hash-match', duplicateGroupId: null, capturedAt: new Date('2026-06-15T14:31:00Z') },
        ])
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date('2026-06-15T14:32:00Z') },
          { id: 'media-hash-match', capturedAt: new Date('2026-06-15T14:31:00Z') },
        ]);
      (mockPrisma.duplicateGroup.create as jest.Mock).mockResolvedValue({ id: 'group-new' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).toHaveBeenCalled();
    });

    it('never downloads bytes or embeds in degraded mode when the hash already exists (best-effort, hash matching still runs)', async () => {
      mockVisualEmbeddingService.isAvailable.mockReturnValue(false);
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      // isAvailable=false short-circuits the embedding-existence probe, so
      // nothing is downloaded and no embed is attempted...
      expect(mockVisualEmbeddingService.hasEmbedding).not.toHaveBeenCalled();
      expect(mockProvider.download).not.toHaveBeenCalled();
      expect(mockVisualEmbeddingService.embedImage).not.toHaveBeenCalled();
      // ...but matching (KNN + hash candidates) still executes.
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Union-find grouping
  // -------------------------------------------------------------------------

  describe('union-find grouping', () => {
    it('creates a new group when none of the matched candidates already belong to a group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'media-a', sim: 0.99 }]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // hash candidates
        .mockResolvedValueOnce([
          { id: 'media-a', duplicateGroupId: null, capturedAt: new Date('2026-06-15T10:00:00Z') },
        ]) // linkedCandidates
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date('2026-06-15T14:32:00Z') },
          { id: 'media-a', capturedAt: new Date('2026-06-15T10:00:00Z') },
        ]); // recomputeGroupMeta
      (mockPrisma.duplicateGroup.create as jest.Mock).mockResolvedValue({ id: 'group-new' });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(SUBJECT_ID);

      // capturedAt of the new group is the EARLIEST member timestamp
      expect(mockPrisma.duplicateGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            capturedAt: new Date('2026-06-15T10:00:00Z'),
            mediaCount: 2,
          }),
        }),
      );
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining([SUBJECT_ID, 'media-a']) } },
          data: { duplicateGroupId: 'group-new' },
        }),
      );
      // recomputeGroupMeta updates the group's mediaCount/capturedAt afterward
      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'group-new' },
          data: expect.objectContaining({ mediaCount: 2 }),
        }),
      );
    });

    it('joins an existing group (single match) via update, not create; mediaCount increments through recomputeGroupMeta', async () => {
      const existingGroupId = 'existing-group-1';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'media-a', sim: 0.99 }]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // hash candidates
        .mockResolvedValueOnce([
          { id: 'media-a', duplicateGroupId: existingGroupId, capturedAt: new Date() },
        ]) // linkedCandidates
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date('2026-06-15T14:32:00Z') },
          { id: 'media-a', capturedAt: new Date('2026-06-15T14:00:00Z') },
          { id: 'media-b', capturedAt: new Date('2026-06-15T13:00:00Z') },
        ]); // recomputeGroupMeta: 3 members now in the existing group
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUBJECT_ID },
          data: { duplicateGroupId: existingGroupId },
        }),
      );
      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existingGroupId },
          data: expect.objectContaining({ mediaCount: 3 }),
        }),
      );
    });

    it('merges multiple distinct existing groups into the oldest and deletes the others', async () => {
      const groupOld = 'group-oldest';
      const groupNew = 'group-newer';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: 'media-a', sim: 0.99 },
        { id: 'media-b', sim: 0.98 },
      ]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // hash candidates
        .mockResolvedValueOnce([
          { id: 'media-a', duplicateGroupId: groupOld, capturedAt: new Date() },
          { id: 'media-b', duplicateGroupId: groupNew, capturedAt: new Date() },
        ]) // linkedCandidates
        .mockResolvedValueOnce([
          { id: SUBJECT_ID, capturedAt: new Date() },
          { id: 'media-a', capturedAt: new Date() },
          { id: 'media-b', capturedAt: new Date() },
        ]); // recomputeGroupMeta
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([
        { id: groupOld, createdAt: new Date('2026-01-01') },
        { id: groupNew, createdAt: new Date('2026-01-02') },
      ]);
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.duplicateGroup.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(SUBJECT_ID);

      // Members of groupNew reassigned to groupOld
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { duplicateGroupId: { in: [groupNew] } },
          data: { duplicateGroupId: groupOld },
        }),
      );
      // Subject assigned to groupOld
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUBJECT_ID },
          data: { duplicateGroupId: groupOld },
        }),
      );
      // Emptied group deleted
      expect(mockPrisma.duplicateGroup.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [groupNew] } } }),
      );
    });

    it('recomputeGroupMeta deletes the group when membership becomes empty', async () => {
      // Directly exercise via a join path where the "existing" group ends up
      // with zero active (non-deleted/non-archived) members at recompute time
      // — this can legitimately happen if members were trashed/archived
      // concurrently between matching and grouping.
      const existingGroupId = 'existing-empties-out';
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'media-a', sim: 0.99 }]);
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([]) // hash candidates
        .mockResolvedValueOnce([
          { id: 'media-a', duplicateGroupId: existingGroupId, capturedAt: new Date() },
        ]) // linkedCandidates
        .mockResolvedValueOnce([]); // recomputeGroupMeta: no active members found (edge case)
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.duplicateGroup.delete as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.duplicateGroup.delete).toHaveBeenCalledWith({ where: { id: existingGroupId } });
      expect(mockPrisma.duplicateGroup.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Burst-overlap exclusions
  // -------------------------------------------------------------------------

  describe('burst-overlap exclusions', () => {
    it('hash-candidate query excludes items sharing the subject burstGroupId', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ burstGroupId: 'burst-resolved-1' }),
      );
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        status: BurstGroupStatus.resolved,
      });
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      const hashCandidatesCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(hashCandidatesCall.where.NOT).toEqual({ burstGroupId: 'burst-resolved-1' });
    });

    it('hash-candidate query has no NOT clause when the subject has no burstGroupId', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      const hashCandidatesCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(hashCandidatesCall.where.NOT).toBeUndefined();
    });

    it('hash-candidate query excludes candidates whose burstGroup is still pending (OR clause)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      const hashCandidatesCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(hashCandidatesCall.where.OR).toEqual([
        { burstGroupId: null },
        { burstGroup: { status: { not: BurstGroupStatus.pending } } },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // On-demand perceptual hash backfill for legacy items
  // -------------------------------------------------------------------------

  describe('on-demand perceptual hash backfill', () => {
    it('does not attempt hash backfill when perceptualHash is already set', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // evictFromDuplicateGroups — burst wins over duplicate detection: pull
  // members out of any duplicate group once they land in a burst group.
  // -------------------------------------------------------------------------

  describe('evictFromDuplicateGroups', () => {
    it('is a no-op when itemIds is empty (no Prisma calls made)', async () => {
      await service.evictFromDuplicateGroups([]);

      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('is a no-op when none of the given items currently belong to a duplicate group', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]); // "linked" query finds nothing

      await service.evictFromDuplicateGroups(['item-a', 'item-b']);

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['item-a', 'item-b'] }, duplicateGroupId: { not: null } },
        }),
      );
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.duplicateGroup.update).not.toHaveBeenCalled();
      expect(mockPrisma.duplicateGroup.delete).not.toHaveBeenCalled();
    });

    it('nulls duplicateGroupId on items currently in a duplicate group and recomputes the affected group', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'item-a', duplicateGroupId: 'group-1' },
          { id: 'item-b', duplicateGroupId: 'group-1' },
        ]) // linked query
        .mockResolvedValueOnce([
          { id: 'item-c', capturedAt: new Date('2026-06-01T00:00:00Z') },
          { id: 'item-d', capturedAt: new Date('2026-06-02T00:00:00Z') },
        ]); // recomputeGroupMeta: remaining active members
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

      await service.evictFromDuplicateGroups(['item-a', 'item-b']);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['item-a', 'item-b'] } },
        data: { duplicateGroupId: null },
      });
      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'group-1' },
          data: expect.objectContaining({ mediaCount: 2 }),
        }),
      );
    });

    it('recomputes each distinct affected group when evicted items span multiple duplicate groups', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'item-a', duplicateGroupId: 'group-x' },
          { id: 'item-b', duplicateGroupId: 'group-y' },
        ]) // linked query
        .mockResolvedValueOnce([
          { id: 'item-x2', capturedAt: new Date() },
          { id: 'item-x3', capturedAt: new Date() },
        ]) // recomputeGroupMeta for group-x
        .mockResolvedValueOnce([
          { id: 'item-y2', capturedAt: new Date() },
          { id: 'item-y3', capturedAt: new Date() },
        ]); // recomputeGroupMeta for group-y
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

      await service.evictFromDuplicateGroups(['item-a', 'item-b']);

      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'group-x' } }),
      );
      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'group-y' } }),
      );
    });

    it('shrinking a duplicate group to exactly 2 active members updates the group (does not delete it)', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'item-a', duplicateGroupId: 'group-shrink' }]) // evicting 1 of 3
        .mockResolvedValueOnce([
          { id: 'item-b', capturedAt: new Date() },
          { id: 'item-c', capturedAt: new Date() },
        ]); // 2 members remain
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

      await service.evictFromDuplicateGroups(['item-a']);

      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'group-shrink' },
          data: expect.objectContaining({ mediaCount: 2 }),
        }),
      );
      expect(mockPrisma.duplicateGroup.delete).not.toHaveBeenCalled();
    });

    it('shrinking a duplicate group to exactly 1 active member clears that member and deletes the group', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'item-a', duplicateGroupId: 'group-lone' }])
        .mockResolvedValueOnce([{ id: 'item-lone', capturedAt: new Date() }]); // 1 member remains
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.duplicateGroup.delete as jest.Mock).mockResolvedValue({});

      await service.evictFromDuplicateGroups(['item-a']);

      // Second updateMany call clears the lone survivor's duplicateGroupId
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'item-lone' },
        data: { duplicateGroupId: null },
      });
      expect(mockPrisma.duplicateGroup.delete).toHaveBeenCalledWith({ where: { id: 'group-lone' } });
      expect(mockPrisma.duplicateGroup.update).not.toHaveBeenCalled();
    });

    it('shrinking a duplicate group to 0 active members deletes the group (pre-existing behavior still holds)', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'item-a', duplicateGroupId: 'group-empty' }])
        .mockResolvedValueOnce([]); // no active members remain
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.duplicateGroup.delete as jest.Mock).mockResolvedValue({});

      await service.evictFromDuplicateGroups(['item-a']);

      expect(mockPrisma.duplicateGroup.delete).toHaveBeenCalledWith({ where: { id: 'group-empty' } });
      expect(mockPrisma.duplicateGroup.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // evictExistingBurstOverlaps — one-time remediation for items already
  // double-listed in both the burst and duplicate review queues.
  // -------------------------------------------------------------------------

  describe('evictExistingBurstOverlaps', () => {
    it('evicts only items that are BOTH in a duplicate group AND in a pending burst group, returning the evicted count', async () => {
      const overlapItems = [{ id: 'overlap-1' }, { id: 'overlap-2' }];
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce(overlapItems);
      const evictSpy = jest
        .spyOn(service, 'evictFromDuplicateGroups')
        .mockResolvedValue(undefined);

      const result = await service.evictExistingBurstOverlaps(CIRCLE_ID);

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: CIRCLE_ID,
            duplicateGroupId: { not: null },
            burstGroup: { status: BurstGroupStatus.pending },
          }),
        }),
      );
      expect(evictSpy).toHaveBeenCalledWith(['overlap-1', 'overlap-2']);
      expect(result).toEqual({ evicted: 2 });
    });

    it('omits the circleId filter from the query when circleId is not provided', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.evictExistingBurstOverlaps();

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.circleId).toBeUndefined();
    });

    it('returns { evicted: 0 } and does not call evictFromDuplicateGroups when no overlaps are found', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]);
      const evictSpy = jest.spyOn(service, 'evictFromDuplicateGroups');

      const result = await service.evictExistingBurstOverlaps(CIRCLE_ID);

      expect(result).toEqual({ evicted: 0 });
      expect(evictSpy).not.toHaveBeenCalled();
    });
  });
  // -------------------------------------------------------------------------
  // Compute/persist split — download-on-demand and persistDuplicate
  // -------------------------------------------------------------------------

  describe('compute/persist split', () => {
    async function makeRealJpeg(): Promise<Buffer> {
      const sharp = (await import('sharp')).default;
      return sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } },
      })
        .jpeg()
        .toBuffer();
    }

    function setupDownloadableObject(bytes: Buffer) {
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        storageKey: 'originals/photo.jpg',
        storageProvider: 's3',
        bucket: 'test-bucket',
      });
      mockProvider.download.mockResolvedValue(Readable.from([bytes]));
    }

    it('downloads once, computes, and persists BOTH hash and embedding when the hash is missing (real dHash pipeline)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: null }),
      );
      mockVisualEmbeddingService.hasEmbedding.mockResolvedValue(false);
      mockVisualEmbeddingService.embedImage.mockResolvedValue([0.1, 0.2, 0.3]);
      setupDownloadableObject(await makeRealJpeg());
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});

      await service.processMediaItem(SUBJECT_ID);

      expect(mockProvider.download).toHaveBeenCalledTimes(1);
      // Embedding persisted with the CLIP model tag
      expect(mockVisualEmbeddingService.persistEmbedding).toHaveBeenCalledWith(
        SUBJECT_ID,
        CIRCLE_ID,
        [0.1, 0.2, 0.3],
        'clip-vit-b32-q8',
      );
      // Hash persisted as an unsigned decimal string, sharpness alongside it
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUBJECT_ID },
          data: expect.objectContaining({
            perceptualHash: expect.stringMatching(/^\d+$/),
            sharpnessScore: expect.any(Number),
          }),
        }),
      );
      // Matching still ran after persistence
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it('propagates a byte-download failure when the hash is missing (worker retries)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: null }),
      );
      mockVisualEmbeddingService.hasEmbedding.mockResolvedValue(false);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        storageKey: 'originals/photo.jpg',
        storageProvider: 's3',
        bucket: 'test-bucket',
      });
      mockProvider.download.mockRejectedValue(new Error('S3 connection timeout'));

      await expect(service.processMediaItem(SUBJECT_ID)).rejects.toThrow('S3 connection timeout');
    });

    it('swallows a byte-download failure when only the embedding is missing (best-effort; hash matching proceeds)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      mockVisualEmbeddingService.hasEmbedding.mockResolvedValue(false);
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        storageKey: 'originals/photo.jpg',
        storageProvider: 's3',
        bucket: 'test-bucket',
      });
      mockProvider.download.mockRejectedValue(new Error('S3 connection timeout'));

      await expect(service.processMediaItem(SUBJECT_ID)).resolves.toBeUndefined();

      expect(mockVisualEmbeddingService.persistEmbedding).not.toHaveBeenCalled();
      expect(mockPrisma.$queryRaw).toHaveBeenCalled(); // matching still ran
    });

    it('computeDuplicate returns model tag + embedding + dHash + sharpness for decodable bytes', async () => {
      mockVisualEmbeddingService.embedImage.mockResolvedValue([0.5, 0.5]);

      const result = await service.computeDuplicate(await makeRealJpeg());

      expect(result.model).toBe('clip-vit-b32-q8');
      expect(result.embedding).toEqual([0.5, 0.5]);
      expect(result.dHash).toMatch(/^\d+$/);
      expect(result.sharpnessScore).not.toBeNull();
    });

    it('computeDuplicate returns null dHash/sharpness for undecodable bytes', async () => {
      mockVisualEmbeddingService.embedImage.mockResolvedValue(null);

      const result = await service.computeDuplicate(Buffer.from('this is not an image'));

      expect(result.embedding).toBeNull();
      expect(result.dHash).toBeNull();
      expect(result.sharpnessScore).toBeNull();
    });

    it('persistDuplicate persists a supplied result for the job media item and runs matching (no download)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ perceptualHash: null }),
      );
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      const job = { id: 'job-1', mediaItemId: SUBJECT_ID } as EnrichmentJob;
      const result: DuplicateComputeResult = {
        model: 'clip-vit-b32-q8',
        embedding: [0.9, 0.1],
        dHash: '42',
        sharpnessScore: 1.5,
      };

      await service.persistDuplicate(job, result);

      expect(mockProvider.download).not.toHaveBeenCalled();
      expect(mockVisualEmbeddingService.persistEmbedding).toHaveBeenCalledWith(
        SUBJECT_ID,
        CIRCLE_ID,
        [0.9, 0.1],
        'clip-vit-b32-q8',
      );
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUBJECT_ID },
          data: expect.objectContaining({ perceptualHash: '42', sharpnessScore: 1.5 }),
        }),
      );
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it('persistDuplicate never overwrites an existing perceptualHash', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      const job = { id: 'job-1', mediaItemId: SUBJECT_ID } as EnrichmentJob;

      await service.persistDuplicate(job, {
        model: 'clip-vit-b32-q8',
        embedding: null,
        dHash: '999',
        sharpnessScore: 2,
      });

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('persistDuplicate is a no-op for a job without a mediaItemId', async () => {
      const job = { id: 'job-1', mediaItemId: null } as EnrichmentJob;

      await service.persistDuplicate(job, {
        model: 'clip-vit-b32-q8',
        embedding: [0.1],
        dHash: '1',
        sharpnessScore: 0,
      });

      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      expect(mockVisualEmbeddingService.persistEmbedding).not.toHaveBeenCalled();
    });
  });
});
