/**
 * Unit tests for the public digest routes (epic #300, issue #311).
 *
 * These are three UNAUTHENTICATED routes, so the tests are written as an
 * attacker would probe them: forged tokens, cross-purpose replay, expired
 * capabilities, ids that do not exist, and — the one that would be a real
 * incident — an attempt to reach an ORIGINAL rather than a thumbnail.
 *
 * No database, no storage, no network: Prisma, the storage resolver and
 * UserSettingsService are mocks, and the "stream" is a sentinel object.
 */

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PublicMemoryDigestController } from './public-memory-digest.controller';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProviderResolver } from '../../storage/providers/storage-provider.resolver';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import { UserSettingsService } from '../../settings/user-settings/user-settings.service';
import {
  signDigestImageToken,
  signDigestUnsubscribeToken,
} from './digest-token.util';

const VALID_KEY = Buffer.alloc(32, 11).toString('base64');
const MEDIA_ID = 'f0000000-0000-4000-8000-000000000001';
const USER_ID = 'f0000000-0000-4000-8000-000000000002';

/** Minimal FastifyReply stand-in that records what the route set. */
function fakeReply() {
  const headers: Record<string, string> = {};
  const reply: any = {
    headers,
    header: jest.fn((k: string, v: string) => {
      headers[k] = v;
      return undefined;
    }),
    send: jest.fn(),
  };
  // `status(n).send(html)` is chainable on a real FastifyReply.
  reply.status = jest.fn(() => reply);
  return reply as typeof reply & { headers: Record<string, string> };
}

describe('PublicMemoryDigestController', () => {
  let controller: PublicMemoryDigestController;
  let prisma: any;
  let resolver: { getProviderFor: jest.Mock };
  let userSettings: { patchSettings: jest.Mock };
  let download: jest.Mock;

  beforeAll(() => {
    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
  });

  beforeEach(async () => {
    download = jest.fn().mockResolvedValue('THUMB-STREAM');
    prisma = {
      mediaItem: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ metadata: { thumbnailStorageKey: 'thumbs/a.jpg' } }),
      },
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({ storageProvider: 's3', bucket: 'b' }),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ id: USER_ID }) },
    };
    resolver = { getProviderFor: jest.fn().mockResolvedValue({ download }) };
    userSettings = { patchSettings: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicMemoryDigestController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: MediaThumbnailService,
          useValue: {
            extractThumbKey: (metadata: any) =>
              typeof metadata?.thumbnailStorageKey === 'string'
                ? metadata.thumbnailStorageKey
                : null,
          },
        },
        { provide: StorageProviderResolver, useValue: resolver },
        { provide: UserSettingsService, useValue: userSettings },
        { provide: STORAGE_PROVIDER, useValue: { download: jest.fn() } },
      ],
    }).compile();

    controller = module.get(PublicMemoryDigestController);
  });

  // =========================================================================
  // Image route
  // =========================================================================

  describe('GET digest-image/:token', () => {
    it('streams the thumbnail for a valid token', async () => {
      const res = fakeReply();

      await controller.digestImage(signDigestImageToken(MEDIA_ID, 30), res as never);

      expect(download).toHaveBeenCalledWith('thumbs/a.jpg');
      expect(res.send).toHaveBeenCalledWith('THUMB-STREAM');
    });

    it('NEVER serves the original — only the thumbnail key is ever read', async () => {
      const res = fakeReply();

      await controller.digestImage(signDigestImageToken(MEDIA_ID, 30), res as never);

      // The select does not even include the original's storage key, so there
      // is no code path that could serve it.
      const select = prisma.mediaItem.findFirst.mock.calls[0][0].select;
      expect(select).toEqual({ metadata: true });
      expect(download).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith('thumbs/a.jpg');
    });

    it('sets hardening headers and an immutable cache policy', async () => {
      const res = fakeReply();

      await controller.digestImage(signDigestImageToken(MEDIA_ID, 30), res as never);

      expect(res.headers['Content-Type']).toBe('image/jpeg');
      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(res.headers['Referrer-Policy']).toBe('no-referrer');
      expect(res.headers['Content-Disposition']).toBe('inline');
      expect(res.headers['Cache-Control']).toContain('immutable');
    });

    it.each([
      ['a garbage token', 'not-a-token'],
      ['an empty token', ''],
      ['a token with a flipped signature', null],
      ['an expired token', null],
      ['an unsubscribe token replayed here', null],
    ])('404s on %s', async (label, literal) => {
      const token =
        literal ??
        (label.includes('flipped')
          ? (() => {
              const t = signDigestImageToken(MEDIA_ID, 30);
              return t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
            })()
          : label.includes('expired')
            ? signDigestImageToken(MEDIA_ID, -1)
            : signDigestUnsubscribeToken(USER_ID));

      await expect(
        controller.digestImage(token, fakeReply() as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(download).not.toHaveBeenCalled();
    });

    it('404s (never 500s, never leaks) for an unknown media item', async () => {
      prisma.mediaItem.findFirst.mockResolvedValue(null);

      await expect(
        controller.digestImage(signDigestImageToken(MEDIA_ID, 30), fakeReply() as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('goes dark for a trashed item', async () => {
      await controller.digestImage(signDigestImageToken(MEDIA_ID, 30), fakeReply() as never);

      // The soft-delete filter is part of the lookup, so a trashed item can
      // never be found no matter how valid the token is.
      expect(prisma.mediaItem.findFirst.mock.calls[0][0].where).toEqual({
        id: MEDIA_ID,
        deletedAt: null,
      });
    });

    it('404s when the item has no thumbnail rather than falling back', async () => {
      prisma.mediaItem.findFirst.mockResolvedValue({ metadata: {} });

      await expect(
        controller.digestImage(signDigestImageToken(MEDIA_ID, 30), fakeReply() as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(download).not.toHaveBeenCalled();
    });

    it('turns a storage failure into a bare 404, not a provider message', async () => {
      download.mockRejectedValue(new Error('AccessDenied: bucket xyz'));

      await expect(
        controller.digestImage(signDigestImageToken(MEDIA_ID, 30), fakeReply() as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves from the provider recorded on the thumbnail row', async () => {
      await controller.digestImage(signDigestImageToken(MEDIA_ID, 30), fakeReply() as never);

      expect(resolver.getProviderFor).toHaveBeenCalledWith('s3', 'b');
    });
  });

  // =========================================================================
  // Unsubscribe
  // =========================================================================

  describe('unsubscribe', () => {
    /** Run a route that writes its own response, and return what it wrote. */
    function capture(): { res: ReturnType<typeof fakeReply>; body: () => string } {
      const res = fakeReply();
      return { res, body: () => String(res.send.mock.calls[0]?.[0] ?? '') };
    }

    it('GET renders a confirmation page and MUTATES NOTHING', () => {
      const { res, body } = capture();

      controller.unsubscribePage(signDigestUnsubscribeToken(USER_ID), res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(body()).toContain('Stop receiving memory digests?');
      expect(body()).toContain('method="post"');
      expect(res.headers['Content-Type']).toContain('text/html');
      expect(res.headers['Cache-Control']).toBe('no-store');
      // The critical property: a link prefetcher or mail security scanner that
      // follows every GET must not unsubscribe anyone.
      expect(userSettings.patchSettings).not.toHaveBeenCalled();
    });

    it.each([
      ['a garbage token', () => 'nope'],
      ['an expired token', () => signDigestUnsubscribeToken(USER_ID, -1)],
      ['an image token replayed here', () => signDigestImageToken(MEDIA_ID, 30)],
    ])('GET 404s on %s, with the same page every time', (_label, make) => {
      const { res, body } = capture();

      controller.unsubscribePage(make(), res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      // One identical body for every failure mode — the route must not be an
      // oracle for which users exist or why a token failed.
      expect(body()).toContain('This link is no longer valid');
      expect(userSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('POST opts the token holder out, with no login', async () => {
      const { res, body } = capture();

      await controller.unsubscribe(signDigestUnsubscribeToken(USER_ID), res as never);

      expect(userSettings.patchSettings).toHaveBeenCalledWith(USER_ID, {
        memories: { emailDigestOptOut: true },
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(body()).toContain("You're unsubscribed");
    });

    it('POST is idempotent — a second one-click is still a success page', async () => {
      const token = signDigestUnsubscribeToken(USER_ID);
      await controller.unsubscribe(token, fakeReply() as never);
      const { res, body } = capture();
      await controller.unsubscribe(token, res as never);

      expect(userSettings.patchSettings).toHaveBeenCalledTimes(2);
      expect(body()).toContain("You're unsubscribed");
    });

    it('POST 404s on a forged token and writes nothing', async () => {
      const token = signDigestUnsubscribeToken(USER_ID);
      const forged = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      const { res, body } = capture();

      await controller.unsubscribe(forged, res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(body()).toContain('This link is no longer valid');
      expect(userSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('POST 404s for a user who no longer exists — same page, no hint', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const { res, body } = capture();

      await controller.unsubscribe(signDigestUnsubscribeToken(USER_ID), res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(body()).toContain('This link is no longer valid');
      expect(userSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('never reveals whose address a token belongs to', () => {
      const { res, body } = capture();

      controller.unsubscribePage(signDigestUnsubscribeToken(USER_ID), res as never);

      expect(body()).not.toContain(USER_ID);
      expect(body()).not.toContain('@');
    });
  });
});
