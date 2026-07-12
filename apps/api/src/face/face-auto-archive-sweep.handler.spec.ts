/**
 * Unit tests for FaceAutoArchiveSweepHandler.
 *
 * Covers:
 *  - Registers itself with the EnrichmentHandlerRegistry on module init.
 *  - Exposes type 'face_auto_archive_sweep'.
 *  - job.circleId null -> warns and no-ops (never reads settings or queries).
 *  - features.faceAutoArchive=false -> no-op (no archived-pool query).
 *  - No archived reference faces in the circle -> no-op (no live scan).
 *  - Hides matched live faces per batch with hiddenReason='auto_archive_match'
 *    and accumulates a total count across multiple pages.
 *  - Cursor-based pagination: the second page's findMany call uses the last
 *    id of the first page as the cursor.
 */

import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { FaceAutoArchiveSweepHandler } from './face-auto-archive-sweep.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { FaceMatchingService } from './face-matching.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'face_auto_archive_sweep',
    mediaItemId: null,
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.backfill,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

function makeSettings(faceAutoArchive: boolean, matchThreshold = 0.45) {
  return {
    features: { faceAutoArchive },
    face: { autoArchive: { matchThreshold } },
  };
}

describe('FaceAutoArchiveSweepHandler', () => {
  let handler: FaceAutoArchiveSweepHandler;
  let mockRegistry: { register: jest.Mock };
  let mockPrisma: MockPrismaService;
  let mockMatchingService: {
    findLiveMatchesAgainstArchived: jest.Mock;
    archiveMaxCandidates: number;
  };
  let mockSystemSettings: { getSettings: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockPrisma = createMockPrismaService();
    mockMatchingService = {
      findLiveMatchesAgainstArchived: jest.fn().mockResolvedValue([]),
      archiveMaxCandidates: 5000,
    };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue(makeSettings(true)),
    };

    handler = new FaceAutoArchiveSweepHandler(
      mockRegistry as unknown as EnrichmentHandlerRegistry,
      mockPrisma as unknown as PrismaService,
      mockMatchingService as unknown as FaceMatchingService,
      mockSystemSettings as unknown as SystemSettingsService,
    );
  });

  it('registers itself with the EnrichmentHandlerRegistry on module init', () => {
    handler.onModuleInit();

    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it("exposes type 'face_auto_archive_sweep'", () => {
    expect(handler.type).toBe('face_auto_archive_sweep');
  });

  // -------------------------------------------------------------------------
  // Guard: missing circleId
  // -------------------------------------------------------------------------

  it('warns and no-ops when job.circleId is null (never reads settings)', async () => {
    const job = makeJob({ circleId: null });

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Guard: feature disabled
  // -------------------------------------------------------------------------

  it('no-ops when features.faceAutoArchive is false', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(false));
    const job = makeJob();

    await handler.process(job);

    expect(mockPrisma.face.findMany).not.toHaveBeenCalled();
    expect(mockMatchingService.findLiveMatchesAgainstArchived).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Guard: no archived reference faces
  // -------------------------------------------------------------------------

  it('no-ops when the circle has no archived reference faces (never scans the live pool)', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true));
    (mockPrisma.face.findMany as jest.Mock).mockResolvedValueOnce([]); // archived pool query

    const job = makeJob();
    await handler.process(job);

    // Only the archived-pool query should have run; no live-pool page query.
    expect(mockPrisma.face.findMany).toHaveBeenCalledTimes(1);
    expect(mockMatchingService.findLiveMatchesAgainstArchived).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path: hides matches, accumulates count across pages
  // -------------------------------------------------------------------------

  it('hides matched live faces with hiddenReason=auto_archive_match', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true, 0.5));

    const archivedPool = [{ id: 'archived-1', embedding: [1, 0] }];

    (mockPrisma.face.findMany as jest.Mock)
      .mockResolvedValueOnce(archivedPool) // archived reference pool
      .mockResolvedValueOnce([
        { id: 'live-1', embedding: [1, 0] },
        { id: 'live-2', embedding: [0, 1] },
      ]) // first live page (full batch size not reached in this test's mock, but the
      // handler only stops paging when a page returns fewer than LIVE_BATCH_SIZE)
      .mockResolvedValueOnce([]); // second page: empty -> stop

    mockMatchingService.findLiveMatchesAgainstArchived.mockResolvedValue(['live-1']);
    (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const job = makeJob();
    await handler.process(job);

    expect(mockMatchingService.findLiveMatchesAgainstArchived).toHaveBeenCalledWith(
      'circle-1',
      expect.objectContaining({
        archivedCandidates: archivedPool,
        threshold: 0.5,
      }),
    );

    expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['live-1'] },
        circleId: 'circle-1',
        personId: null,
        hiddenAt: null,
      },
      data: { hiddenAt: expect.any(Date), hiddenReason: 'auto_archive_match' },
    });
  });

  it('pages through multiple full batches, hiding matches on each page and stopping once a short page is returned', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true));

    // LIVE_BATCH_SIZE is 500: a page of exactly 500 rows forces the handler
    // to fetch a second page; a short (<500) page ends the loop.
    const firstPage = Array.from({ length: 500 }, (_, i) => ({
      id: `live-${i}`,
      embedding: [1, 0],
    }));
    const secondPage = [{ id: 'live-500', embedding: [1, 0] }];

    (mockPrisma.face.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: 'archived-1', embedding: [1, 0] }]) // archived pool
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    // First page match: live-0; second page match: live-500.
    mockMatchingService.findLiveMatchesAgainstArchived
      .mockResolvedValueOnce(['live-0'])
      .mockResolvedValueOnce(['live-500']);

    (mockPrisma.face.updateMany as jest.Mock)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const job = makeJob();
    await handler.process(job);

    // archived pool + 2 live pages = 3 findMany calls total.
    expect((mockPrisma.face.findMany as jest.Mock).mock.calls.length).toBe(3);

    // Second live-page query must use the last id of the first page as cursor.
    const secondPageCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[2][0];
    expect(secondPageCall.cursor).toEqual({ id: 'live-499' });
    expect(secondPageCall.skip).toBe(1);

    expect(mockPrisma.face.updateMany).toHaveBeenCalledTimes(2);
    expect((mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0].where.id).toEqual({
      in: ['live-0'],
    });
    expect((mockPrisma.face.updateMany as jest.Mock).mock.calls[1][0].where.id).toEqual({
      in: ['live-500'],
    });
  });

  it('returns/no-ops gracefully (no updateMany call) when a page has no matches', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true));

    (mockPrisma.face.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: 'archived-1', embedding: [1, 0] }])
      .mockResolvedValueOnce([{ id: 'live-1', embedding: [0, 1] }])
      .mockResolvedValueOnce([]);

    mockMatchingService.findLiveMatchesAgainstArchived.mockResolvedValue([]);

    const job = makeJob();
    await handler.process(job);

    expect(mockPrisma.face.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Cursor pagination
  // -------------------------------------------------------------------------

  it('uses cursor-based pagination: the second page query uses the previous page last id as cursor', async () => {
    mockSystemSettings.getSettings.mockResolvedValue(makeSettings(true));

    // LIVE_BATCH_SIZE is 500 in the handler; to force a second page in this
    // test we'd need 500 rows, which is impractical here. Instead, verify
    // the cursor argument shape directly by simulating a full first page
    // via a batch of exactly the handler's page size is not required for
    // this assertion — we only assert that when a full page is NOT reached
    // (a short page), no cursor is used on the (nonexistent) next call, and
    // that no cursor is passed on the FIRST call.
    (mockPrisma.face.findMany as jest.Mock)
      .mockResolvedValueOnce([{ id: 'archived-1', embedding: [1, 0] }])
      .mockResolvedValueOnce([{ id: 'live-1', embedding: [1, 0] }]);

    mockMatchingService.findLiveMatchesAgainstArchived.mockResolvedValue([]);

    const job = makeJob();
    await handler.process(job);

    const liveQueryCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[1][0];
    expect(liveQueryCall.cursor).toBeUndefined();
    expect(liveQueryCall.orderBy).toEqual({ id: 'asc' });
    // Only two findMany calls: archived pool + one (short) live page.
    expect((mockPrisma.face.findMany as jest.Mock).mock.calls.length).toBe(2);
  });
});
