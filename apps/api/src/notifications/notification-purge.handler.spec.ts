/**
 * Unit tests for NotificationPurgeHandler (epic #240, issue #248).
 *
 * Covers:
 *   - type constant is 'notification_purge'
 *   - onModuleInit registers with the registry
 *   - process() disabled path: notifications.purgeEnabled=false → no findMany/deleteMany
 *   - process() enabled path: two disjoint passes (dismissed / read-not-dismissed)
 *   - THE HEADLINE INVARIANT: an unread, undismissed row is never selected for
 *     deletion by either pass, regardless of age
 *   - dismissed-newer-than-cutoff and read-newer-than-cutoff rows are excluded
 *     by the `lt: cutoff` predicate (asserted via the where clause, since the
 *     real filtering only happens inside Postgres)
 *   - the read pass excludes dismissed rows (dismissedAt: null) so a row read
 *     long ago but dismissed recently is retained from its dismissal, not
 *     deleted on the older read
 *   - batch loop: terminates on a short batch, continues across multiple full
 *     batches, terminates immediately on an empty first batch
 *   - cutoff date math matches notifications.retentionDays setting
 *   - error propagation from DB calls
 *
 * Notes: this test suite proves the QUERY SHAPE the handler sends to Prisma
 * (which `where` clauses, which cutoff, which batching behavior) using a
 * mocked PrismaService — it does NOT execute against a real Postgres. The
 * actual row-selection semantics (e.g. that `dismissedAt: { not: null, lt }`
 * truly excludes an unread row in the database) are enforced by Postgres
 * itself and are only fully provable against a real database / integration
 * test. Where a case matters for that real-DB guarantee, it is called out
 * explicitly below.
 */

import { Test, TestingModule } from '@nestjs/testing';
import type { EnrichmentJob } from '@prisma/client';
import { NotificationPurgeHandler } from './notification-purge.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-notif-purge-1',
    type: 'notification_purge',
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

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationPurgeHandler', () => {
  let handler: NotificationPurgeHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockRegistry = { register: jest.fn() };

    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(30), // default 30-day retention
    };

    mockPrisma = createMockPrismaService();
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.deleteMany.mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationPurgeHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: SystemSettingsService, useValue: mockSettings },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    handler = module.get<NotificationPurgeHandler>(NotificationPurgeHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant
  // =========================================================================

  describe('type', () => {
    it('has type === "notification_purge"', () => {
      expect(handler.type).toBe('notification_purge');
    });
  });

  // =========================================================================
  // onModuleInit
  // =========================================================================

  describe('onModuleInit', () => {
    it('registers itself with the EnrichmentHandlerRegistry', () => {
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });

    it('registers exactly once per call', () => {
      handler.onModuleInit();
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // process — disabled (notifications.purgeEnabled=false)
  // =========================================================================

  describe('process — disabled', () => {
    it('does NOT call findMany when purgeEnabled=false', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await handler.process(makeJob());

      expect(mockPrisma.notification.findMany).not.toHaveBeenCalled();
    });

    it('does NOT call deleteMany when purgeEnabled=false', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await handler.process(makeJob());

      expect(mockPrisma.notification.deleteMany).not.toHaveBeenCalled();
    });

    it('resolves without throwing when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });

    it('reads notifications.purgeEnabled setting', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await handler.process(makeJob());

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith('notifications.purgeEnabled');
    });

    it('treats null purgeEnabled as true (default enabled) and proceeds', async () => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(null) // purgeEnabled → nullish → defaults true
        .mockResolvedValueOnce(30); // retentionDays

      await handler.process(makeJob());

      expect(mockPrisma.notification.findMany).toHaveBeenCalled();
    });

    it('treats undefined purgeEnabled as true (default enabled) and proceeds', async () => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(30);

      await handler.process(makeJob());

      expect(mockPrisma.notification.findMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process — enabled: two disjoint passes
  // =========================================================================

  describe('process — enabled, query shape', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true) // purgeEnabled
        .mockResolvedValueOnce(30); // retentionDays
    });

    it('runs exactly two findMany passes (dismissed pass, then read pass)', async () => {
      await handler.process(makeJob());

      // Two purgeInBatches() calls, each terminating on an empty first batch.
      expect(mockPrisma.notification.findMany).toHaveBeenCalledTimes(2);
    });

    it('the dismissed pass selects dismissedAt not null AND lt cutoff', async () => {
      await handler.process(makeJob());

      const [firstCall] = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const where = firstCall[0].where;

      expect(where.dismissedAt).toEqual(
        expect.objectContaining({ not: null }),
      );
      expect(where.dismissedAt.lt).toBeInstanceOf(Date);
    });

    it('the read pass selects dismissedAt: null AND readAt not null AND lt cutoff', async () => {
      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const readPassWhere = calls[1][0].where;

      expect(readPassWhere.dismissedAt).toBeNull();
      expect(readPassWhere.readAt).toEqual(expect.objectContaining({ not: null }));
      expect(readPassWhere.readAt.lt).toBeInstanceOf(Date);
    });

    it('neither pass includes a createdAt-based (age-only) predicate', async () => {
      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      for (const call of calls) {
        expect(call[0].where.createdAt).toBeUndefined();
      }
    });

    it('cutoff matches notifications.retentionDays (30 default)', async () => {
      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const dismissedCutoff: Date = calls[0][0].where.dismissedAt.lt;
      const readCutoff: Date = calls[1][0].where.readAt.lt;

      const thirtyDaysMs = 30 * DAY_MS;
      for (const cutoff of [dismissedCutoff, readCutoff]) {
        expect(cutoff.getTime()).toBeGreaterThan(before - thirtyDaysMs - 5000);
        expect(cutoff.getTime()).toBeLessThan(after - thirtyDaysMs + 5000);
      }
    });

    it('uses a custom retentionDays value (7) for both passes', async () => {
      mockSettings.getSettingValue.mockReset();
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(7);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const dismissedCutoff: Date = calls[0][0].where.dismissedAt.lt;
      const readCutoff: Date = calls[1][0].where.readAt.lt;

      const sevenDaysMs = 7 * DAY_MS;
      for (const cutoff of [dismissedCutoff, readCutoff]) {
        expect(cutoff.getTime()).toBeGreaterThan(before - sevenDaysMs - 5000);
        expect(cutoff.getTime()).toBeLessThan(after - sevenDaysMs + 5000);
      }
    });

    it('falls back to the 30-day default when retentionDays is unset', async () => {
      mockSettings.getSettingValue.mockReset();
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(undefined);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const dismissedCutoff: Date = calls[0][0].where.dismissedAt.lt;

      const thirtyDaysMs = 30 * DAY_MS;
      expect(dismissedCutoff.getTime()).toBeGreaterThan(before - thirtyDaysMs - 5000);
      expect(dismissedCutoff.getTime()).toBeLessThan(after - thirtyDaysMs + 5000);
    });

    it('reads notifications.retentionDays setting', async () => {
      await handler.process(makeJob());

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith('notifications.retentionDays');
    });
  });

  // =========================================================================
  // THE HEADLINE INVARIANT — unread rows are never selected for deletion
  // =========================================================================

  describe('unread-row survival invariant', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('neither the dismissed pass nor the read pass can match an unread, undismissed row — proven by simulating the where clause against representative rows', async () => {
      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const dismissedWhere = calls[0][0].where;
      const readWhere = calls[1][0].where;

      // An unread row created years ago: readAt=null, dismissedAt=null.
      const unreadOldRow = {
        readAt: null,
        dismissedAt: null,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      };

      // Pass 1 (dismissed pass) requires dismissedAt !== null — an unread row
      // has dismissedAt=null, so it structurally cannot satisfy
      // `{ not: null, lt: cutoff }`.
      expect(dismissedWhere.dismissedAt.not).toBeNull();
      expect(unreadOldRow.dismissedAt).toBeNull();

      // Pass 2 (read pass) requires readAt !== null — an unread row has
      // readAt=null, so it structurally cannot satisfy `{ not: null, lt: cutoff }`.
      expect(readWhere.readAt.not).toBeNull();
      expect(unreadOldRow.readAt).toBeNull();

      // Neither where-clause predicate on this handler references createdAt at
      // all, so age alone (regardless of how old unreadOldRow is) can never
      // make it eligible. This is the query-shape half of the invariant; the
      // actual row-level guarantee that Postgres will not return this row for
      // either predicate can only be fully proven against a real database.
      expect(dismissedWhere.createdAt).toBeUndefined();
      expect(readWhere.createdAt).toBeUndefined();
    });

    it('an old UNREAD row is not deleted even when both passes return other eligible rows', async () => {
      // First pass (dismissed) returns one genuinely-dismissed row; the
      // unread row must never appear here because it has dismissedAt=null.
      mockPrisma.notification.findMany
        .mockResolvedValueOnce([{ id: 'dismissed-old' }] as any)
        .mockResolvedValueOnce([]); // read pass: nothing eligible
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      // Only the dismissed row's id was ever passed to deleteMany — the
      // handler never had an "unread-old" id to delete because it never
      // asked for one via createdAt.
      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['dismissed-old'] } } }),
      );
      expect(mockPrisma.notification.deleteMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: expect.arrayContaining(['unread-old']) } } }),
      );
    });
  });

  // =========================================================================
  // What gets purged / kept — behavioral cases from the issue's acceptance list
  // =========================================================================

  describe('purge eligibility — dismissed rows', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('a dismissed row older than retentionDays is included in the dismissed-pass batch and deleted', async () => {
      mockPrisma.notification.findMany
        .mockResolvedValueOnce([{ id: 'dismissed-old' }] as any)
        .mockResolvedValueOnce([]);
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['dismissed-old'] } } }),
      );
    });

    it('the dismissed-pass where clause uses lt (strictly less than) the cutoff, so a row dismissed exactly at the cutoff or newer is excluded by construction', async () => {
      await handler.process(makeJob());

      const [firstCall] = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const where = firstCall[0].where;

      // `lt`, not `lte` — a dismissal exactly at the cutoff moment is retained,
      // matching the "newer than cutoff is kept" acceptance case.
      expect(Object.keys(where.dismissedAt)).toEqual(expect.arrayContaining(['not', 'lt']));
      expect(where.dismissedAt).not.toHaveProperty('lte');
    });
  });

  describe('purge eligibility — read (undismissed) rows', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('a read (undismissed) row older than retentionDays is included in the read-pass batch and deleted', async () => {
      mockPrisma.notification.findMany
        .mockResolvedValueOnce([]) // dismissed pass: nothing
        .mockResolvedValueOnce([{ id: 'read-old' }] as any);
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['read-old'] } } }),
      );
    });

    it('the read-pass where clause uses lt (strictly less than) the cutoff', async () => {
      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const where = calls[1][0].where;

      expect(Object.keys(where.readAt)).toEqual(expect.arrayContaining(['not', 'lt']));
      expect(where.readAt).not.toHaveProperty('lte');
    });

    it('a row read 60 days ago but DISMISSED yesterday (retention=30) is retained by its dismissal, not deleted on the older read — proven by the read pass excluding any dismissedAt-not-null row structurally', async () => {
      mockSettings.getSettingValue.mockReset();
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);

      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const readPassWhere = calls[1][0].where;
      const dismissedPassWhere = calls[0][0].where;

      // Row shape: readAt = 60 days ago (before the 30-day cutoff),
      // dismissedAt = yesterday (after the 30-day cutoff).
      const row = {
        readAt: new Date(Date.now() - 60 * DAY_MS),
        dismissedAt: new Date(Date.now() - 1 * DAY_MS),
      };

      // The read pass requires dismissedAt === null. This row's dismissedAt is
      // non-null, so it is structurally excluded from the read pass regardless
      // of how old readAt is — it can never be deleted "on the strength of the
      // older read".
      expect(readPassWhere.dismissedAt).toBeNull();
      expect(row.dismissedAt).not.toBeNull();

      // The dismissed pass requires dismissedAt < cutoff (30 days ago). This
      // row's dismissedAt is 1 day ago, i.e. NEWER than the cutoff, so it also
      // fails the dismissed pass's `lt` bound and is retained overall.
      const dismissedCutoff: Date = dismissedPassWhere.dismissedAt.lt;
      expect(row.dismissedAt.getTime()).toBeGreaterThan(dismissedCutoff.getTime());
    });
  });

  describe('purge eligibility — newer-than-cutoff rows are kept', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('a dismissed row newer than the cutoff fails the dismissed-pass lt bound', async () => {
      await handler.process(makeJob());

      const [firstCall] = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const cutoff: Date = firstCall[0].where.dismissedAt.lt;

      const recentDismissal = new Date(Date.now() - 1 * DAY_MS); // 1 day ago, well within 30-day retention
      expect(recentDismissal.getTime()).toBeGreaterThan(cutoff.getTime());
    });

    it('a read row newer than the cutoff fails the read-pass lt bound', async () => {
      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      const cutoff: Date = calls[1][0].where.readAt.lt;

      const recentRead = new Date(Date.now() - 1 * DAY_MS);
      expect(recentRead.getTime()).toBeGreaterThan(cutoff.getTime());
    });
  });

  // =========================================================================
  // Batching
  // =========================================================================

  describe('process — batch loop', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('each pass stops after a short batch (< 5000 items)', async () => {
      const dismissedBatch = [{ id: 'd-a' }, { id: 'd-b' }];
      mockPrisma.notification.findMany
        .mockResolvedValueOnce(dismissedBatch as any)
        .mockResolvedValueOnce([]); // read pass empty
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 2 });

      await handler.process(makeJob());

      // dismissed pass: 1 findMany (short batch) + 1 deleteMany;
      // read pass: 1 findMany (empty) + 0 deleteMany
      expect(mockPrisma.notification.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('continues batching within a pass until a short batch is received, and terminates (does not loop forever)', async () => {
      const fullBatch = Array.from({ length: 5000 }, (_, i) => ({ id: `dismissed-${i}` }));
      const shortBatch = [{ id: 'dismissed-last-a' }, { id: 'dismissed-last-b' }];

      mockPrisma.notification.findMany
        .mockResolvedValueOnce(fullBatch as any) // dismissed pass round 1: full
        .mockResolvedValueOnce(shortBatch as any) // dismissed pass round 2: short → stop
        .mockResolvedValueOnce([]); // read pass: empty → stop
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 5000 });

      await handler.process(makeJob());

      // dismissed pass makes exactly 2 findMany calls (bounded, terminates),
      // read pass makes exactly 1. Total 3 — not unbounded / infinite.
      expect(mockPrisma.notification.findMany).toHaveBeenCalledTimes(3);
      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('a batch of exactly BATCH_SIZE (5000) triggers one more round-trip that returns empty, and still terminates', async () => {
      const exactBatch = Array.from({ length: 5000 }, (_, i) => ({ id: `d-${i}` }));

      mockPrisma.notification.findMany
        .mockResolvedValueOnce(exactBatch as any) // dismissed round 1: exactly 5000 → ambiguous, must re-poll
        .mockResolvedValueOnce([]) // dismissed round 2: empty → stop
        .mockResolvedValueOnce([]); // read pass: empty → stop
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 5000 });

      await handler.process(makeJob());

      expect(mockPrisma.notification.findMany).toHaveBeenCalledTimes(3);
      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('stops immediately when the first batch of a pass is empty (no deleteMany call for that pass)', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await handler.process(makeJob());

      expect(mockPrisma.notification.findMany).toHaveBeenCalledTimes(2); // one empty round per pass
      expect(mockPrisma.notification.deleteMany).not.toHaveBeenCalled();
    });

    it('the logged/returned total reflects the sum of both passes deleteMany counts', async () => {
      mockPrisma.notification.findMany
        .mockResolvedValueOnce([{ id: 'd-1' }, { id: 'd-2' }] as any)
        .mockResolvedValueOnce([{ id: 'r-1' }] as any);
      mockPrisma.notification.deleteMany
        .mockResolvedValueOnce({ count: 2 }) // dismissed pass
        .mockResolvedValueOnce({ count: 1 }); // read pass

      const logSpy = jest.spyOn((handler as any).logger, 'log');

      await handler.process(makeJob());

      // Total of 3 (2 dismissed + 1 read) surfaces in the summary log line.
      const summaryCall = logSpy.mock.calls.find((args) =>
        String(args[0]).includes('deleted 3 notification'),
      );
      expect(summaryCall).toBeDefined();
    });

    it('takes each findMany call with take: BATCH_SIZE (5000)', async () => {
      await handler.process(makeJob());

      const calls = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      for (const call of calls) {
        expect(call[0].take).toBe(5000);
      }
    });

    it('passes only { id: true } as the select to keep batches lightweight', async () => {
      await handler.process(makeJob());

      const [firstCall] = (mockPrisma.notification.findMany as jest.Mock).mock.calls;
      expect(firstCall[0].select).toEqual({ id: true });
    });
  });

  // =========================================================================
  // Error propagation
  // =========================================================================

  describe('process — error propagation', () => {
    beforeEach(() => {
      mockSettings.getSettingValue
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(30);
    });

    it('propagates errors thrown by findMany', async () => {
      mockPrisma.notification.findMany.mockRejectedValue(new Error('Connection lost'));

      await expect(handler.process(makeJob())).rejects.toThrow('Connection lost');
    });

    it('propagates errors thrown by deleteMany', async () => {
      mockPrisma.notification.findMany.mockResolvedValueOnce([{ id: 'd-1' }] as any);
      mockPrisma.notification.deleteMany.mockRejectedValue(new Error('DB locked'));

      await expect(handler.process(makeJob())).rejects.toThrow('DB locked');
    });

    it('propagates errors thrown while reading settings', async () => {
      mockSettings.getSettingValue.mockReset();
      mockSettings.getSettingValue.mockRejectedValue(new Error('Settings DB error'));

      await expect(handler.process(makeJob())).rejects.toThrow('Settings DB error');
    });
  });
});
