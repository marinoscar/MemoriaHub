/**
 * Unit tests for MemoriesGenerationTask (epic #300, issue #302).
 *
 * Covers the three gates in order — MEMORIES_ENABLED env kill-switch,
 * features.memories, and the per-circle (in-flight + interval) gate — plus the
 * `skipDedup: true` contract that keeps one job per circle rather than one job
 * for the whole deployment.
 *
 * No database required: the database client and the jobs, access and settings
 * ports are fully mocked (same shape as InsightsRefreshTask's spec).
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  MEMORY_GENERATION_JOB_TYPE,
  MemoriesGenerationTask,
} from '../../src/memories/memories-generation.task.js';
import { MemoriesSettingsService } from '../../src/memories/memories-settings.util.js';
import { MEMORIES_OPTIONS } from '../../src/memories/host/memories-options.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
} from '../../src/ports/index.js';
import { jobsPortOverFacade } from '../helpers/facade-jobs-port.js';
import { settingsPortFrom } from '../helpers/settings-port.js';

const JobReason = { backfill: 'backfill' } as const;

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
    job: { groupBy: jest.Mock };
  };
  let findActive: jest.Mock;
  let scopes: { allScopeIds: jest.Mock };
  let enrichment: { enqueue: jest.Mock };
  let settings: { getSettings: jest.Mock };

  const originalEnv = process.env['MEMORIES_ENABLED'];

  beforeEach(async () => {
    prisma = {
      job: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    findActive = jest.fn().mockResolvedValue([]);
    scopes = { allScopeIds: jest.fn().mockResolvedValue([]) };
    enrichment = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    settings = {
      getSettings: jest.fn().mockResolvedValue(settingsWith({ enabled: true })),
    };

    delete process.env['MEMORIES_ENABLED'];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoriesGenerationTask,
        MemoriesSettingsService,
        { provide: MEMORIES_OPTIONS, useValue: { digest: { signingKey: () => Buffer.alloc(32) } } },
        { provide: MEMORIAHUB_PRISMA, useValue: prisma },
        { provide: MEMORIAHUB_ACCESS, useValue: scopes },
        { provide: MEMORIAHUB_JOBS, useValue: { ...jobsPortOverFacade(enrichment), findActive } },
        { provide: MEMORIAHUB_SETTINGS, useValue: settingsPortFrom(() => settings.getSettings()) },
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
      scopes.allScopeIds.mockResolvedValue(['circle-a']);

      await task.handleScheduledGeneration();

      expect(enrichment.enqueue).not.toHaveBeenCalled();
      // The env kill-switch short-circuits before even the cached settings read.
      expect(settings.getSettings).not.toHaveBeenCalled();
      expect(scopes.allScopeIds).not.toHaveBeenCalled();
    });

    it('enqueues nothing and never pages circles when features.memories is off (the default)', async () => {
      settings.getSettings.mockResolvedValue(settingsWith({ enabled: false }));
      scopes.allScopeIds.mockResolvedValue(['circle-a']);

      await task.handleScheduledGeneration();

      expect(enrichment.enqueue).not.toHaveBeenCalled();
      // One cached settings read is the entire cost of a disabled tick.
      expect(settings.getSettings).toHaveBeenCalledTimes(1);
      expect(scopes.allScopeIds).not.toHaveBeenCalled();
    });

    it('treats an absent features.memories key as off', async () => {
      settings.getSettings.mockResolvedValue({ features: {} } as any);

      const result = await task.handleScheduledGeneration();

      expect(result.enqueued).toBe(0);
      expect(scopes.allScopeIds).not.toHaveBeenCalled();
    });

    it('MEMORIES_ENABLED=false overrides features.memories=true', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';
      settings.getSettings.mockResolvedValue(settingsWith({ enabled: true }));

      // The env kill-switch wins over the flag.
      const result = await task.handleScheduledGeneration();

      expect(result.enqueued).toBe(0);
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Per-circle enqueue
  // -------------------------------------------------------------------------

  describe('per-circle enqueue', () => {
    it('enqueues ONE job per circle, each with skipDedup: true', async () => {
      scopes.allScopeIds.mockResolvedValue(['circle-a', 'circle-b']);

      const result = await task.handleScheduledGeneration();

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
      scopes.allScopeIds.mockResolvedValue(['circle-a']);
      prisma.job.groupBy.mockResolvedValue([]);

      const result = await task.handleScheduledGeneration();

      expect(result.enqueued).toBe(1);
    });

    it('skips a circle whose job is already pending or running', async () => {
      scopes.allScopeIds.mockResolvedValue(['circle-a', 'circle-b']);
      findActive.mockResolvedValue([{ subjectId: 'circle-a' }]);

      const result = await task.handleScheduledGeneration();

      expect(result).toMatchObject({ enqueued: 1, skipped: 1 });
      expect(enrichment.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-b' }),
      );
      // The in-flight lookup is scoped to pending+running only.
      expect(findActive).toHaveBeenCalledWith(
        expect.objectContaining({ types: [MEMORY_GENERATION_JOB_TYPE], subjectType: 'circle' }),
      );
    });

    it('isolates a per-circle enqueue failure without aborting the sweep', async () => {
      scopes.allScopeIds.mockResolvedValue(['circle-a', 'circle-b']);
      enrichment.enqueue
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ id: 'job-2' });

      const result = await task.handleScheduledGeneration();

      expect(result).toMatchObject({ circles: 2, enqueued: 1, errors: 1 });
    });

    it('never throws out of the cron even when the sweep blows up', async () => {
      scopes.allScopeIds.mockRejectedValue(new Error('connection reset'));

      await expect(task.handleScheduledGeneration()).resolves.toMatchObject({ enqueued: 0 });
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
      scopes.allScopeIds.mockResolvedValue(['circle-a']);
      prisma.job.groupBy.mockResolvedValue([
        { subjectId: 'circle-a', _max: { finishedAt: hoursAgo(1) } },
      ]);

      const result = await task.handleScheduledGeneration();

      expect(result).toMatchObject({ enqueued: 0, skipped: 1 });
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues once the last success falls OUTSIDE the interval', async () => {
      settings.getSettings.mockResolvedValue(
        settingsWith({ enabled: true, intervalHours: 24 }),
      );
      scopes.allScopeIds.mockResolvedValue(['circle-a']);
      prisma.job.groupBy.mockResolvedValue([
        { subjectId: 'circle-a', _max: { finishedAt: hoursAgo(25) } },
      ]);

      const result = await task.handleScheduledGeneration();

      expect(result.enqueued).toBe(1);
    });

    it('honours a shortened intervalHours', async () => {
      settings.getSettings.mockResolvedValue(
        settingsWith({ enabled: true, intervalHours: 1 }),
      );
      scopes.allScopeIds.mockResolvedValue(['circle-a']);
      prisma.job.groupBy.mockResolvedValue([
        { subjectId: 'circle-a', _max: { finishedAt: hoursAgo(2) } },
      ]);

      // 2h since the last run > the 1h interval → eligible again.
      expect((await task.handleScheduledGeneration()).enqueued).toBe(1);
    });

    it('falls back to a 24h interval when the setting is absent', async () => {
      settings.getSettings.mockResolvedValue(settingsWith({ enabled: true }));
      scopes.allScopeIds.mockResolvedValue(['circle-a']);
      prisma.job.groupBy.mockResolvedValue([
        { subjectId: 'circle-a', _max: { finishedAt: hoursAgo(12) } },
      ]);

      expect((await task.handleScheduledGeneration()).enqueued).toBe(0);
    });

    it('only counts SUCCEEDED jobs toward the interval gate', async () => {
      scopes.allScopeIds.mockResolvedValue(['circle-a']);

      await task.handleScheduledGeneration();

      expect(prisma.job.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Circle paging
  // -------------------------------------------------------------------------

  describe('circle paging', () => {
    it('walks every library in chunks of 100 ids, one pair of job lookups per chunk', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `circle-${String(i).padStart(3, '0')}`);
      scopes.allScopeIds.mockResolvedValueOnce(ids);

      const result = await task.handleScheduledGeneration();

      expect(result.circles).toBe(101);
      expect(result.enqueued).toBe(101);
      expect(scopes.allScopeIds).toHaveBeenCalledTimes(1);
      expect(findActive).toHaveBeenCalledTimes(2);
      expect(findActive.mock.calls[0]![0].subjectIds).toHaveLength(100);
    });

    it('stops immediately when there are no circles at all (fresh install)', async () => {
      scopes.allScopeIds.mockResolvedValue([]);

      const result = await task.handleScheduledGeneration();

      expect(result).toMatchObject({ circles: 0, enqueued: 0 });
      expect(scopes.allScopeIds).toHaveBeenCalledTimes(1);
      expect(enrichment.enqueue).not.toHaveBeenCalled();
    });

    it('batches the two job lookups per page, not per circle', async () => {
      scopes.allScopeIds.mockResolvedValue(['circle-a', 'circle-b', 'circle-c']);

      await task.handleScheduledGeneration();

      expect(findActive).toHaveBeenCalledTimes(1);
      expect(prisma.job.groupBy).toHaveBeenCalledTimes(1);
    });
  });
});
