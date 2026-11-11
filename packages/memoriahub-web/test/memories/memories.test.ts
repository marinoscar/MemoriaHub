/**
 * Unit tests for the memories API client: the query-string contract of the
 * Memories API (epic #300, API in issue #307).
 *
 * The clients call the active host's API client, so the fake host records what
 * is put on the wire. The `favorite` cases are the ones worth having: the API
 * treats any value other than the literal string `'true'` as "no filter", so
 * sending `favorite=false` would be an indistinguishable no-op that only makes
 * the URL noisier; the client must omit the param entirely instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { setActiveMemoriahubHost } from '../../src/core/headless/host.js';
import { createFakeMemoriahubWebHost } from '../../src/core/testing/fake-host.js';
import type { FakeMemoriahubWebHost } from '../../src/core/testing/fake-host.js';
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
} from '../../src/memories/headless/services/memories.js';

const EMPTY_PAGE = { items: [], meta: { pageSize: 20, nextCursor: null, hasMore: false } };

let fake: FakeMemoriahubWebHost;

function install(routes: Parameters<typeof createFakeMemoriahubWebHost>[0] = {}) {
  fake = createFakeMemoriahubWebHost(routes);
  setActiveMemoriahubHost(fake.host);
}

beforeEach(() => install());
afterEach(() => setActiveMemoriahubHost(null));

describe('memories clients', () => {
  describe('listMemories', () => {
    it('always sends circleId and omits every unset filter', async () => {
      install({ routes: { 'GET /memories': EMPTY_PAGE } });

      await listMemories({ circleId: 'circle-1' });

      const { query } = fake.calls[0];
      expect(query.get('circleId')).toBe('circle-1');
      expect(query.has('type')).toBe(false);
      expect(query.has('year')).toBe(false);
      expect(query.has('favorite')).toBe(false);
      expect(query.has('cursor')).toBe(false);
    });

    it('sends type, year, cursor and pageSize when supplied', async () => {
      install({ routes: { 'GET /memories': EMPTY_PAGE } });

      await listMemories({ circleId: 'circle-1', type: 'trip', year: 2023, cursor: 'cursor-abc', pageSize: 24 });

      const { query } = fake.calls[0];
      expect(query.get('type')).toBe('trip');
      expect(query.get('year')).toBe('2023');
      expect(query.get('cursor')).toBe('cursor-abc');
      expect(query.get('pageSize')).toBe('24');
    });

    it('sends favorite=true only when narrowing to favorites', async () => {
      install({ routes: { 'GET /memories': EMPTY_PAGE } });

      await listMemories({ circleId: 'circle-1', favorite: true });
      expect(fake.calls[0].query.get('favorite')).toBe('true');

      await listMemories({ circleId: 'circle-1', favorite: false });
      expect(fake.calls[1].query.has('favorite')).toBe(false);
    });

    it('resolves with the { items, meta } the client returns', async () => {
      install({
        routes: {
          'GET /memories': { items: [{ id: 'mem-1' }], meta: { pageSize: 20, nextCursor: 'next', hasMore: true } },
        },
      });

      const result = await listMemories({ circleId: 'circle-1' });

      expect(result.items).toHaveLength(1);
      expect(result.meta.nextCursor).toBe('next');
      expect(result.meta.hasMore).toBe(true);
    });
  });

  describe('getMemoriesFeed', () => {
    it('URL-encodes the circle id', async () => {
      install({ routes: { 'GET /memories/feed': { items: [] } } });

      await getMemoriesFeed('circle/1');

      expect(fake.calls[0].endpoint).toContain('circleId=circle%2F1');
      expect(fake.calls[0].query.get('circleId')).toBe('circle/1');
    });
  });

  describe('per-user state and delete', () => {
    it.each([
      ['seen', () => markMemorySeen('mem-1'), 'POST', '/memories/mem-1/seen'],
      ['hide', () => hideMemory('mem-1'), 'POST', '/memories/mem-1/hide'],
      ['unhide', () => unhideMemory('mem-1'), 'DELETE', '/memories/mem-1/hide'],
      ['favorite', () => favoriteMemory('mem-1'), 'POST', '/memories/mem-1/favorite'],
      ['unfavorite', () => unfavoriteMemory('mem-1'), 'DELETE', '/memories/mem-1/favorite'],
      ['delete', () => deleteMemory('mem-1'), 'DELETE', '/memories/mem-1'],
    ])('%s uses %s %s and tolerates a 204', async (_name, call, method, path) => {
      install({ routes: { [`${method} ${path}`]: null } });

      await expect(call()).resolves.toBeUndefined();
      expect(fake.calls[0].method).toBe(method);
      expect(fake.calls[0].path).toBe(path);
    });
  });

  describe('saveMemoryAsAlbum', () => {
    it('posts an empty body when no name is given', async () => {
      install({ routes: { 'POST /memories/mem-1/save-album': { albumId: 'album-1' } } });

      const result = await saveMemoryAsAlbum('mem-1');

      expect(fake.calls[0].body).toEqual({});
      expect(result.albumId).toBe('album-1');
    });

    it('passes a custom album name through', async () => {
      install({ routes: { 'POST /memories/mem-1/save-album': { albumId: 'album-2' } } });

      await saveMemoryAsAlbum('mem-1', 'Guanacaste 2023');

      expect(fake.calls[0].body).toEqual({ name: 'Guanacaste 2023' });
    });
  });
});
