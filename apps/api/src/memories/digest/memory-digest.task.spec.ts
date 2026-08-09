/**
 * Unit tests for MemoryDigestTask (epic #300, issue #311).
 *
 * Covers the whole gate stack in order — env kill-switch, feature flag, admin
 * digest kill, frequency=off, email unconfigured, send hour, in-flight job,
 * frequency window, and the epic's hard "no new content ⇒ no email, ever"
 * requirement — plus the `skipDedup: true` contract that keeps one job per
 * circle rather than one job for the whole deployment.
 *
 * No database and NO EMAIL: PrismaService, EnrichmentJobService and
 * SystemSettingsService are fully mocked, and MemoryDigestService is used for
 * real only for its pure gate/window helpers (its Prisma-touching methods are
 * spied). Nothing here can reach a network.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, JobStatus } from '@prisma/client';

import { MemoryDigestTask } from './memory-digest.task';
import {
  MEMORY_DIGEST_JOB_TYPE,
  MEMORY_DIGEST_PRIORITY,
  MemoryDigestService,
} from './memory-digest.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { EmailService } from '../../email/email.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SettingsOptions {
  memoriesEnabled?: boolean;
  digestEnabled?: boolean;
  frequency?: 'off' | 'daily' | 'weekly' | 'monthly';
  sendHourUtc?: number;
  emailEnabled?: boolean;
}

/** A settings blob with every digest-relevant knob addressable. */
function settingsWith(options: SettingsOptions = {}): any {
  const {
    memoriesEnabled = true,
    digestEnabled = true,
    frequency = 'daily',
    sendHourUtc = 8,
    emailEnabled = true,
  } = options;

  return {
    features: { memories: memoriesEnabled },
    memories: { digest: { enabled: digestEnabled, frequency, sendHourUtc } },
    email: emailEnabled
      ? {
          enabled: true,
          provider: 'smtp',
          fromAddress: 'memories@example.test',
        }
      : { enabled: false, provider: null, fromAddress: null },
  };
}

/** 10:00 UTC — past the default 08:00 send hour. */
const AFTER_SEND_HOUR = new Date('2026-08-09T10:00:00.000Z');

describe('MemoryDigestTask', () => {
  let task: MemoryDigestTask;
  let digest: MemoryDigestService;
  let prisma: {
    circle: { findMany: jest.Mock };
    enrichmentJob: { findMany: jest.Mock; groupBy: jest.Mock };
  };
  let enrichment: { enqueue: jest.Mock };
  let settings: { getSettings: jest.Mock };
  let loadCandidates: jest.SpyInstance;

  beforeEach(async () => {
    delete process.env.MEMORIES_ENABLED;

    prisma = {
      circle: { findMany: jest.fn().mockResolvedValue([{ id: 'circle-1' }]) },
      enrichmentJob: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    enrichment = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    settings = { getSettings: jest.fn().mockResolvedValue(settingsWith()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryDigestTask,
        MemoryDigestService,
        { provide: PrismaService, useValue: prisma },
        { provide: EnrichmentJobService, useValue: enrichment },
        { provide: SystemSettingsService, useValue: settings },
        // Never reached by these tests; present so the real service constructs.
        { provide: EmailService, useValue: { sendEmail: jest.fn() } },
        { provide: MediaThumbnailService, useValue: { extractThumbKey: jest.fn() } },
      ],
    }).compile();

    task = module.get(MemoryDigestTask);
    digest = module.get(MemoryDigestService);

    // "New content exists" is the default; individual tests override it.
    loadCandidates = jest
      .spyOn(digest, 'loadCandidates')
      .mockResolvedValue([{ id: 'memory-1' } as never]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MEMORIES_ENABLED;
  });

  // -------------------------------------------------------------------------
  // Deployment-wide gates
  // -------------------------------------------------------------------------

  it('enqueues one job for a due circle, with skipDedup', async () => {
    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.enqueued).toBe(1);
    expect(enrichment.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MEMORY_DIGEST_JOB_TYPE,
        mediaItemId: null,
        circleId: 'circle-1',
        reason: JobReason.backfill,
        priority: MEMORY_DIGEST_PRIORITY,
        // Without this, one circle's pending global job would suppress the
        // enqueue for every other circle in the deployment.
        skipDedup: true,
      }),
    );
  });

  it('MEMORIES_ENABLED=false stops the cron before any settings read', async () => {
    process.env.MEMORIES_ENABLED = 'false';

    await task.handleScheduledDigest();

    expect(settings.getSettings).not.toHaveBeenCalled();
    expect(prisma.circle.findMany).not.toHaveBeenCalled();
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('features.memories off ⇒ no circle paging, no jobs, no emails', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ memoriesEnabled: false }));

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.gate).toBe('feature_disabled');
    expect(result.enqueued).toBe(0);
    expect(prisma.circle.findMany).not.toHaveBeenCalled();
  });

  it('memories.digest.enabled=false is the admin global kill', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ digestEnabled: false }));

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.gate).toBe('digest_disabled');
    expect(prisma.circle.findMany).not.toHaveBeenCalled();
  });

  it("frequency 'off' produces nothing", async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ frequency: 'off' }));

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.gate).toBe('frequency_off');
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('email unconfigured ⇒ the task no-ops (in-app memories unaffected)', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ emailEnabled: false }));

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.gate).toBe('email_unconfigured');
    expect(prisma.circle.findMany).not.toHaveBeenCalled();
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('holds off until the configured send hour', async () => {
    const beforeHour = new Date('2026-08-09T03:00:00.000Z');

    const result = await task.sweep(beforeHour);

    expect(result.gate).toBe('before_send_hour');
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('honours a non-default send hour', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ sendHourUtc: 14 }));

    expect((await task.sweep(new Date('2026-08-09T13:00:00.000Z'))).enqueued).toBe(0);
    expect((await task.sweep(new Date('2026-08-09T14:00:00.000Z'))).enqueued).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Per-circle gates
  // -------------------------------------------------------------------------

  it('skips a circle whose digest job is already pending or running', async () => {
    prisma.enrichmentJob.findMany.mockResolvedValue([{ circleId: 'circle-1' }]);

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it('skips a circle inside its frequency window', async () => {
    // Sent an hour ago; a DAILY cadence is nowhere near due.
    prisma.enrichmentJob.groupBy.mockResolvedValue([
      {
        circleId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 3_600_000) },
      },
    ]);

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.skipped).toBe(1);
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('sends again once the window has elapsed', async () => {
    prisma.enrichmentJob.groupBy.mockResolvedValue([
      {
        circleId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 25 * 3_600_000) },
      },
    ]);

    expect((await task.sweep(AFTER_SEND_HOUR)).enqueued).toBe(1);
  });

  it('a weekly cadence is not due after one day', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ frequency: 'weekly' }));
    prisma.enrichmentJob.groupBy.mockResolvedValue([
      {
        circleId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 25 * 3_600_000) },
      },
    ]);

    expect((await task.sweep(AFTER_SEND_HOUR)).enqueued).toBe(0);
  });

  it('a circle that has never had a digest is always past the window', async () => {
    prisma.enrichmentJob.groupBy.mockResolvedValue([]);

    expect((await task.sweep(AFTER_SEND_HOUR)).enqueued).toBe(1);
  });

  it('the one-tick tolerance keeps a daily digest pinned to its hour', async () => {
    // Yesterday's run finished at 10:00:30; today's tick is at 10:00:00. A
    // strict 24h window would slip the send to 11:00 and drift daily.
    prisma.enrichmentJob.groupBy.mockResolvedValue([
      {
        circleId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 24 * 3_600_000 + 30_000) },
      },
    ]);

    expect((await task.sweep(AFTER_SEND_HOUR)).enqueued).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The hard gate
  // -------------------------------------------------------------------------

  it('NEVER enqueues when there is no new content since the watermark', async () => {
    loadCandidates.mockResolvedValue([]);

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('measures new content from the previous digest, not from now', async () => {
    const watermark = new Date(AFTER_SEND_HOUR.getTime() - 48 * 3_600_000);
    prisma.enrichmentJob.groupBy.mockResolvedValue([
      { circleId: 'circle-1', _max: { finishedAt: watermark } },
    ]);

    await task.sweep(AFTER_SEND_HOUR);

    expect(loadCandidates).toHaveBeenCalledWith('circle-1', watermark);
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  it('a per-circle failure is counted, never fatal to the rest of the sweep', async () => {
    prisma.circle.findMany.mockResolvedValue([{ id: 'circle-1' }, { id: 'circle-2' }]);
    enrichment.enqueue
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'job-2' });

    const result = await task.sweep(AFTER_SEND_HOUR);

    expect(result.errors).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.circles).toBe(2);
  });

  it('the cron never throws, even when the sweep blows up', async () => {
    settings.getSettings.mockRejectedValue(new Error('db down'));

    await expect(task.handleScheduledDigest()).resolves.toBeUndefined();
  });

  it('the overlap guard skips a tick while a sweep is in flight', async () => {
    let release!: () => void;
    settings.getSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(settingsWith({ memoriesEnabled: false }));
        }),
    );

    const first = task.handleScheduledDigest();
    await Promise.resolve();
    await task.handleScheduledDigest(); // second tick: must be a no-op
    release();
    await first;

    expect(settings.getSettings).toHaveBeenCalledTimes(1);
  });

  describe('JobStatus filters', () => {
    it('reads in-flight and watermark rows with the right statuses', async () => {
      await task.sweep(AFTER_SEND_HOUR);

      expect(prisma.enrichmentJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [JobStatus.pending, JobStatus.running] },
          }),
        }),
      );
      expect(prisma.enrichmentJob.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: JobStatus.succeeded }),
        }),
      );
    });
  });
});
