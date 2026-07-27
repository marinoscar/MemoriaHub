/**
 * Unit tests for `useEnhancements` — the AI Enhancements hub list + poll hook
 * (issue #201).
 *
 * Covers:
 *  - inert mode (null params): no service call, empty state
 *  - initial load: calls listEnhancements with the given params, populates
 *    items/meta, toggles isLoading
 *  - error handling (Error instance + non-Error throw fallback message)
 *  - refetch when the params VALUE changes, and NOT when the caller merely
 *    passes a new object literal with identical values
 *  - polls every 5s while any row is pending/processing, and those poll ticks
 *    are silent (isLoading stays false)
 *  - stops polling once every row is terminal
 *  - tears the interval down on unmount
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEnhancements, ENHANCEMENTS_POLL_MS } from '../../hooks/useEnhancements';
import type { EnhancementListItem, EnhancementListResponse } from '../../services/enhance';

vi.mock('../../services/enhance', () => ({
  listEnhancements: vi.fn(),
}));

import { listEnhancements } from '../../services/enhance';

const mockList = vi.mocked(listEnhancements);

function makeItem(overrides: Partial<EnhancementListItem> = {}): EnhancementListItem {
  return {
    id: 'enh-1',
    mediaItemId: 'item-1',
    status: 'ready',
    decision: null,
    model: 'gpt-image-1',
    params: {},
    original: { thumbnailUrl: 'https://cdn/o.jpg', width: 4000, height: 3000, size: '1000' },
    enhanced: { thumbnailUrl: 'https://cdn/e.jpg', width: 1024, height: 1024, size: '900' },
    downscaled: true,
    expiresAt: '2026-08-01T00:00:00.000Z',
    lastError: null,
    resultMediaItemId: null,
    sourceFilename: 'IMG_0001.jpg',
    capturedAt: '2026-01-01T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Test User' },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeResponse(items: EnhancementListItem[]): EnhancementListResponse {
  return {
    items,
    meta: { page: 1, pageSize: 24, totalItems: items.length, totalPages: 1 },
  };
}

describe('useEnhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue(makeResponse([makeItem()]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays inert with null params — no service call, empty state', async () => {
    const { result } = renderHook(() => useEnhancements(null));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
    expect(result.current.meta).toBeNull();
    expect(result.current.polling).toBe(false);
  });

  it('loads on mount and populates items/meta', async () => {
    const { result } = renderHook(() =>
      useEnhancements({ circleId: 'circle-1', status: 'awaiting_decision' }),
    );

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(mockList).toHaveBeenCalledWith({
      circleId: 'circle-1',
      status: 'awaiting_decision',
    });
    expect(result.current.meta).toEqual({
      page: 1,
      pageSize: 24,
      totalItems: 1,
      totalPages: 1,
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('surfaces an Error message, and a fallback for a non-Error throw', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    const { result, rerender } = renderHook(
      ({ status }: { status: 'ready' | 'failed' }) =>
        useEnhancements({ circleId: 'circle-1', status }),
      { initialProps: { status: 'ready' as const } },
    );

    await waitFor(() => expect(result.current.error).toBe('boom'));

    mockList.mockRejectedValueOnce('nope');
    rerender({ status: 'failed' });

    await waitFor(() => expect(result.current.error).toBe('Failed to load enhancements'));
  });

  it('refetches when the params VALUE changes but not on an identical new object', async () => {
    const { rerender } = renderHook(
      ({ page }: { page: number }) => useEnhancements({ circleId: 'circle-1', page }),
      { initialProps: { page: 1 } },
    );

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    // New object literal, identical values -> no refetch.
    rerender({ page: 1 });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    // Genuine value change -> refetch.
    rerender({ page: 2 });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(mockList).toHaveBeenLastCalledWith({ circleId: 'circle-1', page: 2 });
  });

  it('polls every 5s while a row is pending or processing, silently', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockList.mockResolvedValue(makeResponse([makeItem({ status: 'processing' })]));

    const { result } = renderHook(() => useEnhancements({ circleId: 'circle-1' }));

    await waitFor(() => expect(result.current.polling).toBe(true));
    expect(mockList).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENHANCEMENTS_POLL_MS);
    });
    expect(mockList).toHaveBeenCalledTimes(2);
    // A poll tick must never flash the list into its loading skeleton.
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENHANCEMENTS_POLL_MS);
    });
    expect(mockList).toHaveBeenCalledTimes(3);
  });

  it('stops polling once every row is terminal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockList.mockResolvedValueOnce(makeResponse([makeItem({ status: 'pending' })]));
    mockList.mockResolvedValue(makeResponse([makeItem({ status: 'ready' })]));

    const { result } = renderHook(() => useEnhancements({ circleId: 'circle-1' }));

    await waitFor(() => expect(result.current.polling).toBe(true));

    // One tick resolves the row to `ready`, which must tear the interval down.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENHANCEMENTS_POLL_MS);
    });
    await waitFor(() => expect(result.current.polling).toBe(false));

    const callsAfterSettle = mockList.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENHANCEMENTS_POLL_MS * 3);
    });
    expect(mockList).toHaveBeenCalledTimes(callsAfterSettle);
  });

  it('clears the poll interval on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockList.mockResolvedValue(makeResponse([makeItem({ status: 'pending' })]));

    const { result, unmount } = renderHook(() => useEnhancements({ circleId: 'circle-1' }));
    await waitFor(() => expect(result.current.polling).toBe(true));

    const callsBefore = mockList.mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENHANCEMENTS_POLL_MS * 3);
    });
    expect(mockList).toHaveBeenCalledTimes(callsBefore);
  });

  it('refresh() re-fetches with a visible loading state', async () => {
    const { result } = renderHook(() => useEnhancements({ circleId: 'circle-1' }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(false);
  });
});
