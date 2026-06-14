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
import { listMediaLocations, listTags } from '../../services/media';
import type { MediaLocation, TagItem } from '../../types/media';

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
