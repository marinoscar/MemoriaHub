/**
 * Unit tests for UploadNotificationService (epic #240, issue #247).
 *
 * Covers the acceptance list verbatim:
 *  - one increment call for the uploader plus one for EVERY other circle
 *    member, regardless of role (explicitly including a `viewer`)
 *  - the 15-minute rolling window is passed through to the shared primitive
 *    (UPLOAD_WINDOW_MS), anchored via `upsertCountedEvent`'s own `updated_at`
 *    semantics — see notifications.service.spec.ts for the window-arithmetic
 *    tests of the primitive itself
 *  - uploader title vs. other-member title differ and both pluralize
 *    correctly ("{count} item(s) uploaded to {circle}" vs
 *    "{uploader} added {count} photo(s) to {circle}")
 *  - a deleted circle (lookup returns null) short-circuits before any
 *    notification call
 *  - a solo circle (uploader is the only member) produces only the
 *    uploader's own row, never an empty other-member loop
 *  - `reunreadOnIncrement: true` on both the uploader and other-member calls
 *  - the circle/user-name lookup caches are honored (bounded DB reads across
 *    a burst of uploads) and expire after their TTL
 *  - recordUploadAsync() is fire-and-forget: it never throws even when the
 *    underlying recordUpload() rejects (cross-cutting best-effort contract)
 *
 * NOTE: `upsertCountedEvent` is MOCKED here — this file proves the producer
 * calls it with the right shape (windowMs, buildTitle, matchData/data,
 * reunreadOnIncrement) for every recipient. It does NOT prove the primitive's
 * own count-folding / window-boundary arithmetic; that lives in
 * notifications.service.spec.ts's `upsertCountedEvent()` describe block. The
 * "N uploads -> ONE row with count=N" guarantee is the conjunction of both:
 * this file proves the producer asks for the right aggregation, the other
 * file proves the primitive delivers it.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications.service';
import { UPLOAD_WINDOW_MS, UploadNotificationService } from './upload-notification.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-abc';
const UPLOADER_ID = 'user-uploader';
const MEMBER_VIEWER_ID = 'user-viewer';
const MEMBER_COLLAB_ID = 'user-collaborator';

function makeCircleRow(memberIds: string[], name = 'Family') {
  return {
    name,
    members: memberIds.map((userId) => ({ userId })),
  };
}

describe('UploadNotificationService', () => {
  let service: UploadNotificationService;
  let mockPrisma: MockPrismaService;
  let mockNotifications: { upsertCountedEvent: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockNotifications = { upsertCountedEvent: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadNotificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get<UploadNotificationService>(UploadNotificationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Audience: uploader + every OTHER member, viewer included
  // -------------------------------------------------------------------------

  describe('audience — uploader plus every other member regardless of role', () => {
    it('increments the uploader once and every other member once each, including a viewer', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID, MEMBER_VIEWER_ID, MEMBER_COLLAB_ID]),
      );
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        displayName: 'Ada Lovelace',
        providerDisplayName: null,
        email: 'ada@example.com',
      });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(mockNotifications.upsertCountedEvent).toHaveBeenCalledTimes(3);

      const recipientIds = mockNotifications.upsertCountedEvent.mock.calls.map(
        ([arg]) => arg.userId,
      );
      expect(recipientIds.sort()).toEqual(
        [UPLOADER_ID, MEMBER_VIEWER_ID, MEMBER_COLLAB_ID].sort(),
      );

      // The viewer specifically gets a row — this is the opposite of #246's
      // collaborator-only review-queue audience.
      const viewerCall = mockNotifications.upsertCountedEvent.mock.calls.find(
        ([arg]) => arg.userId === MEMBER_VIEWER_ID,
      );
      expect(viewerCall).toBeDefined();
      expect(viewerCall![0]).toMatchObject({
        type: NotificationType.upload_completed,
        circleId: CIRCLE_ID,
        windowMs: UPLOAD_WINDOW_MS,
      });
    });

    it('a solo circle (uploader is the only member) produces ONLY the uploader row', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID]),
      );

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(mockNotifications.upsertCountedEvent).toHaveBeenCalledTimes(1);
      expect(mockNotifications.upsertCountedEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: UPLOADER_ID }),
      );
      // No display-name lookup should happen either — there is no "other
      // member" title to build.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('a deleted circle (lookup returns null) short-circuits before any notification call', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(mockNotifications.upsertCountedEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Window pass-through
  // -------------------------------------------------------------------------

  describe('rolling window pass-through', () => {
    it('passes windowMs = UPLOAD_WINDOW_MS (15 minutes) on both the uploader and other-member calls', async () => {
      expect(UPLOAD_WINDOW_MS).toBe(15 * 60 * 1000);

      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID, MEMBER_VIEWER_ID]),
      );
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        displayName: null,
        providerDisplayName: 'Ada L.',
        email: 'ada@example.com',
      });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      for (const [arg] of mockNotifications.upsertCountedEvent.mock.calls) {
        expect(arg.windowMs).toBe(UPLOAD_WINDOW_MS);
      }
    });
  });

  // -------------------------------------------------------------------------
  // reunreadOnIncrement
  // -------------------------------------------------------------------------

  describe('reunreadOnIncrement', () => {
    it('is true on both the uploader and other-member calls, so a growing count re-badges the bell', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID, MEMBER_VIEWER_ID]),
      );
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        displayName: null,
        providerDisplayName: null,
        email: 'someone@example.com',
      });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      for (const [arg] of mockNotifications.upsertCountedEvent.mock.calls) {
        expect(arg.reunreadOnIncrement).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Title pluralization — uploader vs. other-member templates
  // -------------------------------------------------------------------------

  describe('title templates and pluralization', () => {
    it("uploader title is '{count} item(s) uploaded to {circle}' and pluralizes correctly", async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID], 'The Smiths'),
      );

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      const [arg] = mockNotifications.upsertCountedEvent.mock.calls[0];
      expect(arg.buildTitle(1)).toBe('1 item uploaded to The Smiths');
      expect(arg.buildTitle(4)).toBe('4 items uploaded to The Smiths');
      expect(arg.link).toBe('/');
    });

    it("other-member title is '{uploader} added {count} photo(s) to {circle}' and pluralizes correctly", async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID, MEMBER_VIEWER_ID], 'The Smiths'),
      );
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        displayName: 'Grace Hopper',
        providerDisplayName: null,
        email: 'grace@example.com',
      });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      const otherCall = mockNotifications.upsertCountedEvent.mock.calls.find(
        ([arg]) => arg.userId === MEMBER_VIEWER_ID,
      )!;
      const [arg] = otherCall;
      expect(arg.buildTitle(1)).toBe('Grace Hopper added 1 photo to The Smiths');
      expect(arg.buildTitle(3)).toBe('Grace Hopper added 3 photos to The Smiths');
      expect(arg.data).toEqual({ uploaderId: UPLOADER_ID });
      expect(arg.link).toBe('/');
    });

    it('the uploader row carries no uploaderId payload (it IS the uploader)', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID]),
      );

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      const [arg] = mockNotifications.upsertCountedEvent.mock.calls[0];
      expect(arg.data).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Display-name fallback ladder
  // -------------------------------------------------------------------------

  describe('uploader display-name fallback ladder', () => {
    // Each case uses a DISTINCT uploaderId: UploadNotificationService caches
    // a resolved display name for LOOKUP_CACHE_TTL_MS (30s) keyed by userId,
    // so re-using the same uploaderId across cases would just serve the
    // first case's cached name for every later case regardless of what the
    // mock is told to return next — a test-isolation pitfall, not a
    // production bug.
    it('prefers displayName, then providerDisplayName, then email, then "Someone"', async () => {
      const cases: Array<{
        circleId: string;
        uploaderId: string;
        user: { displayName: string | null; providerDisplayName: string | null; email: string } | null;
        expectedName: string;
      }> = [
        {
          circleId: 'circle-case-1',
          uploaderId: 'uploader-with-displayname',
          user: { displayName: 'Ada', providerDisplayName: 'ada-provider', email: 'ada@example.com' },
          expectedName: 'Ada',
        },
        {
          circleId: 'circle-case-2',
          uploaderId: 'uploader-with-provider-name',
          user: { displayName: null, providerDisplayName: 'ada-provider', email: 'ada@example.com' },
          expectedName: 'ada-provider',
        },
        {
          circleId: 'circle-case-3',
          uploaderId: 'uploader-with-email-only',
          user: { displayName: null, providerDisplayName: null, email: 'ada@example.com' },
          expectedName: 'ada@example.com',
        },
        {
          circleId: 'circle-case-4',
          uploaderId: 'uploader-not-found',
          user: null,
          expectedName: 'Someone',
        },
      ];

      for (const c of cases) {
        jest.clearAllMocks();
        // A distinct circleId per case as well as a distinct uploaderId:
        // both the circle lookup and the user-name lookup are cached (30s
        // TTL, keyed by circleId / userId respectively) on the SAME service
        // instance across loop iterations, so reusing either key would let
        // an earlier case's cached value silently leak into a later case.
        (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
          makeCircleRow([c.uploaderId, MEMBER_VIEWER_ID]),
        );
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(c.user);

        await service.recordUpload({ circleId: c.circleId, uploaderId: c.uploaderId });

        const arg = mockNotifications.upsertCountedEvent.mock.calls.at(-1)![0];
        expect(arg.buildTitle(1)).toBe(`${c.expectedName} added 1 photo to Family`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Lookup caches
  // -------------------------------------------------------------------------

  describe('circle/user-name lookup caches', () => {
    it('does not re-query the circle or the uploader name on a second upload within the TTL', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID, MEMBER_VIEWER_ID]),
      );
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        displayName: 'Ada',
        providerDisplayName: null,
        email: 'ada@example.com',
      });

      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });
      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(mockPrisma.circle.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
      // But the notification primitive was still invoked once per upload.
      expect(mockNotifications.upsertCountedEvent).toHaveBeenCalledTimes(4); // 2 recipients x 2 uploads
    });

    it('re-queries after the 30s cache TTL expires', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID]),
      );

      nowSpy.mockReturnValue(1_000_000);
      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      nowSpy.mockReturnValue(1_000_000 + 30_001); // just past the 30s TTL
      await service.recordUpload({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID });

      expect(mockPrisma.circle.findUnique).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: best-effort, never throws
  // -------------------------------------------------------------------------

  describe('best-effort contract', () => {
    it('recordUploadAsync() never throws even when the underlying write path rejects', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));

      expect(() =>
        service.recordUploadAsync({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID }),
      ).not.toThrow();

      // Flush the swallowed rejection's microtask queue.
      await Promise.resolve();
      await Promise.resolve();
    });

    it('recordUploadAsync() never throws even when upsertCountedEvent itself rejects', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(
        makeCircleRow([UPLOADER_ID]),
      );
      mockNotifications.upsertCountedEvent.mockRejectedValue(new Error('write failed'));

      expect(() =>
        service.recordUploadAsync({ circleId: CIRCLE_ID, uploaderId: UPLOADER_ID }),
      ).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
