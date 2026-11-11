/**
 * Unit tests for MemoryDigestTask (epic #300, issue #311).
 *
 * Covers the whole gate stack in order — env kill-switch, feature flag, admin
 * digest kill, frequency=off, email unconfigured, send hour, in-flight job,
 * frequency window, and the epic's hard "no new content ⇒ no email, ever"
 * requirement — plus the `skipDedup: true` contract that keeps one job per
 * circle rather than one job for the whole deployment.
 *
 * No database and NO EMAIL: the database client and the jobs, access, settings
 * and notify ports are fully mocked, and MemoryDigestService is used for real
 * only for its gate/window helpers (its database-touching methods are spied).
 * Nothing here can reach a network.
 */

import { Test, TestingModule } from '@nestjs/testing';

import { MemoryDigestTask } from '../../../src/memories/digest/memory-digest.task.js';
import {
  MEMORY_DIGEST_JOB_TYPE,
  MEMORY_DIGEST_PRIORITY,
  MemoryDigestService,
} from '../../../src/memories/digest/memory-digest.service.js';
import { DigestTokenService } from '../../../src/memories/digest/digest-token.util.js';
import { MemoriesSettingsService } from '../../../src/memories/memories-settings.util.js';
import { MEMORIES_EMAIL_READINESS, MEMORIES_OPTIONS } from '../../../src/memories/host/memories-options.js';
import { MediaThumbnailService } from '../../../src/media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_NOTIFY,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
} from '../../../src/ports/index.js';
import { jobsPortOverFacade } from '../../helpers/facade-jobs-port.js';
import { settingsPortFrom } from '../../helpers/settings-port.js';

const JobReason = { backfill: 'backfill' } as const;

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

/** The e-mail readiness the host answers with (the fixture's `email` row). */
let emailFixture: { enabled?: boolean; provider?: string | null; fromAddress?: string | null } = {};

/** 10:00 UTC — past the default 08:00 send hour. */
const AFTER_SEND_HOUR = new Date('2026-08-09T10:00:00.000Z');

describe('MemoryDigestTask', () => {
  let task: MemoryDigestTask;
  let digest: MemoryDigestService;
  let prisma: {
    job: { groupBy: jest.Mock };
  };
  let findActive: jest.Mock;
  let scopes: { allScopeIds: jest.Mock };
  let enrichment: { enqueue: jest.Mock };
  let settings: { getSettings: jest.Mock };
  let loadCandidates: jest.SpyInstance;

  beforeEach(async () => {
    delete process.env.MEMORIES_ENABLED;

    prisma = {
      job: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    findActive = jest.fn().mockResolvedValue([]);
    scopes = { allScopeIds: jest.fn().mockResolvedValue(['circle-1']) };
    enrichment = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    settings = { getSettings: jest.fn().mockResolvedValue(settingsWith()) };
    emailFixture = settingsWith().email;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryDigestTask,
        MemoryDigestService,
        MemoriesSettingsService,
        DigestTokenService,
        { provide: MEMORIES_OPTIONS, useValue: { digest: { signingKey: () => Buffer.alloc(32) } } },
        { provide: MEMORIAHUB_PRISMA, useValue: prisma },
        { provide: MEMORIAHUB_ACCESS, useValue: scopes },
        { provide: MEMORIAHUB_JOBS, useValue: { ...jobsPortOverFacade(enrichment), findActive } },
        { provide: MEMORIAHUB_SETTINGS, useValue: settingsPortFrom(() => settings.getSettings()) },
        // The notification port is never reached by these tests. Readiness is derived from the fixture's
        // `email` key, which stands in for the host's e-mail settings.
        { provide: MEMORIAHUB_NOTIFY, useValue: { notifyNow: jest.fn() } },
        {
          provide: MEMORIES_EMAIL_READINESS,
          useValue: { isReady: async () => Boolean(emailFixture.enabled && emailFixture.provider && emailFixture.fromAddress) },
        },
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
    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

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
    expect(scopes.allScopeIds).not.toHaveBeenCalled();
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('features.memories off ⇒ no circle paging, no jobs, no emails', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ memoriesEnabled: false }));

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.gate).toBe('feature_disabled');
    expect(result.enqueued).toBe(0);
    expect(scopes.allScopeIds).not.toHaveBeenCalled();
  });

  it('memories.digest.enabled=false is the admin global kill', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ digestEnabled: false }));

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.gate).toBe('digest_disabled');
    expect(scopes.allScopeIds).not.toHaveBeenCalled();
  });

  it("frequency 'off' produces nothing", async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ frequency: 'off' }));

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.gate).toBe('frequency_off');
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('email unconfigured ⇒ the task no-ops (in-app memories unaffected)', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ emailEnabled: false }));
    emailFixture = settingsWith({ emailEnabled: false }).email;

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.gate).toBe('email_unconfigured');
    expect(scopes.allScopeIds).not.toHaveBeenCalled();
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('holds off until the configured send hour', async () => {
    const beforeHour = new Date('2026-08-09T03:00:00.000Z');

    const result = await task.handleScheduledDigest(beforeHour);

    expect(result.gate).toBe('before_send_hour');
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('honours a non-default send hour', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ sendHourUtc: 14 }));

    expect((await task.handleScheduledDigest(new Date('2026-08-09T13:00:00.000Z'))).enqueued).toBe(0);
    expect((await task.handleScheduledDigest(new Date('2026-08-09T14:00:00.000Z'))).enqueued).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Per-circle gates
  // -------------------------------------------------------------------------

  it('skips a circle whose digest job is already pending or running', async () => {
    findActive.mockResolvedValue([{ subjectId: 'circle-1' }]);

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it('skips a circle inside its frequency window', async () => {
    // Sent an hour ago; a DAILY cadence is nowhere near due.
    prisma.job.groupBy.mockResolvedValue([
      {
        subjectId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 3_600_000) },
      },
    ]);

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.skipped).toBe(1);
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('sends again once the window has elapsed', async () => {
    prisma.job.groupBy.mockResolvedValue([
      {
        subjectId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 25 * 3_600_000) },
      },
    ]);

    expect((await task.handleScheduledDigest(AFTER_SEND_HOUR)).enqueued).toBe(1);
  });

  it('a weekly cadence is not due after one day', async () => {
    settings.getSettings.mockResolvedValue(settingsWith({ frequency: 'weekly' }));
    prisma.job.groupBy.mockResolvedValue([
      {
        subjectId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 25 * 3_600_000) },
      },
    ]);

    expect((await task.handleScheduledDigest(AFTER_SEND_HOUR)).enqueued).toBe(0);
  });

  it('a circle that has never had a digest is always past the window', async () => {
    prisma.job.groupBy.mockResolvedValue([]);

    expect((await task.handleScheduledDigest(AFTER_SEND_HOUR)).enqueued).toBe(1);
  });

  it('the one-tick tolerance keeps a daily digest pinned to its hour', async () => {
    // Yesterday's run finished at 10:00:30; today's tick is at 10:00:00. A
    // strict 24h window would slip the send to 11:00 and drift daily.
    prisma.job.groupBy.mockResolvedValue([
      {
        subjectId: 'circle-1',
        _max: { finishedAt: new Date(AFTER_SEND_HOUR.getTime() - 24 * 3_600_000 + 30_000) },
      },
    ]);

    expect((await task.handleScheduledDigest(AFTER_SEND_HOUR)).enqueued).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The hard gate
  // -------------------------------------------------------------------------

  it('NEVER enqueues when there is no new content since the watermark', async () => {
    loadCandidates.mockResolvedValue([]);

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(enrichment.enqueue).not.toHaveBeenCalled();
  });

  it('measures new content from the previous digest, not from now', async () => {
    const watermark = new Date(AFTER_SEND_HOUR.getTime() - 48 * 3_600_000);
    prisma.job.groupBy.mockResolvedValue([
      { subjectId: 'circle-1', _max: { finishedAt: watermark } },
    ]);

    await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(loadCandidates).toHaveBeenCalledWith('circle-1', watermark);
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  it('a per-circle failure is counted, never fatal to the rest of the sweep', async () => {
    scopes.allScopeIds.mockResolvedValue(['circle-1', 'circle-2']);
    enrichment.enqueue
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'job-2' });

    const result = await task.handleScheduledDigest(AFTER_SEND_HOUR);

    expect(result.errors).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.circles).toBe(2);
  });

  it('the cron never throws, even when the sweep blows up', async () => {
    settings.getSettings.mockRejectedValue(new Error('db down'));

    await expect(task.handleScheduledDigest()).resolves.toMatchObject({ enqueued: 0 });
  });

  it('the overlap guard skips a tick while a sweep is in flight', async () => {
    let release!: () => void;
    settings.getSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(settingsWith({ memoriesEnabled: false }));
        }),
    );

    const first = task.handleScheduledDigest();
    await new Promise((resolve) => setImmediate(resolve));
    await task.handleScheduledDigest(); // second tick: must be a no-op
    // Only the first tick's two reads (`features`, `memories`) were made: the second never got past the guard.
    expect(settings.getSettings).toHaveBeenCalledTimes(2);
    release();
    await first;
  });

  describe('JobStatus filters', () => {
    it('reads in-flight rows through the jobs port and watermark rows with the succeeded status', async () => {
      await task.handleScheduledDigest(AFTER_SEND_HOUR);

      expect(findActive).toHaveBeenCalledWith(
        expect.objectContaining({ types: [MEMORY_DIGEST_JOB_TYPE], subjectType: 'circle' }),
      );
      expect(prisma.job.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'succeeded' }),
        }),
      );
    });
  });
});
