/**
 * Unit tests — usePendingThumbnails
 *
 * Background reconcile hook for issue #89 (upload tile stuck on
 * "Processing…" spinner until refresh): polls GET /api/media/thumbnails
 * with light backoff for items that have no thumbnailUrl yet, and hands
 * resolved URLs to `onResolved` so the caller can patch the tile and free
 * the local object-URL preview.
 *
 * Uses fake timers throughout since the hook self-schedules via setTimeout.
 * `getThumbnails` (services/media) is mocked so no network call is made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePendingThumbnails } from '../usePendingThumbnails';
import { getThumbnails } from '../../services/media';
import type { MediaItem } from '../../types/media';

vi.mock('../../services/media', () => ({
  getThumbnails: vi.fn(),
}));

const mockGetThumbnails = vi.mocked(getThumbnails);

const CIRCLE_ID = 'circle-1';
const INITIAL_BACKOFF_MS = 2500;
const BACKOFF_FACTOR = 1.6;

function makeItem(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    storageObjectId: `storage-${id}`,
    addedById: 'user-1',
    circleId: CIRCLE_ID,
    type: 'photo',
    capturedAt: null,
    capturedAtOffset: null,
    importedAt: null,
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
    originalFilename: `${id}.jpg`,
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
    coordSource: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    archivedAt: null,
    metadata: null,
    thumbnailUrl: null,
    ...overrides,
  } as MediaItem;
}

describe('usePendingThumbnails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetThumbnails.mockReset();
    mockGetThumbnails.mockResolvedValue([]);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls only pending photo/video items (excludes items that already have a thumbnailUrl and items past the stuck threshold)', async () => {
    const stuckCreatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago > 15 min threshold
    const items = [
      makeItem('has-thumb', { thumbnailUrl: 'https://cdn.example.com/has-thumb.jpg' }),
      makeItem('stuck', { thumbnailUrl: null, createdAt: stuckCreatedAt }),
      makeItem('pending-1', { thumbnailUrl: null }),
      makeItem('pending-2', { thumbnailUrl: null, type: 'video' }),
    ];
    const onResolved = vi.fn();

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);

    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);
    expect(mockGetThumbnails).toHaveBeenCalledWith(CIRCLE_ID, ['pending-1', 'pending-2']);
  });

  it('calls onResolved with {id, thumbnailUrl} for non-null results and removes them from the next poll', async () => {
    const items = [makeItem('a', { thumbnailUrl: null }), makeItem('b', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    mockGetThumbnails.mockResolvedValueOnce([
      { id: 'a', thumbnailUrl: 'https://cdn.example.com/a.jpg' },
      { id: 'b', thumbnailUrl: null },
    ]);

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith([
      { id: 'a', thumbnailUrl: 'https://cdn.example.com/a.jpg' },
    ]);
  });

  it('ignores null results and keeps polling with the same pending set', async () => {
    const items = [makeItem('a', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    mockGetThumbnails.mockResolvedValue([{ id: 'a', thumbnailUrl: null }]);

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();

    // Second tick fires after the (grown) backoff — still polls the same id.
    const secondBackoff = INITIAL_BACKOFF_MS * BACKOFF_FACTOR;
    await vi.advanceTimersByTimeAsync(secondBackoff);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(2);
    expect(mockGetThumbnails).toHaveBeenLastCalledWith(CIRCLE_ID, ['a']);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('does not schedule any request when nothing is pending', async () => {
    const items = [makeItem('has-thumb', { thumbnailUrl: 'https://cdn.example.com/x.jpg' })];
    const onResolved = vi.fn();

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 2);

    expect(mockGetThumbnails).not.toHaveBeenCalled();
  });

  it('self-terminates once a resolved item empties the pending set (no further polling for it)', async () => {
    const items = [makeItem('a', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    mockGetThumbnails.mockResolvedValueOnce([
      { id: 'a', thumbnailUrl: 'https://cdn.example.com/a.jpg' },
    ]);

    const { rerender } = renderHook(
      ({ items: currentItems }) => usePendingThumbnails(currentItems, CIRCLE_ID, onResolved),
      { initialProps: { items } },
    );

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);

    // Simulate the caller patching the item with the resolved thumbnailUrl,
    // which the real MediaGallery does inside onResolved.
    rerender({
      items: [makeItem('a', { thumbnailUrl: 'https://cdn.example.com/a.jpg' })],
    });

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 5);
    // No further calls — the pending set is now empty.
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);
  });

  it('caps the polled id list at 200 even when more items are pending', async () => {
    const items = Array.from({ length: 250 }, (_, i) => makeItem(`p-${i}`, { thumbnailUrl: null }));
    const onResolved = vi.fn();

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);

    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);
    const [, ids] = mockGetThumbnails.mock.calls[0];
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('p-0');
    expect(ids[199]).toBe('p-199');
  });

  it('does not poll while document.hidden is true, and resumes on visibilitychange', async () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });

    const items = [makeItem('a', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    expect(mockGetThumbnails).not.toHaveBeenCalled();

    // Tab becomes visible again — the visibilitychange handler resumes polling immediately.
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);
  });

  it('does not overlap in-flight requests', async () => {
    const items = [makeItem('a', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    let resolveFetch!: (v: Array<{ id: string; thumbnailUrl: string | null }>) => void;
    mockGetThumbnails.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    // First tick starts the in-flight request but never resolves it yet.
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);

    // A visibility "resume" fires while the first request is still in flight —
    // the guard must prevent a second concurrent call.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);

    // Resolve the original request; no crash, no extra call synchronously.
    resolveFetch([{ id: 'a', thumbnailUrl: null }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThumbnails).toHaveBeenCalledTimes(1);
  });

  it('cleans up (stops polling) on unmount', async () => {
    const items = [makeItem('a', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    const { unmount } = renderHook(() => usePendingThumbnails(items, CIRCLE_ID, onResolved));

    unmount();

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 3);
    expect(mockGetThumbnails).not.toHaveBeenCalled();
  });

  it('does nothing when circleId is undefined', async () => {
    const items = [makeItem('a', { thumbnailUrl: null })];
    const onResolved = vi.fn();

    renderHook(() => usePendingThumbnails(items, undefined, onResolved));

    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 3);
    expect(mockGetThumbnails).not.toHaveBeenCalled();
  });
});
