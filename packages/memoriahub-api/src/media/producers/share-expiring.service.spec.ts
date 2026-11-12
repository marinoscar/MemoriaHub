/**
 * Unit tests for ShareExpiringService (epic #240, issue #247; link grants since RETRO-I4, #578; RETRO-J10).
 *
 *  - candidates come from the sharing port's `listExpiringLinks({ within: 7 days })`
 *  - the sweep is idempotent across consecutive days: running it twice emits once
 *  - the skip probe is the notify port's `hasNotified` (LIVE and DISMISSED rows alike)
 *  - a link whose `expiresAt` is CHANGED gets a fresh notification (value-keyed stamp)
 *  - a link with no creator (SetNull) or whose record is gone is skipped, never crashes
 *  - a per-link failure is counted, never fatal to the rest of the sweep
 */

import { SHARE_EXPIRING_EVENT_KEY, SHARE_EXPIRING_SWEEP_TYPE } from './share-expiring.constants.js';
import { SHARE_EXPIRY_LEAD_DAYS, ShareExpiringService } from './share-expiring.service.js';
import { ShareExpiringHandler } from './share-expiring.handler.js';
import { ShareExpiringTask } from './share-expiring.task.js';

const USER_ID = 'user-creator';
const LINK_ID = 'grant-111';
const CIRCLE_ID = 'circle-abc';

type Link = { id: string; resourceType: string; resourceId: string; grantedById: string | null; expiresAt: Date };

const page = (items: Link[], nextCursor: string | null = null) => ({ items, nextCursor });

const makeLink = (over: Partial<Link> = {}): Link => ({
  id: LINK_ID,
  resourceType: 'media_item',
  resourceId: 'item-1',
  grantedById: USER_ID,
  expiresAt: new Date('2026-08-08T12:00:00Z'),
  ...over,
});

function build(opts: { hasNotified?: boolean } = {}) {
  const sharing = { listExpiringLinks: jest.fn().mockResolvedValue(page([])) };
  const notify: { notify: jest.Mock; hasNotified?: jest.Mock } = {
    notify: jest.fn(),
    hasNotified: jest.fn().mockResolvedValue(false),
  };
  if (opts.hasNotified === false) delete notify.hasNotified;
  const prisma = {
    mediaItem: { findUnique: jest.fn().mockResolvedValue({ originalFilename: 'beach-trip.jpg', circleId: CIRCLE_ID }) },
    album: { findUnique: jest.fn().mockResolvedValue({ name: 'Summer 2026', circleId: CIRCLE_ID }) },
  };
  const service = new ShareExpiringService(prisma as never, notify as never, sharing as never);
  return { service, sharing, notify, prisma };
}

describe('ShareExpiringService', () => {
  it('keeps the permanent event key and job type', () => {
    expect(SHARE_EXPIRING_EVENT_KEY).toBe('shares.expiring');
    expect(SHARE_EXPIRING_SWEEP_TYPE).toBe('shares.expiring_sweep');
  });

  describe('candidates', () => {
    it('asks the port for links expiring within the 7-day horizon, 200 a page', async () => {
      const { service, sharing } = build();
      await service.sweep();
      expect(SHARE_EXPIRY_LEAD_DAYS).toBe(7);
      expect(sharing.listExpiringLinks).toHaveBeenCalledWith({ within: 7 * 24 * 60 * 60 * 1000, cursor: undefined, limit: 200 });
    });

    it('skips a link whose creator is gone', async () => {
      const { service, sharing, notify } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink({ grantedById: null })]));
      const result = await service.sweep();
      expect(notify.notify).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('skips a link whose record no longer exists', async () => {
      const { service, sharing, notify, prisma } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink()]));
      prisma.mediaItem.findUnique.mockResolvedValueOnce(null);
      const result = await service.sweep();
      expect(notify.notify).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('ignores a link of a kind this app does not own', async () => {
      const { service, sharing, notify } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink({ resourceType: 'folder' })]));
      const result = await service.sweep();
      expect(result.candidates).toBe(0);
      expect(notify.notify).not.toHaveBeenCalled();
    });
  });

  describe('idempotency: LIVE and DISMISSED rows both count as "already notified"', () => {
    it('running the sweep twice for the same link and expiry emits exactly once', async () => {
      const { service, sharing, notify } = build();
      sharing.listExpiringLinks.mockResolvedValue(page([makeLink()]));
      notify.hasNotified!.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const day1 = await service.sweep();
      const day2 = await service.sweep();
      expect(notify.notify).toHaveBeenCalledTimes(1);
      expect(day1.emitted).toBe(1);
      expect(day2.emitted).toBe(0);
      expect(day2.skipped).toBe(1);
    });

    it('the probe keys on the (shareId, notifiedFor) pair of the user and event', async () => {
      const { service, sharing, notify } = build();
      sharing.listExpiringLinks.mockResolvedValue(page([makeLink()]));
      notify.hasNotified!.mockResolvedValue(true);
      await service.sweep();
      expect(notify.hasNotified).toHaveBeenCalledWith('shares.expiring', USER_ID, {
        shareId: LINK_ID,
        notifiedFor: makeLink().expiresAt.toISOString(),
      });
      expect(notify.notify).not.toHaveBeenCalled();
    });

    it('a re-dated link (new expiresAt) gets a new notification', async () => {
      const { service, sharing, notify } = build();
      const redated = makeLink({ expiresAt: new Date('2026-08-10T00:00:00Z') });
      sharing.listExpiringLinks.mockResolvedValue(page([redated]));
      const result = await service.sweep();
      expect(result.emitted).toBe(1);
      expect(notify.notify.mock.calls[0]![2]).toMatchObject({ notifiedFor: redated.expiresAt.toISOString() });
    });

    it('a host that cannot answer hasNotified raises nothing (it would repeat every day)', async () => {
      const { service, sharing, notify } = build({ hasNotified: false });
      sharing.listExpiringLinks.mockResolvedValue(page([makeLink()]));
      const result = await service.sweep();
      expect(notify.notify).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });
  });

  describe('notification content', () => {
    it('raises the event with the link id, the expiry, the kind, the target name and the library', async () => {
      const { service, sharing, notify } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink()]));
      await service.sweep();
      expect(notify.notify).toHaveBeenCalledWith('shares.expiring', USER_ID, {
        shareId: LINK_ID,
        notifiedFor: makeLink().expiresAt.toISOString(),
        targetType: 'media_item',
        targetName: 'beach-trip.jpg',
        circleId: CIRCLE_ID,
      });
    });

    it('falls back to "a photo" for an item with no filename', async () => {
      const { service, sharing, notify, prisma } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink()]));
      prisma.mediaItem.findUnique.mockResolvedValueOnce({ originalFilename: null, circleId: CIRCLE_ID });
      await service.sweep();
      expect(notify.notify.mock.calls[0]![2]).toMatchObject({ targetName: 'a photo' });
    });

    it('names an album link by the album name', async () => {
      const { service, sharing, notify, prisma } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink({ resourceType: 'album', resourceId: 'album-1' })]));
      await service.sweep();
      expect(prisma.album.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'album-1' } }));
      expect(notify.notify.mock.calls[0]![2]).toMatchObject({ targetType: 'album', targetName: 'Summer 2026' });
    });
  });

  describe('keyset paging', () => {
    it("pages by the port's cursor, stopping once it returns no next cursor", async () => {
      const { service, sharing, notify } = build();
      const fullPage = Array.from({ length: 200 }, (_, i) => makeLink({ id: `grant-${i}` }));
      sharing.listExpiringLinks
        .mockResolvedValueOnce(page(fullPage, 'grant-199'))
        .mockResolvedValueOnce(page([makeLink({ id: 'grant-last' })]));
      notify.hasNotified!.mockResolvedValue(true);
      const result = await service.sweep();
      expect(sharing.listExpiringLinks).toHaveBeenCalledTimes(2);
      expect(sharing.listExpiringLinks.mock.calls[1]![0].cursor).toBe('grant-199');
      expect(result.candidates).toBe(201);
    });
  });

  describe('failure isolation', () => {
    it('a failure on one link is counted and does not stop the rest of the sweep', async () => {
      const { service, sharing, notify } = build();
      sharing.listExpiringLinks.mockResolvedValueOnce(page([makeLink({ id: 'grant-bad' }), makeLink({ id: 'grant-good' })]));
      notify.hasNotified!.mockRejectedValueOnce(new Error('db boom')).mockResolvedValueOnce(false);
      const result = await service.sweep();
      expect(result).toMatchObject({ errors: 1, emitted: 1, candidates: 2 });
    });

    it('a failing page read propagates (the job fails and the queue retries it)', async () => {
      const { service, sharing } = build();
      sharing.listExpiringLinks.mockRejectedValue(new Error('db down'));
      await expect(service.sweep()).rejects.toThrow('db down');
    });
  });
});

describe('shares.expiring_sweep job and cron (RETRO-C9 #612, RETRO-J10 #624)', () => {
  afterEach(() => {
    delete process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'];
  });

  it('keeps a 5 minute profile, three attempts and no node pair', () => {
    const handler = new ShareExpiringHandler({ registerHandler: jest.fn() } as never, {} as never);
    expect(handler.type).toBe('shares.expiring_sweep');
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
  });

  it('registers through the jobs port and runs the sweep on process', async () => {
    const jobs = { registerHandler: jest.fn() };
    const sweeper = { sweep: jest.fn(async () => ({ candidates: 0, emitted: 0, skipped: 0, errors: 0 })) };
    const handler = new ShareExpiringHandler(jobs as never, sweeper as never);
    handler.onModuleInit();
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    await handler.process();
    expect(sweeper.sweep).toHaveBeenCalledTimes(1);
  });

  it('the cron only asks the jobs port for the housekeeping job, and is off when the kill switch says so', async () => {
    const jobs = { enqueueHousekeeping: jest.fn(async () => ({ id: 'job-1' })), enqueue: jest.fn() };
    await new ShareExpiringTask(jobs as never).handleScheduledSweep();
    expect(jobs.enqueueHousekeeping).toHaveBeenCalledWith(expect.objectContaining({ type: 'shares.expiring_sweep' }));
    expect(jobs.enqueue).not.toHaveBeenCalled();

    process.env['NOTIFICATIONS_SHARE_EXPIRING_ENABLED'] = 'false';
    jobs.enqueueHousekeeping.mockClear();
    await new ShareExpiringTask(jobs as never).handleScheduledSweep();
    expect(jobs.enqueueHousekeeping).not.toHaveBeenCalled();
  });
});
