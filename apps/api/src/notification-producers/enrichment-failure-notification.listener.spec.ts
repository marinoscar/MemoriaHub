/**
 * Unit tests for EnrichmentFailureNotificationListener (epic #240, issue #247).
 *
 * Covers the acceptance list verbatim:
 *  - N terminal failures of ONE job type -> ONE admin row with count = N
 *    (the poison-pill case) — proven via the arguments passed to
 *    notifyCounted (match/windowMs), mirroring the "producer asks
 *    for the right aggregation" split used in upload-notification.service.spec.ts
 *  - two different job types -> two separate rows (partitioned by `jobType`
 *    via matchData)
 *  - a rate-limit DEFERRAL emits nothing; an intermediate retry emits
 *    nothing — only a genuinely terminal `outcome: 'failed'` event, backed by
 *    a re-read confirming `status === 'failed'`, produces a row
 *  - recipients are Admin-role users ONLY — a deployment with no admins (or
 *    a non-admin actor) gets nothing
 *  - NO time window (windowMs: null) — failures accumulate until dismissed,
 *    unlike upload_completed's 15-minute window
 *  - best-effort: never throws when the underlying write rejects
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, MhLegacyJobStatus } from '@prisma/client';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { EnrichmentJobSettledEvent } from '../enrichment/events/enrichment-job-settled.event';
import '../platform/notifications/notification.manifest';
import { renderBrowserNotification } from '../notifications-registry/memoriahub.notifications';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentFailureNotificationListener } from './enrichment-failure-notification.listener';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_1 = 'admin-1';
const ADMIN_2 = 'admin-2';
const JOB_ID = 'job-111';

function makeSettledEvent(
  overrides: Partial<{
    jobId: string;
    type: string;
    reason: JobReason;
    mediaItemId: string | null;
    circleId: string | null;
    outcome: 'succeeded' | 'failed';
  }> = {},
): EnrichmentJobSettledEvent {
  const merged = {
    jobId: JOB_ID,
    type: 'auto_tagging',
    reason: JobReason.upload,
    mediaItemId: null,
    circleId: null,
    outcome: 'failed' as const,
    ...overrides,
  };
  return new EnrichmentJobSettledEvent(
    merged.jobId,
    merged.type,
    merged.reason,
    merged.mediaItemId,
    merged.circleId,
    merged.outcome,
  );
}

describe('EnrichmentFailureNotificationListener', () => {
  let listener: EnrichmentFailureNotificationListener;
  let mockPrisma: MockPrismaService;
  let mockNotifications: { notifyCounted: jest.Mock };
  /** The platform `notifyCounted(eventKey, userId, data, options)` calls, as one object each. */
  const calls = () =>
    mockNotifications.notifyCounted.mock.calls.map(([eventKey, userId, data, options]) => [
      { eventKey, userId, data, circleId: options?.scopeId, matchData: options?.match, windowMs: options?.windowMs ?? null },
    ]);

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockNotifications = { notifyCounted: jest.fn().mockResolvedValue(undefined) };

    (mockPrisma.job.findUnique as jest.Mock).mockResolvedValue({
      status: MhLegacyJobStatus.failed,
      lastError: 'boom',
    });
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([{ id: ADMIN_1 }, { id: ADMIN_2 }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentFailureNotificationListener,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    listener = module.get<EnrichmentFailureNotificationListener>(
      EnrichmentFailureNotificationListener,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Terminal-only gate
  // -------------------------------------------------------------------------

  describe('terminal-only gate', () => {
    it("a 'succeeded' settlement event emits nothing", async () => {
      await listener.handleJobSettled(makeSettledEvent({ outcome: 'succeeded' }));

      expect(mockNotifications.notifyCounted).not.toHaveBeenCalled();
      // Never even re-reads the job row — the outcome check short-circuits first.
      expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    });

    it(
      'an intermediate retry / rate-limit DEFERRAL never reaches this listener because ' +
        'EnrichmentTerminalService only emits ENRICHMENT_JOB_SETTLED_EVENT on a terminal ' +
        'transition — simulated here by a re-read that finds the job back in a non-failed ' +
        '(e.g. pending, requeued) status, which the listener defensively re-checks and skips',
      async () => {
        (mockPrisma.job.findUnique as jest.Mock).mockResolvedValue({
          status: MhLegacyJobStatus.pending,
          lastError: null,
        });

        await listener.handleJobSettled(makeSettledEvent({ outcome: 'failed' }));

        expect(mockNotifications.notifyCounted).not.toHaveBeenCalled();
      },
    );

    it('a missing job row (deleted between settlement and re-read) emits nothing', async () => {
      (mockPrisma.job.findUnique as jest.Mock).mockResolvedValue(null);

      await listener.handleJobSettled(makeSettledEvent({ outcome: 'failed' }));

      expect(mockNotifications.notifyCounted).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Recipients — Admin role only
  // -------------------------------------------------------------------------

  describe('recipients — Admin role only', () => {
    it('queries active users holding the Admin role', async () => {
      await listener.handleJobSettled(makeSettledEvent());

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
            userRoles: { some: { role: { name: 'admin' } } },
          }),
        }),
      );
    });

    it('notifies EVERY admin — one notifyCounted call per admin', async () => {
      await listener.handleJobSettled(makeSettledEvent());

      expect(mockNotifications.notifyCounted).toHaveBeenCalledTimes(2);
      const recipients = calls().map(([a]) => a.userId);
      expect(recipients.sort()).toEqual([ADMIN_1, ADMIN_2].sort());
    });

    it('a deployment with zero admins emits nothing (and never calls notifyCounted)', async () => {
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await listener.handleJobSettled(makeSettledEvent());

      expect(mockNotifications.notifyCounted).not.toHaveBeenCalled();
    });

    it('caches the admin id list for ADMIN_CACHE_TTL_MS across settlements', async () => {
      await listener.handleJobSettled(makeSettledEvent({ jobId: 'job-1' }));
      await listener.handleJobSettled(makeSettledEvent({ jobId: 'job-2' }));

      // Two settlements, but only one role lookup within the TTL window.
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Aggregation: N failures of ONE job type -> ONE row per admin
  // -------------------------------------------------------------------------

  describe('aggregation — one row per (admin, jobType), no time window', () => {
    it('every call for the same jobType uses the SAME matchData partition key and NO windowMs', async () => {
      await listener.handleJobSettled(makeSettledEvent({ jobId: 'job-1', type: 'auto_tagging' }));
      await listener.handleJobSettled(makeSettledEvent({ jobId: 'job-2', type: 'auto_tagging' }));

      // 2 admins x 2 settlements = 4 calls, all partitioned identically.
      expect(mockNotifications.notifyCounted).toHaveBeenCalledTimes(4);
      for (const [arg] of calls()) {
        expect(arg.eventKey).toBe('media.enrichment_failed');
        expect(arg.circleId).toBeNull();
        expect(arg.matchData).toEqual({ jobType: 'auto_tagging' });
        expect(arg.data).toMatchObject({ jobType: 'auto_tagging' });
        // No rolling window — accumulate until dismissed, unlike upload_completed.
        expect(arg.windowMs).toBeNull();
      }
    });

    it('two DIFFERENT job types produce calls partitioned into two separate matchData keys', async () => {
      await listener.handleJobSettled(makeSettledEvent({ jobId: 'job-1', type: 'auto_tagging' }));
      await listener.handleJobSettled(makeSettledEvent({ jobId: 'job-2', type: 'geocode' }));

      const matchDataValues = calls().map(
        ([arg]) => arg.matchData.jobType,
      );
      expect(new Set(matchDataValues)).toEqual(new Set(['auto_tagging', 'geocode']));
      // 2 admins x 2 job types = 4 calls total, 2 per type.
      expect(
        matchDataValues.filter((t: string) => t === 'auto_tagging'),
      ).toHaveLength(2);
      expect(matchDataValues.filter((t: string) => t === 'geocode')).toHaveLength(2);
    });

    it('title pluralizes on the RESULTING count and names the job type', async () => {
      await listener.handleJobSettled(makeSettledEvent({ type: 'geocode' }));

      const [arg] = calls()[0];
      // The event's template renders the title from the platform's running count.
      const render = (data: object) => renderBrowserNotification(arg.eventKey, data)!;
      expect(render({ ...arg.data, count: 1 }).title).toBe('1 geocode job failed permanently');
      expect(render({ ...arg.data, count: 400 }).title).toBe('400 geocode jobs failed permanently');
      expect(render({ ...arg.data, count: 1 }).link).toBe('/admin/settings/jobs?status=failed');
    });

    it('lastError is truncated to 500 chars and carried in data', async () => {
      const longError = 'x'.repeat(1000);
      (mockPrisma.job.findUnique as jest.Mock).mockResolvedValue({
        status: MhLegacyJobStatus.failed,
        lastError: longError,
      });

      await listener.handleJobSettled(makeSettledEvent());

      const [arg] = calls()[0];
      expect((arg.data.lastError as string).length).toBe(500);
    });

    it('a null lastError is passed through as null, not omitted', async () => {
      (mockPrisma.job.findUnique as jest.Mock).mockResolvedValue({
        status: MhLegacyJobStatus.failed,
        lastError: null,
      });

      await listener.handleJobSettled(makeSettledEvent());

      const [arg] = calls()[0];
      expect(arg.data).toHaveProperty('lastError', null);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: best-effort, never throws
  // -------------------------------------------------------------------------

  describe('best-effort contract', () => {
    it('never throws when the job re-read rejects', async () => {
      (mockPrisma.job.findUnique as jest.Mock).mockRejectedValue(
        new Error('db down'),
      );

      await expect(
        listener.handleJobSettled(makeSettledEvent()),
      ).resolves.toBeUndefined();
    });

    it('never throws when the admin-role lookup rejects', async () => {
      (mockPrisma.user.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(
        listener.handleJobSettled(makeSettledEvent()),
      ).resolves.toBeUndefined();
    });

    it('never throws when notifyCounted itself rejects', async () => {
      mockNotifications.notifyCounted.mockRejectedValue(new Error('write failed'));

      await expect(
        listener.handleJobSettled(makeSettledEvent()),
      ).resolves.toBeUndefined();
    });
  });
});
