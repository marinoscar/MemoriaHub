/**
 * `useBroadcasts` / `useBroadcastActions` / `useVisiblePolling` — epic #481,
 * issue #488.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../services/api';

vi.mock('../../services/broadcasts', () => ({
  getBroadcasts: vi.fn(),
  createBroadcast: vi.fn(),
  cancelBroadcast: vi.fn(),
  resumeBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  sendTestBroadcast: vi.fn(),
}));

import {
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcasts,
  resumeBroadcast,
  sendTestBroadcast,
} from '../../services/broadcasts';
import { useBroadcastActions, useBroadcasts, useVisiblePolling } from '../../hooks/useBroadcasts';

const row = { id: 'b1', status: 'sent' } as any;

describe('useBroadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBroadcasts).mockResolvedValue({
      items: [row],
      meta: { page: 1, pageSize: 20, totalItems: 7, totalPages: 1 },
    });
  });

  it('loads a page and remembers the query for refresh', async () => {
    const { result } = renderHook(() => useBroadcasts());
    await act(async () => {
      await result.current.fetchBroadcasts({ page: 2, status: 'failed' });
    });
    expect(result.current.broadcasts).toEqual([row]);
    expect(result.current.total).toBe(7);
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });
    expect(getBroadcasts).toHaveBeenLastCalledWith({ page: 2, status: 'failed' });
  });

  it('clears rows and names a 403', async () => {
    vi.mocked(getBroadcasts).mockRejectedValue(new ApiError('Forbidden', 403));
    const { result } = renderHook(() => useBroadcasts());
    await act(async () => {
      await result.current.fetchBroadcasts();
    });
    expect(result.current.broadcasts).toEqual([]);
    expect(result.current.error).toMatch(/do not have permission/);
  });
});

describe('useBroadcastActions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifies a change after each write but not after a test send', async () => {
    const onChanged = vi.fn();
    vi.mocked(createBroadcast).mockResolvedValue(row);
    vi.mocked(cancelBroadcast).mockResolvedValue(row);
    vi.mocked(resumeBroadcast).mockResolvedValue(row);
    vi.mocked(deleteBroadcast).mockResolvedValue(undefined);
    vi.mocked(sendTestBroadcast).mockResolvedValue({ channels: ['inbox'] } as any);
    const { result } = renderHook(() => useBroadcastActions(onChanged));
    const body = { title: 't', body: 'b', critical: false, channels: ['inbox' as const] };

    await act(async () => {
      expect(await result.current.create(body)).toBe(row);
      expect(await result.current.cancel('b1')).toBe(row);
      expect(await result.current.resume('b1')).toBe(row);
      expect(await result.current.remove('b1')).toBe(true);
    });
    expect(onChanged).toHaveBeenCalledTimes(4);

    await act(async () => {
      await result.current.sendTest(body);
    });
    expect(onChanged).toHaveBeenCalledTimes(4);
  });

  it('passes the API message through on a 409 and resolves null/false', async () => {
    vi.mocked(cancelBroadcast).mockRejectedValue(new ApiError("Broadcast b1 is 'sent'", 409));
    vi.mocked(deleteBroadcast).mockRejectedValue(new ApiError('currently sending', 409));
    const { result } = renderHook(() => useBroadcastActions());

    await act(async () => {
      expect(await result.current.cancel('b1')).toBeNull();
    });
    expect(result.current.error).toBe("Broadcast b1 is 'sent'");
    await act(async () => {
      expect(await result.current.remove('b1')).toBe(false);
    });
    expect(result.current.error).toBe('currently sending');
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.isWorking).toBe(false);
  });
});

describe('useVisiblePolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls at the interval, and not at all for 0', () => {
    const callback = vi.fn();
    const { rerender } = renderHook(({ ms }) => useVisiblePolling(callback, ms), {
      initialProps: { ms: 0 },
    });
    vi.advanceTimersByTime(30_000);
    expect(callback).not.toHaveBeenCalled();

    rerender({ ms: 10_000 });
    vi.advanceTimersByTime(20_000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('skips ticks while the tab is hidden', () => {
    const callback = vi.fn();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHook(() => useVisiblePolling(callback, 1000));
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
