/**
 * Unit tests for MemoriesGenerationTask (epic #300, issue #302).
 *
 * Covers the three gates in order — MEMORIES_ENABLED env kill-switch,
 * features.memories, and the per-circle (in-flight + interval) gate — plus the
 * `skipDedup: true` contract that keeps one job per circle rather than one job
 * for the whole deployment.
 *
 * No database required: PrismaService, EnrichmentJobService and
 * SystemSettingsService are fully mocked (same shape as
 * InsightsRefreshTask's spec).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, JobStatus } from '@prisma/client';
import {
  MEMORY_GENERATION_JOB_TYPE,
  MemoriesGenerationTask,
} from './memories-generation.task';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal resolved-settings stand-in with the two fields the task reads. */
function settingsWith(options: {
  enabled: boolean;
  intervalHours?: number;
}): any {
  return {
    features: { memories: options.enabled },
    memories:
      options.intervalHours === undefined
        ? undefined
        : { generation: { intervalHours: options.intervalHours } },
  };
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

describe('MemoriesGenerationTask', () => {
  let task: MemoriesGenerationTask;
  let prisma: {
    circle: { findMany: jest.Mock };
    enrichmentJob: { findMany: jest.Mock; groupBy: jest.Mock };
  };
  let enrichment: { enqueue: jest.Mock };
  let settings: { getSettings: jest.Mock };

  const originalEnv = process.env['MEMORIES_ENABLED'];

  beforeEach(async () => {
    prisma = {
      circle: { findMany: jest.fn().mockResolvedValue([]) },
      enrichmentJob: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    enrichment = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    settings = {
      getSettings: jest.fn().mockResolvedValue(settingsWith({ enabled: true })),
    };

    delete process.env['MEMORIES_ENABLED'];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoriesGenerationTask,
        { provide: PrismaService, useValue: prisma },
        { provide: EnrichmentJobService, useValue: enrichment },
        { provide: SystemSettingsService, useValue: settings },
      ],
    }).compile();

    task = module.get(MemoriesGenerationTask);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['MEMORIES_ENABLED'];
    else process.env['MEMORIES_ENABLED'] = originalEnv;
  });

  // -------------------------------------------------------------------------
  // Gating — the "zero background cost when off" contract
  // -------------------------------------------------------------------------

  describe('gating', () => {
    it('enqueues nothing and reads NOTHING when MEMORIES_ENABLED=false', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);

      await task.handleScheduledGeneration();

      expect(enrichment.enqueue).not.toHaveBeenCalled();
      // The env kill-switch short-circuits before even the cached settings read.
      expect(settings.getSettings).not.toHaveBeenCalled();
      expect(prisma.circle.findMany).not.toHaveBeenCalled();
    });

    it('enqueues nothing and never pages circles when features.memories is off (the default)', async () => {
      settings.getSettings.mockResolvedValue(settingsWith({ enabled: false }));
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);

      await task.handleScheduledGeneration();

      expect(enrichment.enqueue).not.toHaveBeenCalled();
      // One cached settings read is the entire cost of a disabled tick.
      expect(settings.getSettings).toHaveBeenCalledTimes(1);
      expect(prisma.circle.findMany).not.toHaveBeenCalled();
    });

    it('treats an absent features.memories key as off', async () => {
      settings.getSettings.mockResolvedValue({ features: {} } as any);

      const result = await task.sweep();

      expect(result.enqueued).toBe(0);
      expect(prisma.circle.findMany).not.toHaveBeenCalled();
    });

    it('MEMORIES_ENABLED=false overrides features.memories=true', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';
      settings.getSettings.mockResolvedValue(settingsWith({ enabled: true }));

      // sweep() re-checks via isMemoriesEnabled, so even the direct call is safe.
      const result = await task.sweep();

      expect(result.enqueued).toBe(0);
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Per-circle enqueue
  // -------------------------------------------------------------------------

  describe('per-circle enqueue', () => {
    it('enqueues ONE job per circle, each with skipDedup: true', async () => {
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ]);

      const result = await task.sweep();

      expect(result).toMatchObject({ circles: 2, enqueued: 2, skipped: 0, errors: 0 });
      expect(enrichment.enqueue).toHaveBeenCalledTimes(2);
      for (const circleId of ['circle-a', 'circle-b']) {
        expect(enrichment.enqueue).toHaveBeenCalledWith({
          type: MEMORY_GENERATION_JOB_TYPE,
          mediaItemId: null,
          circleId,
          reason: JobReason.backfill,
          priority: 100,
          // Without this, the (type, mediaItemId IS NULL) global dedup would
          // collapse both circles into a single job.
          skipDedup: true,
        });
      }
    });

    it('enqueues for a circle that has never generated (no succeeded job)', async () => {
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);
      prisma.enrichmentJob.groupBy.mockResolvedValue([]);

      const result = await task.sweep();

      expect(result.enqueued).toBe(1);
    });

    it('skips a circle whose job is already pending or running', async () => {
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ]);
      prisma.enrichmentJob.findMany.mockResolvedValue([{ circleId: 'circle-a' }]);

      const result = await task.sweep();

      expect(result).toMatchObject({ enqueued: 1, skipped: 1 });
      expect(enrichment.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-b' }),
      );
      // The in-flight lookup is scoped to pending+running only.
      expect(prisma.enrichmentJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [JobStatus.pending, JobStatus.running] },
          }),
        }),
      );
    });

    it('isolates a per-circle enqueue failure without aborting the sweep', async () => {
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
      ]);
      enrichment.enqueue
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ id: 'job-2' });

      const result = await task.sweep();

      expect(result).toMatchObject({ circles: 2, enqueued: 1, errors: 1 });
    });

    it('never throws out of the cron even when the sweep blows up', async () => {
      prisma.circle.findMany.mockRejectedValue(new Error('connection reset'));

      await expect(task.handleScheduledGeneration()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Interval gate
  // -------------------------------------------------------------------------

  describe('interval gate', () => {
    it('skips a circle whose last success is INSIDE the configured interval', async () => {
      settings.getSettings.mockResolvedValue(
        settingsWith({ enabled: true, intervalHours: 24 }),
      );
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);
      prisma.enrichmentJob.groupBy.mockResolvedValue([
        { circleId: 'circle-a', _max: { finishedAt: hoursAgo(1) } },
      ]);

      const result = await task.sweep();

      expect(result).toMatchObject({ enqueued: 0, skipped: 1 });
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues once the last success falls OUTSIDE the interval', async () => {
      settings.getSettings.mockResolvedValue(
        settingsWith({ enabled: true, intervalHours: 24 }),
      );
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);
      prisma.enrichmentJob.groupBy.mockResolvedValue([
        { circleId: 'circle-a', _max: { finishedAt: hoursAgo(25) } },
      ]);

      const result = await task.sweep();

      expect(result.enqueued).toBe(1);
    });

    it('honours a shortened intervalHours', async () => {
      settings.getSettings.mockResolvedValue(
        settingsWith({ enabled: true, intervalHours: 1 }),
      );
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);
      prisma.enrichmentJob.groupBy.mockResolvedValue([
        { circleId: 'circle-a', _max: { finishedAt: hoursAgo(2) } },
      ]);

      // 2h since the last run > the 1h interval → eligible again.
      expect((await task.sweep()).enqueued).toBe(1);
    });

    it('falls back to a 24h interval when the setting is absent', async () => {
      settings.getSettings.mockResolvedValue(settingsWith({ enabled: true }));
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);
      prisma.enrichmentJob.groupBy.mockResolvedValue([
        { circleId: 'circle-a', _max: { finishedAt: hoursAgo(12) } },
      ]);

      expect((await task.sweep()).enqueued).toBe(0);
    });

    it('only counts SUCCEEDED jobs toward the interval gate', async () => {
      prisma.circle.findMany.mockResolvedValue([{ id: 'circle-a' }]);

      await task.sweep();

      expect(prisma.enrichmentJob.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: JobStatus.succeeded }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Circle paging
  // -------------------------------------------------------------------------

  describe('circle paging', () => {
    it('keyset-pages circles 100 at a time until a short page', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: `circle-${String(i).padStart(3, '0')}`,
      }));
      const page2 = [{ id: 'circle-100' }];
      prisma.circle.findMany
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2);

      const result = await task.sweep();

      expect(result.circles).toBe(101);
      expect(result.enqueued).toBe(101);
      expect(prisma.circle.findMany).toHaveBeenCalledTimes(2);
      // Second page continues after the last id of the first, skipping it.
      expect(prisma.circle.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          take: 100,
          cursor: { id: 'circle-099' },
          skip: 1,
        }),
      );
    });

    it('stops immediately when there are no circles at all (fresh install)', async () => {
      prisma.circle.findMany.mockResolvedValue([]);

      const result = await task.sweep();

      expect(result).toMatchObject({ circles: 0, enqueued: 0 });
      expect(prisma.circle.findMany).toHaveBeenCalledTimes(1);
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });

    it('batches the two job lookups per page, not per circle', async () => {
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-a' },
        { id: 'circle-b' },
        { id: 'circle-c' },
      ]);

      await task.sweep();

      expect(prisma.enrichmentJob.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.enrichmentJob.groupBy).toHaveBeenCalledTimes(1);
    });
  });
});
