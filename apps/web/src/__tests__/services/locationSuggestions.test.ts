/**
 * Unit tests for services/locationSuggestions — URL building for
 * listLocationSuggestions, including the sortBy/sortOrder params added for
 * issue #189.
 *
 * Uses MSW to intercept the real fetch calls made by the api singleton.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { listLocationSuggestions } from '../../services/locationSuggestions';
import { api } from '../../services/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

describe('listLocationSuggestions', () => {
  it('builds the base URL with circleId and no optional params when omitted', async () => {
    let seenSearch = '';
    server.use(
      http.get('*/api/media/location-suggestions', ({ request }) => {
        seenSearch = new URL(request.url).search;
        return HttpResponse.json({ items: [], meta: { total: 0, page: 1, pageSize: 20 } });
      }),
    );

    await listLocationSuggestions({ circleId: 'circle-1' });

    const params = new URLSearchParams(seenSearch);
    expect(params.get('circleId')).toBe('circle-1');
    expect(params.has('sortBy')).toBe(false);
    expect(params.has('sortOrder')).toBe(false);
    expect(params.has('status')).toBe(false);
    expect(params.has('page')).toBe(false);
    expect(params.has('pageSize')).toBe(false);
    expect(params.has('mediaItemId')).toBe(false);
  });

  it('omits sortBy and sortOrder from the URL when neither is provided (byte-identical to before)', async () => {
    let seenSearch = '';
    server.use(
      http.get('*/api/media/location-suggestions', ({ request }) => {
        seenSearch = new URL(request.url).search;
        return HttpResponse.json({ items: [], meta: { total: 0, page: 1, pageSize: 20 } });
      }),
    );

    await listLocationSuggestions({ circleId: 'circle-1', status: 'pending', page: 1, pageSize: 20 });

    expect(seenSearch).not.toContain('sortBy');
    expect(seenSearch).not.toContain('sortOrder');
  });

  it('includes sortBy and sortOrder in the URL when provided', async () => {
    let seenSearch = '';
    server.use(
      http.get('*/api/media/location-suggestions', ({ request }) => {
        seenSearch = new URL(request.url).search;
        return HttpResponse.json({ items: [], meta: { total: 0, page: 1, pageSize: 20 } });
      }),
    );

    await listLocationSuggestions({ circleId: 'circle-1', sortBy: 'confidence', sortOrder: 'asc' });

    expect(seenSearch).toContain('sortBy=confidence');
    expect(seenSearch).toContain('sortOrder=asc');
  });

  it('forwards mediaItemId, status, page, and pageSize alongside sort params', async () => {
    let seenSearch = '';
    server.use(
      http.get('*/api/media/location-suggestions', ({ request }) => {
        seenSearch = new URL(request.url).search;
        return HttpResponse.json({ items: [], meta: { total: 0, page: 2, pageSize: 10 } });
      }),
    );

    await listLocationSuggestions({
      circleId: 'circle-1',
      mediaItemId: 'media-1',
      status: 'accepted',
      page: 2,
      pageSize: 10,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });

    const params = new URLSearchParams(seenSearch);
    expect(params.get('mediaItemId')).toBe('media-1');
    expect(params.get('status')).toBe('accepted');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('10');
    expect(params.get('sortBy')).toBe('createdAt');
    expect(params.get('sortOrder')).toBe('asc');
  });

  it('returns items/meta from the response, defaulting items to [] when absent', async () => {
    server.use(
      http.get('*/api/media/location-suggestions', () =>
        HttpResponse.json({ meta: { total: 0, page: 1, pageSize: 20 } }),
      ),
    );

    const result = await listLocationSuggestions({ circleId: 'circle-1' });

    expect(result.items).toEqual([]);
    expect(result.meta).toEqual({ total: 0, page: 1, pageSize: 20 });
  });
});
