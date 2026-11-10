/**
 * Unit tests for UploadNotificationService (epic #240, issue #247; moved to the
 * media slice by RETRO-J5, #613). Host-free: the ports are plain doubles.
 *
 *  - one counted write for the uploader plus one for EVERY other scope member,
 *    regardless of role (explicitly including a `viewer`)
 *  - the 15-minute rolling window and the scope (the library) are passed through
 *    to the port's COUNTED write, under the permanent event key
 *  - the uploader row and the other-member rows carry the data the event's
 *    templates render ("{count} item(s) uploaded to {circle}" vs
 *    "{uploader} added {count} photo(s) to {circle}")
 *  - a deleted scope short-circuits before any notification call
 *  - a solo scope produces only the uploader's own row
 *  - the scope/user-name lookup caches are honoured and expire after their TTL
 *  - recordUploadAsync() is fire-and-forget: it never throws
 *
 * The fold itself (one row per (user, scope) inside the window, count growing,
 * re-badge on increment) is the host's `notifyCounted`, covered by the platform's
 * tests and the real-Postgres specs of the web app.
 */

import {
  UPLOAD_COMPLETED_EVENT_KEY,
  UPLOAD_COMPLETED_WINDOW_MS,
  UPLOAD_WINDOW_MS,
  UploadNotificationService,
} from './upload-notification.service.js';

const CIRCLE_ID = 'circle-abc';
const UPLOADER_ID = 'user-uploader';
const MEMBER_VIEWER_ID = 'user-viewer';
const MEMBER_COLLAB_ID = 'user-collaborator';

/** The scope directory double: `null` = no such library. */
const scopeLookup = jest.fn();

function scope(memberIds: string[], name = 'Family') {
  return { name, members: memberIds.map((userId) => ({ userId, role: 'viewer' })) };
}

describe('UploadNotificationService', () => {
  let service: UploadNotificationService;
  let prisma: { user: { findUnique: jest.Mock } };
  let notify: { notifyCounted: jest.Mock };

  /** Each `notifyCounted` call as `{ eventKey, userId, data, options }`. */
  const recorded = () =>
    notify.notifyCounted.mock.calls.map(([eventKey, userId, data, options]) => ({ eventKey, userId, data, options }));

  beforeEach(() => {
    scopeLookup.mockReset();
    prisma = { user: { findUnique: jest.fn() } };
    notify = { notifyCounted: jest.fn() };
    let last: ReturnType<typeof scope> | null | undefined;
    const access = {
      scopeSummary: jest.fn(async (id: string) => {
        last = await scopeLookup(id);
        return last ? { id, name: last.name, kind: 'group', ownerId: null, createdById: null } : null;
      }),
      membersOf: jest.fn(async () => last?.members ?? []),
    };

    service = new UploadNotificationService(prisma as never, notify as never, access as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constants', () => {
    it('the event key and the window are permanent', () => {
      expect(UPLOAD_COMPLETED_EVENT_KEY).toBe('media.upload_completed');
      expect(UPLOAD_COMPLETED_WINDOW_MS).toBe(15 * 60 * 1000);
      expect(UPLOAD_WINDOW_MS).toBe(UPLOAD_COMPLETED_WINDOW_MS);
    });
  });

  describe('audience: uploader plus every other member regardless of role', () => {
    it('increments the uploader once and every other member once each, including a viewer', async () => {
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID, MEMBER_VIEWER_ID, MEMBER_COLLAB_ID]));
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Ada Lovelace', providerDisplayName: null, email: 'ada@example.test' });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(notify.notifyCounted).toHaveBeenCalledTimes(3);
      expect(recorded().map((c) => c.userId).sort()).toEqual([UPLOADER_ID, MEMBER_VIEWER_ID, MEMBER_COLLAB_ID].sort());
      const viewerCall = recorded().find((c) => c.userId === MEMBER_VIEWER_ID);
      expect(viewerCall).toMatchObject({
        eventKey: 'media.upload_completed',
        options: { scopeId: CIRCLE_ID, windowMs: UPLOAD_WINDOW_MS },
      });
    });

    it('a solo scope (uploader is the only member) produces ONLY the uploader row', async () => {
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID]));

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(notify.notifyCounted).toHaveBeenCalledTimes(1);
      expect(recorded()[0]!.userId).toBe(UPLOADER_ID);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('a deleted scope (lookup returns null) short-circuits before any notification call', async () => {
      scopeLookup.mockResolvedValue(null);

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(notify.notifyCounted).not.toHaveBeenCalled();
    });
  });

  describe('rolling window pass-through', () => {
    it('passes windowMs = UPLOAD_WINDOW_MS (15 minutes) on both the uploader and other-member calls', async () => {
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID, MEMBER_VIEWER_ID]));
      prisma.user.findUnique.mockResolvedValue({ displayName: null, providerDisplayName: 'Ada L.', email: 'ada@example.test' });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      for (const call of recorded()) expect(call.options.windowMs).toBe(15 * 60 * 1000);
    });
  });

  describe('event data (what the templates render)', () => {
    it('the uploader row carries the scope name and no uploader payload (it IS the uploader)', async () => {
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID], 'The Smiths'));

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(recorded()[0]!.data).toEqual({ circleId: CIRCLE_ID, circleName: 'The Smiths' });
    });

    it('other-member rows carry the uploader id and display name', async () => {
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID, MEMBER_VIEWER_ID], 'The Smiths'));
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Grace Hopper', providerDisplayName: null, email: 'grace@example.test' });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      const other = recorded().find((c) => c.userId === MEMBER_VIEWER_ID)!;
      expect(other.data).toEqual({
        circleId: CIRCLE_ID,
        circleName: 'The Smiths',
        uploaderId: UPLOADER_ID,
        uploaderName: 'Grace Hopper',
      });
    });
  });

  describe('uploader display-name fallback ladder', () => {
    // A distinct scope and uploader per case: both lookups are cached per key on the one service instance.
    it('prefers displayName, then providerDisplayName, then email, then "Someone"', async () => {
      const cases: Array<{
        circleId: string;
        uploaderId: string;
        user: { displayName: string | null; providerDisplayName: string | null; email: string } | null;
        expectedName: string;
      }> = [
        { circleId: 'c1', uploaderId: 'u1', user: { displayName: 'Ada', providerDisplayName: 'ada-provider', email: 'ada@example.test' }, expectedName: 'Ada' },
        { circleId: 'c2', uploaderId: 'u2', user: { displayName: null, providerDisplayName: 'ada-provider', email: 'ada@example.test' }, expectedName: 'ada-provider' },
        { circleId: 'c3', uploaderId: 'u3', user: { displayName: null, providerDisplayName: null, email: 'ada@example.test' }, expectedName: 'ada@example.test' },
        { circleId: 'c4', uploaderId: 'u4', user: null, expectedName: 'Someone' },
      ];

      for (const c of cases) {
        notify.notifyCounted.mockClear();
        scopeLookup.mockResolvedValue(scope([c.uploaderId, MEMBER_VIEWER_ID]));
        prisma.user.findUnique.mockResolvedValueOnce(c.user);

        await service.recordUpload({ circleId: c.circleId, uploaderId: c.uploaderId });

        expect(recorded().at(-1)!.data.uploaderName).toBe(c.expectedName);
      }
    });
  });

  describe('scope/user-name lookup caches', () => {
    it('does not re-query the scope or the uploader name on a second upload within the TTL', async () => {
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID, MEMBER_VIEWER_ID]));
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Ada', providerDisplayName: null, email: 'ada@example.test' });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });
      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(scopeLookup).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(notify.notifyCounted).toHaveBeenCalledTimes(4); // 2 recipients x 2 uploads
    });

    it('re-queries after the 30s cache TTL expires', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      scopeLookup.mockResolvedValue(scope([UPLOADER_ID]));

      nowSpy.mockReturnValue(1_000_000);
      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });
      nowSpy.mockReturnValue(1_000_000 + 30_001);
      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(scopeLookup).toHaveBeenCalledTimes(2);
    });
  });

  describe('best-effort contract', () => {
    it('recordUploadAsync() never throws even when the underlying lookup rejects', async () => {
      scopeLookup.mockRejectedValue(new Error('db down'));

      expect(() => service.recordUploadAsync({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID })).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
