/**
 * Unit tests for MediaTouchService (issue #310, epic #308 — Local Media Backup
 * via Worker Nodes).
 *
 * Covers the contract documented at the top of media-touch.service.ts:
 *   - chunks at 500 ids per updateMany call
 *   - deduplicates ids before chunking
 *   - no-ops (no DB call) on an empty array
 *   - explicitly sets `updatedAt = new Date()` (updateMany does not apply @updatedAt)
 *   - swallows a failed updateMany and logs a warning instead of throwing
 *   - uses the passed Prisma.TransactionClient instead of the injected PrismaService
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MediaTouchService } from './media-touch.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('MediaTouchService', () => {
  let service: MediaTouchService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaTouchService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MediaTouchService>(MediaTouchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // empty array — no-op
  // -------------------------------------------------------------------------

  it('no-ops on an empty array (no updateMany call)', async () => {
    await service.touchMediaItems([]);

    expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // dedupe
  // -------------------------------------------------------------------------

  it('deduplicates ids before writing', async () => {
    await service.touchMediaItems(['a', 'a', 'b', 'a', 'b']);

    expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledTimes(1);
    const call = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where.id.in).toEqual(['a', 'b']);
  });

  // -------------------------------------------------------------------------
  // explicit updatedAt
  // -------------------------------------------------------------------------

  it('explicitly sets updatedAt to a fresh Date (updateMany does not apply @updatedAt)', async () => {
    const before = Date.now();

    await service.touchMediaItems(['a']);

    const call = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.data.updatedAt).toBeInstanceOf(Date);
    const stamped = (call.data.updatedAt as Date).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  // -------------------------------------------------------------------------
  // chunking at 500
  // -------------------------------------------------------------------------

  describe('chunking', () => {
    it('issues a single updateMany call for exactly 500 ids', async () => {
      const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);

      await service.touchMediaItems(ids);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledTimes(1);
      const call = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where.id.in).toHaveLength(500);
    });

    it('splits 501 unique ids into two chunks (500 + 1)', async () => {
      const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);

      await service.touchMediaItems(ids);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledTimes(2);
      const calls = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(calls[0][0].where.id.in).toHaveLength(500);
      expect(calls[1][0].where.id.in).toHaveLength(1);
      expect(calls[1][0].where.id.in).toEqual(['id-500']);
    });

    it('splits 1200 unique ids into three chunks (500 + 500 + 200)', async () => {
      const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`);

      await service.touchMediaItems(ids);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledTimes(3);
      const calls = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(calls[0][0].where.id.in).toHaveLength(500);
      expect(calls[1][0].where.id.in).toHaveLength(500);
      expect(calls[2][0].where.id.in).toHaveLength(200);
    });

    it('deduplicates BEFORE chunking, so duplicates never inflate the chunk count', async () => {
      // 500 unique ids, each duplicated once => 1000 raw entries but still
      // only 500 unique ids => exactly one chunk, not two.
      const unique = Array.from({ length: 500 }, (_, i) => `id-${i}`);
      const withDupes = [...unique, ...unique];

      await service.touchMediaItems(withDupes);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // error swallowed with warning
  // -------------------------------------------------------------------------

  describe('best-effort error handling', () => {
    it('swallows an updateMany rejection and never throws', async () => {
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockRejectedValueOnce(
        new Error('db unavailable'),
      );

      await expect(service.touchMediaItems(['a'])).resolves.toBeUndefined();
    });

    it('logs a warning including the failure count and error message on rejection', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn');
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockRejectedValueOnce(
        new Error('db unavailable'),
      );

      await service.touchMediaItems(['a', 'b']);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to bump updatedAt on 2 item(s): db unavailable'),
      );
    });

    it('handles a non-Error rejection by stringifying it in the warning', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn');
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockRejectedValueOnce('boom');

      await service.touchMediaItems(['a']);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('stops issuing further chunk calls once a chunk throws (loop aborts on first failure)', async () => {
      const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
      (mockPrisma.mediaItem.updateMany as jest.Mock)
        .mockRejectedValueOnce(new Error('first chunk failed'))
        .mockResolvedValueOnce({ count: 500 });

      await service.touchMediaItems(ids);

      // Only the first chunk's call was attempted before the try/catch
      // swallowed the error and returned.
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // tx client used when passed
  // -------------------------------------------------------------------------

  describe('transaction client', () => {
    it('writes through the passed Prisma.TransactionClient instead of the injected PrismaService', async () => {
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const fakeTx = { mediaItem: { updateMany: txUpdateMany } } as any;

      await service.touchMediaItems(['a'], fakeTx);

      expect(txUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('still chunks at 500 when writing through a tx client', async () => {
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 500 });
      const fakeTx = { mediaItem: { updateMany: txUpdateMany } } as any;
      const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);

      await service.touchMediaItems(ids, fakeTx);

      expect(txUpdateMany).toHaveBeenCalledTimes(2);
    });

    it('swallows a tx-client failure the same as the default-client path', async () => {
      const txUpdateMany = jest.fn().mockRejectedValue(new Error('tx aborted'));
      const fakeTx = { mediaItem: { updateMany: txUpdateMany } } as any;

      await expect(service.touchMediaItems(['a'], fakeTx)).resolves.toBeUndefined();
    });
  });
});
