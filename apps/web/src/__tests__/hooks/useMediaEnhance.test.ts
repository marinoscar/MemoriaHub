/**
 * Unit tests for useMediaEnhance.
 *
 * Drives the enhance -> poll -> review lifecycle. Two real bugs (fixed in the
 * commit set this test targets) are specifically covered:
 *
 *  1. A rejected `start()` (e.g. the API 400s with "Picture enhancement is
 *     disabled") must surface via `error` — before the fix this was
 *     swallowed and the button looked dead.
 *  2. A poll timeout (MAX_POLLS exceeded) or a poll fetch failure must move
 *     `status` to a TERMINAL value ('failed') so the progress spinner
 *     resolves — before the fix `status` stayed 'processing' forever and the
 *     error was unreachable (the drawer only renders `error` in the params
 *     step, which requires a terminal, non-polling status).
 *
 * Poll cadence is 2s, capped at 120 polls (4 min). Fake timers drive this
 * deterministically instead of waiting in real time, mirroring the pattern
 * used for useSuggestLocation in useLocationSuggestions.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMediaEnhance } from '../../hooks/useMediaEnhance';

// ---------------------------------------------------------------------------
// Mock the enhance service module
// ---------------------------------------------------------------------------
vi.mock('../../services/enhance', () => ({
  startEnhance: vi.fn(),
  getEnhancement: vi.fn(),
  getLatestEnhancement: vi.fn(),
  applyEnhancement: vi.fn(),
  discardEnhancement: vi.fn(),
}));

import {
  startEnhance,
  getEnhancement,
  getLatestEnhancement,
  applyEnhancement,
  discardEnhancement,
} from '../../services/enhance';
import type { EnhancementDto, EnhancementStatus } from '../../services/enhance';

const mockStartEnhance = vi.mocked(startEnhance);
const mockGetEnhancement = vi.mocked(getEnhancement);
const mockGetLatestEnhancement = vi.mocked(getLatestEnhancement);
const mockApplyEnhancement = vi.mocked(applyEnhancement);
const mockDiscardEnhancement = vi.mocked(discardEnhancement);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeEnhancementDto(
  status: EnhancementStatus = 'processing',
  overrides: Partial<EnhancementDto> = {},
): EnhancementDto {
  return {
    id: 'enh-1',
    status,
    model: 'gpt-image-1',
    original: null,
    enhanced: null,
    downscaled: false,
    params: null,
    lastError: null,
    ...overrides,
  };
}

describe('useMediaEnhance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts idle with no data or error', () => {
      const { result } = renderHook(() => useMediaEnhance('media-1'));

      expect(result.current.status).toBe('idle');
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.polling).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('start() — rejected start surfaces error (bug fix)', () => {
    it('sets error and returns status to idle when the API 400s on start', async () => {
      mockStartEnhance.mockRejectedValue(new Error('Picture enhancement is disabled'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      expect(result.current.error).toBe('Picture enhancement is disabled');
      // Must land on a non-polling status so the params step (where `error`
      // is rendered) is actually shown — 'processing'/'pending' would hide it.
      expect(result.current.status).toBe('idle');
      expect(result.current.polling).toBe(false);
      expect(mockGetEnhancement).not.toHaveBeenCalled();
    });

    it('falls back to a generic message for a non-Error rejection', async () => {
      mockStartEnhance.mockRejectedValue('plain string failure');

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      expect(result.current.error).toBe('Failed to start enhancement');
      expect(result.current.status).toBe('idle');
    });

    it('clears error and starts polling on a subsequent successful start', async () => {
      mockStartEnhance.mockRejectedValueOnce(new Error('Picture enhancement is disabled'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });
      expect(result.current.error).toBe('Picture enhancement is disabled');

      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValueOnce({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('processing'));

      await act(async () => {
        await result.current.start({});
      });

      expect(result.current.error).toBeNull();
      expect(result.current.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  describe('start() — success path with polling', () => {
    it('starts polling and reflects intermediate processing status', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('processing'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });
      expect(result.current.status).toBe('pending');
      expect(result.current.polling).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('processing');
      });
      expect(mockGetEnhancement).toHaveBeenCalledWith('media-1', 'enh-1');
    });

    it('stops polling once the job reaches "ready"', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('ready'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      expect(result.current.polling).toBe(false);
      expect(result.current.data?.status).toBe('ready');

      // No further calls after stopping.
      const callsAtReady = mockGetEnhancement.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(mockGetEnhancement.mock.calls.length).toBe(callsAtReady);
    });

    it('surfaces lastError and stops polling once the job reaches "failed"', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(
        makeEnhancementDto('failed', { lastError: 'Model call failed' }),
      );

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
      });
      expect(result.current.error).toBe('Model call failed');
      expect(result.current.polling).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('poll timeout — MAX_POLLS exceeded (bug fix)', () => {
    it('moves status to "failed" and sets a timeout error after 120 polls with no terminal status', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('processing'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      // 120 polls * 2000ms = 240000ms (MAX_POLLS ceiling). Use the async
      // variant so each tick's mocked promise resolves (and pollCountRef
      // updates) before the NEXT tick fires — a plain synchronous
      // advanceTimersByTime would fire all 120 setInterval callbacks first
      // and only then flush their .then() microtasks, which races: earlier
      // ticks' `setStatus('processing')` would resolve AFTER the timeout
      // tick's `setStatus('failed')` and clobber it back to 'processing'.
      // That's an artifact of bursting virtual time, not how the real
      // 2s-apart interval behaves, so the async advance is the correct match
      // for this hook's actual runtime behavior.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120 * 2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
      });
      expect(result.current.error).toBe('Timed out waiting for the enhancement to finish.');
      expect(result.current.polling).toBe(false);

      // Polling must actually have stopped — no further getEnhancement calls.
      const callsAtTimeout = mockGetEnhancement.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(mockGetEnhancement.mock.calls.length).toBe(callsAtTimeout);
    });
  });

  // -------------------------------------------------------------------------
  describe('poll fetch failure (bug fix)', () => {
    it('moves status to "failed" and surfaces the error when a poll tick rejects', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
      });
      expect(result.current.error).toBe('Network error');
      expect(result.current.polling).toBe(false);
    });

    it('falls back to a generic message for a non-Error poll rejection', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockRejectedValue('plain string');

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
      });
      expect(result.current.error).toBe('Failed to poll enhancement');
    });
  });

  // -------------------------------------------------------------------------
  describe('resumeLatest()', () => {
    it('resumes an in-flight (processing) enhancement and continues polling', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockGetLatestEnhancement.mockResolvedValue(makeEnhancementDto('processing'));
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('ready'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.resumeLatest();
      });

      expect(result.current.status).toBe('processing');
      expect(result.current.polling).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
    });

    it('surfaces a ready enhancement without polling', async () => {
      mockGetLatestEnhancement.mockResolvedValue(makeEnhancementDto('ready'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.resumeLatest();
      });

      expect(result.current.status).toBe('ready');
      expect(result.current.polling).toBe(false);
      expect(mockGetEnhancement).not.toHaveBeenCalled();
    });

    it('does nothing (stays idle) when there is no latest enhancement', async () => {
      mockGetLatestEnhancement.mockResolvedValue(null);

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.resumeLatest();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.data).toBeNull();
    });

    it('is non-fatal when getLatestEnhancement rejects', async () => {
      mockGetLatestEnhancement.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.resumeLatest();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBeNull();
    });

    it('ignores a terminal "discarded"/"applied"/"expired" latest enhancement', async () => {
      mockGetLatestEnhancement.mockResolvedValue(makeEnhancementDto('discarded'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.resumeLatest();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.data).toBeNull();
    });

    // --- explicit enhancementId (issue #201, AI Enhancements hub) ----------

    it('resolves a NAMED enhancement instead of the latest when given an id', async () => {
      mockGetEnhancement.mockResolvedValue({
        ...makeEnhancementDto('ready'),
        id: 'enh-older',
      });

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.resumeLatest('enh-older');
      });

      expect(mockGetEnhancement).toHaveBeenCalledWith('media-1', 'enh-older');
      // The "latest" lookup must be bypassed entirely, not merely overridden.
      expect(mockGetLatestEnhancement).not.toHaveBeenCalled();
      expect(result.current.status).toBe('ready');
      expect(result.current.data?.id).toBe('enh-older');
    });

    it('applies decisions against the named enhancement', async () => {
      mockGetEnhancement.mockResolvedValue({
        ...makeEnhancementDto('ready'),
        id: 'enh-older',
      });
      mockApplyEnhancement.mockResolvedValue({ id: 'new-item' });

      const { result } = renderHook(() => useMediaEnhance('media-1'));
      await act(async () => {
        await result.current.resumeLatest('enh-older');
      });

      await act(async () => {
        await result.current.apply('keep_both');
      });

      expect(mockApplyEnhancement).toHaveBeenCalledWith('media-1', 'enh-older', 'keep_both');
    });

    it('still resolves the latest when called with no argument', async () => {
      mockGetLatestEnhancement.mockResolvedValue(makeEnhancementDto('ready'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));
      await act(async () => {
        await result.current.resumeLatest();
      });

      expect(mockGetLatestEnhancement).toHaveBeenCalledWith('media-1');
      expect(result.current.status).toBe('ready');
    });
  });

  // -------------------------------------------------------------------------
  describe('apply()', () => {
    it('throws when there is no in-flight enhancement to apply', async () => {
      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await expect(result.current.apply('keep_both')).rejects.toThrow(
        'No enhancement to apply',
      );
      expect(mockApplyEnhancement).not.toHaveBeenCalled();
    });

    it('delegates to applyEnhancement with the current enhancement id', async () => {
      mockGetLatestEnhancement.mockResolvedValue(makeEnhancementDto('ready'));
      mockApplyEnhancement.mockResolvedValue({ status: 'ready', width: 100, height: 100 });

      const { result } = renderHook(() => useMediaEnhance('media-1'));
      await act(async () => {
        await result.current.resumeLatest();
      });

      const res = await result.current.apply('replace');

      expect(mockApplyEnhancement).toHaveBeenCalledWith('media-1', 'enh-1', 'replace');
      expect(res).toEqual({ status: 'ready', width: 100, height: 100 });
    });
  });

  // -------------------------------------------------------------------------
  describe('discard()', () => {
    it('is a no-op when there is no in-flight enhancement', async () => {
      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.discard();
      });

      expect(mockDiscardEnhancement).not.toHaveBeenCalled();
    });

    it('delegates to discardEnhancement with the current enhancement id', async () => {
      mockGetLatestEnhancement.mockResolvedValue(makeEnhancementDto('ready'));
      mockDiscardEnhancement.mockResolvedValue(undefined);

      const { result } = renderHook(() => useMediaEnhance('media-1'));
      await act(async () => {
        await result.current.resumeLatest();
      });

      await act(async () => {
        await result.current.discard();
      });

      expect(mockDiscardEnhancement).toHaveBeenCalledWith('media-1', 'enh-1');
    });
  });

  // -------------------------------------------------------------------------
  describe('reset()', () => {
    it('clears data/error/status back to idle and stops polling', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('processing'));

      const { result } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });
      expect(result.current.polling).toBe(true);

      act(() => {
        result.current.reset();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.polling).toBe(false);

      // Polling must have actually stopped.
      const callsAtReset = mockGetEnhancement.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(mockGetEnhancement.mock.calls.length).toBe(callsAtReset);
    });
  });

  // -------------------------------------------------------------------------
  describe('unmount', () => {
    it('stops polling on unmount without throwing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockStartEnhance.mockResolvedValue({ enhancementId: 'enh-1', jobId: 'job-1', status: 'pending' });
      mockGetEnhancement.mockResolvedValue(makeEnhancementDto('processing'));

      const { result, unmount } = renderHook(() => useMediaEnhance('media-1'));

      await act(async () => {
        await result.current.start({});
      });

      unmount();

      await act(async () => {
        vi.advanceTimersByTime(20000);
      });
      // No assertion beyond "did not throw" — jsdom/vitest would surface an
      // unhandled rejection/console error otherwise.
    });
  });
});
