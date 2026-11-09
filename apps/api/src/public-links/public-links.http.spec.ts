/**
 * The public link routes over HTTP (RETRO-I4, #578), on a minimal Fastify app with the
 * REAL `LinkGrantGuard` and miss throttle and a `LinkGrantsService` whose `resolve`
 * accepts exactly one token: the IMPORTED form of an old `media_shares` token
 * (`lnk_` + the 43 characters an old `/s/<token>` URL carried).
 *
 *  - an old share token opens its item and its album through `X-Link-Token: lnk_<old>`;
 *  - the bare old token, a token in a query string, no token, a revoked/expired/unknown
 *    link: the same 404 (`Link not found`), never a hint;
 *  - every response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`;
 *  - the bodies carry media type, dimensions and presigned URLs only (no metadata);
 *  - the retired `/api/public/shares/*` routes answer 410 `LEGACY_SHARE_ROUTE`;
 *  - no route of the module streams bytes (no `@Res()`, no `send(stream)`).
 */
import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IS_PUBLIC_KEY } from '@marinoscar/platform-api/identity';
import {
  LINK_GRANT_RESOURCE_KEY,
  LinkGrantGuard,
  LinkGrantsService,
  LinkMissThrottle,
  type ResolvedLinkGrant,
} from '@marinoscar/platform-api/sharing';

import { LegacyPublicShareController } from './legacy-public-share.controller';
import { PublicAlbumLinkController } from './public-album-link.controller';
import { PublicLinkViewService } from './public-link-view.service';
import { PublicMediaLinkController } from './public-media-link.controller';

/** An old `media_shares.token` (randomBytes(32).toString('base64url')): invented. */
const OLD_MEDIA_TOKEN = 'A'.repeat(21) + '_' + 'b'.repeat(21);
const OLD_ALBUM_TOKEN = 'C'.repeat(21) + '-' + 'd'.repeat(21);

const LINKS: Record<string, ResolvedLinkGrant> = {
  [`lnk_${OLD_MEDIA_TOKEN}`]: { grantId: 'g-1', orgId: 'org-1', resourceType: 'media_item', resourceId: 'item-1', role: 'viewer', expiresAt: null },
  [`lnk_${OLD_ALBUM_TOKEN}`]: { grantId: 'g-2', orgId: 'org-1', resourceType: 'album', resourceId: 'album-1', role: 'viewer', expiresAt: null },
};

describe('public link routes (HTTP)', () => {
  let app: NestFastifyApplication;
  const views = {
    mediaView: jest.fn(async (link: ResolvedLinkGrant) => ({
      type: 'media_item',
      expiresAt: null,
      media: { mediaType: 'photo', width: 4, height: 3, url: `https://bucket.example.test/${link.resourceId}?sig=1`, thumbnailUrl: null },
    })),
    albumView: jest.fn(async () => ({
      type: 'album',
      expiresAt: null,
      itemCount: 1,
      items: [{ mediaType: 'video', width: 16, height: 9, url: 'https://bucket.example.test/v?sig=1', thumbnailUrl: 'https://bucket.example.test/t?sig=1' }],
    })),
  };
  const links = {
    resolve: jest.fn(async (token: unknown, expect: { resourceType: string }) => {
      const link = typeof token === 'string' ? LINKS[token] : undefined;
      if (!link) return { ok: false as const, failure: 'unknown' as const, resourceType: null };
      if (link.resourceType !== expect.resourceType) return { ok: false as const, failure: 'wrong_type' as const, resourceType: link.resourceType };
      return { ok: true as const, link };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicMediaLinkController, PublicAlbumLinkController, LegacyPublicShareController],
      providers: [
        LinkGrantGuard,
        { provide: LinkMissThrottle, useValue: new LinkMissThrottle() },
        { provide: LinkGrantsService, useValue: links },
        { provide: PublicLinkViewService, useValue: views },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, token?: string) =>
    app.inject({ method: 'GET', url, headers: token ? { 'x-link-token': token } : {} });

  it('opens an imported media share with X-Link-Token: lnk_<old token>', async () => {
    const res = await get('/api/public/links/media', `lnk_${OLD_MEDIA_TOKEN}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const body = res.json();
    expect(body.type).toBe('media_item');
    expect(Object.keys(body.media).sort()).toEqual(['height', 'mediaType', 'thumbnailUrl', 'url', 'width']);
    expect(views.mediaView).toHaveBeenCalledWith(LINKS[`lnk_${OLD_MEDIA_TOKEN}`]);
  });

  it('opens an imported album share', async () => {
    const res = await get('/api/public/links/album', `lnk_${OLD_ALBUM_TOKEN}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: 'album', itemCount: 1 });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['the bare old token (no lnk_ prefix)', '/api/public/links/media', OLD_MEDIA_TOKEN],
    ['an unknown, revoked or expired link', '/api/public/links/media', `lnk_${'z'.repeat(43)}`],
    ['an album link on the media route', '/api/public/links/media', `lnk_${OLD_ALBUM_TOKEN}`],
    ['no token at all', '/api/public/links/album', undefined],
  ])('answers the same 404 for %s', async (_case, url, token) => {
    const res = await get(url, token);

    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('never reads a token from the query string', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/public/links/media?token=lnk_${OLD_MEDIA_TOKEN}` });

    expect(res.statusCode).toBe(404);
  });

  it.each(['/api/public/shares/' + OLD_MEDIA_TOKEN, `/api/public/shares/${OLD_MEDIA_TOKEN}/media/0`])(
    'retires %s with 410 LEGACY_SHARE_ROUTE',
    async (url) => {
      const res = await get(url);

      expect(res.statusCode).toBe(410);
      expect(res.json()).toMatchObject({ message: expect.any(String) });
      expect(JSON.stringify(res.json())).toContain('LEGACY_SHARE_ROUTE');
      expect(JSON.stringify(res.json())).not.toContain(OLD_MEDIA_TOKEN);
    },
  );

  it('marks the link routes public and guarded by type', () => {
    for (const [controller, type] of [
      [PublicMediaLinkController, 'media_item'],
      [PublicAlbumLinkController, 'album'],
    ] as const) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller)).toBe(true);
      const handler = Object.getOwnPropertyNames(controller.prototype).find((name) => name !== 'constructor')!;
      expect(Reflect.getMetadata(LINK_GRANT_RESOURCE_KEY, (controller.prototype as unknown as Record<string, object>)[handler])).toMatchObject({ resourceType: type, action: 'read' });
    }
  });

  it('streams no bytes: no handler of the module takes the raw reply', () => {
    const dir = __dirname;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect({ file, res: /@Res\(/.test(source), stream: /\.download\(/.test(source) }).toEqual({ file, res: false, stream: false });
    }
  });
});
