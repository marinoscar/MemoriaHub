/**
 * services/media — listMediaLocations tests.
 *
 * Uses MSW to intercept the real fetch calls made by the api singleton,
 * so no implementation details of the HTTP layer are needed in the assertions.
 *
 * Tests verify:
 *   - listMediaLocations hits GET /media/locations with no query string when
 *     called without filters
 *   - query string is built correctly for each filter param
 *   - the returned array is passed through from the server response
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  listMediaLocations,
  listTags,
  aggregateLocations,
  getThumbnails,
  getLocationExtent,
} from '../../services/media';
import type { MediaLocation, MapCluster, TagItem, LocationExtent } from '../../types/media';
import type { ThumbnailRef } from '../../services/media';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockLocations: MediaLocation[] = [
  {
    id: 'loc-1',
    takenLat: 9.9281,
    takenLng: -84.0907,
    capturedAt: '2024-06-15T10:30:00.000Z',
    geoLocality: 'La Fortuna',
    thumbnailUrl: 'https://cdn.example.com/thumb1.jpg',
  },
  {
    id: 'loc-2',
    takenLat: 48.8566,
    takenLng: 2.3522,
    capturedAt: '2024-01-10T09:00:00.000Z',
    geoLocality: 'Paris',
    thumbnailUrl: null,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listMediaLocations', () => {
  let capturedUrl: URL | null = null;

  beforeEach(() => {
    capturedUrl = null;

    server.use(
      http.get('*/api/media/locations', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ data: mockLocations });
      }),
    );
  });

  // ----- No-arg call -----

  it('should call GET /media/locations with no query params when no filters given', async () => {
    await listMediaLocations();
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.search).toBe('');
  });

  it('should return the array of MediaLocation objects from the server', async () => {
    const result = await listMediaLocations();
    expect(result).toEqual(mockLocations);
  });

  // ----- Filter params -----

  it('should include type in the query string', async () => {
    await listMediaLocations({ type: 'photo' });
    expect(capturedUrl!.searchParams.get('type')).toBe('photo');
  });

  it('should include country in the query string', async () => {
    await listMediaLocations({ country: 'Costa Rica' });
    expect(capturedUrl!.searchParams.get('country')).toBe('Costa Rica');
  });

  it('should include region in the query string', async () => {
    await listMediaLocations({ region: 'Alajuela' });
    expect(capturedUrl!.searchParams.get('region')).toBe('Alajuela');
  });

  it('should include locality in the query string', async () => {
    await listMediaLocations({ locality: 'La Fortuna' });
    expect(capturedUrl!.searchParams.get('locality')).toBe('La Fortuna');
  });

  it('should include place in the query string', async () => {
    await listMediaLocations({ place: 'Arenal' });
    expect(capturedUrl!.searchParams.get('place')).toBe('Arenal');
  });

  it('should include location (free-text) in the query string', async () => {
    await listMediaLocations({ location: 'volcano' });
    expect(capturedUrl!.searchParams.get('location')).toBe('volcano');
  });

  it('should include capturedAtFrom in the query string', async () => {
    await listMediaLocations({ capturedAtFrom: '2024-01-01T00:00:00.000Z' });
    expect(capturedUrl!.searchParams.get('capturedAtFrom')).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  it('should include capturedAtTo in the query string', async () => {
    await listMediaLocations({ capturedAtTo: '2024-12-31T23:59:59.999Z' });
    expect(capturedUrl!.searchParams.get('capturedAtTo')).toBe(
      '2024-12-31T23:59:59.999Z',
    );
  });

  it('should include bbox in the query string when provided', async () => {
    await listMediaLocations({ bbox: '-85,9,-84,10' });
    expect(capturedUrl!.searchParams.get('bbox')).toBe('-85,9,-84,10');
  });

  it('should omit bbox from the query string when not provided', async () => {
    await listMediaLocations({ type: 'photo' });
    expect(capturedUrl!.searchParams.has('bbox')).toBe(false);
  });

  it('should include all filters simultaneously', async () => {
    await listMediaLocations({
      type: 'video',
      country: 'CR',
      region: 'Alajuela',
      locality: 'La Fortuna',
      place: 'Arenal',
      location: 'volcano',
      capturedAtFrom: '2024-01-01T00:00:00.000Z',
      capturedAtTo: '2024-12-31T23:59:59.999Z',
      circleId: 'circle-1',
      albumId: 'album-1',
      bbox: '-85,9,-84,10',
    });

    const params = capturedUrl!.searchParams;
    expect(params.get('type')).toBe('video');
    expect(params.get('country')).toBe('CR');
    expect(params.get('region')).toBe('Alajuela');
    expect(params.get('locality')).toBe('La Fortuna');
    expect(params.get('place')).toBe('Arenal');
    expect(params.get('location')).toBe('volcano');
    expect(params.get('capturedAtFrom')).toBe('2024-01-01T00:00:00.000Z');
    expect(params.get('capturedAtTo')).toBe('2024-12-31T23:59:59.999Z');
    expect(params.get('circleId')).toBe('circle-1');
    expect(params.get('albumId')).toBe('album-1');
    expect(params.get('bbox')).toBe('-85,9,-84,10');
  });

  it('should round-trip a response with thumbnailUrl omitted (optional field)', async () => {
    server.use(
      http.get('*/api/media/locations', () => {
        return HttpResponse.json({
          data: [
            {
              id: 'loc-3',
              takenLat: 1,
              takenLng: 2,
              capturedAt: null,
              geoLocality: null,
            },
          ],
        });
      }),
    );

    const result = await listMediaLocations();
    expect(result).toEqual([
      { id: 'loc-3', takenLat: 1, takenLng: 2, capturedAt: null, geoLocality: null },
    ]);
    expect(result[0].thumbnailUrl).toBeUndefined();
  });

  it('should omit undefined filter fields from the query string', async () => {
    await listMediaLocations({ type: 'photo', country: undefined });
    expect(capturedUrl!.searchParams.has('country')).toBe(false);
  });

  it('should return an empty array when the server returns no locations', async () => {
    server.use(
      http.get('*/api/media/locations', () => {
        return HttpResponse.json({ data: [] });
      }),
    );

    const result = await listMediaLocations();
    expect(result).toEqual([]);
  });

  it('should include circleId in the query string when provided', async () => {
    await listMediaLocations({ circleId: 'circle-1' });
    expect(capturedUrl!.searchParams.get('circleId')).toBe('circle-1');
  });
});

// ---------------------------------------------------------------------------
// aggregateLocations
// ---------------------------------------------------------------------------

describe('aggregateLocations', () => {
  let capturedUrl: URL | null = null;

  const mockClusters: MapCluster[] = [
    { lat: 9.9281, lng: -84.0907, count: 1, sampleId: 'loc-1' },
    { lat: 48.8566, lng: 2.3522, count: 12, sampleId: 'loc-2' },
  ];

  beforeEach(() => {
    capturedUrl = null;

    server.use(
      http.get('*/api/media/locations/aggregate', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ data: mockClusters });
      }),
    );
  });

  it('should call GET /media/locations/aggregate with no query params when called with no args', async () => {
    await aggregateLocations();
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.search).toBe('');
  });

  it('should return the array of MapCluster objects from the server', async () => {
    const result = await aggregateLocations();
    expect(result).toEqual(mockClusters);
  });

  it('should include circleId in the query string when provided', async () => {
    await aggregateLocations({ circleId: 'circle-1' });
    expect(capturedUrl!.searchParams.get('circleId')).toBe('circle-1');
  });

  it('should include precision in the query string when provided', async () => {
    await aggregateLocations({ precision: 3 });
    expect(capturedUrl!.searchParams.get('precision')).toBe('3');
  });

  it('should include precision=0 in the query string (falsy value must not be dropped)', async () => {
    await aggregateLocations({ precision: 0 });
    expect(capturedUrl!.searchParams.has('precision')).toBe(true);
    expect(capturedUrl!.searchParams.get('precision')).toBe('0');
  });

  it('should omit precision from the query string when not provided', async () => {
    await aggregateLocations({ circleId: 'circle-1' });
    expect(capturedUrl!.searchParams.has('precision')).toBe(false);
  });

  it('should include bbox in the query string when provided', async () => {
    await aggregateLocations({ bbox: '-85,9,-84,10' });
    expect(capturedUrl!.searchParams.get('bbox')).toBe('-85,9,-84,10');
  });

  it('should include type in the query string when provided', async () => {
    await aggregateLocations({ type: 'video' });
    expect(capturedUrl!.searchParams.get('type')).toBe('video');
  });

  it('should include capturedAtFrom in the query string when provided', async () => {
    await aggregateLocations({ capturedAtFrom: '2024-01-01T00:00:00.000Z' });
    expect(capturedUrl!.searchParams.get('capturedAtFrom')).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  it('should include capturedAtTo in the query string when provided', async () => {
    await aggregateLocations({ capturedAtTo: '2024-12-31T23:59:59.999Z' });
    expect(capturedUrl!.searchParams.get('capturedAtTo')).toBe(
      '2024-12-31T23:59:59.999Z',
    );
  });

  it('should include all filters simultaneously', async () => {
    await aggregateLocations({
      circleId: 'circle-1',
      precision: 2,
      bbox: '-85,9,-84,10',
      type: 'photo',
      capturedAtFrom: '2024-01-01T00:00:00.000Z',
      capturedAtTo: '2024-12-31T23:59:59.999Z',
    });

    const params = capturedUrl!.searchParams;
    expect(params.get('circleId')).toBe('circle-1');
    expect(params.get('precision')).toBe('2');
    expect(params.get('bbox')).toBe('-85,9,-84,10');
    expect(params.get('type')).toBe('photo');
    expect(params.get('capturedAtFrom')).toBe('2024-01-01T00:00:00.000Z');
    expect(params.get('capturedAtTo')).toBe('2024-12-31T23:59:59.999Z');
  });

  it('should return an empty array when the server returns no clusters', async () => {
    server.use(
      http.get('*/api/media/locations/aggregate', () => {
        return HttpResponse.json({ data: [] });
      }),
    );

    const result = await aggregateLocations();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getThumbnails
// ---------------------------------------------------------------------------

describe('getThumbnails', () => {
  let capturedUrl: URL | null = null;
  let requestCount = 0;

  const mockThumbnails: ThumbnailRef[] = [
    { id: 'item-1', thumbnailUrl: 'https://cdn.example.com/thumb1.jpg' },
    { id: 'item-2', thumbnailUrl: null },
  ];

  beforeEach(() => {
    capturedUrl = null;
    requestCount = 0;

    server.use(
      http.get('*/api/media/thumbnails', ({ request }) => {
        requestCount += 1;
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ data: mockThumbnails });
      }),
    );
  });

  it('should include circleId and comma-joined ids in the query string', async () => {
    await getThumbnails('circle-1', ['item-1', 'item-2', 'item-3']);
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.searchParams.get('circleId')).toBe('circle-1');
    expect(capturedUrl!.searchParams.get('ids')).toBe('item-1,item-2,item-3');
  });

  it('should return the array of ThumbnailRef objects from the server', async () => {
    const result = await getThumbnails('circle-1', ['item-1', 'item-2']);
    expect(result).toEqual(mockThumbnails);
  });

  it('should resolve to an empty array without making an HTTP request when ids is empty', async () => {
    const result = await getThumbnails('circle-1', []);
    expect(result).toEqual([]);
    expect(requestCount).toBe(0);
    expect(capturedUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getLocationExtent
// ---------------------------------------------------------------------------

describe('getLocationExtent', () => {
  let capturedUrl: URL | null = null;

  const mockExtent: LocationExtent = {
    minLat: 9.5,
    minLng: -85.0,
    maxLat: 10.5,
    maxLng: -84.0,
    count: 42,
  };

  beforeEach(() => {
    capturedUrl = null;

    server.use(
      http.get('*/api/media/locations/extent', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ data: mockExtent });
      }),
    );
  });

  it('should call GET /media/locations/extent with no query params when called with no args', async () => {
    await getLocationExtent();
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl!.search).toBe('');
  });

  it('should return the LocationExtent object from the server', async () => {
    const result = await getLocationExtent();
    expect(result).toEqual(mockExtent);
  });

  it('should include circleId in the query string when provided', async () => {
    await getLocationExtent({ circleId: 'circle-1' });
    expect(capturedUrl!.searchParams.get('circleId')).toBe('circle-1');
  });

  it('should include type in the query string when provided', async () => {
    await getLocationExtent({ type: 'video' });
    expect(capturedUrl!.searchParams.get('type')).toBe('video');
  });

  it('should include capturedAtFrom in the query string when provided', async () => {
    await getLocationExtent({ capturedAtFrom: '2024-01-01T00:00:00.000Z' });
    expect(capturedUrl!.searchParams.get('capturedAtFrom')).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  it('should include capturedAtTo in the query string when provided', async () => {
    await getLocationExtent({ capturedAtTo: '2024-12-31T23:59:59.999Z' });
    expect(capturedUrl!.searchParams.get('capturedAtTo')).toBe(
      '2024-12-31T23:59:59.999Z',
    );
  });

  it('should include all filters simultaneously', async () => {
    await getLocationExtent({
      circleId: 'circle-1',
      type: 'photo',
      capturedAtFrom: '2024-01-01T00:00:00.000Z',
      capturedAtTo: '2024-12-31T23:59:59.999Z',
    });

    const params = capturedUrl!.searchParams;
    expect(params.get('circleId')).toBe('circle-1');
    expect(params.get('type')).toBe('photo');
    expect(params.get('capturedAtFrom')).toBe('2024-01-01T00:00:00.000Z');
    expect(params.get('capturedAtTo')).toBe('2024-12-31T23:59:59.999Z');
  });

  // Regression coverage for the fix in commit `e041dab` ("fix(web): correctly
  // unwrap a legitimate null data payload from the API envelope").
  // `ApiService`'s response unwrapping previously did
  // `return data.data ?? data;`, which only substituted the envelope when
  // `data.data` was `undefined`. When the server legitimately responds with
  // `{ data: null }` (as `TransformInterceptor` produces for this endpoint
  // when a circle has zero geotagged items — see media.service.ts
  // `getLocationsExtent`), `null ?? data` evaluated to `data`, so the raw
  // envelope object round-tripped instead of `null`. That bug has been fixed
  // by explicitly checking `'data' in data` before unwrapping, so
  // `getLocationExtent()` now correctly returns `null` for the "no geotagged
  // items" case documented in this endpoint's contract. Downstream,
  // `MediaMapPage`'s `FitToExtent` guards with `if (!extent) return;`, so a
  // `null` result correctly leaves the map unframed instead of calling
  // `map.setView([undefined, undefined], 13)`. See also the component-level
  // tests in MediaMapPage.test.tsx, which mock `services/media` directly and
  // so do not exercise this envelope-unwrapping behavior.
  it('returns null, not the raw envelope, when the server response has a legitimately-null data field', async () => {
    server.use(
      http.get('*/api/media/locations/extent', () => {
        return HttpResponse.json({ data: null });
      }),
    );

    const result = await getLocationExtent();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTags
// ---------------------------------------------------------------------------

describe('listTags', () => {
  const mockTags: TagItem[] = [
    { id: 'tag-1', name: 'vacation', count: 5, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'tag-2', name: 'family', count: 3, createdAt: '2024-01-02T00:00:00.000Z' },
  ];

  it('fetches tags without circleId by default', async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get('*/api/media/tags', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockTags);
      }),
    );

    const result = await listTags();
    expect(result).toEqual(mockTags);
    expect(capturedUrl!.search).toBe('');
  });

  it('includes circleId query param when provided', async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get('*/api/media/tags', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockTags);
      }),
    );

    await listTags('circle-1');
    expect(capturedUrl!.searchParams.get('circleId')).toBe('circle-1');
  });
});
