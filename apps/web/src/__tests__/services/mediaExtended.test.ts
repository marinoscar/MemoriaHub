/**
 * services/media — extended coverage for all service functions not tested in media.test.ts.
 *
 * Covers: listMedia, getMedia, patchMedia, deleteMedia, initUpload, uploadPart,
 * completeUpload, registerMedia, listAlbums, createAlbum, getAlbum,
 * bulkUpdateMedia, bulkTags, bulkDelete, reverseGeocode, searchPlaces, getDashboard.
 *
 * exportMedia is excluded — it depends on browser APIs (URL.createObjectURL,
 * anchor.click) that are not realistic to simulate in jsdom without extensive
 * mocking of DOM behaviour.
 *
 * Uses MSW to intercept real HTTP calls from the `api` singleton so that the
 * service logic (query-string building, response mapping, error handling) is
 * exercised without a running backend.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  listMedia,
  getMedia,
  patchMedia,
  deleteMedia,
  initUpload,
  completeUpload,
  registerMedia,
  listAlbums,
  createAlbum,
  getAlbum,
  bulkUpdateMedia,
  bulkTags,
  bulkDelete,
  reverseGeocode,
  searchPlaces,
  getDashboard,
  uploadPart,
} from '../../services/media';
import type {
  MediaItem,
  MediaKeysetResponse,
  InitUploadResponse,
  AlbumListResponse,
  Album,
  AlbumDetail,
  DashboardResponse,
} from '../../types/media';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockMediaItem: MediaItem = {
  id: 'item-1',
  storageObjectId: 'obj-1',
  addedById: 'user-1',
  circleId: 'circle-1',
  type: 'photo',
  capturedAt: null,
  capturedAtOffset: null,
  importedAt: new Date().toISOString(),
  source: 'web',
  contentHash: null,
  width: null,
  height: null,
  durationMs: null,
  orientation: null,
  takenLat: null,
  takenLng: null,
  takenAltitude: null,
  cameraMake: null,
  cameraModel: null,
  originalFilename: 'photo.jpg',
  description: null,
  favorite: false,
  geoCountry: null,
  geoCountryCode: null,
  geoAdmin1: null,
  geoAdmin2: null,
  geoLocality: null,
  geoPlaceName: null,
  geoSource: null,
  geocodedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  metadata: null,
  thumbnailUrl: null,
};

const mockListResponse: MediaKeysetResponse = {
  items: [mockMediaItem],
  meta: { pageSize: 20, nextCursor: 'cursor-next-1', hasMore: true },
};

const mockDashboard: DashboardResponse = {
  onThisDay: [mockMediaItem],
  recent: [mockMediaItem],
  favorites: [],
  counts: { total: 10, missingGeo: 1 },
};

const mockAlbum: Album = {
  id: 'album-1',
  name: 'Vacation 2024',
  description: null,
  addedById: 'user-1',
  circleId: 'circle-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockAlbumDetail: AlbumDetail = {
  ...mockAlbum,
  items: [mockMediaItem],
};

const mockAlbumListResponse: AlbumListResponse = {
  items: [mockAlbum],
  meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
};

const mockInitUploadResponse: InitUploadResponse = {
  objectId: 'obj-new',
  uploadId: 'upload-123',
  partSize: 5_242_880,
  totalParts: 1,
  presignedUrls: [{ partNumber: 1, url: 'https://s3.example.com/presigned' }],
};

// ---------------------------------------------------------------------------
// listMedia
// ---------------------------------------------------------------------------

describe('listMedia', () => {
  let capturedUrl: URL | null = null;

  beforeEach(() => {
    capturedUrl = null;
    server.use(
      http.get('*/api/media', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockListResponse);
      }),
    );
  });

  it('calls GET /media with no params when called without arguments', async () => {
    await listMedia();
    expect(capturedUrl!.search).toBe('');
  });

  it('returns the list response', async () => {
    const result = await listMedia();
    expect(result).toEqual(mockListResponse);
    expect(result.items).toEqual([mockMediaItem]);
    expect(result.meta.nextCursor).toBe('cursor-next-1');
    expect(result.meta.hasMore).toBe(true);
  });

  it('includes cursor and pageSize in query string, omits page', async () => {
    await listMedia({ cursor: 'cursor-abc', pageSize: 50 });
    expect(capturedUrl!.searchParams.get('cursor')).toBe('cursor-abc');
    expect(capturedUrl!.searchParams.get('pageSize')).toBe('50');
    expect(capturedUrl!.searchParams.has('page')).toBe(false);
  });

  it('includes type filter', async () => {
    await listMedia({ type: 'video' });
    expect(capturedUrl!.searchParams.get('type')).toBe('video');
  });

  it('includes favorite filter', async () => {
    await listMedia({ favorite: true });
    expect(capturedUrl!.searchParams.get('favorite')).toBe('true');
  });

  it('includes missingGeo=1 when missingGeo is true', async () => {
    await listMedia({ missingGeo: true });
    expect(capturedUrl!.searchParams.get('missingGeo')).toBe('1');
  });

  it('includes missingGeo=0 when missingGeo is false', async () => {
    await listMedia({ missingGeo: false });
    expect(capturedUrl!.searchParams.get('missingGeo')).toBe('0');
  });

  it('includes circleId, sortBy, sortOrder, contentHash', async () => {
    await listMedia({
      circleId: 'circle-1',
      sortBy: 'capturedAt',
      sortOrder: 'desc',
      contentHash: 'abc123',
    });
    const p = capturedUrl!.searchParams;
    expect(p.get('circleId')).toBe('circle-1');
    expect(p.get('sortBy')).toBe('capturedAt');
    expect(p.get('sortOrder')).toBe('desc');
    expect(p.get('contentHash')).toBe('abc123');
  });

  it('includes geo filter params', async () => {
    await listMedia({
      country: 'CR',
      region: 'Alajuela',
      locality: 'La Fortuna',
      place: 'Arenal',
      location: 'volcano',
    });
    const p = capturedUrl!.searchParams;
    expect(p.get('country')).toBe('CR');
    expect(p.get('region')).toBe('Alajuela');
    expect(p.get('locality')).toBe('La Fortuna');
    expect(p.get('place')).toBe('Arenal');
    expect(p.get('location')).toBe('volcano');
  });

  it('includes capturedAt range filters', async () => {
    await listMedia({
      capturedAtFrom: '2024-01-01T00:00:00.000Z',
      capturedAtTo: '2024-12-31T23:59:59.999Z',
    });
    expect(capturedUrl!.searchParams.get('capturedAtFrom')).toBe('2024-01-01T00:00:00.000Z');
    expect(capturedUrl!.searchParams.get('capturedAtTo')).toBe('2024-12-31T23:59:59.999Z');
  });

  it('includes camera and source device filters', async () => {
    await listMedia({
      cameraMake: 'Apple',
      cameraModel: 'iPhone 15',
      sourceDeviceId: 'dev-1',
      sourceDeviceName: 'My Phone',
    });
    const p = capturedUrl!.searchParams;
    expect(p.get('cameraMake')).toBe('Apple');
    expect(p.get('cameraModel')).toBe('iPhone 15');
    expect(p.get('sourceDeviceId')).toBe('dev-1');
    expect(p.get('sourceDeviceName')).toBe('My Phone');
  });

  it('includes tag and albumId filters', async () => {
    await listMedia({ tag: 'vacation', albumId: 'album-1' });
    expect(capturedUrl!.searchParams.get('tag')).toBe('vacation');
    expect(capturedUrl!.searchParams.get('albumId')).toBe('album-1');
  });
});

// ---------------------------------------------------------------------------
// getMedia
// ---------------------------------------------------------------------------

describe('getMedia', () => {
  it('calls GET /media/:id and returns the item', async () => {
    server.use(
      http.get('*/api/media/:id', ({ params }) => {
        expect(params.id).toBe('item-1');
        return HttpResponse.json(mockMediaItem);
      }),
    );

    const result = await getMedia('item-1');
    expect(result).toMatchObject({ id: 'item-1' });
  });
});

// ---------------------------------------------------------------------------
// patchMedia
// ---------------------------------------------------------------------------

describe('patchMedia', () => {
  it('calls PATCH /media/:id with the DTO and returns updated item', async () => {
    server.use(
      http.patch('*/api/media/:id', async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockMediaItem, id: String(params.id), ...body });
      }),
    );

    const result = await patchMedia('item-1', { description: 'Updated description', favorite: true });
    expect(result.description).toBe('Updated description');
    expect(result.favorite).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteMedia
// ---------------------------------------------------------------------------

describe('deleteMedia', () => {
  it('calls DELETE /media/:id', async () => {
    let deleteCalled = false;
    server.use(
      http.delete('*/api/media/:id', ({ params }) => {
        expect(params.id).toBe('item-1');
        deleteCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await deleteMedia('item-1');
    expect(deleteCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// initUpload
// ---------------------------------------------------------------------------

describe('initUpload', () => {
  it('POSTs to /storage/objects/upload/init and returns the init response', async () => {
    server.use(
      http.post('*/api/storage/objects/upload/init', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.name).toBe('photo.jpg');
        expect(body.size).toBe(1024);
        expect(body.mimeType).toBe('image/jpeg');
        return HttpResponse.json(mockInitUploadResponse);
      }),
    );

    const result = await initUpload({ name: 'photo.jpg', size: 1024, mimeType: 'image/jpeg' });
    expect(result).toEqual(mockInitUploadResponse);
  });
});

// ---------------------------------------------------------------------------
// uploadPart
// ---------------------------------------------------------------------------

describe('uploadPart', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends PUT to the presigned URL and returns the ETag', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name === 'ETag' ? '"abc123"' : null),
      },
    } as unknown as Response);

    const etag = await uploadPart('https://s3.example.com/presigned', new Blob(['data']));
    expect(etag).toBe('"abc123"');
  });

  it('throws when the response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    } as unknown as Response);

    await expect(uploadPart('https://s3.example.com/presigned', new Blob(['data']))).rejects.toThrow(
      'Part upload failed: 403 Forbidden',
    );
  });

  it('throws when ETag header is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => null,
      },
    } as unknown as Response);

    await expect(uploadPart('https://s3.example.com/presigned', new Blob(['data']))).rejects.toThrow(
      'S3 did not return an ETag',
    );
  });
});

// ---------------------------------------------------------------------------
// completeUpload
// ---------------------------------------------------------------------------

describe('completeUpload', () => {
  it('POSTs to /storage/objects/:id/upload/complete', async () => {
    let called = false;
    server.use(
      http.post('*/api/storage/objects/:id/upload/complete', async ({ params, request }) => {
        expect(params.id).toBe('obj-new');
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.parts).toEqual([{ partNumber: 1, eTag: '"etag-1"' }]);
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await completeUpload('obj-new', [{ partNumber: 1, eTag: '"etag-1"' }]);
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerMedia
// ---------------------------------------------------------------------------

describe('registerMedia', () => {
  it('POSTs to /media and returns the registered item', async () => {
    server.use(
      http.post('*/api/media', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ...mockMediaItem, storageObjectId: body.storageObjectId as string },
          { status: 201 },
        );
      }),
    );

    const result = await registerMedia({
      storageObjectId: 'obj-new',
      type: 'photo',
      source: 'web',
      originalFilename: 'photo.jpg',
      circleId: 'circle-1',
    });

    expect(result.storageObjectId).toBe('obj-new');
  });
});

// ---------------------------------------------------------------------------
// listAlbums
// ---------------------------------------------------------------------------

describe('listAlbums', () => {
  let capturedUrl: URL | null = null;

  beforeEach(() => {
    capturedUrl = null;
    server.use(
      http.get('*/api/media/albums', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockAlbumListResponse);
      }),
    );
  });

  it('calls GET /media/albums with no params when called without arguments', async () => {
    await listAlbums();
    expect(capturedUrl!.search).toBe('');
  });

  it('returns the album list response', async () => {
    const result = await listAlbums();
    expect(result).toEqual(mockAlbumListResponse);
  });

  it('includes page, pageSize, circleId, sortBy, sortOrder', async () => {
    await listAlbums({ page: 2, pageSize: 10, circleId: 'circle-1', sortBy: 'name', sortOrder: 'asc' });
    const p = capturedUrl!.searchParams;
    expect(p.get('page')).toBe('2');
    expect(p.get('pageSize')).toBe('10');
    expect(p.get('circleId')).toBe('circle-1');
    expect(p.get('sortBy')).toBe('name');
    expect(p.get('sortOrder')).toBe('asc');
  });
});

// ---------------------------------------------------------------------------
// createAlbum
// ---------------------------------------------------------------------------

describe('createAlbum', () => {
  it('POSTs to /media/albums and returns the created album', async () => {
    server.use(
      http.post('*/api/media/albums', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockAlbum, name: body.name as string }, { status: 201 });
      }),
    );

    const result = await createAlbum({ name: 'Summer 2024', circleId: 'circle-1' });
    expect(result.name).toBe('Summer 2024');
  });
});

// ---------------------------------------------------------------------------
// getAlbum
// ---------------------------------------------------------------------------

describe('getAlbum', () => {
  it('calls GET /media/albums/:id and returns the album detail', async () => {
    server.use(
      http.get('*/api/media/albums/:id', ({ params }) => {
        expect(params.id).toBe('album-1');
        return HttpResponse.json(mockAlbumDetail);
      }),
    );

    const result = await getAlbum('album-1');
    expect(result.id).toBe('album-1');
    expect(result.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// bulkUpdateMedia
// ---------------------------------------------------------------------------

describe('bulkUpdateMedia', () => {
  it('calls PATCH /media/bulk and returns the updated count', async () => {
    server.use(
      http.patch('*/api/media/bulk', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const ids = body.ids as string[];
        return HttpResponse.json({ updated: ids.length });
      }),
    );

    const result = await bulkUpdateMedia({
      circleId: 'circle-1',
      ids: ['item-1', 'item-2'],
      set: { favorite: true },
    });

    expect(result.updated).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// bulkTags
// ---------------------------------------------------------------------------

describe('bulkTags', () => {
  it('POSTs to /media/bulk/tags and returns added/removed counts', async () => {
    server.use(
      http.post('*/api/media/bulk/tags', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const add = (body.add as string[] | undefined) ?? [];
        const remove = (body.remove as string[] | undefined) ?? [];
        return HttpResponse.json({ added: add.length, removed: remove.length });
      }),
    );

    const result = await bulkTags({
      circleId: 'circle-1',
      ids: ['item-1'],
      add: ['vacation', 'family'],
      remove: ['draft'],
    });

    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// bulkDelete
// ---------------------------------------------------------------------------

describe('bulkDelete', () => {
  it('POSTs to /media/bulk/delete and returns deleted count', async () => {
    server.use(
      http.post('*/api/media/bulk/delete', async ({ request }) => {
        const body = (await request.json()) as { ids: string[] };
        return HttpResponse.json({ deleted: body.ids.length });
      }),
    );

    const result = await bulkDelete({ circleId: 'circle-1', ids: ['item-1', 'item-2', 'item-3'] });
    expect(result.deleted).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// reverseGeocode
// ---------------------------------------------------------------------------

describe('reverseGeocode', () => {
  it('calls GET /media/geo/reverse with lat and lng', async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get('*/api/media/geo/reverse', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({
          country: 'Costa Rica',
          countryCode: 'CR',
          admin1: 'Alajuela',
          admin2: null,
          locality: 'La Fortuna',
          placeName: 'Arenal Volcano',
        });
      }),
    );

    const result = await reverseGeocode(10.463, -84.703);
    expect(capturedUrl!.searchParams.get('lat')).toBe('10.463');
    expect(capturedUrl!.searchParams.get('lng')).toBe('-84.703');
    expect(result?.country).toBe('Costa Rica');
  });

  it('returns empty result when no location found', async () => {
    server.use(
      http.get('*/api/media/geo/reverse', () => {
        return HttpResponse.json({
          country: null,
          countryCode: null,
          admin1: null,
          admin2: null,
          locality: null,
          placeName: null,
        });
      }),
    );

    const result = await reverseGeocode(0, 0);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// searchPlaces
// ---------------------------------------------------------------------------

describe('searchPlaces', () => {
  it('calls GET /media/geo/search with q param', async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get('*/api/media/geo/search', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json([{ lat: 9.9, lng: -84.1, label: 'San José' }]);
      }),
    );

    const result = await searchPlaces('San José');
    expect(capturedUrl!.searchParams.get('q')).toBe('San José');
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('San José');
  });

  it('includes limit param when provided', async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get('*/api/media/geo/search', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json([]);
      }),
    );

    await searchPlaces('Paris', 5);
    expect(capturedUrl!.searchParams.get('limit')).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// getDashboard
// ---------------------------------------------------------------------------

describe('getDashboard', () => {
  it('calls GET /media/dashboard with circleId and returns dashboard data', async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get('*/api/media/dashboard', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockDashboard);
      }),
    );

    const result = await getDashboard('circle-1');
    expect(capturedUrl!.searchParams.get('circleId')).toBe('circle-1');
    expect(result.counts.total).toBe(10);
    expect(result.onThisDay).toHaveLength(1);
  });
});
