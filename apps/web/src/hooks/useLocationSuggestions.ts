import { useState, useCallback, useEffect, useRef } from 'react';
import {
  listLocationSuggestions,
  acceptLocationSuggestion,
  rejectLocationSuggestion,
  revertLocationSuggestion,
  inferLocation,
} from '../services/locationSuggestions';
import type {
  LocationSuggestionStatus,
  LocationSuggestionSortBy,
  LocationSuggestionSummary,
  LocationSuggestionListMeta,
  AcceptLocationSuggestionResult,
  RejectRevertResult,
} from '../services/locationSuggestions';
import type { SortOrder } from '../types/media';
import { getMedia } from '../services/media';
import { useIsMounted } from './useIsMounted';

/**
 * Params accepted by {@link useLocationSuggestions}'s `fetchSuggestions`.
 * Named (rather than inlined twice) so the hook's public signature and the
 * internal `useCallback` implementation cannot drift apart.
 */
export interface FetchLocationSuggestionsParams {
  circleId: string;
  status?: LocationSuggestionStatus;
  page?: number;
  sortBy?: LocationSuggestionSortBy;
  sortOrder?: SortOrder;
}

interface UseLocationSuggestionsResult {
  items: LocationSuggestionSummary[];
  meta: LocationSuggestionListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchSuggestions: (params: FetchLocationSuggestionsParams) => Promise<void>;
  accept: (id: string, lat?: number, lng?: number) => Promise<AcceptLocationSuggestionResult>;
  reject: (id: string) => Promise<RejectRevertResult>;
  revert: (id: string) => Promise<RejectRevertResult>;
  actingIds: Set<string>;
}

export function useLocationSuggestions(): UseLocationSuggestionsResult {
  const [items, setItems] = useState<LocationSuggestionSummary[]>([]);
  const [meta, setMeta] = useState<LocationSuggestionListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());
  const isMounted = useIsMounted();

  const fetchSuggestions = useCallback(
    async (params: FetchLocationSuggestionsParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await listLocationSuggestions(params);
        if (!isMounted()) return;
        setItems(result.items);
        setMeta(result.meta);
      } catch (err) {
        if (!isMounted()) return;
        setError(err instanceof Error ? err.message : 'Failed to load location suggestions');
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const withActing = useCallback(async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    setActingIds((prev) => new Set(prev).add(id));
    try {
      return await fn();
    } finally {
      if (isMounted()) {
        setActingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [isMounted]);

  const accept = useCallback(
    (id: string, lat?: number, lng?: number) => withActing(id, () => acceptLocationSuggestion(id, lat, lng)),
    [withActing],
  );

  const reject = useCallback((id: string) => withActing(id, () => rejectLocationSuggestion(id)), [withActing]);

  const revert = useCallback((id: string) => withActing(id, () => revertLocationSuggestion(id)), [withActing]);

  return {
    items,
    meta,
    isLoading,
    error,
    fetchSuggestions,
    accept,
    reject,
    revert,
    actingIds,
  };
}

// ---------------------------------------------------------------------------
// useSuggestLocation — per-item "Suggest location" affordance for the media
// detail drawer. There is no dedicated per-item status endpoint for location
// inference (unlike metadata/tags), so this polls GET /media/:id and treats a
// newly-populated takenLat as the auto-applied outcome. A suggestion-only
// outcome writes no coordinates, so it cannot be detected by polling the
// media item alone — the caller is told to check the review queue instead.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 10;

export type SuggestLocationOutcome = 'auto_applied' | 'queued' | 'error';

export function useSuggestLocation(mediaId: string, onRefresh: () => void) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const isMounted = useIsMounted();

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const suggest = useCallback(
    async (onOutcome: (outcome: SuggestLocationOutcome) => void) => {
      if (!mediaId) return;
      setLoading(true);
      setError(null);
      stopPolling();
      try {
        await inferLocation(mediaId);
        if (!isMounted()) return;

        pollCountRef.current = 0;
        pollRef.current = setInterval(() => {
          pollCountRef.current += 1;
          getMedia(mediaId)
            .then((item) => {
              if (!isMounted()) {
                stopPolling();
                return;
              }
              if (item.takenLat !== null && item.takenLng !== null) {
                stopPolling();
                setLoading(false);
                onRefresh();
                onOutcome('auto_applied');
                return;
              }
              if (pollCountRef.current >= MAX_POLLS) {
                stopPolling();
                setLoading(false);
                onOutcome('queued');
              }
            })
            .catch(() => {
              stopPolling();
              if (!isMounted()) return;
              setLoading(false);
              onOutcome('error');
            });
        }, POLL_INTERVAL_MS);
      } catch (err) {
        if (!isMounted()) return;
        setError(err instanceof Error ? err.message : 'Failed to queue location inference');
        setLoading(false);
        onOutcome('error');
      }
    },
    [mediaId, onRefresh, stopPolling, isMounted],
  );

  return { suggest, loading, error };
}

// ---------------------------------------------------------------------------
// useItemLocationCandidate — resolves the PENDING LocationSuggestion for one
// item so a location picker can OPEN framed on the inferred candidate rather
// than a world view. Read-only: it never accepts the suggestion, it only
// borrows its coordinates as a map-framing hint. Uses the same `mediaItemId`
// query param as useItemAutoAppliedSuggestion below (an exact, server-side
// lookup — no client-side scanning), just with status='pending'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// useItemAutoAppliedSuggestion — resolves the LocationSuggestion row backing
// an item whose coordSource === 'inferred', so the drawer's Revert action can
// call POST /location-suggestions/:id/revert (the id there is the SUGGESTION
// id, not the media item id). Uses the `mediaItemId` query param on
// GET /media/location-suggestions for an exact, server-side lookup — no
// client-side scanning of a bounded page of results.
// ---------------------------------------------------------------------------

export function useItemLocationCandidate(circleId: string, mediaItemId: string, enabled: boolean) {
  const [candidate, setCandidate] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !circleId || !mediaItemId) {
      setCandidate(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listLocationSuggestions({ circleId, mediaItemId, status: 'pending', page: 1, pageSize: 1 })
      .then((result) => {
        if (cancelled) return;
        const suggestion = result.items[0];
        setCandidate(suggestion ? { lat: suggestion.lat, lng: suggestion.lng } : null);
      })
      .catch(() => {
        // A missing candidate is not an error — the caller just falls through
        // to the next rung of its framing ladder.
        if (!cancelled) setCandidate(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [circleId, mediaItemId, enabled]);

  return { candidate, loading };
}

export function useItemAutoAppliedSuggestion(circleId: string, mediaItemId: string, enabled: boolean) {
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !circleId || !mediaItemId) {
      setSuggestionId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listLocationSuggestions({ circleId, mediaItemId, status: 'auto_applied', page: 1, pageSize: 1 })
      .then((result) => {
        if (cancelled) return;
        setSuggestionId(result.items[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setSuggestionId(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [circleId, mediaItemId, enabled]);

  return { suggestionId, loading };
}
