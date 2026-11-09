/**
 * Unit tests for ShareExpiringService (epic #240, issue #247; link grants since RETRO-I4, #578).
 *
 *  - candidates come from `LinkGrantDirectory.expiringPage(now, now + 7 days)`: active
 *    link grants expiring in the lead window (the query shape is the directory's spec)
 *  - the sweep is idempotent across consecutive days: running it twice emits once
 *  - the skip check considers DISMISSED rows too (no `dismissed_at` predicate)
 *  - a link whose `expiresAt` is CHANGED gets a fresh notification (value-keyed stamp)
 *  - a link with no creator (SetNull) or whose record is gone is skipped, never crashes
 *  - a per-link failure is counted, never fatal to the rest of the sweep
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { createPlatformNotificationsMock } from '../../test/mocks/platform-notifications.mock';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { renderBrowserNotification } from '../notifications-registry/memoriahub.notifications';
import { PrismaService } from '../prisma/prisma.service';
import { LinkGrantDirectory, type ExpiringLink } from '../public-links/link-grant-directory.service';
import { SHARE_EXPIRY_LEAD_DAYS, ShareExpiringService } from './share-expiring.service';

const USER_ID = 'user-creator';
const LINK_ID = 'grant-111';
const ITEM_ID = 'item-1';
const ALBUM_ID = 'album-1';
const CIRCLE_ID = 'circle-abc';
const NOW = new Date('2026-08-05T12:00:00Z');

function makeLink(overrides: Partial<ExpiringLink> = {}): ExpiringLink {
  return {
    id: LINK_ID,
    resourceType: 'media_item',
    resourceId: ITEM_ID,
    grantedById: USER_ID,
    expiresAt: new Date('2026-08-08T12:00:00Z'), // 3 days out
    ...overrides,
  };
}

describe('ShareExpiringService', () => {
  let service: ShareExpiringService;
  let mockPrisma: MockPrismaService;
  let directory: { expiringPage: jest.Mock };
  let mockNotifications: { emit: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    directory = { expiringPage: jest.fn().mockResolvedValue([]) };
    mockNotifications = { emit: jest.fn().mockResolvedValue(undefined) };
    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({ originalFilename: 'beach-trip.jpg', circleId: CIRCLE_ID });
    (mockPrisma.album.findUnique as jest.Mock).mockResolvedValue({ name: 'Summer 2026', circleId: CIRCLE_ID });
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    // The platform `notify(eventKey, userId, data)` call, recorded with the event
    // template rendered at the sweep's `NOW` (the title's relative date is
    // rendered at dispatch time).
    const platform = createPlatformNotificationsMock();
    platform.mock.notify.mockImplementation(async (eventKey: string, userId: string, data: Record<string, unknown>) => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const rendered = renderBrowserNotification(eventKey, data);
      jest.useRealTimers();
      const { circleId, ...rest } = data;
      return mockNotifications.emit({ userId, circleId, type: eventKey, title: rendered?.title, link: rendered?.link, data: rest });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareExpiringService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: platform.mock },
        { provide: LinkGrantDirectory, useValue: directory },
      ],
    }).compile();

    service = module.get(ShareExpiringService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('candidates', () => {
    it('asks the directory for links expiring strictly after now and at/before the 7-day horizon', async () => {
      await service.sweep(NOW);

      expect(SHARE_EXPIRY_LEAD_DAYS).toBe(7);
      expect(directory.expiringPage).toHaveBeenCalledWith(NOW, new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000), 200, undefined);
    });

    it('skips a link whose creator is gone (granted_by_id SetNull)', async () => {
      directory.expiringPage.mockResolvedValueOnce([makeLink({ grantedById: null })]);

      const result = await service.sweep(NOW);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('skips a link whose record no longer exists', async () => {
      directory.expiringPage.mockResolvedValueOnce([makeLink()]);
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const result = await service.sweep(NOW);

      expect(mockNotifications.emit).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });
  });

  describe('idempotency: LIVE and DISMISSED rows both count as "already notified"', () => {
    it('running the sweep twice for the same link/expiry emits exactly once', async () => {
      directory.expiringPage.mockResolvedValue([makeLink()]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ exists: 1 }]);

      const day1 = await service.sweep(NOW);
      const day2 = await service.sweep(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));

      expect(mockNotifications.emit).toHaveBeenCalledTimes(1);
      expect(day1.emitted).toBe(1);
      expect(day2.emitted).toBe(0);
      expect(day2.skipped).toBe(1);
    });

    it('the probe does NOT filter on dismissed_at and keys on the (shareId, notifiedFor) pair', async () => {
      directory.expiringPage.mockResolvedValue([makeLink()]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]);

      await service.sweep(NOW);

      const sqlArg = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0];
      const text: string = sqlArg.text ?? sqlArg.sql ?? String(sqlArg);
      expect(text).not.toMatch(/dismissed_at/i);
      const values: unknown[] = sqlArg.values ?? [];
      expect(values).toContain(USER_ID);
      expect(values).toContain('shares.expiring');
      const json = values.find((v) => typeof v === 'string' && v.includes(LINK_ID));
      expect(JSON.parse(json as string)).toEqual({ shareId: LINK_ID, notifiedFor: makeLink().expiresAt.toISOString() });
      expect(mockNotifications.emit).not.toHaveBeenCalled();
    });

    it('a re-dated link (new expiresAt) gets a new notification', async () => {
      const redated = makeLink({ expiresAt: new Date('2026-08-10T00:00:00Z') });
      directory.expiringPage.mockResolvedValue([redated]);

      const result = await service.sweep(NOW);

      expect(result.emitted).toBe(1);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ notifiedFor: redated.expiresAt.toISOString() }) }),
      );
    });
  });

  describe('notification content', () => {
    it('emits the grant id, the expiry, the type, the target name and the circle', async () => {
      directory.expiringPage.mockResolvedValueOnce([makeLink()]);

      await service.sweep(NOW);

      expect(mockNotifications.emit).toHaveBeenCalledWith({
        userId: USER_ID,
        circleId: CIRCLE_ID,
        type: 'shares.expiring',
        title: expect.stringContaining("'beach-trip.jpg'"),
        link: '/admin/settings/sharing',
        data: {
          shareId: LINK_ID,
          notifiedFor: makeLink().expiresAt.toISOString(),
          targetType: 'media_item',
          targetName: 'beach-trip.jpg',
        },
      });
    });

    it('falls back to "a photo" for an item with no filename', async () => {
      directory.expiringPage.mockResolvedValueOnce([makeLink()]);
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValueOnce({ originalFilename: null, circleId: CIRCLE_ID });

      await service.sweep(NOW);

      expect(mockNotifications.emit).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("'a photo'") }));
    });

    it('titles an album link by the album name', async () => {
      directory.expiringPage.mockResolvedValueOnce([makeLink({ resourceType: 'album', resourceId: ALBUM_ID })]);

      await service.sweep(NOW);

      expect(mockPrisma.album.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ALBUM_ID } }));
      expect(mockNotifications.emit).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("'Summer 2026'") }));
    });

    it('relative-date phrasing: <1 day -> "today", 30h -> "tomorrow", else "in N days"', async () => {
      for (const c of [
        { hoursOut: 3, expect: 'today' },
        { hoursOut: 30, expect: 'tomorrow' },
        { hoursOut: 24 * 5, expect: 'in 5 days' },
      ]) {
        mockNotifications.emit.mockClear();
        directory.expiringPage.mockResolvedValueOnce([makeLink({ expiresAt: new Date(NOW.getTime() + c.hoursOut * 3600 * 1000) })]);
        await service.sweep(NOW);
        expect(mockNotifications.emit).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining(c.expect) }));
      }
    });
  });

  describe('keyset paging', () => {
    it('pages by id, stopping once a page returns fewer rows than the page size', async () => {
      const fullPage = Array.from({ length: 200 }, (_, i) => makeLink({ id: `grant-${i}` }));
      directory.expiringPage.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([makeLink({ id: 'grant-last' })]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]);

      const result = await service.sweep(NOW);

      expect(directory.expiringPage).toHaveBeenCalledTimes(2);
      expect(directory.expiringPage.mock.calls[1][3]).toBe('grant-199');
      expect(result.candidates).toBe(201);
    });
  });

  describe('failure isolation', () => {
    it('a failure on one link is counted and does not stop the rest of the sweep', async () => {
      directory.expiringPage.mockResolvedValueOnce([makeLink({ id: 'grant-bad' }), makeLink({ id: 'grant-good' })]);
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('db boom')).mockResolvedValueOnce([]);

      const result = await service.sweep(NOW);

      expect(result).toMatchObject({ errors: 1, emitted: 1, candidates: 2 });
    });

    it('a failing page read propagates (the task one layer up swallows it)', async () => {
      directory.expiringPage.mockRejectedValue(new Error('db down'));

      await expect(service.sweep(NOW)).rejects.toThrow('db down');
    });
  });
});
