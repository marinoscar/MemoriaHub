/**
 * Unit tests for useLocationSuggestions, useSuggestLocation, and
 * useItemAutoAppliedSuggestion hooks.
 *
 * Covers:
 *  useLocationSuggestions:
 *   - Initial state (empty items, null meta, not loading, no error, empty actingIds, bulkAccepting=false)
 *   - fetchSuggestions: loading -> success (calls listLocationSuggestions with params, populates items/meta)
 *   - fetchSuggestions: error handling (Error instance and non-Error throw fallback message)
 *   - accept/reject/revert: route through the acting-ids Set (added before call, removed in finally)
 *   - accept/reject/revert: error path rethrows and still clears the acting id
 *   - bulkAccept: toggles bulkAccepting true/false around the call; error path rethrows and resets flag
 *
 *  useSuggestLocation:
 *   - suggest() calls inferLocation(mediaId) then polls getMedia every 2s
 *   - auto_applied: stops polling, calls onRefresh() and onOutcome('auto_applied') once coords appear
 *   - queued: onOutcome('queued') after MAX_POLLS (10) polls with no coords
 *   - error (getMedia rejects): stops polling, onOutcome('error')
 *   - error (inferLocation rejects): sets error, onOutcome('error'), no polling ever starts
 *
 *  useItemAutoAppliedSuggestion:
 *   - enabled + both ids present: calls listLocationSuggestions with status='auto_applied', page=1, pageSize=1
 *   - resolves suggestionId to items[0].id, or null when no items returned
 *   - disabled or missing id: clears suggestionId without calling the service
 *   - stale-response guard: an in-flight fetch from a previous render does not clobber state after deps change
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useLocationSuggestions,
  useSuggestLocation,
  useItemAutoAppliedSuggestion,
} from '../../hooks/useLocationSuggestions';

// ---------------------------------------------------------------------------
// Mock the locationSuggestions service module
// ---------------------------------------------------------------------------

vi.mock('../../services/locationSuggestions', () => ({
  listLocationSuggestions: vi.fn(),
  acceptLocationSuggestion: vi.fn(),
  rejectLocationSuggestion: vi.fn(),
  revertLocationSuggestion: vi.fn(),
  bulkAcceptLocationSuggestions: vi.fn(),
  inferLocation: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  getMedia: vi.fn(),
}));

import {
  listLocationSuggestions,
  acceptLocationSuggestion,
  rejectLocationSuggestion,
  revertLocationSuggestion,
  bulkAcceptLocationSuggestions,
  inferLocation,
} from '../../services/locationSuggestions';
import { getMedia } from '../../services/media';
import type {
  LocationSuggestionSummary,
  LocationSuggestionListResponse,
} from '../../services/locationSuggestions';
import type { MediaItem } from '../../types/media';

const mockListLocationSuggestions = vi.mocked(listLocationSuggestions);
const mockAcceptLocationSuggestion = vi.mocked(acceptLocationSuggestion);
const mockRejectLocationSuggestion = vi.mocked(rejectLocationSuggestion);
const mockRevertLocationSuggestion = vi.mocked(revertLocationSuggestion);
const mockBulkAcceptLocationSuggestions = vi.mocked(bulkAcceptLocationSuggestions);
const mockInferLocation = vi.mocked(inferLocation);
const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(id = 'suggestion-1'): LocationSuggestionSummary {
  return {
    id,
    mediaItemId: 'media-1',
    status: 'pending',
    lat: 9.9281,
    lng: -84.0907,
    confidence: 0.85,
    method: 'interpolated',
    anchorBeforeId: 'media-before',
    anchorAfterId: 'media-after',
    gapBeforeSeconds: 300,
    gapAfterSeconds: 400,
    anchorDistanceKm: 0.5,
    impliedSpeedKmh: 10,
    capturedAt: '2026-06-15T14:32:00.000Z',
    cameraMake: 'Apple',
    cameraModel: 'iPhone 14',
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
  };
}

function makeListResponse(
  items: LocationSuggestionSummary[] = [makeSummary()],
): LocationSuggestionListResponse {
  return {
    items,
    meta: { total: items.length, page: 1, pageSize: 20 },
  };
}

function makeMediaItemPartial(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    takenLat: null,
    takenLng: null,
    ...overrides,
  } as MediaItem;
}

// ---------------------------------------------------------------------------
// useLocationSuggestions
// ---------------------------------------------------------------------------

describe('useLocationSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts with empty items, null meta, not loading, no error, empty actingIds, bulkAccepting=false', () => {
      const { result } = renderHook(() => useLocationSuggestions());

      expect(result.current.items).toEqual([]);
      expect(result.current.meta).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.actingIds.size).toBe(0);
      expect(result.current.bulkAccepting).toBe(false);
    });
  });

  describe('fetchSuggestions — success', () => {
    it('calls listLocationSuggestions with the given params', async () => {
      mockListLocationSuggestions.mockResolvedValue(makeListResponse());

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1', status: 'pending', page: 2 });
      });

      expect(mockListLocationSuggestions).toHaveBeenCalledWith({
        circleId: 'circle-1',
        status: 'pending',
        page: 2,
      });
    });

    it('populates items and meta after a successful fetch', async () => {
      const response = makeListResponse([makeSummary('s-1'), makeSummary('s-2')]);
      mockListLocationSuggestions.mockResolvedValue(response);

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1' });
      });

      expect(result.current.items).toEqual(response.items);
      expect(result.current.meta).toEqual(response.meta);
    });

    it('sets isLoading=true while fetching and false after resolution', async () => {
      let resolveFn!: (v: LocationSuggestionListResponse) => void;
      const promise = new Promise<LocationSuggestionListResponse>((res) => {
        resolveFn = res;
      });
      mockListLocationSuggestions.mockReturnValue(promise);

      const { result } = renderHook(() => useLocationSuggestions());

      let fetchPromise!: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchSuggestions({ circleId: 'circle-1' });
      });

      await waitFor(() => expect(result.current.isLoading).toBe(true));

      await act(async () => {
        resolveFn(makeListResponse());
        await fetchPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('clears a previous error on a new successful fetch', async () => {
      mockListLocationSuggestions.mockRejectedValueOnce(new Error('boom'));
      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1' });
      });
      expect(result.current.error).toBe('boom');

      mockListLocationSuggestions.mockResolvedValueOnce(makeListResponse());
      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1' });
      });
      expect(result.current.error).toBeNull();
    });
  });

  describe('fetchSuggestions — error handling', () => {
    it('sets error message when listLocationSuggestions rejects with an Error', async () => {
      mockListLocationSuggestions.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1' });
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.isLoading).toBe(false);
    });

    it('sets a fallback error message when a non-Error is thrown', async () => {
      mockListLocationSuggestions.mockRejectedValue('plain string');

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1' });
      });

      expect(result.current.error).toBe('Failed to load location suggestions');
    });

    it('leaves items empty when the fetch fails', async () => {
      mockListLocationSuggestions.mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.fetchSuggestions({ circleId: 'circle-1' });
      });

      expect(result.current.items).toEqual([]);
    });
  });

  describe('accept', () => {
    it('calls acceptLocationSuggestion with (id, lat, lng)', async () => {
      mockAcceptLocationSuggestion.mockResolvedValue({
        id: 'suggestion-1',
        status: 'accepted',
        lat: 1,
        lng: 2,
        coordSource: 'manual',
      });

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.accept('suggestion-1', 1, 2);
      });

      expect(mockAcceptLocationSuggestion).toHaveBeenCalledWith('suggestion-1', 1, 2);
    });

    it('calls acceptLocationSuggestion with only the id when lat/lng are omitted', async () => {
      mockAcceptLocationSuggestion.mockResolvedValue({
        id: 'suggestion-1',
        status: 'accepted',
        lat: 9.9281,
        lng: -84.0907,
        coordSource: 'inferred',
      });

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.accept('suggestion-1');
      });

      expect(mockAcceptLocationSuggestion).toHaveBeenCalledWith('suggestion-1', undefined, undefined);
    });

    it('adds the id to actingIds during the call and removes it after resolution', async () => {
      let resolveFn!: (v: {
        id: string;
        status: string;
        lat: number;
        lng: number;
        coordSource: string;
      }) => void;
      const promise = new Promise<{ id: string; status: string; lat: number; lng: number; coordSource: string }>(
        (res) => {
          resolveFn = res;
        },
      );
      mockAcceptLocationSuggestion.mockReturnValue(promise);

      const { result } = renderHook(() => useLocationSuggestions());

      let callPromise!: Promise<unknown>;
      act(() => {
        callPromise = result.current.accept('suggestion-1');
      });

      await waitFor(() => expect(result.current.actingIds.has('suggestion-1')).toBe(true));

      await act(async () => {
        resolveFn({ id: 'suggestion-1', status: 'accepted', lat: 1, lng: 2, coordSource: 'manual' });
        await callPromise;
      });

      expect(result.current.actingIds.has('suggestion-1')).toBe(false);
    });

    it('removes the id from actingIds and rethrows when acceptLocationSuggestion rejects', async () => {
      mockAcceptLocationSuggestion.mockRejectedValue(new Error('Accept failed'));

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await expect(result.current.accept('suggestion-1')).rejects.toThrow('Accept failed');
      });

      expect(result.current.actingIds.has('suggestion-1')).toBe(false);
    });
  });

  describe('reject', () => {
    it('calls rejectLocationSuggestion with the id', async () => {
      mockRejectLocationSuggestion.mockResolvedValue({ id: 'suggestion-1', status: 'rejected' });

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.reject('suggestion-1');
      });

      expect(mockRejectLocationSuggestion).toHaveBeenCalledWith('suggestion-1');
    });

    it('rethrows and clears actingIds when rejectLocationSuggestion rejects', async () => {
      mockRejectLocationSuggestion.mockRejectedValue(new Error('Reject failed'));

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await expect(result.current.reject('suggestion-1')).rejects.toThrow('Reject failed');
      });

      expect(result.current.actingIds.has('suggestion-1')).toBe(false);
    });
  });

  describe('revert', () => {
    it('calls revertLocationSuggestion with the id', async () => {
      mockRevertLocationSuggestion.mockResolvedValue({ id: 'suggestion-1', status: 'reverted' });

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.revert('suggestion-1');
      });

      expect(mockRevertLocationSuggestion).toHaveBeenCalledWith('suggestion-1');
    });

    it('two concurrent acting calls each track their own id independently', async () => {
      let resolveA!: (v: { id: string; status: string }) => void;
      let resolveB!: (v: { id: string; status: string }) => void;
      mockRejectLocationSuggestion.mockReturnValue(
        new Promise((res) => {
          resolveA = res;
        }),
      );
      mockRevertLocationSuggestion.mockReturnValue(
        new Promise((res) => {
          resolveB = res;
        }),
      );

      const { result } = renderHook(() => useLocationSuggestions());

      let p1!: Promise<unknown>;
      let p2!: Promise<unknown>;
      act(() => {
        p1 = result.current.reject('suggestion-a');
        p2 = result.current.revert('suggestion-b');
      });

      await waitFor(() => {
        expect(result.current.actingIds.has('suggestion-a')).toBe(true);
        expect(result.current.actingIds.has('suggestion-b')).toBe(true);
      });

      await act(async () => {
        resolveA({ id: 'suggestion-a', status: 'rejected' });
        await p1;
      });

      // Only suggestion-a should be cleared; suggestion-b is still in-flight.
      expect(result.current.actingIds.has('suggestion-a')).toBe(false);
      expect(result.current.actingIds.has('suggestion-b')).toBe(true);

      await act(async () => {
        resolveB({ id: 'suggestion-b', status: 'reverted' });
        await p2;
      });

      expect(result.current.actingIds.has('suggestion-b')).toBe(false);
    });
  });

  describe('bulkAccept', () => {
    it('calls bulkAcceptLocationSuggestions with (circleId, minConfidence)', async () => {
      mockBulkAcceptLocationSuggestions.mockResolvedValue({ accepted: 5 });

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await result.current.bulkAccept('circle-1', 0.8);
      });

      expect(mockBulkAcceptLocationSuggestions).toHaveBeenCalledWith('circle-1', 0.8);
    });

    it('returns the result to the caller', async () => {
      mockBulkAcceptLocationSuggestions.mockResolvedValue({ accepted: 3 });

      const { result } = renderHook(() => useLocationSuggestions());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.bulkAccept('circle-1', 0.8);
      });

      expect(returned).toEqual({ accepted: 3 });
    });

    it('sets bulkAccepting=true during the call and false after resolution', async () => {
      let resolveFn!: (v: { accepted: number }) => void;
      const promise = new Promise<{ accepted: number }>((res) => {
        resolveFn = res;
      });
      mockBulkAcceptLocationSuggestions.mockReturnValue(promise);

      const { result } = renderHook(() => useLocationSuggestions());

      let callPromise!: Promise<unknown>;
      act(() => {
        callPromise = result.current.bulkAccept('circle-1', 0.8);
      });

      await waitFor(() => expect(result.current.bulkAccepting).toBe(true));

      await act(async () => {
        resolveFn({ accepted: 5 });
        await callPromise;
      });

      expect(result.current.bulkAccepting).toBe(false);
    });

    it('resets bulkAccepting=false and rethrows when bulkAcceptLocationSuggestions rejects', async () => {
      mockBulkAcceptLocationSuggestions.mockRejectedValue(new Error('Bulk accept failed'));

      const { result } = renderHook(() => useLocationSuggestions());

      await act(async () => {
        await expect(result.current.bulkAccept('circle-1', 0.8)).rejects.toThrow('Bulk accept failed');
      });

      expect(result.current.bulkAccepting).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// useSuggestLocation
// ---------------------------------------------------------------------------

describe('useSuggestLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts with loading=false and error=null', () => {
      const onRefresh = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('suggest — success path with polling', () => {
    it('calls inferLocation(mediaId) when suggest is invoked', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockInferLocation.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockGetMedia.mockResolvedValue(makeMediaItemPartial());

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      expect(mockInferLocation).toHaveBeenCalledWith('media-1');
    });

    it('sets loading=true immediately after calling suggest', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockInferLocation.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockGetMedia.mockReturnValue(new Promise(() => {})); // never resolves — poll hangs

      const onRefresh = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      act(() => {
        void result.current.suggest(vi.fn());
      });

      await waitFor(() => expect(result.current.loading).toBe(true));
    });

    it('resolves auto_applied when getMedia returns non-null coords on a poll tick', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockInferLocation.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockGetMedia.mockResolvedValue(makeMediaItemPartial({ takenLat: 9.9281, takenLng: -84.0907 }));

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      // Advance one poll tick (2000ms)
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(onOutcome).toHaveBeenCalledWith('auto_applied');
      });
      expect(onRefresh).toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
    });

    it('does not resolve auto_applied when only one of takenLat/takenLng is set', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockInferLocation.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockGetMedia.mockResolvedValue(makeMediaItemPartial({ takenLat: 9.9281, takenLng: null }));

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(onOutcome).not.toHaveBeenCalled();
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('resolves queued after MAX_POLLS (10) polls with no coordinates ever appearing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockInferLocation.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockGetMedia.mockResolvedValue(makeMediaItemPartial({ takenLat: null, takenLng: null }));

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      // Advance through all 10 poll ticks (2000ms each = 20000ms)
      await act(async () => {
        vi.advanceTimersByTime(20000);
      });

      await waitFor(() => {
        expect(onOutcome).toHaveBeenCalledWith('queued');
      });
      expect(onOutcome).toHaveBeenCalledTimes(1);
      expect(onRefresh).not.toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
    });

    it('resolves error when getMedia rejects during polling', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockInferLocation.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockGetMedia.mockRejectedValue(new Error('Network error'));

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(onOutcome).toHaveBeenCalledWith('error');
      });
      expect(result.current.loading).toBe(false);
    });
  });

  describe('suggest — inferLocation rejects', () => {
    it('sets error, calls onOutcome("error"), and never starts polling', async () => {
      mockInferLocation.mockRejectedValue(new Error('Failed to queue'));

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      expect(result.current.error).toBe('Failed to queue');
      expect(onOutcome).toHaveBeenCalledWith('error');
      expect(result.current.loading).toBe(false);
      // getMedia should never have been called since inferLocation failed before polling started
      expect(mockGetMedia).not.toHaveBeenCalled();
    });

    it('sets a fallback error message for a non-Error rejection', async () => {
      mockInferLocation.mockRejectedValue('plain string');

      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('media-1', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      expect(result.current.error).toBe('Failed to queue location inference');
    });
  });

  describe('suggest — no-op guard', () => {
    it('does nothing when mediaId is empty', async () => {
      const onRefresh = vi.fn();
      const onOutcome = vi.fn();
      const { result } = renderHook(() => useSuggestLocation('', onRefresh));

      await act(async () => {
        await result.current.suggest(onOutcome);
      });

      expect(mockInferLocation).not.toHaveBeenCalled();
      expect(onOutcome).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// useItemAutoAppliedSuggestion
// ---------------------------------------------------------------------------

describe('useItemAutoAppliedSuggestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enabled with both ids present', () => {
    it('calls listLocationSuggestions with status=auto_applied, page=1, pageSize=1', async () => {
      mockListLocationSuggestions.mockResolvedValue(makeListResponse([makeSummary('suggestion-9')]));

      const { result } = renderHook(() =>
        useItemAutoAppliedSuggestion('circle-1', 'media-1', true),
      );

      await waitFor(() => {
        expect(mockListLocationSuggestions).toHaveBeenCalledWith({
          circleId: 'circle-1',
          mediaItemId: 'media-1',
          status: 'auto_applied',
          page: 1,
          pageSize: 1,
        });
      });

      await waitFor(() => {
        expect(result.current.suggestionId).toBe('suggestion-9');
      });
    });

    it('sets suggestionId to null when the result has no items', async () => {
      mockListLocationSuggestions.mockResolvedValue(makeListResponse([]));

      const { result } = renderHook(() =>
        useItemAutoAppliedSuggestion('circle-1', 'media-1', true),
      );

      await waitFor(() => {
        expect(result.current.suggestionId).toBeNull();
      });
    });

    it('sets loading=true while the fetch is in flight, then false after resolution', async () => {
      let resolveFn!: (v: LocationSuggestionListResponse) => void;
      const promise = new Promise<LocationSuggestionListResponse>((res) => {
        resolveFn = res;
      });
      mockListLocationSuggestions.mockReturnValue(promise);

      const { result } = renderHook(() =>
        useItemAutoAppliedSuggestion('circle-1', 'media-1', true),
      );

      await waitFor(() => expect(result.current.loading).toBe(true));

      await act(async () => {
        resolveFn(makeListResponse([makeSummary()]));
        await promise;
      });

      await waitFor(() => expect(result.current.loading).toBe(false));
    });

    it('sets suggestionId to null when listLocationSuggestions rejects', async () => {
      mockListLocationSuggestions.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() =>
        useItemAutoAppliedSuggestion('circle-1', 'media-1', true),
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.suggestionId).toBeNull();
    });
  });

  describe('disabled or missing ids', () => {
    it('does not call the service and clears suggestionId when enabled=false', () => {
      const { result } = renderHook(() =>
        useItemAutoAppliedSuggestion('circle-1', 'media-1', false),
      );

      expect(mockListLocationSuggestions).not.toHaveBeenCalled();
      expect(result.current.suggestionId).toBeNull();
    });

    it('does not call the service when circleId is empty', () => {
      const { result } = renderHook(() => useItemAutoAppliedSuggestion('', 'media-1', true));

      expect(mockListLocationSuggestions).not.toHaveBeenCalled();
      expect(result.current.suggestionId).toBeNull();
    });

    it('does not call the service when mediaItemId is empty', () => {
      const { result } = renderHook(() => useItemAutoAppliedSuggestion('circle-1', '', true));

      expect(mockListLocationSuggestions).not.toHaveBeenCalled();
      expect(result.current.suggestionId).toBeNull();
    });
  });

  describe('stale-response guard', () => {
    it('ignores an out-of-order resolve from a previous mediaItemId after deps change', async () => {
      let resolveFirst!: (v: LocationSuggestionListResponse) => void;
      const firstPromise = new Promise<LocationSuggestionListResponse>((res) => {
        resolveFirst = res;
      });

      mockListLocationSuggestions
        .mockReturnValueOnce(firstPromise) // media-a fetch hangs
        .mockResolvedValueOnce(makeListResponse([makeSummary('suggestion-b')])); // media-b resolves immediately

      const { result, rerender } = renderHook(
        ({ mediaItemId }: { mediaItemId: string }) =>
          useItemAutoAppliedSuggestion('circle-1', mediaItemId, true),
        { initialProps: { mediaItemId: 'media-a' } },
      );

      // Switch to media-b before media-a's fetch completes
      rerender({ mediaItemId: 'media-b' });

      await waitFor(() => {
        expect(result.current.suggestionId).toBe('suggestion-b');
      });

      // Now resolve media-a's stale fetch — it must be discarded
      await act(async () => {
        resolveFirst(makeListResponse([makeSummary('suggestion-a')]));
        await Promise.resolve();
      });

      expect(result.current.suggestionId).toBe('suggestion-b');
    });
  });
});
