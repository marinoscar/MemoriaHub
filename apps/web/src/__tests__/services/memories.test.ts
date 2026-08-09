/**
 * Unit tests for `services/memories` — the query-string contract of the
 * Memories API client (epic #300, API in issue #307).
 *
 * Uses MSW to intercept the real fetch calls the `api` singleton makes, so what
 * is asserted is the URL actually put on the wire, not a mock's arguments.
 *
 * The `favorite` cases are the ones worth having: the API treats any value
 * other than the literal string `'true'` as "no filter", so sending
 * `favorite=false` would be an indistinguishable no-op that only makes the URL
 * noisier — the client must omit the param entirely instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api } from '../../services/api';
import {
  deleteMemory,
  favoriteMemory,
  getMemoriesFeed,
  hideMemory,
  listMemories,
  markMemorySeen,
  saveMemoryAsAlbum,
  unfavoriteMemory,
  unhideMemory,
} from '../../services/memories';

const BASE = 'http://localhost:3000/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

/** Capture the request URL an endpoint is called with. */
function captureUrl(path: string, body: unknown = { items: [], meta: {} }) {
  const seen: { url: URL | null; method: string | null } = { url: null, method: null };
  server.use(
    http.all(`${BASE}${path}`, ({ request }) => {
      seen.url = new URL(request.url);
      seen.method = request.method;
      return HttpResponse.json({ data: body });
    }),
  );
  return seen;
}

describe('services/memories', () => {
  describe('listMemories', () => {
    it('always sends circleId and omits every unset filter', async () => {
      const seen = captureUrl('/memories', {
        items: [],
        meta: { pageSize: 20, nextCursor: null, hasMore: false },
      });

      await listMemories({ circleId: 'circle-1' });

      expect(seen.url?.searchParams.get('circleId')).toBe('circle-1');
      expect(seen.url?.searchParams.has('type')).toBe(false);
      expect(seen.url?.searchParams.has('year')).toBe(false);
      expect(seen.url?.searchParams.has('favorite')).toBe(false);
      expect(seen.url?.searchParams.has('cursor')).toBe(false);
    });

    it('sends type, year, cursor and pageSize when supplied', async () => {
      const seen = captureUrl('/memories', {
        items: [],
        meta: { pageSize: 24, nextCursor: null, hasMore: false },
      });

      await listMemories({
        circleId: 'circle-1',
        type: 'trip',
        year: 2023,
        cursor: 'cursor-abc',
        pageSize: 24,
      });

      expect(seen.url?.searchParams.get('type')).toBe('trip');
      expect(seen.url?.searchParams.get('year')).toBe('2023');
      expect(seen.url?.searchParams.get('cursor')).toBe('cursor-abc');
      expect(seen.url?.searchParams.get('pageSize')).toBe('24');
    });

    it('sends favorite=true only when narrowing to favorites', async () => {
      const on = captureUrl('/memories', {
        items: [],
        meta: { pageSize: 20, nextCursor: null, hasMore: false },
      });
      await listMemories({ circleId: 'circle-1', favorite: true });
      expect(on.url?.searchParams.get('favorite')).toBe('true');

      const off = captureUrl('/memories', {
        items: [],
        meta: { pageSize: 20, nextCursor: null, hasMore: false },
      });
      await listMemories({ circleId: 'circle-1', favorite: false });
      expect(off.url?.searchParams.has('favorite')).toBe(false);
    });

    it('unwraps the response envelope into { items, meta }', async () => {
      server.use(
        http.get(`${BASE}/memories`, () =>
          HttpResponse.json({
            data: {
              items: [{ id: 'mem-1' }],
              meta: { pageSize: 20, nextCursor: 'next', hasMore: true },
            },
            meta: { timestamp: '2026-08-09T00:00:00.000Z' },
          }),
        ),
      );

      const result = await listMemories({ circleId: 'circle-1' });

      expect(result.items).toHaveLength(1);
      expect(result.meta.nextCursor).toBe('next');
      expect(result.meta.hasMore).toBe(true);
    });
  });

  describe('getMemoriesFeed', () => {
    it('URL-encodes the circle id', async () => {
      const seen = captureUrl('/memories/feed', { items: [] });
      await getMemoriesFeed('circle/1');
      expect(seen.url?.searchParams.get('circleId')).toBe('circle/1');
    });
  });

  describe('per-user state and delete', () => {
    it.each([
      ['seen', () => markMemorySeen('mem-1'), 'POST', '/memories/mem-1/seen'],
      ['hide', () => hideMemory('mem-1'), 'POST', '/memories/mem-1/hide'],
      ['unhide', () => unhideMemory('mem-1'), 'DELETE', '/memories/mem-1/hide'],
      ['favorite', () => favoriteMemory('mem-1'), 'POST', '/memories/mem-1/favorite'],
      [
        'unfavorite',
        () => unfavoriteMemory('mem-1'),
        'DELETE',
        '/memories/mem-1/favorite',
      ],
      ['delete', () => deleteMemory('mem-1'), 'DELETE', '/memories/mem-1'],
    ])('%s uses %s %s and tolerates a 204', async (_name, call, method, path) => {
      let seenMethod: string | null = null;
      server.use(
        http.all(`${BASE}${path}`, ({ request }) => {
          seenMethod = request.method;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await expect(call()).resolves.toBeUndefined();
      expect(seenMethod).toBe(method);
    });
  });

  describe('saveMemoryAsAlbum', () => {
    it('posts an empty body when no name is given', async () => {
      let body: unknown = 'unset';
      server.use(
        http.post(`${BASE}/memories/mem-1/save-album`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ data: { albumId: 'album-1' } }, { status: 201 });
        }),
      );

      const result = await saveMemoryAsAlbum('mem-1');

      expect(body).toEqual({});
      expect(result.albumId).toBe('album-1');
    });

    it('passes a custom album name through', async () => {
      let body: unknown = null;
      server.use(
        http.post(`${BASE}/memories/mem-1/save-album`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ data: { albumId: 'album-2' } }, { status: 201 });
        }),
      );

      await saveMemoryAsAlbum('mem-1', 'Guanacaste 2023');

      expect(body).toEqual({ name: 'Guanacaste 2023' });
    });
  });
});
