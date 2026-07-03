/**
 * Unit tests for DuplicateDetectionService.
 *
 * Covers:
 *  - Guards: non-photo, deleted, archived items are skipped entirely
 *  - Guards: item in a PENDING burst group is skipped entirely (burst review
 *    may soft-delete/reshuffle members concurrently)
 *  - Link-rule matrix: embedding-only match, hash-only match, both, neither
 *  - Degraded mode: embedding unavailable ('unavailable') — hash-only linking
 *    still works because the KNN query naturally returns zero rows
 *  - Union-find grouping: no existing group -> create; one existing group ->
 *    join (+ mediaCount increment via recomputeGroupMeta); multiple existing
 *    groups -> merge into the oldest and delete the emptied groups
 *  - Burst-overlap exclusions: candidates sharing the subject's burstGroupId
 *    are excluded from hash-candidate query filters
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { VisualEmbeddingService } from './visual-embedding.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { BurstGroupStatus, MediaType } from '@prisma/client';

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
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockVisualEmbeddingService: { ensureEmbedding: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockResolver = { getProviderFor: jest.fn() };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({ dedup: DEDUP_CONFIG }),
    };
    mockVisualEmbeddingService = {
      ensureEmbedding: jest.fn().mockResolvedValue('exists'),
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

      expect(mockVisualEmbeddingService.ensureEmbedding).not.toHaveBeenCalled();
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    });

    it('returns early when the mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ deletedAt: new Date() }),
      );

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.ensureEmbedding).not.toHaveBeenCalled();
    });

    it('returns early when the mediaItem is archived', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ archivedAt: new Date() }),
      );

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.ensureEmbedding).not.toHaveBeenCalled();
    });

    it('returns early when the mediaItem is not a photo', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ type: MediaType.video }),
      );

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.ensureEmbedding).not.toHaveBeenCalled();
    });

    it('skips entirely when the item is in a PENDING burst group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ burstGroupId: 'burst-1' }),
      );
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        status: BurstGroupStatus.pending,
      });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.ensureEmbedding).not.toHaveBeenCalled();
    });

    it('proceeds when the item is in a RESOLVED (non-pending) burst group', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeSubjectItem({ burstGroupId: 'burst-1' }),
      );
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        status: BurstGroupStatus.resolved,
      });

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.ensureEmbedding).toHaveBeenCalledWith(SUBJECT_ID);
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
    it('still links via hash-only matching when ensureEmbedding returns "unavailable"', async () => {
      mockVisualEmbeddingService.ensureEmbedding.mockResolvedValue('unavailable');
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

    it('calls ensureEmbedding regardless of outcome (best-effort, never blocks hash matching)', async () => {
      mockVisualEmbeddingService.ensureEmbedding.mockResolvedValue('unavailable');
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeSubjectItem());
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.processMediaItem(SUBJECT_ID);

      expect(mockVisualEmbeddingService.ensureEmbedding).toHaveBeenCalledWith(SUBJECT_ID);
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
});
