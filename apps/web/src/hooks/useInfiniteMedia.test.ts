/**
 * Unit tests — useInfiniteMedia
 *
 * Cursor (keyset) pagination hook for the gallery (issue #104). These tests
 * exercise the hook entirely through the `options.fetcher` seam so no
 * `services/media` module mocking is needed — `listMedia` itself is never
 * invoked from this suite.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInfiniteMedia } from './useInfiniteMedia';
import type { InfiniteMediaFetcher } from './useInfiniteMedia';
import type { MediaItem, MediaQueryParams } from '../types/media';

function makeItem(id: string): MediaItem {
  return { id } as MediaItem;
}

const BASE_PARAMS: Omit<MediaQueryParams, 'page' | 'pageSize'> = { circleId: 'circle-1' };

describe('useInfiniteMedia', () => {
  it('performs the initial load: fetcher called once with (null, pageSize), items populated, hasMore true when nextCursor is non-null', async () => {
    const fetcher: InfiniteMediaFetcher = vi.fn().mockResolvedValue({
      items: [makeItem('a'), makeItem('b')],
      nextCursor: 'cursor-1',
    });

    const { result } = renderHook(() =>
      useInfiniteMedia(BASE_PARAMS, 50, true, { fetcher }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(null, 50);
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('loadMore appends items using the stored cursor and advances it', async () => {
    const fetcher: InfiniteMediaFetcher = vi
      .fn()
      .mockResolvedValueOnce({ items: [makeItem('a'), makeItem('b')], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [makeItem('c'), makeItem('d')], nextCursor: 'cursor-2' });

    const { result } = renderHook(() =>
      useInfiniteMedia(BASE_PARAMS, 50, true, { fetcher }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'cursor-1', 50);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.hasMore).toBe(true);
  });

  it('sets hasMore=false at end of feed and does not fetch again on further loadMore calls', async () => {
    const fetcher: InfiniteMediaFetcher = vi
      .fn()
      .mockResolvedValueOnce({ items: [makeItem('a')], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [makeItem('b')], nextCursor: null });

    const { result } = renderHook(() =>
      useInfiniteMedia(BASE_PARAMS, 50, true, { fetcher }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasMore).toBe(false);
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);

    // Further loadMore calls are a no-op (cursorRef is null — no more pages).
    act(() => {
      result.current.loadMore();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reset() replaces items and refetches from cursor=null', async () => {
    const fetcher: InfiniteMediaFetcher = vi
      .fn()
      .mockResolvedValueOnce({ items: [makeItem('a'), makeItem('b')], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [makeItem('z')], nextCursor: null });

    const { result } = renderHook(() =>
      useInfiniteMedia(BASE_PARAMS, 50, true, { fetcher }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);

    act(() => {
      result.current.reset();
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenNthCalledWith(2, null, 50);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Replaced, not appended.
    expect(result.current.items.map((i) => i.id)).toEqual(['z']);
    expect(result.current.hasMore).toBe(false);
  });

  it('refetches from cursor=null and replaces items when params change', async () => {
    const fetcher: InfiniteMediaFetcher = vi
      .fn()
      .mockResolvedValueOnce({ items: [makeItem('photo-1')], nextCursor: null })
      .mockResolvedValueOnce({ items: [makeItem('video-1')], nextCursor: null });

    const paramsA: Omit<MediaQueryParams, 'page' | 'pageSize'> = {
      circleId: 'circle-1',
      type: 'photo',
    };
    const paramsB: Omit<MediaQueryParams, 'page' | 'pageSize'> = {
      circleId: 'circle-1',
      type: 'video',
    };

    const { result, rerender } = renderHook(
      ({ params }: { params: Omit<MediaQueryParams, 'page' | 'pageSize'> }) =>
        useInfiniteMedia(params, 50, true, { fetcher }),
      { initialProps: { params: paramsA } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.items.map((i) => i.id)).toEqual(['photo-1']);

    rerender({ params: paramsB });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenNthCalledWith(2, null, 50);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['video-1']);
  });

  it('discards a stale in-flight fetch when reset() bumps the generation before it resolves', async () => {
    let resolveFirst!: (v: { items: MediaItem[]; nextCursor: string | null }) => void;
    const firstPromise = new Promise<{ items: MediaItem[]; nextCursor: string | null }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );

    const fetcher: InfiniteMediaFetcher = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValueOnce({ items: [makeItem('fresh')], nextCursor: null });

    const { result } = renderHook(() =>
      useInfiniteMedia(BASE_PARAMS, 50, true, { fetcher }),
    );

    // First fetch is in flight (deferred), so items are still empty.
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(result.current.items).toEqual([]);

    // Bump generation before the first fetch resolves.
    act(() => {
      result.current.reset();
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual(['fresh']);

    // Resolve the stale first fetch late — its result must be discarded.
    await act(async () => {
      resolveFirst({ items: [makeItem('stale')], nextCursor: 'stale-cursor' });
      // Let the resolved microtask/then-chain of fetchPage run.
      await Promise.resolve();
    });

    expect(result.current.items.map((i) => i.id)).toEqual(['fresh']);
    expect(result.current.error).toBeNull();
  });
});
