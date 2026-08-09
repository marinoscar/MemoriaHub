/**
 * Unit tests for the memories list/feed hooks (epic #300, issue #309).
 *
 * The behaviour that actually matters here is the DISABLED path: with
 * `features.memories` off — the default — the epic requires zero cost, and on
 * the client that means the hook must fire NO request at all, not merely render
 * nothing. Those two assertions are the load-bearing ones in this file.
 *
 * Beyond that: keyset accumulation across pages, the reset-on-filter-change
 * that stops a stale page landing in a new query, and the optimistic list
 * mutators (which must MERGE `myState` rather than replace it, and must restore
 * a rolled-back card to its original index).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MemoryCard, MemoryFeedCard } from '../../types/memories';

vi.mock('../../services/memories', () => ({
  listMemories: vi.fn(),
  getMemoriesFeed: vi.fn(),
}));

import { listMemories, getMemoriesFeed } from '../../services/memories';
import { useMemories } from '../../hooks/useMemories';
import { useMemoriesFeed } from '../../hooks/useMemoriesFeed';

const mockList = vi.mocked(listMemories);
const mockFeed = vi.mocked(getMemoriesFeed);

function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    id: 'mem-1',
    type: 'trip',
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    itemCount: 24,
    periodStart: '2023-03-12T00:00:00.000Z',
    periodEnd: '2023-03-18T00:00:00.000Z',
    coverMediaItemId: 'media-1',
    coverThumbnailUrl: 'https://cdn/cover.jpg',
    meta: null,
    myState: { seen: false, favorited: false },
    generatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFeedCard(overrides: Partial<MemoryFeedCard> = {}): MemoryFeedCard {
  return { ...makeCard(), itemThumbnailUrls: [], ...overrides };
}

function page(items: MemoryCard[], nextCursor: string | null = null) {
  return { items, meta: { pageSize: 24, nextCursor, hasMore: nextCursor !== null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue(page([makeCard()]));
  mockFeed.mockResolvedValue({ items: [makeFeedCard()] });
});

describe('useMemories', () => {
  it('fires NO request when disabled (the feature flag is off)', async () => {
    const { result } = renderHook(() => useMemories('circle-1', {}, false));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it('fires NO request without an active circle', async () => {
    renderHook(() => useMemories(null, {}, true));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockList).not.toHaveBeenCalled();
  });

  it('loads the first page and reports the keyset cursor state', async () => {
    mockList.mockResolvedValue(page([makeCard()], 'cursor-2'));

    const { result } = renderHook(() => useMemories('circle-1', {}, true));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: 'circle-1', cursor: null }),
    );
    expect(result.current.hasMore).toBe(true);
  });

  it('appends the next page on loadMore, carrying the cursor forward', async () => {
    mockList.mockResolvedValueOnce(page([makeCard({ id: 'a' })], 'cursor-2'));
    mockList.mockResolvedValueOnce(page([makeCard({ id: 'b' })], null));

    const { result } = renderHook(() => useMemories('circle-1', {}, true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(mockList).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-2' }),
    );
    expect(result.current.hasMore).toBe(false);
  });

  it('resets to the first page when the filters change', async () => {
    const { result, rerender } = renderHook(
      ({ filters }) => useMemories('circle-1', filters, true),
      { initialProps: { filters: {} as { type?: 'trip' } } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mockList.mockResolvedValue(page([makeCard({ id: 'filtered' })]));
    rerender({ filters: { type: 'trip' } });

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'trip', cursor: null }),
      ),
    );
    await waitFor(() => expect(result.current.items[0].id).toBe('filtered'));
  });

  it('does NOT refetch when the caller passes an equal filters literal', async () => {
    const { rerender } = renderHook(
      ({ filters }) => useMemories('circle-1', filters, true),
      { initialProps: { filters: { type: 'trip' as const } } },
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    rerender({ filters: { type: 'trip' as const } });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('surfaces a load failure without throwing', async () => {
    mockList.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useMemories('circle-1', {}, true));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.items).toEqual([]);
  });

  describe('optimistic mutators', () => {
    it('patchMyState MERGES rather than replacing the state object', async () => {
      mockList.mockResolvedValue(
        page([makeCard({ myState: { seen: true, favorited: false } })]),
      );
      const { result } = renderHook(() => useMemories('circle-1', {}, true));
      await waitFor(() => expect(result.current.items).toHaveLength(1));

      act(() => result.current.patchMyState('mem-1', { favorited: true }));

      // `seen` must survive a favorite patch — replacing the object here is
      // exactly how a card silently loses its ring state.
      expect(result.current.items[0].myState).toEqual({
        seen: true,
        favorited: true,
      });
    });

    it('restoreItem puts a rolled-back card back at its original index', async () => {
      mockList.mockResolvedValue(
        page([makeCard({ id: 'a' }), makeCard({ id: 'b' }), makeCard({ id: 'c' })]),
      );
      const { result } = renderHook(() => useMemories('circle-1', {}, true));
      await waitFor(() => expect(result.current.items).toHaveLength(3));

      act(() => result.current.removeItem('b'));
      expect(result.current.items.map((i) => i.id)).toEqual(['a', 'c']);

      act(() => result.current.restoreItem('b'));
      expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('restoreItem is a no-op for a card that was never removed', async () => {
      const { result } = renderHook(() => useMemories('circle-1', {}, true));
      await waitFor(() => expect(result.current.items).toHaveLength(1));

      act(() => result.current.restoreItem('never-removed'));

      expect(result.current.items).toHaveLength(1);
    });
  });
});

describe('useMemoriesFeed', () => {
  it('fires NO request when disabled', async () => {
    const { result } = renderHook(() => useMemoriesFeed('circle-1', false));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFeed).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });

  it('fires NO request without an active circle', async () => {
    renderHook(() => useMemoriesFeed(null, true));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFeed).not.toHaveBeenCalled();
  });

  it('loads the feed for the active circle', async () => {
    const { result } = renderHook(() => useMemoriesFeed('circle-1', true));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(mockFeed).toHaveBeenCalledWith('circle-1');
  });

  it('refetches when the circle changes', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useMemoriesFeed(id, true),
      { initialProps: { id: 'circle-1' } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    rerender({ id: 'circle-2' });

    await waitFor(() => expect(mockFeed).toHaveBeenLastCalledWith('circle-2'));
  });

  it('reports an error and empties the row on failure', async () => {
    mockFeed.mockRejectedValue(new Error('feed down'));

    const { result } = renderHook(() => useMemoriesFeed('circle-1', true));

    await waitFor(() => expect(result.current.error).toBe('feed down'));
    expect(result.current.items).toEqual([]);
  });
});
