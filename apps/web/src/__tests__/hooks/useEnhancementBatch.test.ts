/**
 * Unit tests for `useEnhancementBatch` (epic #420, issue #423).
 *
 * The hook is shaped exactly like `useTrashEmptyRun`/`useReviewRun` — a single
 * `fetchBatch(batchId)` that populates `batch`/`isLoading`/`error` — so this
 * suite mirrors `useMediaTags.test.ts`'s teardown-guard regression pattern
 * (issue #196) rather than inventing a new harness.
 *
 * Covers:
 *  - fetch / refetch behaviour (loading toggles, batch populated, refetch
 *    replaces the previous batch)
 *  - error surfacing (Error instance message, and the fallback message for a
 *    non-Error throw), and that a failed fetch clears any previously-loaded
 *    batch
 *  - unmount safety: no state update fires once the component has unmounted,
 *    even when the in-flight fetch resolves afterwards — the exact race
 *    `useIsMounted` exists to guard against
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEnhancementBatch } from '../../hooks/useEnhancementBatch';
import type { EnhancementBatch } from '../../services/enhance';

vi.mock('../../services/enhance', () => ({
  getEnhancementBatch: vi.fn(),
}));

import { getEnhancementBatch } from '../../services/enhance';

const mockGetEnhancementBatch = vi.mocked(getEnhancementBatch);

function makeBatch(overrides: Partial<EnhancementBatch> = {}): EnhancementBatch {
  return {
    id: 'batch-1',
    circleId: 'circle-1',
    status: 'running',
    matchedCount: 10,
    processedCount: 3,
    succeededCount: 2,
    failedCount: 1,
    skippedCount: 0,
    startedById: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:10.000Z',
    startedAt: '2026-08-01T00:00:01.000Z',
    finishedAt: null,
    lastError: null,
    requestedCount: 10,
    queuedCount: 10,
    skipped: null,
    params: {},
    source: 'selection',
    cancelledAt: null,
    ...overrides,
  };
}

describe('useEnhancementBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Fetch / refetch behaviour
  // -------------------------------------------------------------------------
  describe('fetch / refetch', () => {
    it('starts with an empty, non-loading state', () => {
      const { result } = renderHook(() => useEnhancementBatch());

      expect(result.current.batch).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('fetches and populates the batch, toggling isLoading around it', async () => {
      let resolveGet!: (value: EnhancementBatch) => void;
      const pending = new Promise<EnhancementBatch>((resolve) => {
        resolveGet = resolve;
      });
      mockGetEnhancementBatch.mockReturnValue(pending);

      const { result } = renderHook(() => useEnhancementBatch());

      let fetchPromise!: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchBatch('batch-1');
      });

      await waitFor(() => expect(result.current.isLoading).toBe(true));

      await act(async () => {
        resolveGet(makeBatch());
        await fetchPromise;
      });

      expect(mockGetEnhancementBatch).toHaveBeenCalledWith('batch-1');
      expect(result.current.batch).toEqual(makeBatch());
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('a later fetchBatch call replaces the previously-loaded batch (poll semantics)', async () => {
      mockGetEnhancementBatch.mockResolvedValueOnce(
        makeBatch({ status: 'running', processedCount: 3 }),
      );
      const { result } = renderHook(() => useEnhancementBatch());

      await act(async () => {
        await result.current.fetchBatch('batch-1');
      });
      expect(result.current.batch?.processedCount).toBe(3);

      mockGetEnhancementBatch.mockResolvedValueOnce(
        makeBatch({ status: 'completed', processedCount: 10, succeededCount: 9 }),
      );
      await act(async () => {
        await result.current.fetchBatch('batch-1');
      });

      expect(mockGetEnhancementBatch).toHaveBeenCalledTimes(2);
      expect(result.current.batch?.status).toBe('completed');
      expect(result.current.batch?.processedCount).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Error surfacing
  // -------------------------------------------------------------------------
  describe('error surfacing', () => {
    it('surfaces an Error instance message and clears the batch', async () => {
      mockGetEnhancementBatch.mockResolvedValueOnce(makeBatch());
      const { result } = renderHook(() => useEnhancementBatch());

      await act(async () => {
        await result.current.fetchBatch('batch-1');
      });
      expect(result.current.batch).not.toBeNull();

      mockGetEnhancementBatch.mockRejectedValueOnce(new Error('Enhancement batch not found'));
      await act(async () => {
        await result.current.fetchBatch('missing-batch');
      });

      expect(result.current.error).toBe('Enhancement batch not found');
      // A failed re-fetch must not leave a stale batch on screen.
      expect(result.current.batch).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it('falls back to a generic message for a non-Error throw', async () => {
      mockGetEnhancementBatch.mockRejectedValueOnce('nope');
      const { result } = renderHook(() => useEnhancementBatch());

      await act(async () => {
        await result.current.fetchBatch('batch-1');
      });

      expect(result.current.error).toBe('Failed to fetch the enhancement batch');
      expect(result.current.batch).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Unmount safety (issue #196's useIsMounted guard)
  // -------------------------------------------------------------------------
  describe('unmount safety', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let unhandledRejections: unknown[];
    let onUnhandledRejection: (reason: unknown) => void;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      unhandledRejections = [];
      onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandledRejection);
      consoleErrorSpy.mockRestore();
    });

    it('does not update state, warn, or reject when an in-flight fetch resolves AFTER unmount', async () => {
      let resolveGet!: (value: EnhancementBatch) => void;
      const pending = new Promise<EnhancementBatch>((resolve) => {
        resolveGet = resolve;
      });
      mockGetEnhancementBatch.mockReturnValue(pending);

      const { result, unmount } = renderHook(() => useEnhancementBatch());

      // Kick off the fetch — it is now in flight (mocked promise still pending).
      let fetchPromise!: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchBatch('batch-1');
      });

      // Unmount BEFORE the fetch resolves — the exact race issue #196 guards.
      unmount();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const savedWindow = (globalThis as any).window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).window;

      // Now let the fetch resolve, well after teardown.
      resolveGet(makeBatch());

      // Give the resolved promise's continuation (the guarded `then`/`finally`
      // block inside useEnhancementBatch) every opportunity to run.
      await fetchPromise;
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window = savedWindow;

      // No thrown/rejected error escaped the continuation.
      expect(unhandledRejections).toEqual([]);
      // No React "not wrapped in act" (or any other) warning fired — meaning
      // no state update was attempted against the unmounted component.
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('does not update state when an in-flight fetch REJECTS after unmount', async () => {
      let rejectGet!: (reason: unknown) => void;
      const pending = new Promise<EnhancementBatch>((_resolve, reject) => {
        rejectGet = reject;
      });
      mockGetEnhancementBatch.mockReturnValue(pending);
      // A rejected promise this test intentionally never lets propagate as an
      // unhandled rejection from the mock itself.
      pending.catch(() => {});

      const { result, unmount } = renderHook(() => useEnhancementBatch());

      let fetchPromise!: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchBatch('batch-1');
      });

      unmount();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const savedWindow = (globalThis as any).window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).window;

      rejectGet(new Error('boom'));

      await fetchPromise;
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window = savedWindow;

      expect(unhandledRejections).toEqual([]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
