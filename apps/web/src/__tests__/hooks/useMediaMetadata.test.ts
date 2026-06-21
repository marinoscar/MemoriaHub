/**
 * Unit tests for useMediaMetadata hook.
 *
 * Tests: initial load, loading state, error handling,
 * rerun with optimistic pending update, polling until terminal status,
 * onRefresh callback, and cleanup on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMediaMetadata } from '../../hooks/useMediaMetadata';

// ---------------------------------------------------------------------------
// Mock the metadata service module
// ---------------------------------------------------------------------------

vi.mock('../../services/metadata', () => ({
  getMediaMetadataStatus: vi.fn(),
  rerunMediaMetadata: vi.fn(),
}));

import {
  getMediaMetadataStatus,
  rerunMediaMetadata,
} from '../../services/metadata';
import type { MediaMetadataStatusDto } from '../../services/metadata';

const mockGetMediaMetadataStatus = vi.mocked(getMediaMetadataStatus);
const mockRerunMediaMetadata = vi.mocked(rerunMediaMetadata);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatus(
  status: MediaMetadataStatusDto['status'] = 'processed',
): MediaMetadataStatusDto {
  return {
    status,
    processedAt: status === 'processed' ? new Date().toISOString() : null,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMediaMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Initial load
  // -------------------------------------------------------------------------

  describe('initial load', () => {
    it('calls getMediaMetadataStatus on mount with correct mediaId', async () => {
      mockGetMediaMetadataStatus.mockResolvedValue(makeStatus('processed'));

      renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => {
        expect(mockGetMediaMetadataStatus).toHaveBeenCalledWith('media-1');
      });
    });

    it('populates status after load', async () => {
      const status = makeStatus('processed');
      mockGetMediaMetadataStatus.mockResolvedValue(status);

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.status).toEqual(status);
      });
    });

    it('starts with null status', () => {
      // Never-resolving promise captures initial state
      mockGetMediaMetadataStatus.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      expect(result.current.status).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('loading state', () => {
    it('sets loading=true while fetching and false after', async () => {
      let resolve!: (v: MediaMetadataStatusDto) => void;
      const promise = new Promise<MediaMetadataStatusDto>((res) => { resolve = res; });

      mockGetMediaMetadataStatus.mockReturnValue(promise);

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      // During fetch, loading should be true
      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      await act(async () => {
        resolve(makeStatus('processed'));
        await promise;
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('sets error string when getMediaMetadataStatus rejects', async () => {
      mockGetMediaMetadataStatus.mockRejectedValue(new Error('Failed to fetch status'));

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to fetch status');
      });
    });

    it('sets fallback error message for non-Error throws', async () => {
      mockGetMediaMetadataStatus.mockRejectedValue('plain string');

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load metadata status');
      });
    });

    it('sets loading=false after error', async () => {
      mockGetMediaMetadataStatus.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.error).not.toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------------
  // rerun — optimistic update
  // -------------------------------------------------------------------------

  describe('rerun — optimistic update', () => {
    it('calls rerunMediaMetadata with the correct mediaId', async () => {
      mockGetMediaMetadataStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunMediaMetadata.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      // Keep polling alive but never terminal
      mockGetMediaMetadataStatus.mockResolvedValue(makeStatus('processing'));

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        void result.current.rerun();
        await new Promise((r) => Promise.resolve().then(r));
      });

      expect(mockRerunMediaMetadata).toHaveBeenCalledWith('media-1');
    });

    it('optimistically sets status to pending after calling rerun', async () => {
      // initial load returns processed; subsequent (poll) returns processing
      mockGetMediaMetadataStatus
        .mockResolvedValueOnce(makeStatus('processed'))
        .mockResolvedValue(makeStatus('processing'));
      mockRerunMediaMetadata.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        void result.current.rerun();
        await new Promise((r) => Promise.resolve().then(r));
      });

      expect(result.current.status?.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // rerun — polling until terminal status
  // -------------------------------------------------------------------------

  describe('rerun — polling', () => {
    it('polls getMediaMetadataStatus and stops on terminal "processed" — rerunLoading becomes false', async () => {
      mockGetMediaMetadataStatus
        .mockResolvedValueOnce(makeStatus('not_processed')) // initial load
        .mockResolvedValueOnce(makeStatus('pending'))       // poll 1
        .mockResolvedValueOnce(makeStatus('processed'));    // poll 2 → terminal
      mockRerunMediaMetadata.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      // Wait for initial load
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Trigger rerun
      await act(async () => {
        void result.current.rerun();
      });

      // Wait for rerunLoading to become true (optimistic update triggered)
      await waitFor(() => expect(result.current.rerunLoading).toBe(true));

      // Wait for polling to complete — terminal status 'processed' reached
      await waitFor(
        () => {
          expect(result.current.rerunLoading).toBe(false);
          expect(result.current.status?.status).toBe('processed');
        },
        { timeout: 8000 },
      );
    }, 15000);

    it('also stops on terminal "failed" status', async () => {
      mockGetMediaMetadataStatus
        .mockResolvedValueOnce(makeStatus('processed')) // initial load
        .mockResolvedValueOnce(makeStatus('failed'));   // poll 1 → terminal
      mockRerunMediaMetadata.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const onRefresh = vi.fn();
      const { result } = renderHook(() => useMediaMetadata('media-1', onRefresh));

      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        void result.current.rerun();
      });

      await waitFor(() => expect(result.current.rerunLoading).toBe(true));

      await waitFor(
        () => {
          expect(result.current.rerunLoading).toBe(false);
          expect(result.current.status?.status).toBe('failed');
        },
        { timeout: 8000 },
      );
    }, 15000);

    it('calls onRefresh when terminal status is reached', async () => {
      mockGetMediaMetadataStatus
        .mockResolvedValueOnce(makeStatus('not_processed')) // initial load
        .mockResolvedValueOnce(makeStatus('processed'));    // poll 1 → terminal
      mockRerunMediaMetadata.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const onRefresh = vi.fn();
      const { result } = renderHook(() => useMediaMetadata('media-1', onRefresh));

      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        void result.current.rerun();
      });

      await waitFor(() => expect(result.current.rerunLoading).toBe(true));

      await waitFor(
        () => expect(onRefresh).toHaveBeenCalled(),
        { timeout: 8000 },
      );
    }, 15000);
  });

  // -------------------------------------------------------------------------
  // rerun — error path
  // -------------------------------------------------------------------------

  describe('rerun — error path', () => {
    it('sets error and rerunLoading=false when rerunMediaMetadata rejects', async () => {
      mockGetMediaMetadataStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunMediaMetadata.mockRejectedValue(new Error('Rerun failed'));

      const { result } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.rerun();
      });

      expect(result.current.error).toBe('Rerun failed');
      expect(result.current.rerunLoading).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    it('stops polling on unmount without causing errors', async () => {
      // Polling never reaches terminal status
      mockGetMediaMetadataStatus.mockResolvedValue(makeStatus('pending'));
      mockRerunMediaMetadata.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const { result, unmount } = renderHook(() => useMediaMetadata('media-1', vi.fn()));

      await waitFor(() => expect(result.current.loading).toBe(false));

      // Start rerun to begin polling
      act(() => {
        void result.current.rerun();
      });

      await waitFor(() => expect(result.current.rerunLoading).toBe(true));

      // Unmount while polling is active — should not throw
      unmount();

      // Wait a moment to confirm no errors surface after unmount
      await new Promise((r) => setTimeout(r, 100));

      // Test passes if no uncaught errors thrown
    });
  });
});
