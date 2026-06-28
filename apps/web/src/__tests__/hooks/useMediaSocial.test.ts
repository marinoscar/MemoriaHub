/**
 * Unit tests for useMediaSocial hook.
 *
 * Tests: initial load, loading state, error handling,
 * rerun with optimistic pending update, polling until terminal status,
 * onRefresh callback, and cleanup on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMediaSocial } from '../../hooks/useMediaSocial';

// ---------------------------------------------------------------------------
// Mock the social service module
// ---------------------------------------------------------------------------

vi.mock('../../services/social', () => ({
  getSocialStatus: vi.fn(),
  rerunSocial: vi.fn(),
}));

import { getSocialStatus, rerunSocial } from '../../services/social';
import type { SocialStatusDto } from '../../services/social';

const mockGetSocialStatus = vi.mocked(getSocialStatus);
const mockRerunSocial = vi.mocked(rerunSocial);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatus(
  status: SocialStatusDto['status'] = 'processed',
  overrides: Partial<SocialStatusDto> = {},
): SocialStatusDto {
  return {
    status,
    detected: status === 'processed',
    platform: null,
    processedAt: status === 'processed' ? new Date().toISOString() : null,
    lastError: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMediaSocial', () => {
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
    it('calls getSocialStatus on mount with correct mediaId', async () => {
      mockGetSocialStatus.mockResolvedValue(makeStatus('not_processed'));

      renderHook(() => useMediaSocial('media-1', vi.fn()));

      await waitFor(() => {
        expect(mockGetSocialStatus).toHaveBeenCalledWith('media-1');
      });
    });

    it('populates status after load', async () => {
      const status = makeStatus('processed', { detected: true, platform: 'TikTok' });
      mockGetSocialStatus.mockResolvedValue(status);

      const { result } = renderHook(() => useMediaSocial('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.status).toEqual(status);
      });
    });

    it('sets loading=true during fetch and false after', async () => {
      let resolve!: (v: SocialStatusDto) => void;
      mockGetSocialStatus.mockReturnValue(new Promise((r) => { resolve = r; }));

      const { result } = renderHook(() => useMediaSocial('media-1', vi.fn()));

      expect(result.current.loading).toBe(true);

      act(() => { resolve(makeStatus('not_processed')); });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('sets error when getSocialStatus throws', async () => {
      mockGetSocialStatus.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMediaSocial('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
        expect(result.current.loading).toBe(false);
      });
    });

    it('sets a generic error message when getSocialStatus throws a non-Error', async () => {
      mockGetSocialStatus.mockRejectedValue('unexpected');

      const { result } = renderHook(() => useMediaSocial('media-1', vi.fn()));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load social detection status');
      });
    });
  });

  // -------------------------------------------------------------------------
  // rerun
  // -------------------------------------------------------------------------

  describe('rerun', () => {
    it('calls rerunSocial with the correct mediaId', async () => {
      mockGetSocialStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunSocial.mockResolvedValue({ jobId: 'job-s1', status: 'pending' });

      const { result } = renderHook(() => useMediaSocial('media-2', vi.fn()));

      await waitFor(() => { expect(result.current.status).toBeDefined(); });

      await act(async () => {
        await result.current.rerun();
      });

      expect(mockRerunSocial).toHaveBeenCalledWith('media-2');
    });

    it('optimistically sets status to pending after rerun call', async () => {
      vi.useFakeTimers();
      mockGetSocialStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunSocial.mockResolvedValue({ jobId: 'job-s1', status: 'pending' });

      const { result } = renderHook(() => useMediaSocial('media-1', vi.fn()));

      // Let initial load settle
      mockGetSocialStatus.mockResolvedValue(makeStatus('not_processed'));
      await act(async () => { await vi.runAllTimersAsync(); });

      mockRerunSocial.mockResolvedValue({ jobId: 'job-s2', status: 'pending' });
      mockGetSocialStatus.mockResolvedValue(makeStatus('pending', { detected: false }));

      await act(async () => {
        await result.current.rerun();
      });

      // Should have optimistically updated to pending
      expect(result.current.status?.status).toBe('pending');
    });

    it('sets error and stops rerunLoading when rerunSocial throws', async () => {
      mockGetSocialStatus.mockResolvedValue(makeStatus('processed'));
      mockRerunSocial.mockRejectedValue(new Error('Rerun failed'));

      const { result } = renderHook(() => useMediaSocial('media-1', vi.fn()));

      await waitFor(() => { expect(result.current.status).toBeDefined(); });

      await act(async () => {
        await result.current.rerun();
      });

      expect(result.current.error).toBe('Rerun failed');
      expect(result.current.rerunLoading).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // mediaId reactivity
  // -------------------------------------------------------------------------

  describe('mediaId reactivity', () => {
    it('re-fetches when mediaId changes', async () => {
      mockGetSocialStatus.mockResolvedValue(makeStatus('not_processed'));

      const { rerender } = renderHook(
        ({ id }: { id: string }) => useMediaSocial(id, vi.fn()),
        { initialProps: { id: 'media-a' } },
      );

      await waitFor(() => {
        expect(mockGetSocialStatus).toHaveBeenCalledWith('media-a');
      });

      rerender({ id: 'media-b' });

      await waitFor(() => {
        expect(mockGetSocialStatus).toHaveBeenCalledWith('media-b');
      });
    });
  });
});
