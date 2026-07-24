/**
 * Unit tests for TrashPurgeHandler.
 *
 * Verifies: handler type constant; onModuleInit registers with the registry;
 * process() reads retentionDays from settings, computes the cutoff, finds
 * expired items, and calls mediaService.purgeMediaItemsBatched() (issue #165
 * — Empty Trash at scale switched this handler from the old per-item
 * purgeMediaItems to the batched purgeMediaItemsBatched, shared with the new
 * trash-empty execute-batch handler; see purgeMediaItemsBatched's own
 * coverage in archive-trash.service.spec.ts).
 *
 * No database required — all dependencies are fully mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TrashPurgeHandler } from './trash-purge.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import type { EnrichmentJob } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-trash-1',
    type: 'trash_purge',
    mediaItemId: null,
    circleId: null,
    status: 'running' as any,
    reason: 'backfill' as any,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrashPurgeHandler', () => {
  let handler: TrashPurgeHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;
  let mockMediaService: jest.Mocked<Pick<MediaService, 'purgeMediaItemsBatched'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockRegistry = {
      register: jest.fn(),
    };

    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(30),
    };

    mockMediaService = {
      purgeMediaItemsBatched: jest.fn().mockResolvedValue({ deleted: 0, failedIds: [] }),
    };

    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrashPurgeHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: SystemSettingsService, useValue: mockSettings },
        { provide: MediaService, useValue: mockMediaService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    handler = module.get<TrashPurgeHandler>(TrashPurgeHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant
  // =========================================================================

  describe('type', () => {
    it('has type === "trash_purge"', () => {
      expect(handler.type).toBe('trash_purge');
    });
  });

  // =========================================================================
  // onModuleInit — registers with the registry
  // =========================================================================

  describe('onModuleInit', () => {
    it('registers itself in the EnrichmentHandlerRegistry on init', () => {
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });

    it('registers exactly once per call', () => {
      const before = (mockRegistry.register as jest.Mock).mock.calls.length;
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledTimes(before + 1);
    });
  });

  // =========================================================================
  // process — happy path
  // =========================================================================

  describe('process', () => {
    it('reads retentionDays from storage.trash.retentionDays setting', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith('storage.trash.retentionDays');
    });

    it('uses default retentionDays of 30 when setting returns undefined', async () => {
      mockSettings.getSettingValue.mockResolvedValue(undefined);
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      // Should not throw; purgeMediaItemsBatched should NOT be called (no items)
      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: expect.objectContaining({ not: null }),
          }),
        }),
      );
    });

    it('queries mediaItem with deletedAt NOT null AND lt cutoff', async () => {
      mockSettings.getSettingValue.mockResolvedValue(30);
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      const where = call[0].where;

      // deletedAt must be not null AND lt some Date
      expect(where.deletedAt).toBeDefined();
      expect(where.deletedAt.not).toBeNull();
      const cutoff: Date = where.deletedAt.lt;
      expect(cutoff).toBeInstanceOf(Date);
      // Cutoff should be approximately now minus 30 days
      const thirtyDaysMs = 30 * 86_400_000;
      expect(cutoff.getTime()).toBeGreaterThan(before - thirtyDaysMs - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - thirtyDaysMs + 5000);
    });

    it('does NOT call purgeMediaItemsBatched when no expired items are found', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockMediaService.purgeMediaItemsBatched).not.toHaveBeenCalled();
    });

    it('calls purgeMediaItemsBatched with the ids of expired items', async () => {
      const expiredItems = [{ id: 'item-old-1' }, { id: 'item-old-2' }];
      mockPrisma.mediaItem.findMany.mockResolvedValue(expiredItems as any);
      mockMediaService.purgeMediaItemsBatched.mockResolvedValue({ deleted: 2, failedIds: [] });

      await handler.process(makeJob());

      expect(mockMediaService.purgeMediaItemsBatched).toHaveBeenCalledWith(['item-old-1', 'item-old-2']);
    });

    it('resolves without throwing when purgeMediaItemsBatched succeeds', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([{ id: 'item-1' }] as any);
      mockMediaService.purgeMediaItemsBatched.mockResolvedValue({ deleted: 1, failedIds: [] });

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });

    it('propagates errors thrown by purgeMediaItemsBatched (worker records lastError and retries)', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([{ id: 'item-1' }] as any);
      mockMediaService.purgeMediaItemsBatched.mockRejectedValue(new Error('S3 unavailable'));

      await expect(handler.process(makeJob())).rejects.toThrow('S3 unavailable');
    });

    it('propagates errors thrown by prisma.mediaItem.findMany', async () => {
      mockPrisma.mediaItem.findMany.mockRejectedValue(new Error('DB connection lost'));

      await expect(handler.process(makeJob())).rejects.toThrow('DB connection lost');
    });

    it('uses custom retentionDays from settings', async () => {
      mockSettings.getSettingValue.mockResolvedValue(7); // 7 days
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      const cutoff: Date = call[0].where.deletedAt.lt;
      const sevenDaysMs = 7 * 86_400_000;
      expect(cutoff.getTime()).toBeGreaterThan(before - sevenDaysMs - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - sevenDaysMs + 5000);
    });

    it('global job fields: mediaItemId and circleId are null', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      const job = makeJob({ mediaItemId: null, circleId: null });
      await handler.process(job);

      // Should still work — global job ignores these fields
      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
