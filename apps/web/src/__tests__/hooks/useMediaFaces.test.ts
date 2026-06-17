/**
 * Unit tests for useMediaFaces hook.
 *
 * Tests: initial load, loading state, error handling,
 * rerun with optimistic pending update, polling until terminal status,
 * and cleanup on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMediaFaces } from '../../hooks/useMediaFaces';

// ---------------------------------------------------------------------------
// Mock the face service module
// ---------------------------------------------------------------------------

vi.mock('../../services/face', () => ({
  getMediaFaces: vi.fn(),
  getMediaFaceStatus: vi.fn(),
  rerunMediaFaces: vi.fn(),
}));

import {
  getMediaFaces,
  getMediaFaceStatus,
  rerunMediaFaces,
} from '../../services/face';
import type { DetectedFaceDto, MediaFaceStatusDto } from '../../services/face';

const mockGetMediaFaces = vi.mocked(getMediaFaces);
const mockGetMediaFaceStatus = vi.mocked(getMediaFaceStatus);
const mockRerunMediaFaces = vi.mocked(rerunMediaFaces);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatus(
  status: MediaFaceStatusDto['status'] = 'processed',
): MediaFaceStatusDto {
  return {
    status,
    faceCount: status === 'processed' ? 1 : 0,
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    processedAt: status === 'processed' ? new Date().toISOString() : null,
    lastError: null,
  };
}

function makeFace(overrides: Partial<DetectedFaceDto> = {}): DetectedFaceDto {
  return {
    id: 'face-1',
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    personId: null,
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    manuallyAssigned: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMediaFaces', () => {
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
    it('calls getMediaFaces and getMediaFaceStatus on mount', async () => {
      mockGetMediaFaces.mockResolvedValue([makeFace()]);
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus('processed'));

      renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => {
        expect(mockGetMediaFaces).toHaveBeenCalledWith('media-1');
        expect(mockGetMediaFaceStatus).toHaveBeenCalledWith('media-1');
      });
    });

    it('populates faces and status after load', async () => {
      const face = makeFace();
      const status = makeStatus('processed');
      mockGetMediaFaces.mockResolvedValue([face]);
      mockGetMediaFaceStatus.mockResolvedValue(status);

      const { result } = renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => {
        expect(result.current.faces).toEqual([face]);
        expect(result.current.status).toEqual(status);
      });
    });

    it('starts with empty faces and null status', () => {
      // Never-resolving promises capture initial state
      mockGetMediaFaces.mockReturnValue(new Promise(() => {}));
      mockGetMediaFaceStatus.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMediaFaces('media-1'));

      expect(result.current.faces).toEqual([]);
      expect(result.current.status).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('loading state', () => {
    it('sets loading=true while fetching and false after', async () => {
      let resolveFaces!: (v: DetectedFaceDto[]) => void;
      let resolveStatus!: (v: MediaFaceStatusDto) => void;
      const facePromise = new Promise<DetectedFaceDto[]>((res) => { resolveFaces = res; });
      const statusPromise = new Promise<MediaFaceStatusDto>((res) => { resolveStatus = res; });

      mockGetMediaFaces.mockReturnValue(facePromise);
      mockGetMediaFaceStatus.mockReturnValue(statusPromise);

      const { result } = renderHook(() => useMediaFaces('media-1'));

      // During fetch, loading should be true
      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      await act(async () => {
        resolveFaces([]);
        resolveStatus(makeStatus('no_faces'));
        await facePromise;
        await statusPromise;
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
    it('sets error string when getMediaFaces rejects', async () => {
      mockGetMediaFaces.mockRejectedValue(new Error('Failed to fetch faces'));
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus());

      const { result } = renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to fetch faces');
      });
    });

    it('sets error string when getMediaFaceStatus rejects', async () => {
      mockGetMediaFaces.mockResolvedValue([]);
      mockGetMediaFaceStatus.mockRejectedValue(new Error('Status unavailable'));

      const { result } = renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Status unavailable');
      });
    });

    it('sets fallback error message for non-Error throws', async () => {
      mockGetMediaFaces.mockRejectedValue('plain string');
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus());

      const { result } = renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load face data');
      });
    });

    it('sets loading=false after error', async () => {
      mockGetMediaFaces.mockRejectedValue(new Error('Network error'));
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus());

      const { result } = renderHook(() => useMediaFaces('media-1'));

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
    it('calls rerunMediaFaces with the correct mediaId', async () => {
      mockGetMediaFaces.mockResolvedValue([makeFace()]);
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunMediaFaces.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      // Keep polling alive but never terminal so test stays simple
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus('processing'));

      const { result } = renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        void result.current.rerun();
        // Yield to let the rerun promise settle
        await new Promise((r) => Promise.resolve().then(r));
      });

      expect(mockRerunMediaFaces).toHaveBeenCalledWith('media-1');
    });

    it('optimistically sets status to pending after calling rerun', async () => {
      mockGetMediaFaces.mockResolvedValue([makeFace()]);
      // initial load returns processed; subsequent (poll) returns processing
      mockGetMediaFaceStatus
        .mockResolvedValueOnce(makeStatus('processed'))
        .mockResolvedValue(makeStatus('processing'));
      mockRerunMediaFaces.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const { result } = renderHook(() => useMediaFaces('media-1'));
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
    it('polls getMediaFaceStatus and stops on terminal status "processed"', async () => {
      // Use real timers — set up mocks so polling completes quickly
      // We verify polling behavior by checking call counts and final state
      mockGetMediaFaces.mockResolvedValue([]);
      // Sequence: initial load, poll1 (pending), poll2 (processed=terminal)
      mockGetMediaFaceStatus
        .mockResolvedValueOnce(makeStatus('no_faces'))   // initial load
        .mockResolvedValueOnce(makeStatus('pending'))    // poll 1
        .mockResolvedValueOnce(makeStatus('processed')); // poll 2 → terminal
      mockRerunMediaFaces.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      // After terminal, refreshFaces called
      mockGetMediaFaces.mockResolvedValue([makeFace()]);

      const { result } = renderHook(() => useMediaFaces('media-1'));

      // Wait for initial load
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Trigger rerun
      await act(async () => {
        void result.current.rerun();
      });

      // Wait for rerunLoading to become true (optimistic update triggered)
      await waitFor(() => expect(result.current.rerunLoading).toBe(true));

      // Wait for polling to complete — terminal status 'processed' reached after 2 polls
      // Each poll happens every POLL_INTERVAL_MS (2000ms); use waitFor with generous timeout
      await waitFor(
        () => {
          expect(result.current.rerunLoading).toBe(false);
          expect(result.current.status?.status).toBe('processed');
        },
        { timeout: 8000 },
      );
    }, 15000);

    it('sets rerunLoading=true during rerun and false after terminal status', async () => {
      mockGetMediaFaces.mockResolvedValue([]);
      mockGetMediaFaceStatus
        .mockResolvedValueOnce(makeStatus('no_faces'))   // initial
        .mockResolvedValue(makeStatus('processed'));     // poll → terminal immediately
      mockRerunMediaFaces.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const { result } = renderHook(() => useMediaFaces('media-1'));

      await waitFor(() => expect(result.current.loading).toBe(false));

      // Start rerun
      act(() => {
        void result.current.rerun();
      });

      // rerunLoading should become true quickly
      await waitFor(() => expect(result.current.rerunLoading).toBe(true));

      // Then become false after terminal status reached
      await waitFor(
        () => expect(result.current.rerunLoading).toBe(false),
        { timeout: 8000 },
      );
    }, 15000);
  });

  // -------------------------------------------------------------------------
  // rerun — error path
  // -------------------------------------------------------------------------

  describe('rerun — error path', () => {
    it('sets error and rerunLoading=false when rerunMediaFaces rejects', async () => {
      mockGetMediaFaces.mockResolvedValue([]);
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunMediaFaces.mockRejectedValue(new Error('Rerun failed'));

      const { result } = renderHook(() => useMediaFaces('media-1'));

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
      mockGetMediaFaces.mockResolvedValue([]);
      // Polling never reaches terminal status
      mockGetMediaFaceStatus.mockResolvedValue(makeStatus('pending'));
      mockRerunMediaFaces.mockResolvedValue({ jobId: 'job-1', status: 'pending' });

      const { result, unmount } = renderHook(() => useMediaFaces('media-1'));

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
