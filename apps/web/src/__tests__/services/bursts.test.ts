/**
 * Unit tests for services/bursts — bulkResolveBurstGroups chunking and
 * fetchAllPendingBurstGroupIds pagination (issue #125: bulk actions used to
 * fail at scale because a single request could carry an unbounded id list /
 * assumed a single list page).
 *
 * Uses MSW to intercept the real fetch calls made by the api singleton.
 *
 * Covers:
 *  - bulkResolveBurstGroups splits > BULK_RESOLVE_CHUNK_SIZE (100) ids into
 *    sequential chunked requests and aggregates the per-chunk results into
 *    one summed result.
 *  - fetchAllPendingBurstGroupIds paginates the list endpoint at pageSize=100
 *    until a short/empty page is returned, collecting ids across all pages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  bulkResolveBurstGroups,
  fetchAllPendingBurstGroupIds,
  BULK_RESOLVE_CHUNK_SIZE,
  type BurstGroupSummary,
} from '../../services/bursts';
import { api } from '../../services/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

function makeSummary(id: string): BurstGroupSummary {
  return {
    id,
    circleId: 'circle-1',
    status: 'pending',
    mediaCount: 3,
    capturedAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.8,
    suggestedBestItemId: 'media-1',
    suggestedBestThumbnailUrl: null,
    coverThumbnailUrls: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('bulkResolveBurstGroups', () => {
  it('splits 250 ids into exactly 3 chunked requests (100 + 100 + 50) and aggregates the results', async () => {
    const requestBodies: Array<{ ids: string[] }> = [];

    server.use(
      http.post('*/api/media/bursts/bulk/resolve', async ({ request }) => {
        const body = (await request.json()) as { circleId: string; ids: string[]; action: string };
        requestBodies.push({ ids: body.ids });
        return HttpResponse.json({
          data: {
            resolvedGroups: body.ids.length,
            keptCount: body.ids.length,
            removedCount: body.ids.length * 2,
            action: body.action,
            skipped: 1,
            errors: 2,
          },
        });
      }),
    );

    const ids = Array.from({ length: 250 }, (_, i) => `group-${i}`);
    const result = await bulkResolveBurstGroups({ circleId: 'circle-1', ids, action: 'archive' });

    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[0].ids).toHaveLength(BULK_RESOLVE_CHUNK_SIZE);
    expect(requestBodies[1].ids).toHaveLength(BULK_RESOLVE_CHUNK_SIZE);
    expect(requestBodies[2].ids).toHaveLength(50);
    // No id is dropped or duplicated across chunks.
    expect(requestBodies.flatMap((b) => b.ids)).toEqual(ids);

    expect(result).toEqual({
      resolvedGroups: 250,
      keptCount: 250,
      removedCount: 500,
      action: 'archive',
      skipped: 3,
      errors: 6,
    });
  });

  it('issues a single request when ids.length is within the chunk size', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/media/bursts/bulk/resolve', async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { ids: string[] };
        return HttpResponse.json({
          data: {
            resolvedGroups: body.ids.length,
            keptCount: body.ids.length,
            removedCount: 0,
            action: 'archive',
            skipped: 0,
            errors: 0,
          },
        });
      }),
    );

    const ids = Array.from({ length: 5 }, (_, i) => `group-${i}`);
    const result = await bulkResolveBurstGroups({ circleId: 'circle-1', ids, action: 'archive' });

    expect(calls).toBe(1);
    expect(result.resolvedGroups).toBe(5);
  });
});

describe('fetchAllPendingBurstGroupIds', () => {
  it('paginates at pageSize=100 across two full pages and a partial page, collecting all ids', async () => {
    const seenPages: number[] = [];

    server.use(
      http.get('*/api/media/bursts', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('status')).toBe('pending');
        expect(url.searchParams.get('pageSize')).toBe('100');
        const page = Number(url.searchParams.get('page') ?? '1');
        seenPages.push(page);

        const total = 240;
        const pageSize = 100;
        let items: BurstGroupSummary[];
        if (page === 1) {
          items = Array.from({ length: 100 }, (_, i) => makeSummary(`p1-${i}`));
        } else if (page === 2) {
          items = Array.from({ length: 100 }, (_, i) => makeSummary(`p2-${i}`));
        } else {
          items = Array.from({ length: 40 }, (_, i) => makeSummary(`p3-${i}`));
        }
        return HttpResponse.json({ items, meta: { total, page, pageSize } });
      }),
    );

    const ids = await fetchAllPendingBurstGroupIds('circle-1');

    expect(seenPages).toEqual([1, 2, 3]);
    expect(ids).toHaveLength(240);
    expect(ids[0]).toBe('p1-0');
    expect(ids[99]).toBe('p1-99');
    expect(ids[100]).toBe('p2-0');
    expect(ids[239]).toBe('p3-39');
  });

  it('stops after a single page when total fits within one page', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/media/bursts', () => {
        calls += 1;
        return HttpResponse.json({
          items: [makeSummary('a'), makeSummary('b')],
          meta: { total: 2, page: 1, pageSize: 100 },
        });
      }),
    );

    const ids = await fetchAllPendingBurstGroupIds('circle-1');

    expect(calls).toBe(1);
    expect(ids).toEqual(['a', 'b']);
  });

  it('stops immediately when the first page is empty', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/media/bursts', () => {
        calls += 1;
        return HttpResponse.json({ items: [], meta: { total: 0, page: 1, pageSize: 100 } });
      }),
    );

    const ids = await fetchAllPendingBurstGroupIds('circle-1');

    expect(calls).toBe(1);
    expect(ids).toEqual([]);
  });
});
