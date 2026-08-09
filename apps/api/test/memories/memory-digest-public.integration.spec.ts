/**
 * Memory digest public routes — integration (epic #300, issue #311)
 *
 * Boots the REAL AppModule over a mocked PrismaService, which is the right
 * harness for what the unit specs cannot reach: whether the three routes are
 * actually WIRED — mounted at the expected paths, exempt from the global JWT
 * guard via `@Public()`, and (for the RFC 8058 one-click POST) able to accept
 * an `application/x-www-form-urlencoded` body at all.
 *
 * This file exists because it found two bugs no unit test could:
 *
 *   1. Fastify's default `maxParamLength` is 100 characters, and every digest
 *      token is longer, so EVERY image and unsubscribe link in a delivered
 *      email came back `414 URI Too Long`. Fixed by the shared adapter options
 *      in `src/common/fastify-setup.ts`, which this harness now boots with.
 *   2. Returning an HTML string under `@Header('Content-Type', 'text/html')`
 *      turned every invalid-token 404 into a 500, because the exception filter
 *      serialized a JSON object into a response already declared as HTML.
 *
 * Both are invisible to a controller unit test, which calls the method directly
 * and never crosses the router or the exception filter.
 *
 * NOTHING HERE SENDS EMAIL. The digest send path is not exercised; only the
 * two capabilities a delivered email hands back to the server.
 */

import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import {
  setupBaseMocks,
  setupMockUserSettings,
} from '../fixtures/mock-setup.helper';
import {
  signDigestImageToken,
  signDigestUnsubscribeToken,
} from '../../src/memories/digest/digest-token.util';

const MEDIA_ID = '7e310000-0000-4000-8000-000000000001';
const USER_ID = '7e310000-0000-4000-8000-000000000002';

const IMAGE_BASE = '/api/public/memories/digest-image';
const UNSUB_BASE = '/api/public/memories/digest-unsubscribe';

describe('Memory digest public routes (integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    // The token codec derives its signing sub-keys from this. It must be set
    // before the first sign/verify call, since derived keys are cached.
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    // patchSettings reads the caller's existing settings document before
    // merging, so the unsubscribe POST needs a well-formed row to merge into.
    setupMockUserSettings(USER_ID, {
      theme: 'system',
      profile: { useProviderImage: true },
    });
  });

  // =========================================================================
  // Image
  // =========================================================================

  describe(`GET ${IMAGE_BASE}/:token`, () => {
    it('404s a forged token WITHOUT any authentication challenge', async () => {
      const response = await request(context.app.getHttpServer())
        .get(`${IMAGE_BASE}/definitely-not-a-token`)
        .expect(404);

      // The route is @Public(): the global JWT guard must not turn a bad
      // capability into a 401, which would also confirm the route exists.
      expect(response.status).not.toBe(401);
    });

    it('404s a validly-signed token for a media item that does not exist', async () => {
      context.prismaMock.mediaItem.findFirst.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`${IMAGE_BASE}/${signDigestImageToken(MEDIA_ID, 30)}`)
        .expect(404);
    });

    it('404s an expired token', async () => {
      await request(context.app.getHttpServer())
        .get(`${IMAGE_BASE}/${signDigestImageToken(MEDIA_ID, -1)}`)
        .expect(404);
      // Never reached the database — the signature/expiry check comes first.
      expect(context.prismaMock.mediaItem.findFirst).not.toHaveBeenCalled();
    });

    it('404s an unsubscribe token replayed against the image route', async () => {
      await request(context.app.getHttpServer())
        .get(`${IMAGE_BASE}/${signDigestUnsubscribeToken(USER_ID)}`)
        .expect(404);
      expect(context.prismaMock.mediaItem.findFirst).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Unsubscribe
  // =========================================================================

  describe(`${UNSUB_BASE}/:token`, () => {
    it('GET serves the confirmation page as HTML, with no login', async () => {
      const response = await request(context.app.getHttpServer())
        .get(`${UNSUB_BASE}/${signDigestUnsubscribeToken(USER_ID)}`)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.text).toContain('method="post"');
      // The load-bearing property: a link prefetcher following this GET must
      // not have unsubscribed anyone.
      expect(context.prismaMock.userSettings.update).not.toHaveBeenCalled();
    });

    it('GET 404s a forged token', async () => {
      await request(context.app.getHttpServer()).get(`${UNSUB_BASE}/garbage`).expect(404);
    });

    it('accepts an RFC 8058 one-click POST — form-urlencoded body, no session', async () => {
      context.prismaMock.user.findUnique.mockResolvedValue({ id: USER_ID });

      const response = await request(context.app.getHttpServer())
        .post(`${UNSUB_BASE}/${signDigestUnsubscribeToken(USER_ID)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('List-Unsubscribe=One-Click');

      // A 415 here would mean the raw urlencoded parser in main.ts is missing
      // and every mail-client unsubscribe button is silently broken.
      expect(response.status).not.toBe(415);
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(200);
      expect(response.text).toContain("You're unsubscribed");
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('POST 404s a forged token and writes nothing', async () => {
      const token = signDigestUnsubscribeToken(USER_ID);
      const forged = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

      await request(context.app.getHttpServer())
        .post(`${UNSUB_BASE}/${forged}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('List-Unsubscribe=One-Click')
        .expect(404);

      expect(context.prismaMock.userSettings.update).not.toHaveBeenCalled();
    });

    it('POST 404s for a user who no longer exists', async () => {
      context.prismaMock.user.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post(`${UNSUB_BASE}/${signDigestUnsubscribeToken(USER_ID)}`)
        .expect(404);
    });
  });
});
