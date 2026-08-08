/**
 * Unit tests for PictureEnhancementPurgeHandler (retention sweep, spec §13).
 *
 * Mirrors trash-purge.handler.spec.ts: fully mocked collaborators, no
 * database required. Verifies the handler reads
 * pictureEnhancement.retentionHours (with a 168h fallback), only targets
 * ready/failed rows past the cutoff, best-effort deletes staged bytes, and
 * always transitions matched rows to `expired` regardless of whether the
 * staging delete succeeded.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MediaEnhancementStatus } from '@prisma/client';
import type { EnrichmentJob } from '@prisma/client';
import { PictureEnhancementPurgeHandler } from './picture-enhancement-purge.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-purge-1',
    type: 'picture_enhancement_purge',
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

function makeRow(overrides: Record<string, any> = {}) {
  return {
    id: 'enh-1',
    status: MediaEnhancementStatus.ready,
    stagingStorageKey: 'enhancements/enh-1/result.jpg',
    stagingThumbnailKey: 'enhancements/enh-1/thumb.jpg',
    stagingProvider: 'r2',
    stagingBucket: 'active-bucket',
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PictureEnhancementPurgeHandler', () => {
  let handler: PictureEnhancementPurgeHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockPrisma: MockPrismaService;
  let mockResolver: { getProviderFor: jest.Mock };
  let mockDeleteFn: jest.Mock;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;

  beforeEach(async () => {
    mockRegistry = { register: jest.fn() };
    mockPrisma = createMockPrismaService();
    mockDeleteFn = jest.fn().mockResolvedValue(undefined);
    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue({ delete: mockDeleteFn }),
    };
    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(72),  // explicit setting overrides the default
    };

    (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.mediaEnhancement.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PictureEnhancementPurgeHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: SystemSettingsService, useValue: mockSettings },
      ],
    }).compile();

    handler = module.get<PictureEnhancementPurgeHandler>(PictureEnhancementPurgeHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('has type === "picture_enhancement_purge"', () => {
    expect(handler.type).toBe('picture_enhancement_purge');
  });

  it('registers itself with the EnrichmentHandlerRegistry on module init', () => {
    handler.onModuleInit();
    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it('queries only ready/failed rows past the cutoff, using the configured retentionHours', async () => {
    await handler.process(makeJob());

    expect(mockSettings.getSettingValue).toHaveBeenCalledWith('pictureEnhancement.retentionHours');
    expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: [MediaEnhancementStatus.ready, MediaEnhancementStatus.failed] },
        updatedAt: { lt: expect.any(Date) },
      },
    });
  });

  it('falls back to a 168h retention window when the setting is unset', async () => {
    mockSettings.getSettingValue.mockResolvedValue(undefined as any);
    const before = Date.now();

    await handler.process(makeJob());

    const cutoff: Date = (mockPrisma.mediaEnhancement.findMany as jest.Mock).mock.calls[0][0].where.updatedAt.lt;
    const expectedCutoffMs = before - 168 * 3_600_000;
    // Allow a small tolerance for test execution time.
    expect(Math.abs(cutoff.getTime() - expectedCutoffMs)).toBeLessThan(5000);
  });

  it('does nothing further when no rows are past the cutoff', async () => {
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([]);

    await handler.process(makeJob());

    expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
  });

  it('deletes the staged bytes and transitions a matched row to expired', async () => {
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([makeRow()] as any);

    await handler.process(makeJob());

    expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'active-bucket');
    // Both staged objects are reaped: the full-resolution result AND its
    // thumbnail derivative (issue #203).
    expect(mockDeleteFn).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
    expect(mockDeleteFn).toHaveBeenCalledWith('enhancements/enh-1/thumb.jpg');
    expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
      where: { id: 'enh-1' },
      data: {
        status: MediaEnhancementStatus.expired,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });
  });

  it('handles multiple candidate rows in one sweep', async () => {
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([
      makeRow({ id: 'enh-1' }),
      makeRow({
        id: 'enh-2',
        status: MediaEnhancementStatus.failed,
        stagingStorageKey: 'enhancements/enh-2/result.jpg',
        stagingThumbnailKey: 'enhancements/enh-2/thumb.jpg',
      }),
    ] as any);

    await handler.process(makeJob());

    expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
      where: { id: 'enh-1' },
      data: {
        status: MediaEnhancementStatus.expired,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });
    expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
      where: { id: 'enh-2' },
      data: {
        status: MediaEnhancementStatus.expired,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });
  });

  it('still expires the row (best-effort) even when the staging delete fails', async () => {
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([makeRow()] as any);
    mockDeleteFn.mockRejectedValue(new Error('object not found'));

    await expect(handler.process(makeJob())).resolves.toBeUndefined();

    expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
      where: { id: 'enh-1' },
      data: {
        status: MediaEnhancementStatus.expired,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });
  });

  it('deletes only the result when the row never got a thumbnail derivative', async () => {
    // Pre-#203 rows, and rows whose best-effort thumbnail render failed, carry
    // a null stagingThumbnailKey — the sweep must not attempt a delete for it.
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([
      makeRow({ stagingThumbnailKey: null }),
    ] as any);

    await handler.process(makeJob());

    expect(mockDeleteFn).toHaveBeenCalledTimes(1);
    expect(mockDeleteFn).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
  });

  it('still deletes the thumbnail when deleting the result fails (independent best-effort)', async () => {
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([makeRow()] as any);
    mockDeleteFn.mockImplementation(async (key: string) => {
      if (key.endsWith('result.jpg')) throw new Error('object not found');
    });

    await expect(handler.process(makeJob())).resolves.toBeUndefined();

    expect(mockDeleteFn).toHaveBeenCalledWith('enhancements/enh-1/thumb.jpg');
  });

  it('skips the staging delete call entirely for a row with no stagingStorageKey (still expires it)', async () => {
    mockPrisma.mediaEnhancement.findMany.mockResolvedValue([
      makeRow({
        stagingStorageKey: null,
        stagingThumbnailKey: null,
        stagingProvider: null,
      }),
    ] as any);

    await handler.process(makeJob());

    expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
      where: { id: 'enh-1' },
      data: {
        status: MediaEnhancementStatus.expired,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });
  });

  it('never touches applied/discarded/expired/pending/processing rows (query-level exclusion)', async () => {
    // The findMany where-clause itself excludes these statuses; this test
    // documents that contract rather than re-implementing the query.
    await handler.process(makeJob());

    const where = (mockPrisma.mediaEnhancement.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status.in).toEqual([MediaEnhancementStatus.ready, MediaEnhancementStatus.failed]);
    expect(where.status.in).not.toContain(MediaEnhancementStatus.applied);
    expect(where.status.in).not.toContain(MediaEnhancementStatus.discarded);
    expect(where.status.in).not.toContain(MediaEnhancementStatus.expired);
    expect(where.status.in).not.toContain(MediaEnhancementStatus.pending);
    expect(where.status.in).not.toContain(MediaEnhancementStatus.processing);
  });
});
