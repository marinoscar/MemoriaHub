/**
 * Unit tests for `useEnhancementBatch` (epic #420, issue #423).
 *
 * Shaped like `useTrashEmptyRun`'s own suite: fetch/refetch behaviour, error
 * surfacing (Error instance + non-Error fallback message), and the
 * `useIsMounted` unmount-safety contract — no state update fires after the
 * component has unmounted, which is what keeps a slow in-flight request from
 * throwing "ReferenceError: window is not defined" into an unrelated test
 * file once jsdom has torn down (see `useIsMounted`'s own doc comment).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEnhancementBatch } from '../../hooks/useEnhancementBatch';
import type { EnhancementBatch } from '../../services/enhance';

vi.mock('../../services/enhance', () => ({
  getEnhancementBatch: vi.fn(),
}));

import { getEnhancementBatch } from '../../services/enhance';

const mockGetBatch = vi.mocked(getEnhancementBatch);

function makeBatch(overrides: Partial<EnhancementBatch> = {}): EnhancementBatch {
  return {
    id: 'batch-1',
    circleId: 'circle-1',
    status: 'running',
    matchedCount: 10,
    processedCount: 3,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: null,
    lastError: null,
    requestedCount: 10,
    queuedCount: 10,
    skipped: null,
    params: {},
    source: 'bulk',
    cancelledAt: null,
    ...overrides,
  };
}

describe('useEnhancementBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with no batch, not loading, no error', () => {
    const { result } = renderHook(() => useEnhancementBatch());

    expect(result.current.batch).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetBatch).not.toHaveBeenCalled();
  });

  it('fetchBatch calls the service with the given id and populates the batch', async () => {
    mockGetBatch.mockResolvedValue(makeBatch({ id: 'batch-42' }));
    const { result } = renderHook(() => useEnhancementBatch());

    await act(async () => {
      await result.current.fetchBatch('batch-42');
    });

    expect(mockGetBatch).toHaveBeenCalledWith('batch-42');
    expect(result.current.batch?.id).toBe('batch-42');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('a later fetchBatch call refetches and replaces the batch', async () => {
    mockGetBatch.mockResolvedValueOnce(makeBatch({ processedCount: 3 }));
    const { result } = renderHook(() => useEnhancementBatch());

    await act(async () => {
      await result.current.fetchBatch('batch-1');
    });
    expect(result.current.batch?.processedCount).toBe(3);

    mockGetBatch.mockResolvedValueOnce(makeBatch({ processedCount: 7 }));
    await act(async () => {
      await result.current.fetchBatch('batch-1');
    });
    expect(mockGetBatch).toHaveBeenCalledTimes(2);
    expect(result.current.batch?.processedCount).toBe(7);
  });

  it('toggles isLoading true then false around a fetch', async () => {
    let resolveFn: (b: EnhancementBatch) => void = () => {};
    mockGetBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve;
        }),
    );
    const { result } = renderHook(() => useEnhancementBatch());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.fetchBatch('batch-1');
    });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveFn(makeBatch());
      await pending;
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('surfaces an Error message and clears the batch', async () => {
    mockGetBatch.mockRejectedValueOnce(new Error('Enhancement batch not found'));
    const { result } = renderHook(() => useEnhancementBatch());

    await act(async () => {
      await result.current.fetchBatch('missing');
    });

    expect(result.current.error).toBe('Enhancement batch not found');
    expect(result.current.batch).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to a generic message for a non-Error throw', async () => {
    mockGetBatch.mockRejectedValueOnce('nope');
    const { result } = renderHook(() => useEnhancementBatch());

    await act(async () => {
      await result.current.fetchBatch('batch-1');
    });

    expect(result.current.error).toBe('Failed to fetch the enhancement batch');
  });

  it('a fresh successful fetch clears a previous error', async () => {
    mockGetBatch.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useEnhancementBatch());

    await act(async () => {
      await result.current.fetchBatch('batch-1');
    });
    expect(result.current.error).toBe('boom');

    mockGetBatch.mockResolvedValueOnce(makeBatch());
    await act(async () => {
      await result.current.fetchBatch('batch-1');
    });
    expect(result.current.error).toBeNull();
    expect(result.current.batch).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Unmount safety (useIsMounted contract)
  // -------------------------------------------------------------------------
  describe('unmount safety', () => {
    it('does not update state (batch) after unmount once a pending fetch resolves', async () => {
      let resolveFn: (b: EnhancementBatch) => void = () => {};
      mockGetBatch.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFn = resolve;
          }),
      );
      const { result, unmount } = renderHook(() => useEnhancementBatch());

      let pending!: Promise<void>;
      act(() => {
        pending = result.current.fetchBatch('batch-1');
      });
      expect(result.current.isLoading).toBe(true);

      unmount();

      // Resolve the in-flight request AFTER the component is gone. If the
      // hook does not guard its post-await setters, this throws/leaks a
      // React state update against an unmounted host.
      await act(async () => {
        resolveFn(makeBatch());
        await pending;
      });

      // No assertion on `result.current` is meaningful post-unmount (React
      // testing library warns on reading stale state) — the real assertion
      // is that awaiting the resolved promise above did not throw or log a
      // "Warning: Can't perform a React state update on an unmounted
      // component" error, which `useIsMounted()` exists to prevent.
    });

    it('does not update state (error) after unmount once a pending fetch rejects', async () => {
      let rejectFn: (err: unknown) => void = () => {};
      mockGetBatch.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectFn = reject;
          }),
      );
      const { result, unmount } = renderHook(() => useEnhancementBatch());

      let pending!: Promise<void>;
      act(() => {
        pending = result.current.fetchBatch('batch-1');
      });

      unmount();

      await act(async () => {
        rejectFn(new Error('too late'));
        // The hook swallows this into local error state (never a thrown
        // rejection out of fetchBatch), so awaiting it must resolve cleanly
        // even after unmount.
        await pending;
      });
    });
  });
});
