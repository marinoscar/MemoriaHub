/**
 * Unit tests for NotificationsService (epic #240, issue #245).
 *
 * Covers:
 *  - list(): the four status filters (unread/read/dismissed/all — the
 *    dismissed-row-exclusion asymmetry is the single most regression-prone
 *    behavior here), ordering, pagination meta, pageSize capping, circleId scope
 *  - getUnreadCount(): per-user TTL cache, cross-user isolation, invalidation
 *    on every mutation path
 *  - markRead() / dismiss() / remove(): cross-user 404 scoping (security-
 *    critical), idempotency (COALESCE), countAtRead SQL shape, dismiss-implies-read
 *  - markAllRead() / dismissAll(): raw-SQL + updateMany split, circleId scoping,
 *    SQL fragment/value assertions
 *  - emit() / upsertState(): best-effort (never throws), state-row upsert,
 *    P2002 concurrent-create retry
 */

import { NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsService } from './notifications.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const OTHER_USER_ID = 'user-xyz';
const CIRCLE_ID = 'circle-111';
const NOTIF_ID = 'notif-111';

/** Build a Prisma P2002 error the way Prisma actually throws it. */
function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '0.0.0',
    meta: { target: ['user_id', 'circle_id', 'type'] },
  });
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTIF_ID,
    userId: USER_ID,
    circleId: CIRCLE_ID,
    type: 'review_queue_bursts',
    title: 'Bursts pending review',
    body: null,
    link: '/bursts',
    data: { count: 5 },
    readAt: null,
    dismissedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

/** Wires $transaction so `cb(tx)` runs against the same mock (mirrors production tx semantics). */
function wireTransactionPassthrough(mockPrisma: MockPrismaService): void {
  (mockPrisma.$transaction as jest.Mock).mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)(mockPrisma);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg;
  });
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockPrisma: MockPrismaService;
  /**
   * #251 preference gate. Defaults to "everything enabled", which is the state
   * every pre-#251 assertion in this file was written against.
   */
  let mockPreferences: {
    isEnabled: jest.Mock;
    prime: jest.Mock;
    invalidate: jest.Mock;
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockPreferences = {
      isEnabled: jest.fn().mockResolvedValue(true),
      prime: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationPreferencesService, useValue: mockPreferences },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // list() — status filter semantics (the dismissed-exclusion asymmetry)
  // =========================================================================

  describe('list() — status filter semantics', () => {
    beforeEach(() => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('status=unread → { dismissedAt: null, readAt: null }', async () => {
      await service.list(USER_ID, { status: 'unread' });

      const where = (mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ userId: USER_ID, dismissedAt: null, readAt: null });
      // count() must use the identical predicate as findMany()
      expect((mockPrisma.notification.count as jest.Mock).mock.calls[0][0].where).toMatchObject({
        dismissedAt: null,
        readAt: null,
      });
    });

    it('status=read → { dismissedAt: null, readAt: { not: null } }', async () => {
      await service.list(USER_ID, { status: 'read' });

      const where = (mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ dismissedAt: null, readAt: { not: null } });
    });

    it('status=dismissed → ONLY dismissed rows: { dismissedAt: { not: null } }', async () => {
      await service.list(USER_ID, { status: 'dismissed' });

      const where = (mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ dismissedAt: { not: null } });
      // Must NOT also filter by readAt — dismissed rows are returned
      // regardless of read state.
      expect(where.readAt).toBeUndefined();
    });

    it('status=all → dismissed rows EXCLUDED: { dismissedAt: null } only (no readAt filter)', async () => {
      await service.list(USER_ID, { status: 'all' });

      const where = (mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ dismissedAt: null });
      expect(where.readAt).toBeUndefined();
    });

    it('omitted status defaults to "all" semantics (dismissed rows excluded)', async () => {
      await service.list(USER_ID, {});

      const where = (mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ dismissedAt: null });
      expect(where.readAt).toBeUndefined();
    });
  });

  // =========================================================================
  // list() — ordering, pagination, scoping
  // =========================================================================

  describe('list() — ordering, pagination meta, scoping', () => {
    it('orders newest-first with an id tiebreak', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.list(USER_ID, {});

      expect((mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('computes pagination meta from totalItems/pageSize', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(45);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([makeRow()]);

      const result = await service.list(USER_ID, { page: 2, pageSize: 20 });

      expect(result.meta).toEqual({ page: 2, pageSize: 20, totalItems: 45, totalPages: 3 });
      expect((mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].skip).toBe(20);
      expect((mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].take).toBe(20);
    });

    it('totalPages is at least 1 even when there are zero items', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.list(USER_ID, {});

      expect(result.meta.totalPages).toBe(1);
    });

    it('caps pageSize at 100 even if a caller passes a larger value directly to the service', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.list(USER_ID, { pageSize: 500 });

      expect(result.meta.pageSize).toBe(100);
      expect((mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].take).toBe(100);
    });

    it('floors pageSize at 1 and page at 1', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.list(USER_ID, { page: 0, pageSize: 0 });

      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(1);
    });

    it('scopes to circleId when provided, and omits it when not', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.list(USER_ID, { circleId: CIRCLE_ID });
      expect((mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
        circleId: CIRCLE_ID,
      });

      await service.list(USER_ID, {});
      expect(
        (mockPrisma.notification.findMany as jest.Mock).mock.calls[1][0].where,
      ).not.toHaveProperty('circleId');
    });

    it('always scopes to the caller userId', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);

      await service.list(USER_ID, {});

      expect((mockPrisma.notification.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
        userId: USER_ID,
      });
    });

    it('maps rows to DTOs with ISO-string timestamps', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([makeRow()]);

      const result = await service.list(USER_ID, {});

      expect(result.items[0]).toMatchObject({
        id: NOTIF_ID,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        readAt: null,
        dismissedAt: null,
      });
    });
  });

  // =========================================================================
  // getUnreadCount() — per-user TTL cache
  // =========================================================================

  describe('getUnreadCount() — per-user cache', () => {
    it('queries Prisma with { readAt: null, dismissedAt: null } scoped to the user', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(7);

      const result = await service.getUnreadCount(USER_ID);

      expect(result).toEqual({ count: 7 });
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: USER_ID, readAt: null, dismissedAt: null },
      });
    });

    it('a second call within the TTL does NOT re-query Prisma', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(3);

      await service.getUnreadCount(USER_ID);
      const result2 = await service.getUnreadCount(USER_ID);

      expect(result2).toEqual({ count: 3 });
      expect(mockPrisma.notification.count).toHaveBeenCalledTimes(1);
    });

    it('re-queries after the TTL expires', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      (mockPrisma.notification.count as jest.Mock)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(9);

      nowSpy.mockReturnValue(1_000_000);
      await service.getUnreadCount(USER_ID);

      // 2001ms later — past the 2000ms TTL.
      nowSpy.mockReturnValue(1_002_001);
      const result = await service.getUnreadCount(USER_ID);

      expect(result).toEqual({ count: 9 });
      expect(mockPrisma.notification.count).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });

    it('SECURITY: a cached value for user A is never returned for user B', async () => {
      (mockPrisma.notification.count as jest.Mock)
        .mockResolvedValueOnce(5) // userA
        .mockResolvedValueOnce(9); // userB

      const a = await service.getUnreadCount(USER_ID);
      const b = await service.getUnreadCount(OTHER_USER_ID);

      expect(a).toEqual({ count: 5 });
      expect(b).toEqual({ count: 9 });
      expect(mockPrisma.notification.count).toHaveBeenCalledTimes(2);

      // Re-fetch userA within the TTL — must still see userA's own cached
      // value, not userB's, and must not issue a third query.
      const aAgain = await service.getUnreadCount(USER_ID);
      expect(aAgain).toEqual({ count: 5 });
      expect(mockPrisma.notification.count).toHaveBeenCalledTimes(2);
    });

    describe('cache invalidation on every mutation path', () => {
      /**
       * For each mutation, prime the cache for USER_ID, perform the mutation,
       * then assert a subsequent getUnreadCount() re-queries Prisma instead of
       * serving the stale cached value — proving the mutation invalidated the
       * per-user entry.
       */
      async function expectInvalidates(mutate: () => Promise<unknown>): Promise<void> {
        (mockPrisma.notification.count as jest.Mock)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2);

        await service.getUnreadCount(USER_ID); // primes cache with 1
        await mutate();
        const after = await service.getUnreadCount(USER_ID);

        expect(after).toEqual({ count: 2 });
        expect(mockPrisma.notification.count).toHaveBeenCalledTimes(2);
      }

      it('markRead() invalidates', async () => {
        (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
        await expectInvalidates(() => service.markRead(USER_ID, NOTIF_ID));
      });

      it('dismiss() invalidates', async () => {
        (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);
        await expectInvalidates(() => service.dismiss(USER_ID, NOTIF_ID));
      });

      it('remove() invalidates', async () => {
        (mockPrisma.notification.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
        await expectInvalidates(() => service.remove(USER_ID, NOTIF_ID));
      });

      it('markAllRead() invalidates', async () => {
        wireTransactionPassthrough(mockPrisma);
        (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
        (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        await expectInvalidates(() => service.markAllRead(USER_ID));
      });

      it('dismissAll() invalidates', async () => {
        (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
        await expectInvalidates(() => service.dismissAll(USER_ID));
      });

      it('emit() invalidates', async () => {
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());
        await expectInvalidates(() =>
          service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' }),
        );
      });

      it('upsertState() invalidates', async () => {
        (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        await expectInvalidates(() =>
          service.upsertState({
            userId: USER_ID,
            circleId: CIRCLE_ID,
            type: 'review_queue_bursts',
            title: 'x',
          }),
        );
      });
    });
  });

  // =========================================================================
  // markRead() — single-row mutation
  // =========================================================================

  describe('markRead()', () => {
    it('issues an atomic UPDATE scoped by id AND user_id, with COALESCE for idempotency', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      await service.markRead(USER_ID, NOTIF_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([NOTIF_ID, USER_ID]);
      expect(sqlArg.text).toContain('COALESCE(read_at, now())');
      expect(sqlArg.text).toContain('jsonb_exists(data');
      expect(sqlArg.text).toContain("'{countAtRead}'");
      expect(sqlArg.text).toMatch(/WHERE id = .*AND user_id = /s);
    });

    it('SECURITY: a row belonging to another user yields 404, not 403 (affected=0)', async () => {
      // The WHERE clause is scoped by id AND user_id, so a cross-user id
      // updates zero rows — indistinguishable from a nonexistent id.
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await expect(service.markRead(OTHER_USER_ID, NOTIF_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the id does not exist at all', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await expect(service.markRead(USER_ID, 'nonexistent')).rejects.toThrow(
        'Notification not found',
      );
    });
  });

  // =========================================================================
  // dismiss() — single-row mutation, implies read
  // =========================================================================

  describe('dismiss()', () => {
    it('issues an atomic UPDATE setting both dismissed_at and read_at via COALESCE (implies read)', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      await service.dismiss(USER_ID, NOTIF_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([NOTIF_ID, USER_ID]);
      expect(sqlArg.text).toContain('COALESCE(dismissed_at, now())');
      expect(sqlArg.text).toContain('COALESCE(read_at, now())');
    });

    it('SECURITY: a row belonging to another user yields 404 (affected=0)', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await expect(service.dismiss(OTHER_USER_ID, NOTIF_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('is idempotent: a second dismiss call still succeeds (affected=1 both times)', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      await service.dismiss(USER_ID, NOTIF_ID);
      await expect(service.dismiss(USER_ID, NOTIF_ID)).resolves.toBeUndefined();
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // remove() — hard delete
  // =========================================================================

  describe('remove()', () => {
    it('deletes scoped by id AND userId', async () => {
      (mockPrisma.notification.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.remove(USER_ID, NOTIF_ID);

      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { id: NOTIF_ID, userId: USER_ID },
      });
    });

    it('SECURITY: a row belonging to another user yields 404, not 403 (count=0)', async () => {
      (mockPrisma.notification.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.remove(OTHER_USER_ID, NOTIF_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // markAllRead() — bulk read, two-statement split
  // =========================================================================

  describe('markAllRead()', () => {
    beforeEach(() => wireTransactionPassthrough(mockPrisma));

    it('runs the raw jsonb_set statement and the plain updateMany inside one transaction and sums their counts', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(4); // rows WITH data.count
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 6 }); // the remainder

      const result = await service.markAllRead(USER_ID);

      expect(result).toEqual({ updated: 10 });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('the raw statement targets unread, non-dismissed, data.count rows and stamps updated_at explicitly', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.markAllRead(USER_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([USER_ID]);
      expect(sqlArg.text).toContain('jsonb_exists(data');
      expect(sqlArg.text).toContain("'{countAtRead}'");
      expect(sqlArg.text).toContain('updated_at = now()');
      expect(sqlArg.text).toContain('read_at IS NULL');
      expect(sqlArg.text).toContain('dismissed_at IS NULL');
    });

    it('the plain updateMany covers the remainder: userId + readAt:null + dismissedAt:null', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.markAllRead(USER_ID);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, readAt: null, dismissedAt: null },
        data: { readAt: expect.any(Date) },
      });
    });

    it('scopes both statements to circleId when provided', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.markAllRead(USER_ID, CIRCLE_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([USER_ID, CIRCLE_ID]);
      expect(sqlArg.text).toContain('circle_id');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, readAt: null, dismissedAt: null, circleId: CIRCLE_ID },
        data: { readAt: expect.any(Date) },
      });
    });

    it('omits circle_id from both statements when circleId is not provided', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.markAllRead(USER_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([USER_ID]);
      expect(sqlArg.text).not.toContain('circle_id');
      expect(
        (mockPrisma.notification.updateMany as jest.Mock).mock.calls[0][0].where,
      ).not.toHaveProperty('circleId');
    });
  });

  // =========================================================================
  // dismissAll() — bulk dismiss
  // =========================================================================

  describe('dismissAll()', () => {
    it('issues one raw UPDATE and returns its affected-row count directly', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(7);

      const result = await service.dismissAll(USER_ID);

      expect(result).toEqual({ updated: 7 });
    });

    it('sets dismissed_at, COALESCEs read_at (dismiss implies read), and stamps updated_at', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await service.dismissAll(USER_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([USER_ID]);
      expect(sqlArg.text).toContain('dismissed_at = now()');
      expect(sqlArg.text).toContain('COALESCE(read_at, now())');
      expect(sqlArg.text).toContain('updated_at = now()');
      expect(sqlArg.text).toContain('dismissed_at IS NULL');
    });

    it('scopes to circleId when provided', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await service.dismissAll(USER_ID, CIRCLE_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([USER_ID, CIRCLE_ID]);
      expect(sqlArg.text).toContain('circle_id');
    });

    it('omits circle_id when not provided', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await service.dismissAll(USER_ID);

      const sqlArg = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
      expect(sqlArg.values).toEqual([USER_ID]);
      expect(sqlArg.text).not.toContain('circle_id');
    });
  });

  // =========================================================================
  // emit() — EVENT-type producer write
  // =========================================================================

  describe('emit()', () => {
    it('creates a new row for the given event type', async () => {
      (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

      await service.emit({
        userId: USER_ID,
        circleId: CIRCLE_ID,
        type: 'upload_completed',
        title: 'Upload finished',
        body: 'body text',
        link: '/media/1',
        data: { mediaItemId: 'm1' },
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          circleId: CIRCLE_ID,
          type: 'upload_completed',
          title: 'Upload finished',
          body: 'body text',
          link: '/media/1',
          data: { mediaItemId: 'm1' },
        },
      });
    });

    it('writes SQL NULL (Prisma.JsonNull) — not a JSON null literal — when no data payload is given', async () => {
      (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

      await service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' });

      const callArg = (mockPrisma.notification.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.data).toBe(Prisma.JsonNull);
      expect(callArg.data.circleId).toBeNull();
      expect(callArg.data.body).toBeNull();
      expect(callArg.data.link).toBeNull();
    });

    it('BEST-EFFORT: never throws when the underlying Prisma call rejects', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.notification.create as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(
        service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('upload_completed'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });
  });

  // =========================================================================
  // upsertState() — STATE-type producer write (at most one LIVE row)
  // =========================================================================

  describe('upsertState()', () => {
    const stateInput = {
      userId: USER_ID,
      circleId: CIRCLE_ID,
      type: 'review_queue_bursts' as const,
      title: 'Bursts pending review',
      data: { count: 12 },
    };

    it('refreshes an existing LIVE row in place (updateMany matches → no create)', async () => {
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.upsertState(stateInput);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          circleId: CIRCLE_ID,
          type: 'review_queue_bursts',
          dismissedAt: null,
        },
        data: { title: stateInput.title, body: null, link: null, data: stateInput.data },
      });
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('creates when no LIVE row exists (updateMany matches zero rows)', async () => {
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

      await service.upsertState(stateInput);

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          circleId: CIRCLE_ID,
          type: 'review_queue_bursts',
          title: stateInput.title,
          body: null,
          link: null,
          data: stateInput.data,
        },
      });
    });

    it('P2002 concurrent-create race: retries as an update rather than throwing', async () => {
      (mockPrisma.notification.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 0 }) // no live row found initially
        .mockResolvedValueOnce({ count: 1 }); // retry after losing the create race
      (mockPrisma.notification.create as jest.Mock).mockRejectedValue(makeP2002Error());

      await service.upsertState(stateInput);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('BEST-EFFORT: a non-P2002 create failure never throws to the caller', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.notification.create as jest.Mock).mockRejectedValue(new Error('constraint violation'));

      await expect(service.upsertState(stateInput)).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('review_queue_bursts'));
    });

    it('BEST-EFFORT: never throws when the underlying updateMany rejects outright', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.notification.updateMany as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(service.upsertState(stateInput)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('does not touch readAt on refresh — left to the caller to decide re-marking-unread semantics', async () => {
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.upsertState(stateInput);

      const data = (mockPrisma.notification.updateMany as jest.Mock).mock.calls[0][0].data;
      expect(data).not.toHaveProperty('readAt');
    });
  });

  // =========================================================================
  // upsertCountedEvent() — the #247 COUNTED EVENT producer primitive
  //
  // NOTE ON WHAT THIS PROVES vs. DOESN'T: $queryRaw/$executeRaw are mocked, so
  // these tests inspect the SHAPE of the SQL this method builds (which columns
  // it filters/compares on, which parameters it binds) — they prove the method
  // asks Postgres the right question. They do NOT execute real SQL, so they
  // cannot prove Postgres answers correctly (e.g. that `pg_advisory_xact_lock`
  // actually serializes two concurrent transactions, or that `updated_at >
  // now() - interval` evaluates as expected at a real boundary). That requires
  // a live database — see the DB_GATED integration suite this task's ground
  // rules point at (test/notifications/notification-dedup.integration.spec.ts)
  // for the pattern used elsewhere in this module when that distinction
  // matters enough to justify a second, DB-gated suite.
  // =========================================================================

  describe('upsertCountedEvent()', () => {
    const baseInput = {
      userId: USER_ID,
      circleId: CIRCLE_ID,
      type: 'upload_completed' as const,
      buildTitle: (count: number) => `${count} uploaded`,
    };

    beforeEach(() => {
      wireTransactionPassthrough(mockPrisma);
    });

    function lastQueryRawSql(): Prisma.Sql {
      return (mockPrisma.$queryRaw as jest.Mock).mock.calls.at(-1)![0] as Prisma.Sql;
    }

    function lastAdvisoryLockSql(): Prisma.Sql {
      // The advisory lock is always the FIRST $executeRaw call of the
      // transaction; a subsequent increment-path UPDATE is a later call.
      return (mockPrisma.$executeRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    }

    // -----------------------------------------------------------------------
    // Advisory lock — serializes the find-or-create per aggregation key
    // -----------------------------------------------------------------------

    describe('advisory lock', () => {
      it('takes pg_advisory_xact_lock(hashtext(key)) as the FIRST statement of the transaction', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent(baseInput);

        const lockSql = lastAdvisoryLockSql();
        expect(lockSql.text).toContain('pg_advisory_xact_lock(hashtext(');
        expect(lockSql.values).toEqual([`${USER_ID}|upload_completed|${CIRCLE_ID}|-`]);
      });

      it('the lock key incorporates matchData (JSON-stringified) so different job types never share a lock', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({
          ...baseInput,
          circleId: null,
          matchData: { jobType: 'auto_tagging' },
        });

        const lockSql = lastAdvisoryLockSql();
        expect(lockSql.values).toEqual([
          `${USER_ID}|upload_completed|-|${JSON.stringify({ jobType: 'auto_tagging' })}`,
        ]);
      });
    });

    // -----------------------------------------------------------------------
    // Window arithmetic — anchor field, comparison operator, unit conversion
    // -----------------------------------------------------------------------

    describe('rolling window clause', () => {
      it('when windowMs is set, the lookup filters on updated_at (NOT created_at) with a strict ">" against now() minus the interval', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({ ...baseInput, windowMs: 15 * 60 * 1000 });

        const sql = lastQueryRawSql();
        expect(sql.text).toContain('updated_at >');
        expect(sql.text).not.toContain('created_at >');
        expect(sql.text).toContain('make_interval(secs =>');
      });

      it('converts windowMs to seconds (divides by 1000) for make_interval', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({ ...baseInput, windowMs: 15 * 60 * 1000 });

        const sql = lastQueryRawSql();
        expect(sql.values).toContain(900); // 15*60*1000 / 1000 = 900 seconds
      });

      it('omits the window clause entirely when windowMs is null (accumulate until dismissed)', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({ ...baseInput, windowMs: null });

        const sql = lastQueryRawSql();
        expect(sql.text).not.toContain('updated_at >');
        expect(sql.text).not.toContain('make_interval');
      });

      it('omits the window clause when windowMs is undefined (same as null)', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        const { windowMs, ...withoutWindow } = { ...baseInput, windowMs: undefined as unknown };
        await service.upsertCountedEvent(withoutWindow as typeof baseInput);

        const sql = lastQueryRawSql();
        expect(sql.text).not.toContain('updated_at >');
      });

      it('omits the window clause when windowMs is 0 (falsy, treated as "no window" per the > 0 guard)', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({ ...baseInput, windowMs: 0 });

        const sql = lastQueryRawSql();
        expect(sql.text).not.toContain('updated_at >');
      });
    });

    // -----------------------------------------------------------------------
    // matchData JSONB containment partition
    // -----------------------------------------------------------------------

    describe('matchData partition', () => {
      it('adds a jsonb containment predicate when matchData is supplied', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({
          ...baseInput,
          matchData: { jobType: 'geocode' },
        });

        const sql = lastQueryRawSql();
        expect(sql.text).toContain('data @>');
        expect(sql.values).toContain(JSON.stringify({ jobType: 'geocode' }));
      });

      it('omits the containment predicate entirely when matchData is not supplied', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent(baseInput);

        const sql = lastQueryRawSql();
        expect(sql.text).not.toContain('data @>');
      });
    });

    // -----------------------------------------------------------------------
    // Global (circleId: null) rows — NULL-safe comparison
    // -----------------------------------------------------------------------

    describe('circleId null-safety', () => {
      it('uses IS NOT DISTINCT FROM (not plain "=") so a global row (circle_id IS NULL) can be found again', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({ ...baseInput, circleId: null });

        const sql = lastQueryRawSql();
        expect(sql.text).toContain('IS NOT DISTINCT FROM');
        expect(sql.text).not.toMatch(/circle_id\s*=\s*\$/);
      });
    });

    // -----------------------------------------------------------------------
    // Create vs. increment branch, count arithmetic, title rebuild
    // -----------------------------------------------------------------------

    describe('create-vs-increment branching', () => {
      it('creates a new row with count = increment (default 1) when no live row is found', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent(baseInput);

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            userId: USER_ID,
            circleId: CIRCLE_ID,
            type: 'upload_completed',
            title: '1 uploaded',
            data: { count: 1 },
          }),
        });
        expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1); // lock only, no UPDATE
      });

      it('increments an existing live row via raw UPDATE (no create) and rebuilds the title from the NEW total', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'row-existing', count: 5 }]);

        await service.upsertCountedEvent({ ...baseInput, increment: 3 });

        expect(mockPrisma.notification.create).not.toHaveBeenCalled();
        // Two $executeRaw calls: the advisory lock, then the increment UPDATE.
        expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
        const updateSql = (mockPrisma.$executeRaw as jest.Mock).mock.calls[1][0] as Prisma.Sql;
        expect(updateSql.text).toContain('SET title =');
        expect(updateSql.values).toContain('8 uploaded'); // 5 + 3
        expect(updateSql.values).toContain('row-existing');
      });

      it('a custom increment other than 1 is honored on the CREATE path too', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({ ...baseInput, increment: 5 });

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ data: { count: 5 } }),
        });
      });

      it('merges extra `data` payload fields alongside `count`', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent({
          ...baseInput,
          data: { jobType: 'geocode', lastError: null },
        });

        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            data: { jobType: 'geocode', lastError: null, count: 1 },
          }),
        });
      });
    });

    // -----------------------------------------------------------------------
    // reunreadOnIncrement
    // -----------------------------------------------------------------------

    describe('reunreadOnIncrement', () => {
      it('clears read_at on the increment UPDATE when reunreadOnIncrement is true', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'row-existing', count: 1 }]);

        await service.upsertCountedEvent({ ...baseInput, reunreadOnIncrement: true });

        const updateSql = (mockPrisma.$executeRaw as jest.Mock).mock.calls[1][0] as Prisma.Sql;
        expect(updateSql.text).toContain('read_at = NULL');
      });

      it('does NOT clear read_at when reunreadOnIncrement is false/omitted', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'row-existing', count: 1 }]);

        await service.upsertCountedEvent(baseInput);

        const updateSql = (mockPrisma.$executeRaw as jest.Mock).mock.calls[1][0] as Prisma.Sql;
        expect(updateSql.text).not.toContain('read_at = NULL');
      });
    });

    // -----------------------------------------------------------------------
    // Best-effort — never throws
    // -----------------------------------------------------------------------

    describe('best-effort contract', () => {
      it('never throws when the transaction rejects outright', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        (mockPrisma.$transaction as jest.Mock).mockRejectedValue(new Error('db down'));

        await expect(service.upsertCountedEvent(baseInput)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('upload_completed'));
      });

      it('never throws when $queryRaw rejects inside the transaction', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('query failed'));

        await expect(service.upsertCountedEvent(baseInput)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
      });

      it('never throws when notification.create rejects', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockRejectedValue(new Error('constraint'));

        await expect(service.upsertCountedEvent(baseInput)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
      });

      it('invalidates the caller unread-count cache on success', async () => {
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());
        (mockPrisma.notification.count as jest.Mock)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2);

        await service.getUnreadCount(USER_ID); // primes cache
        await service.upsertCountedEvent(baseInput);
        const after = await service.getUnreadCount(USER_ID);

        expect(after).toEqual({ count: 2 });
      });
    });
  });

  // =========================================================================
  // #251 preference gate — enforced in ALL THREE write paths
  //
  // NotificationsService never inspects settings itself: every write path
  // asks the injected NotificationPreferencesService.isEnabled() first and
  // writes NOTHING when it returns false. These tests replace the
  // beforeEach's default `isEnabled: true` stub per-case to prove the gate is
  // real for each of emit()/upsertState()/upsertCountedEvent() individually —
  // upsertCountedEvent() is the highest-volume path (upload_completed /
  // enrichment_failed), so a gap there would silently break preferences for
  // exactly the types users toggle off first.
  // =========================================================================

  describe('#251 preference gate — suppression across all three write paths', () => {
    describe('emit()', () => {
      it('a disabled type writes NO row', async () => {
        mockPreferences.isEnabled.mockResolvedValue(false);

        await service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' });

        expect(mockPreferences.isEnabled).toHaveBeenCalledWith(USER_ID, 'upload_completed');
        expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      });

      it('does not touch the unread-count cache when suppressed (nothing was written)', async () => {
        mockPreferences.isEnabled.mockResolvedValue(false);
        (mockPrisma.notification.count as jest.Mock).mockResolvedValue(3);

        await service.getUnreadCount(USER_ID); // primes cache with 3
        await service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' });
        const after = await service.getUnreadCount(USER_ID);

        // Still served from cache (never invalidated) — proves emit() returned
        // before reaching the create()+invalidate step.
        expect(after).toEqual({ count: 3 });
        expect(mockPrisma.notification.count).toHaveBeenCalledTimes(1);
      });

      it('an enabled type is unaffected — the gate is per-call, not global', async () => {
        mockPreferences.isEnabled.mockResolvedValue(true);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' });

        expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      });
    });

    describe('upsertState()', () => {
      const stateInput = {
        userId: USER_ID,
        circleId: CIRCLE_ID,
        type: 'review_queue_bursts' as const,
        title: 'Bursts pending review',
        data: { count: 12 },
      };

      it('a disabled STATE type writes no row AND refreshes none', async () => {
        mockPreferences.isEnabled.mockResolvedValue(false);

        await service.upsertState(stateInput);

        expect(mockPreferences.isEnabled).toHaveBeenCalledWith(USER_ID, 'review_queue_bursts');
        expect(mockPrisma.notification.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      });

      it('does not resurrect an existing live row for a now-suppressed type — no update, no create', async () => {
        mockPreferences.isEnabled.mockResolvedValue(false);
        // Even if a live row happened to exist, the gate must short-circuit
        // before the updateMany is ever issued.
        (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

        await service.upsertState(stateInput);

        expect(mockPrisma.notification.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('upsertCountedEvent()', () => {
      const countedInput = {
        userId: USER_ID,
        circleId: CIRCLE_ID,
        type: 'upload_completed' as const,
        buildTitle: (count: number) => `${count} uploaded`,
      };

      it('a disabled type writes no row and never opens the transaction (never contends for the advisory lock)', async () => {
        mockPreferences.isEnabled.mockResolvedValue(false);

        await service.upsertCountedEvent(countedInput);

        expect(mockPreferences.isEnabled).toHaveBeenCalledWith(USER_ID, 'upload_completed');
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      });

      it('enrichment_failed (the other counted-event type) is gated identically', async () => {
        mockPreferences.isEnabled.mockResolvedValue(false);

        await service.upsertCountedEvent({
          userId: USER_ID,
          type: 'enrichment_failed',
          matchData: { jobType: 'auto_tagging' },
          buildTitle: (count) => `${count} failed`,
        });

        expect(mockPreferences.isEnabled).toHaveBeenCalledWith(USER_ID, 'enrichment_failed');
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('checked BEFORE $transaction opens — an enabled type still proceeds normally', async () => {
        mockPreferences.isEnabled.mockResolvedValue(true);
        wireTransactionPassthrough(mockPrisma);
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
        (mockPrisma.notification.create as jest.Mock).mockResolvedValue(makeRow());

        await service.upsertCountedEvent(countedInput);

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      });
    });

    describe('master switch (enabled: false) suppresses every type', () => {
      it('emit(), upsertState(), and upsertCountedEvent() all no-op when isEnabled resolves false for every type — the gate is uniform regardless of WHY isEnabled said no', async () => {
        // NotificationsService itself has no notion of a "master switch" — it
        // only ever asks isEnabled(userId, type). Modeling the master switch's
        // effect (every type suppressed) is exactly "isEnabled always returns
        // false", which is what NotificationPreferencesService.isEnabled()
        // resolves to for every type once `enabled: false` is stored (see
        // notification-preferences.service.spec.ts for that resolution).
        mockPreferences.isEnabled.mockResolvedValue(false);
        wireTransactionPassthrough(mockPrisma);

        await service.emit({ userId: USER_ID, type: 'upload_completed', title: 'x' });
        await service.upsertState({
          userId: USER_ID,
          circleId: CIRCLE_ID,
          type: 'review_queue_bursts',
          title: 'x',
        });
        await service.upsertCountedEvent({
          userId: USER_ID,
          type: 'enrichment_failed',
          buildTitle: (c) => `${c}`,
        });

        expect(mockPrisma.notification.create).not.toHaveBeenCalled();
        expect(mockPrisma.notification.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });
    });
  });
});
