/**
 * Unit tests for MemoryBackfillService (epic #300, issue #315).
 *
 * The three properties worth pinning down here are the ones an admin actually
 * depends on, and none of them is a curator's behaviour:
 *
 *  1. CHUNKING. A backfill must enqueue the whole shard plan per circle — one
 *     job per On This Day month plus one per remaining curator — because a
 *     single unsharded job can approach ENRICHMENT_JOB_TIMEOUT_MS on a 70k-item
 *     library. Every row must carry `backfill: true`, background priority 100,
 *     `skipDedup: true` and a divided AI-title cap.
 *  2. IN-FLIGHT SKIPPING. A circle already generating is skipped and counted,
 *     so the button is safe to double-click.
 *  3. IT NEVER PARTIALLY FAILS THE SWEEP. One bad enqueue is logged and the
 *     rest of the deployment still gets its backfill.
 *
 * No database: PrismaService and EnrichmentJobService are fully mocked, the
 * same shape as MemoriesGenerationTask's spec.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { JobReason, JobStatus } from '@prisma/client';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MEMORY_GENERATION_JOB_TYPE } from '../memories-generation.task';
import { MemoryBackfillService } from './memory-backfill.service';
import {
  MEMORY_BACKFILL_AI_TITLE_CAP_PER_SHARD,
  MEMORY_BACKFILL_SHARDS,
} from './memory-backfill.shards';

const SHARDS = MEMORY_BACKFILL_SHARDS.length;

describe('MemoryBackfillService', () => {
  let service: MemoryBackfillService;
  let prisma: {
    circle: { findMany: jest.Mock; findUnique: jest.Mock };
    enrichmentJob: { findMany: jest.Mock };
  };
  let enrichment: { enqueue: jest.Mock };

  beforeEach(async () => {
    prisma = {
      circle: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      enrichmentJob: { findMany: jest.fn().mockResolvedValue([]) },
    };
    enrichment = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryBackfillService,
        { provide: PrismaService, useValue: prisma },
        { provide: EnrichmentJobService, useValue: enrichment },
      ],
    }).compile();
    module.useLogger(false);

    service = module.get(MemoryBackfillService);
  });

  // -------------------------------------------------------------------------
  describe('the shard plan', () => {
    it('covers all twelve calendar months for on_this_day', () => {
      const months = MEMORY_BACKFILL_SHARDS.filter((s) =>
        s.curators.includes('on_this_day'),
      ).flatMap((s) => [...(s.anchorMonths ?? [])]);

      expect([...months].sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
    });

    it('gives every other curator exactly one shard and no month filter', () => {
      const others = MEMORY_BACKFILL_SHARDS.filter((s) => !s.curators.includes('on_this_day'));

      expect(others.map((s) => s.curators).flat().sort()).toEqual([
        'person_highlights',
        'person_over_years',
        'seasonal',
        'theme',
        'trip',
        'year_in_review',
      ]);
      expect(others.every((s) => s.anchorMonths === undefined)).toBe(true);
    });

    it('divides the AI-title budget rather than multiplying it', () => {
      // The whole point of the division: a sharded backfill must not cost N x
      // the per-job cap #306 chose.
      expect(MEMORY_BACKFILL_AI_TITLE_CAP_PER_SHARD).toBeGreaterThanOrEqual(1);
      expect(MEMORY_BACKFILL_AI_TITLE_CAP_PER_SHARD * SHARDS).toBeLessThanOrEqual(100);
    });
  });

  // -------------------------------------------------------------------------
  describe('all circles', () => {
    it('enqueues the whole shard plan for every circle', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }]);

      const result = await service.backfillLibrary();

      expect(result).toEqual({ enqueued: SHARDS * 2, circles: 2, skipped: 0 });
      expect(enrichment.enqueue).toHaveBeenCalledTimes(SHARDS * 2);
    });

    it('enqueues background-priority, dedup-skipping backfill jobs', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'c1' }]);

      await service.backfillLibrary();

      for (const call of enrichment.enqueue.mock.calls) {
        expect(call[0]).toMatchObject({
          type: MEMORY_GENERATION_JOB_TYPE,
          mediaItemId: null,
          circleId: 'c1',
          reason: JobReason.backfill,
          priority: 100,
          skipDedup: true,
        });
        expect(call[0].payload).toMatchObject({
          backfill: true,
          aiTitleCap: MEMORY_BACKFILL_AI_TITLE_CAP_PER_SHARD,
        });
        expect(Array.isArray(call[0].payload.curators)).toBe(true);
      }
    });

    it('produces one on_this_day job per month', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'c1' }]);

      await service.backfillLibrary();

      const months = enrichment.enqueue.mock.calls
        .map((call) => call[0].payload)
        .filter((p: { curators: string[] }) => p.curators.includes('on_this_day'))
        .flatMap((p: { anchorMonths?: number[] }) => p.anchorMonths ?? []);

      expect(months).toHaveLength(12);
      expect(new Set(months).size).toBe(12);
    });

    it('pages through circles with a keyset cursor', async () => {
      // 100 is the page size — a full page must trigger a second read.
      const page1 = Array.from({ length: 100 }, (_u, i) => ({ id: `c${i}` }));
      prisma.circle.findMany
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce([{ id: 'last' }]);

      const result = await service.backfillLibrary();

      expect(prisma.circle.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.circle.findMany.mock.calls[1]![0]).toMatchObject({
        cursor: { id: 'c99' },
        skip: 1,
      });
      expect(result.circles).toBe(101);
    });

    it('returns zeroes when there are no circles', async () => {
      const result = await service.backfillLibrary();

      expect(result).toEqual({ enqueued: 0, circles: 0, skipped: 0 });
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('in-flight skipping', () => {
    it('skips a circle that already has a generation job pending or running', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'busy' }, { id: 'free' }]);
      prisma.enrichmentJob.findMany.mockResolvedValueOnce([{ circleId: 'busy' }]);

      const result = await service.backfillLibrary();

      expect(result).toEqual({ enqueued: SHARDS, circles: 1, skipped: 1 });
      expect(
        enrichment.enqueue.mock.calls.every((call) => call[0].circleId === 'free'),
      ).toBe(true);
    });

    it('checks in-flight jobs once per page, not once per circle', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);

      await service.backfillLibrary();

      expect(prisma.enrichmentJob.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.enrichmentJob.findMany.mock.calls[0]![0]).toMatchObject({
        where: {
          type: MEMORY_GENERATION_JOB_TYPE,
          circleId: { in: ['c1', 'c2', 'c3'] },
          status: { in: [JobStatus.pending, JobStatus.running] },
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('single circle', () => {
    it('enqueues only that circle and never pages', async () => {
      prisma.circle.findUnique.mockResolvedValueOnce({ id: 'c9' });

      const result = await service.backfillLibrary({ circleId: 'c9' });

      expect(result).toEqual({ enqueued: SHARDS, circles: 1, skipped: 0 });
      expect(prisma.circle.findMany).not.toHaveBeenCalled();
    });

    it('throws NotFound for an unknown circle rather than reporting success', async () => {
      prisma.circle.findUnique.mockResolvedValueOnce(null);

      await expect(service.backfillLibrary({ circleId: 'nope' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });

    it('still honours the in-flight skip', async () => {
      prisma.circle.findUnique.mockResolvedValueOnce({ id: 'c9' });
      prisma.enrichmentJob.findMany.mockResolvedValueOnce([{ circleId: 'c9' }]);

      const result = await service.backfillLibrary({ circleId: 'c9' });

      expect(result).toEqual({ enqueued: 0, circles: 0, skipped: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe('failure isolation', () => {
    it('keeps going when one shard enqueue throws', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'c1' }]);
      enrichment.enqueue
        .mockRejectedValueOnce(new Error('deadlock'))
        .mockResolvedValue({ id: 'job' });

      const result = await service.backfillLibrary();

      expect(result).toEqual({ enqueued: SHARDS - 1, circles: 1, skipped: 0 });
    });

    it('does not count a circle whose every shard failed', async () => {
      prisma.circle.findMany.mockResolvedValueOnce([{ id: 'c1' }]);
      enrichment.enqueue.mockRejectedValue(new Error('down'));

      const result = await service.backfillLibrary();

      expect(result).toEqual({ enqueued: 0, circles: 0, skipped: 0 });
    });
  });
});
