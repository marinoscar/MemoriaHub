/**
 * Unit tests for `useMemoryActions` — optimistic memory mutations with
 * rollback (epic #300, issue #309).
 *
 * Every test here is about the FAILURE path, because the success path is
 * trivially right and the failure path is where an optimistic UI lies to the
 * user: a rejected favorite must un-fill the heart, a rejected hide must put
 * the card back, a rejected delete must restore it. The seen-dedup tests cover
 * the other half — a fire-and-forget write that must happen at most once per
 * memory per session, but must become retriable again if it failed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../../services/memories', () => ({
  markMemorySeen: vi.fn(),
  hideMemory: vi.fn(),
  unhideMemory: vi.fn(),
  favoriteMemory: vi.fn(),
  unfavoriteMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

import {
  deleteMemory,
  favoriteMemory,
  hideMemory,
  markMemorySeen,
  unfavoriteMemory,
  unhideMemory,
} from '../../services/memories';
import { resetSeenSession, useMemoryActions } from '../../hooks/useMemoryActions';

const mockSeen = vi.mocked(markMemorySeen);
const mockHide = vi.mocked(hideMemory);
const mockUnhide = vi.mocked(unhideMemory);
const mockFavorite = vi.mocked(favoriteMemory);
const mockUnfavorite = vi.mocked(unfavoriteMemory);
const mockDelete = vi.mocked(deleteMemory);

function makePatchers() {
  return {
    patchMyState: vi.fn(),
    removeItem: vi.fn(),
    restoreItem: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSeenSession();
  mockSeen.mockResolvedValue(undefined);
  mockHide.mockResolvedValue(undefined);
  mockUnhide.mockResolvedValue(undefined);
  mockFavorite.mockResolvedValue(undefined);
  mockUnfavorite.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
});

describe('useMemoryActions — markSeen', () => {
  it('reports a memory seen once and optimistically flips the ring', () => {
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    act(() => result.current.markSeen('mem-1'));

    expect(mockSeen).toHaveBeenCalledExactlyOnceWith('mem-1');
    expect(patchers.patchMyState).toHaveBeenCalledWith('mem-1', { seen: true });
  });

  it('does not report the same memory twice in a session', () => {
    const { result } = renderHook(() => useMemoryActions(makePatchers()));

    act(() => {
      result.current.markSeen('mem-1');
      result.current.markSeen('mem-1');
    });

    expect(mockSeen).toHaveBeenCalledTimes(1);
  });

  it('dedups across separate hook instances (the carousel and the hub)', () => {
    const first = renderHook(() => useMemoryActions(makePatchers()));
    const second = renderHook(() => useMemoryActions(makePatchers()));

    act(() => first.result.current.markSeen('mem-1'));
    act(() => second.result.current.markSeen('mem-1'));

    expect(mockSeen).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed report', async () => {
    mockSeen.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useMemoryActions(makePatchers()));

    act(() => result.current.markSeen('mem-1'));
    // Let the rejection settle so the session entry is released.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.markSeen('mem-1'));

    expect(mockSeen).toHaveBeenCalledTimes(2);
  });
});

describe('useMemoryActions — setFavorite', () => {
  it('flips optimistically and keeps the flip on success', async () => {
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    let ok = false;
    await act(async () => {
      ok = await result.current.setFavorite('mem-1', true);
    });

    expect(ok).toBe(true);
    expect(mockFavorite).toHaveBeenCalledWith('mem-1');
    expect(patchers.patchMyState).toHaveBeenCalledExactlyOnceWith('mem-1', {
      favorited: true,
    });
  });

  it('rolls the flip back and reports the error on failure', async () => {
    mockFavorite.mockRejectedValue(new Error('nope'));
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    let ok = true;
    await act(async () => {
      ok = await result.current.setFavorite('mem-1', true);
    });

    expect(ok).toBe(false);
    expect(patchers.patchMyState).toHaveBeenNthCalledWith(1, 'mem-1', {
      favorited: true,
    });
    expect(patchers.patchMyState).toHaveBeenNthCalledWith(2, 'mem-1', {
      favorited: false,
    });
    expect(result.current.error).toBe('nope');
  });

  it('calls the un-favorite endpoint when clearing', async () => {
    const { result } = renderHook(() => useMemoryActions(makePatchers()));

    await act(async () => {
      await result.current.setFavorite('mem-1', false);
    });

    expect(mockUnfavorite).toHaveBeenCalledWith('mem-1');
    expect(mockFavorite).not.toHaveBeenCalled();
  });
});

describe('useMemoryActions — setHidden', () => {
  it('removes the card optimistically and leaves it gone on success', async () => {
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    await act(async () => {
      await result.current.setHidden('mem-1', true);
    });

    expect(patchers.removeItem).toHaveBeenCalledWith('mem-1');
    expect(patchers.restoreItem).not.toHaveBeenCalled();
    expect(mockHide).toHaveBeenCalledWith('mem-1');
  });

  it('restores the card when hiding fails', async () => {
    mockHide.mockRejectedValue(new Error('hide failed'));
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    await act(async () => {
      await result.current.setHidden('mem-1', true);
    });

    expect(patchers.restoreItem).toHaveBeenCalledWith('mem-1');
    expect(result.current.error).toBe('hide failed');
  });

  it('does not touch the list when un-hiding', async () => {
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    await act(async () => {
      await result.current.setHidden('mem-1', false);
    });

    expect(mockUnhide).toHaveBeenCalledWith('mem-1');
    expect(patchers.removeItem).not.toHaveBeenCalled();
  });
});

describe('useMemoryActions — remove (the circle-level tombstone)', () => {
  it('removes optimistically and reports success', async () => {
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    let ok = false;
    await act(async () => {
      ok = await result.current.remove('mem-1');
    });

    expect(ok).toBe(true);
    expect(patchers.removeItem).toHaveBeenCalledWith('mem-1');
    expect(mockDelete).toHaveBeenCalledWith('mem-1');
  });

  it('restores the card and reports the error when the delete is refused', async () => {
    mockDelete.mockRejectedValue(new Error('Forbidden'));
    const patchers = makePatchers();
    const { result } = renderHook(() => useMemoryActions(patchers));

    let ok = true;
    await act(async () => {
      ok = await result.current.remove('mem-1');
    });

    expect(ok).toBe(false);
    expect(patchers.restoreItem).toHaveBeenCalledWith('mem-1');
    expect(result.current.error).toBe('Forbidden');
  });

  it('clearError resets the snackbar state', async () => {
    mockDelete.mockRejectedValue(new Error('Forbidden'));
    const { result } = renderHook(() => useMemoryActions(makePatchers()));

    await act(async () => {
      await result.current.remove('mem-1');
    });
    act(() => result.current.clearError());

    expect(result.current.error).toBeNull();
  });
});

describe('useMemoryActions — no patchers', () => {
  it('works without a list (the detail page passes only patchMyState)', async () => {
    const { result } = renderHook(() => useMemoryActions());

    await act(async () => {
      await expect(result.current.remove('mem-1')).resolves.toBe(true);
    });
    expect(mockDelete).toHaveBeenCalledWith('mem-1');
  });
});
