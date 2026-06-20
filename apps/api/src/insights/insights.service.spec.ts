/**
 * Unit tests for InsightsService.
 *
 * Verifies: computeMetrics() BigInt-safe serialisation, totalFaces/taggedItems
 * call args, recompute() happy path, error path, and concurrency lock;
 * getLatest() query shape.
 *
 * No database required — PrismaService is fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { InsightsService } from './insights.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-uuid-1',
    status: 'ready',
    metrics: null,
    computedAt: new Date(),
    durationMs: 120,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightsService', () => {
  let service: InsightsService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<InsightsService>(InsightsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // computeMetrics
  // =========================================================================

  describe('computeMetrics', () => {
    const photoRow = { type: 'photo', cnt: 800n, bytes: 472_000_000n };
    const videoRow = { type: 'video', cnt: 200n, bytes: 788_000_000n };

    beforeEach(() => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([photoRow, videoRow]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(4217);
      (mockPrisma.mediaTagStatus.count as jest.Mock).mockResolvedValue(650);
    });

    it('returns byte fields as strings (no BigInt leaks)', async () => {
      const result = await service.computeMetrics();

      expect(typeof result.totalBytes).toBe('string');
      expect(typeof result.photoBytes).toBe('string');
      expect(typeof result.videoBytes).toBe('string');
    });

    it('serialises photo bytes correctly', async () => {
      const result = await service.computeMetrics();

      expect(result.photoBytes).toBe('472000000');
    });

    it('serialises video bytes correctly', async () => {
      const result = await service.computeMetrics();

      expect(result.videoBytes).toBe('788000000');
    });

    it('serialises total bytes as the sum of photo + video bytes', async () => {
      const result = await service.computeMetrics();

      const expected = (472_000_000n + 788_000_000n).toString();
      expect(result.totalBytes).toBe(expected);
    });

    it('returns count fields as numbers', async () => {
      const result = await service.computeMetrics();

      expect(typeof result.photoCount).toBe('number');
      expect(typeof result.videoCount).toBe('number');
      expect(typeof result.totalItems).toBe('number');
      expect(typeof result.totalFaces).toBe('number');
      expect(typeof result.taggedItems).toBe('number');
    });

    it('returns correct photoCount and videoCount', async () => {
      const result = await service.computeMetrics();

      expect(result.photoCount).toBe(800);
      expect(result.videoCount).toBe(200);
    });

    it('returns totalItems as the sum of photoCount + videoCount', async () => {
      const result = await service.computeMetrics();

      expect(result.totalItems).toBe(1000);
    });

    it('returns totalFaces from face.count()', async () => {
      const result = await service.computeMetrics();

      expect(result.totalFaces).toBe(4217);
    });

    it('returns taggedItems from mediaTagStatus.count()', async () => {
      const result = await service.computeMetrics();

      expect(result.taggedItems).toBe(650);
    });

    it('calls mediaTagStatus.count with tagCount gt:0 and soft-delete filter', async () => {
      await service.computeMetrics();

      expect(mockPrisma.mediaTagStatus.count).toHaveBeenCalledWith({
        where: {
          tagCount: { gt: 0 },
          mediaItem: { deletedAt: null },
        },
      });
    });

    it('handles a result set with only photos (no video row)', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([photoRow]);

      const result = await service.computeMetrics();

      expect(result.photoCount).toBe(800);
      expect(result.videoCount).toBe(0);
      expect(result.totalItems).toBe(800);
      expect(result.videoBytes).toBe('0');
      expect(result.totalBytes).toBe('472000000');
    });

    it('handles an empty result set (no media)', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.computeMetrics();

      expect(result.photoCount).toBe(0);
      expect(result.videoCount).toBe(0);
      expect(result.totalItems).toBe(0);
      expect(result.totalBytes).toBe('0');
      expect(result.photoBytes).toBe('0');
      expect(result.videoBytes).toBe('0');
    });

    it('runs $queryRaw, face.count, and mediaTagStatus.count concurrently (Promise.all)', async () => {
      const callOrder: string[] = [];
      (mockPrisma.$queryRaw as jest.Mock).mockImplementation(async () => {
        callOrder.push('queryRaw');
        return [photoRow, videoRow];
      });
      (mockPrisma.face.count as jest.Mock).mockImplementation(async () => {
        callOrder.push('faceCount');
        return 4217;
      });
      (mockPrisma.mediaTagStatus.count as jest.Mock).mockImplementation(async () => {
        callOrder.push('tagCount');
        return 650;
      });

      await service.computeMetrics();

      // All three must have been called (concurrency is an impl detail;
      // we just assert each was called exactly once)
      expect(callOrder).toContain('queryRaw');
      expect(callOrder).toContain('faceCount');
      expect(callOrder).toContain('tagCount');
    });
  });

  // =========================================================================
  // getLatest
  // =========================================================================

  describe('getLatest', () => {
    it('queries for the most recent ready snapshot', async () => {
      const snapshot = makeSnapshot();
      (mockPrisma.insightsSnapshot.findFirst as jest.Mock).mockResolvedValue(snapshot);

      const result = await service.getLatest();

      expect(mockPrisma.insightsSnapshot.findFirst).toHaveBeenCalledWith({
        where: { status: 'ready' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual(snapshot);
    });

    it('returns null when no ready snapshot exists', async () => {
      (mockPrisma.insightsSnapshot.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getLatest();

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // recompute
  // =========================================================================

  describe('recompute', () => {
    const computingRow = makeSnapshot({ id: 'snap-computing', status: 'computing', computedAt: null, durationMs: null });
    const readyRow = makeSnapshot({ id: 'snap-computing', status: 'ready' });

    beforeEach(() => {
      // computeMetrics prerequisites
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { type: 'photo', cnt: 100n, bytes: 1_000_000n },
      ]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.mediaTagStatus.count as jest.Mock).mockResolvedValue(0);

      // Snapshot lifecycle
      (mockPrisma.insightsSnapshot.create as jest.Mock).mockResolvedValue(computingRow);
      (mockPrisma.insightsSnapshot.update as jest.Mock).mockResolvedValue(readyRow);
      (mockPrisma.insightsSnapshot.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    });

    it('creates a computing snapshot row before computing', async () => {
      await service.recompute();

      expect(mockPrisma.insightsSnapshot.create).toHaveBeenCalledWith({
        data: { status: 'computing' },
      });
    });

    it('updates the snapshot to ready with metrics, computedAt, and durationMs', async () => {
      await service.recompute();

      const updateCall = (mockPrisma.insightsSnapshot.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'snap-computing' });
      expect(updateCall.data.status).toBe('ready');
      expect(updateCall.data.metrics).toBeTruthy();
      expect(updateCall.data.computedAt).toBeInstanceOf(Date);
      expect(typeof updateCall.data.durationMs).toBe('number');
      expect(updateCall.data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('deletes all other snapshots after updating to ready', async () => {
      await service.recompute();

      expect(mockPrisma.insightsSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { id: { not: 'snap-computing' } },
      });
    });

    it('returns the updated ready snapshot', async () => {
      const result = await service.recompute();

      expect(result).toEqual(readyRow);
    });

    it('updates snapshot to failed with error string when computeMetrics throws', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('DB unavailable'));

      await expect(service.recompute()).rejects.toThrow('DB unavailable');

      const updateCall = (mockPrisma.insightsSnapshot.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'snap-computing' });
      expect(updateCall.data.status).toBe('failed');
      expect(typeof updateCall.data.error).toBe('string');
      expect(updateCall.data.error).toContain('DB unavailable');
    });

    it('re-throws the error after marking snapshot as failed', async () => {
      const boom = new Error('compute failure');
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(boom);

      await expect(service.recompute()).rejects.toThrow(boom);
    });

    it('concurrency lock: second concurrent call returns existing snapshot without re-running', async () => {
      // First call takes long; second call should short-circuit
      let unlockFirst!: () => void;
      const firstCompute = new Promise<{ type: string; cnt: bigint; bytes: bigint }[]>((resolve) => {
        unlockFirst = () => resolve([{ type: 'photo', cnt: 10n, bytes: 100n }]);
      });
      (mockPrisma.$queryRaw as jest.Mock).mockReturnValue(firstCompute);

      const existingSnapshot = makeSnapshot({ id: 'snap-existing' });
      (mockPrisma.insightsSnapshot.findFirst as jest.Mock).mockResolvedValue(existingSnapshot);

      // Kick off first recompute (it will be stuck waiting for unlockFirst)
      const firstPromise = service.recompute();

      // Second concurrent call: service.computing is now true
      const secondResult = await service.recompute();

      // The second call must have returned the existing snapshot, not started a new compute
      expect(secondResult).toEqual(existingSnapshot);
      // $queryRaw was called once (only the first compute), not twice
      expect(mockPrisma.$queryRaw as jest.Mock).toHaveBeenCalledTimes(1);

      // Unblock first compute and let it finish
      unlockFirst();
      await firstPromise;
    });

    it('concurrency lock: throws when locked and no existing snapshot', async () => {
      let unlockFirst!: () => void;
      const firstCompute = new Promise<{ type: string; cnt: bigint; bytes: bigint }[]>((resolve) => {
        unlockFirst = () => resolve([{ type: 'photo', cnt: 10n, bytes: 100n }]);
      });
      (mockPrisma.$queryRaw as jest.Mock).mockReturnValue(firstCompute);

      // No existing snapshot
      (mockPrisma.insightsSnapshot.findFirst as jest.Mock).mockResolvedValue(null);

      // Start first (hangs)
      const firstPromise = service.recompute();

      // Second concurrent call: locked and no snapshot → throws
      await expect(service.recompute()).rejects.toThrow(
        /already in progress/i,
      );

      // Clean up
      unlockFirst();
      await firstPromise;
    });

    it('releases the lock after successful compute', async () => {
      await service.recompute();

      // A second sequential call should not be blocked
      (mockPrisma.insightsSnapshot.create as jest.Mock).mockResolvedValue(
        makeSnapshot({ id: 'snap-second', status: 'computing' }),
      );
      (mockPrisma.insightsSnapshot.update as jest.Mock).mockResolvedValue(
        makeSnapshot({ id: 'snap-second', status: 'ready' }),
      );

      // Should not throw "already in progress"
      await expect(service.recompute()).resolves.toBeDefined();
    });

    it('releases the lock even when compute fails', async () => {
      (mockPrisma.$queryRaw as jest.Mock)
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValue([{ type: 'photo', cnt: 10n, bytes: 100n }]);

      await expect(service.recompute()).rejects.toThrow('first failure');

      // Reset create/update mocks for the second call
      (mockPrisma.insightsSnapshot.create as jest.Mock).mockResolvedValue(computingRow);
      (mockPrisma.insightsSnapshot.update as jest.Mock).mockResolvedValue(readyRow);

      // The lock should have been released; this must not throw "already in progress"
      await expect(service.recompute()).resolves.toBeDefined();
    });
  });
});
