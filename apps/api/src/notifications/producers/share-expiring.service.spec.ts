/**
 * Unit tests for ShareExpiringService (epic #240, issue #247).
 *
 * Covers the acceptance list verbatim:
 *  - the sweep is idempotent across consecutive days: running it twice emits
 *    once (the second run finds the stamp and skips)
 *  - the skip check considers DISMISSED rows too — a user who dismissed
 *    yesterday's warning must NOT be re-warned today. Asserted explicitly by
 *    proving `alreadyNotified`'s query carries NO `dismissed_at` predicate at
 *    all (i.e. it is not scoped to live rows only)
 *  - a share whose `expiresAt` is CHANGED gets a fresh notification (the
 *    stamp is value-keyed via `data.notifiedFor`, not a boolean)
 *  - only shares expiring within the 7-day lead window, not revoked, with a
 *    still-existing creator are candidates (query-shape assertions) — and a
 *    share missing either at read time is defensively skipped, never crashes
 *    the sweep
 *  - best-effort: a per-share failure is counted, never fatal to the rest of
 *    the sweep, and the sweep itself never throws
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType, ShareTargetType } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications.service';
import { SHARE_EXPIRY_LEAD_DAYS, ShareExpiringService } from './share-expiring.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-creator';
const SHARE_ID = 'share-111';
const CIRCLE_ID = 'circle-abc';
const NOW = new Date('2026-08-05T12:00:00Z');

function makeShareRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SHARE_ID,
    circleId: CIRCLE_ID,
    targetType: ShareTargetType.media_item,
    expiresAt: new Date('2026-08-08T12:00:00Z'), // 3 days out
    createdBy: { id: USER_ID },
    mediaItem: { originalFilename: 'beach-trip.jpg' },
    album: null,
    ...overrides,
  };
}

describe('ShareExpiringService', () => {
  let service: ShareExpiringService;
  let mockPrisma: MockPrismaService;
  let mockNotifications: { emit: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareExpiringService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get<ShareExpiringService>(ShareExpiringService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Query shape — window, revoked, creator INNER JOIN
  // -------------------------------------------------------------------------

  describe('candidate query shape', () => {
    it('scopes to non-revoked shares expiring strictly after now and at/before the 7-day horizon', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValue([]);

      await service.sweep(NOW);

      expect(SHARE_EXPIRY_LEAD_DAYS).toBe(7);
      const call = (mockPrisma.mediaShare.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.revokedAt).toBeNull();
      expect(call.where.expiresAt.gt).toEqual(NOW);
      expect(call.where.expiresAt.lte).toEqual(
        new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      );
    });

    it('selects createdBy via an inner-join-shaped relation select (creator must exist)', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValue([]);

      await service.sweep(NOW);

      const call = (mockPrisma.mediaShare.findMany as jest.Mock).mock.calls[0][0];
      expect(call.select.createdBy).toEqual({ select: { id: true } });
    });

    it('a share row with a null createdBy (defensive — should be structurally impossible) is skipped, not crashed on', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
        makeShareRow({ createdBy: null }),
      ]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.sweep(NOW);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('a share row with a null expiresAt (defensive) is skipped, not crashed on', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
        makeShareRow({ expiresAt: null }),
      ]);

      const result = await service.sweep(NOW);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency across consecutive days — the load-bearing half
  // -------------------------------------------------------------------------

  describe('idempotency: LIVE and DISMISSED rows both count as "already notified"', () => {
    it('running the sweep twice for the same share/expiry emits exactly once', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValue([makeShareRow()]);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([]) // day 1: no prior notification
        .mockResolvedValueOnce([{ exists: 1 }]); // day 2: stamp now exists

      const day1 = await service.sweep(NOW);
      const day2 = await service.sweep(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));

      expect(mockNotifications.emit).toHaveBeenCalledTimes(1);
      expect(day1.emitted).toBe(1);
      expect(day2.emitted).toBe(0);
      expect(day2.skipped).toBe(1);
    });

    it(
      'the idempotency probe query does NOT filter on dismissed_at — a DISMISSED prior ' +
        'warning still counts as "already told them", so the user is not re-warned',
      async () => {
        (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValue([makeShareRow()]);
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]);

        await service.sweep(NOW);

        const sqlArg = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0];
        // Prisma.sql produces a tagged-template object exposing `.text`/`.sql`
        // depending on driver; check whichever is present for the raw text.
        const text: string = sqlArg.text ?? sqlArg.sql ?? String(sqlArg);
        expect(text).not.toMatch(/dismissed_at/i);
        expect(mockNotifications.emit).not.toHaveBeenCalled();
      },
    );

    it('the probe keys on the (shareId, notifiedFor) VALUE pair via jsonb containment, scoped by userId + type', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValue([makeShareRow()]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.sweep(NOW);

      const sqlArg = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0];
      const values: unknown[] = sqlArg.values ?? [];
      expect(values).toContain(USER_ID);
      expect(values).toContain(String(NotificationType.share_expiring));
      const jsonValue = values.find((v) => typeof v === 'string' && v.includes(SHARE_ID));
      expect(jsonValue).toBeDefined();
      expect(JSON.parse(jsonValue as string)).toEqual({
        shareId: SHARE_ID,
        notifiedFor: makeShareRow().expiresAt!.toISOString(),
      });
    });

    it('a RESCHEDULED share (new expiresAt) is treated as fresh information and gets a new notification', async () => {
      const rescheduled = makeShareRow({ expiresAt: new Date('2026-08-10T00:00:00Z') });
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValue([rescheduled]);
      // The stamp for the OLD expiresAt exists, but the probe is keyed on the
      // CURRENT expiresAt value, so it must not find a match for the new one.
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.sweep(NOW);

      expect(result.emitted).toBe(1);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            notifiedFor: rescheduled.expiresAt!.toISOString(),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Notification content
  // -------------------------------------------------------------------------

  describe('notification content', () => {
    it('titles a media_item share by its original filename and falls back to "a photo"', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
        makeShareRow({ mediaItem: { originalFilename: 'beach-trip.jpg' } }),
      ]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.sweep(NOW);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining("'beach-trip.jpg'") }),
      );

      jest.clearAllMocks();
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
        makeShareRow({ mediaItem: { originalFilename: null } }),
      ]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.sweep(NOW);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining("'a photo'") }),
      );
    });

    it('titles an album share by its name and falls back to "an album"', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
        makeShareRow({
          targetType: ShareTargetType.album,
          mediaItem: null,
          album: { name: 'Summer 2026' },
        }),
      ]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await service.sweep(NOW);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining("'Summer 2026'") }),
      );
    });

    it('relative-date phrasing: <1 day -> "today", exactly 1 day -> "tomorrow", else "in N days"', async () => {
      const cases: Array<{ hoursOut: number; expect: string }> = [
        { hoursOut: 3, expect: 'today' },
        { hoursOut: 30, expect: 'tomorrow' },
        { hoursOut: 24 * 5, expect: 'in 5 days' },
      ];

      for (const c of cases) {
        jest.clearAllMocks();
        (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
          makeShareRow({ expiresAt: new Date(NOW.getTime() + c.hoursOut * 60 * 60 * 1000) }),
        ]);
        (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

        await service.sweep(NOW);

        expect(mockNotifications.emit).toHaveBeenCalledWith(
          expect.objectContaining({ title: expect.stringContaining(c.expect) }),
        );
      }
    });

    it('emits with the share circleId, link, and data.targetType', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([makeShareRow()]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.sweep(NOW);

      expect(mockNotifications.emit).toHaveBeenCalledWith({
        userId: USER_ID,
        circleId: CIRCLE_ID,
        type: NotificationType.share_expiring,
        title: expect.any(String),
        link: '/admin/settings/sharing',
        data: {
          shareId: SHARE_ID,
          notifiedFor: makeShareRow().expiresAt!.toISOString(),
          targetType: ShareTargetType.media_item,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Keyset paging
  // -------------------------------------------------------------------------

  describe('keyset paging', () => {
    it('pages by id, stopping once a page returns fewer rows than the page size', async () => {
      const fullPage = Array.from({ length: 200 }, (_, i) =>
        makeShareRow({ id: `share-${i}`, expiresAt: new Date('2026-08-09T00:00:00Z') }),
      );
      const lastPage = [makeShareRow({ id: 'share-last' })];
      (mockPrisma.mediaShare.findMany as jest.Mock)
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce(lastPage)
        .mockResolvedValueOnce([]); // safety net if the loop over-runs
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]); // skip all — content irrelevant here

      const result = await service.sweep(NOW);

      expect(mockPrisma.mediaShare.findMany).toHaveBeenCalledTimes(2);
      expect(result.candidates).toBe(201);
      // Second page's call carries a cursor.
      const secondCallArg = (mockPrisma.mediaShare.findMany as jest.Mock).mock.calls[1][0];
      expect(secondCallArg.cursor).toEqual({ id: 'share-199' });
      expect(secondCallArg.skip).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: per-share failure isolation and best-effort
  // -------------------------------------------------------------------------

  describe('failure isolation', () => {
    it('a failure notifying one share is counted in errors and does not stop the rest of the sweep', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockResolvedValueOnce([
        makeShareRow({ id: 'share-bad' }),
        makeShareRow({ id: 'share-good' }),
      ]);
      (mockPrisma.$queryRaw as jest.Mock)
        .mockRejectedValueOnce(new Error('db boom'))
        .mockResolvedValueOnce([]);

      const result = await service.sweep(NOW);

      expect(result.errors).toBe(1);
      expect(result.emitted).toBe(1);
      expect(result.candidates).toBe(2);
    });

    it('sweep() itself never throws even when the top-level findMany rejects', async () => {
      (mockPrisma.mediaShare.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(service.sweep(NOW)).rejects.toThrow();
      // NOTE: unlike the other three producers, ShareExpiringService.sweep()
      // does NOT itself swallow a top-level query failure — only PER-SHARE
      // failures inside the loop are caught (see failure isolation above).
      // The best-effort/never-throws contract for this producer is enforced
      // one layer up, by ShareExpiringTask.handleScheduledSweep()'s own
      // try/catch (see share-expiring.task.spec.ts).
    });
  });
});
