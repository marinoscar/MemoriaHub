/**
 * Unit tests for ShareExpiringService (epic #240, issue #247; link grants since RETRO-I4, #578).
 *
 *  - candidates come from `LinkGrantsService.listExpiring({ orgId, within: 7 days })`: active
 *    link grants expiring in the lead window (the query is the slice's)
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
import { LinkGrantsService } from '@marinoscar/platform-api/sharing';
import { DefaultOrgId } from '../common/tenancy/default-org-id';
import { PrismaService } from '../prisma/prisma.service';
import { SHARE_EXPIRY_LEAD_DAYS, ShareExpiringService, type ExpiringLink } from './share-expiring.service';

const USER_ID = 'user-creator';
const LINK_ID = 'grant-111';
const ITEM_ID = 'item-1';
const ALBUM_ID = 'album-1';
const CIRCLE_ID = 'circle-abc';
const NOW = new Date('2026-08-05T12:00:00Z');
const ORG_ID = 'org-default';

/** One `listExpiring` page of the given links (the slice's grant shape). */
function page(links: ExpiringLink[], nextCursor: string | null = null) {
  return {
    items: links.map((l) => ({
      grantId: l.id,
      orgId: ORG_ID,
      resourceType: l.resourceType,
      resourceId: l.resourceId,
      role: 'viewer',
      label: null,
      expiresAt: l.expiresAt,
      grantedById: l.grantedById,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    })),
    nextCursor,
  };
}

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
  let directory: { listExpiring: jest.Mock };
  let mockNotifications: { emit: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    directory = { listExpiring: jest.fn().mockResolvedValue(page([])) };
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
        { provide: LinkGrantsService, useValue: directory },
        { provide: DefaultOrgId, useValue: { get: async () => ORG_ID } },
      ],
    }).compile();

    service = module.get(ShareExpiringService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('candidates', () => {
    it('asks the slice for links expiring strictly after now and at/before the 7-day horizon', async () => {
      await service.sweep();

      expect(SHARE_EXPIRY_LEAD_DAYS).toBe(7);
      expect(directory.listExpiring).toHaveBeenCalledWith({ orgId: ORG_ID, within: 7 * 24 * 60 * 60 * 1000, cursor: undefined, limit: 200 });
    });

    it('skips a link whose creator is gone (granted_by_id SetNull)', async () => {
      directory.listExpiring.mockResolvedValueOnce(page([makeLink({ grantedById: null })]));

      const result = await service.sweep();

      expect(mockNotifications.emit).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('skips a link whose record no longer exists', async () => {
      directory.listExpiring.mockResolvedValueOnce(page([makeLink()]));
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const result = await service.sweep();

      expect(mockNotifications.emit).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });
  });

  describe('idempotency: LIVE and DISMISSED rows both count as "already notified"', () => {
    it('running the sweep twice for the same link/expiry emits exactly once', async () => {
      directory.listExpiring.mockResolvedValue(page([makeLink()]));
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ exists: 1 }]);

      const day1 = await service.sweep();
      const day2 = await service.sweep();

      expect(mockNotifications.emit).toHaveBeenCalledTimes(1);
      expect(day1.emitted).toBe(1);
      expect(day2.emitted).toBe(0);
      expect(day2.skipped).toBe(1);
    });

    it('the probe does NOT filter on dismissed_at and keys on the (shareId, notifiedFor) pair', async () => {
      directory.listExpiring.mockResolvedValue(page([makeLink()]));
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]);

      await service.sweep();

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
      directory.listExpiring.mockResolvedValue(page([redated]));

      const result = await service.sweep();

      expect(result.emitted).toBe(1);
      expect(mockNotifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ notifiedFor: redated.expiresAt.toISOString() }) }),
      );
    });
  });

  describe('notification content', () => {
    it('emits the grant id, the expiry, the type, the target name and the circle', async () => {
      directory.listExpiring.mockResolvedValueOnce(page([makeLink()]));

      await service.sweep();

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
      directory.listExpiring.mockResolvedValueOnce(page([makeLink()]));
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValueOnce({ originalFilename: null, circleId: CIRCLE_ID });

      await service.sweep();

      expect(mockNotifications.emit).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("'a photo'") }));
    });

    it('titles an album link by the album name', async () => {
      directory.listExpiring.mockResolvedValueOnce(page([makeLink({ resourceType: 'album', resourceId: ALBUM_ID })]));

      await service.sweep();

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
        directory.listExpiring.mockResolvedValueOnce(page([makeLink({ expiresAt: new Date(NOW.getTime() + c.hoursOut * 3600 * 1000) })]));
        await service.sweep();
        expect(mockNotifications.emit).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining(c.expect) }));
      }
    });
  });

  describe('keyset paging', () => {
    it("pages by the slice's cursor, stopping once it returns no next cursor", async () => {
      const fullPage = Array.from({ length: 200 }, (_, i) => makeLink({ id: `grant-${i}` }));
      directory.listExpiring
        .mockResolvedValueOnce(page(fullPage, 'grant-199'))
        .mockResolvedValueOnce(page([makeLink({ id: 'grant-last' })]));
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]);

      const result = await service.sweep();

      expect(directory.listExpiring).toHaveBeenCalledTimes(2);
      expect(directory.listExpiring.mock.calls[1][0].cursor).toBe('grant-199');
      expect(result.candidates).toBe(201);
    });
  });

  describe('failure isolation', () => {
    it('a failure on one link is counted and does not stop the rest of the sweep', async () => {
      directory.listExpiring.mockResolvedValueOnce(page([makeLink({ id: 'grant-bad' }), makeLink({ id: 'grant-good' })]));
      (mockPrisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('db boom')).mockResolvedValueOnce([]);

      const result = await service.sweep();

      expect(result).toMatchObject({ errors: 1, emitted: 1, candidates: 2 });
    });

    it('a failing page read propagates (the task one layer up swallows it)', async () => {
      directory.listExpiring.mockRejectedValue(new Error('db down'));

      await expect(service.sweep()).rejects.toThrow('db down');
    });
  });
});
