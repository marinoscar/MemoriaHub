import { useState, useCallback, useEffect, useRef } from 'react';
import {
  listLocationSuggestions,
  acceptLocationSuggestion,
  rejectLocationSuggestion,
  revertLocationSuggestion,
  bulkAcceptLocationSuggestions,
  inferLocation,
} from '../services/locationSuggestions';
import type {
  LocationSuggestionStatus,
  LocationSuggestionSummary,
  LocationSuggestionListMeta,
  AcceptLocationSuggestionResult,
  RejectRevertResult,
  BulkAcceptResult,
} from '../services/locationSuggestions';
import { getMedia } from '../services/media';

interface UseLocationSuggestionsResult {
  items: LocationSuggestionSummary[];
  meta: LocationSuggestionListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchSuggestions: (params: {
    circleId: string;
    status?: LocationSuggestionStatus;
    page?: number;
  }) => Promise<void>;
  accept: (id: string, lat?: number, lng?: number) => Promise<AcceptLocationSuggestionResult>;
  reject: (id: string) => Promise<RejectRevertResult>;
  bulkAccept: (circleId: string, minConfidence: number) => Promise<BulkAcceptResult>;
  actingIds: Set<string>;
  bulkAccepting: boolean;
}

export function useLocationSuggestions(): UseLocationSuggestionsResult {
  const [items, setItems] = useState<LocationSuggestionSummary[]>([]);
  const [meta, setMeta] = useState<LocationSuggestionListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());
  const [bulkAccepting, setBulkAccepting] = useState(false);

  const fetchSuggestions = useCallback(
    async (params: { circleId: string; status?: LocationSuggestionStatus; page?: number }) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await listLocationSuggestions(params);
        setItems(result.items);
        setMeta(result.meta);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load location suggestions');
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const withActing = useCallback(async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    setActingIds((prev) => new Set(prev).add(id));
    try {
      return await fn();
    } finally {
      setActingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const accept = useCallback(
    (id: string, lat?: number, lng?: number) => withActing(id, () => acceptLocationSuggestion(id, lat, lng)),
    [withActing],
  );

  const reject = useCallback((id: string) => withActing(id, () => rejectLocationSuggestion(id)), [withActing]);

  const bulkAccept = useCallback(async (circleId: string, minConfidence: number) => {
    setBulkAccepting(true);
    try {
      return await bulkAcceptLocationSuggestions(circleId, minConfidence);
    } finally {
      setBulkAccepting(false);
    }
  }, []);

  return { items, meta, isLoading, error, fetchSuggestions, accept, reject, bulkAccept, actingIds, bulkAccepting };
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

        pollCountRef.current = 0;
        pollRef.current = setInterval(() => {
          pollCountRef.current += 1;
          getMedia(mediaId)
            .then((item) => {
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
              setLoading(false);
              onOutcome('error');
            });
        }, POLL_INTERVAL_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to queue location inference');
        setLoading(false);
        onOutcome('error');
      }
    },
    [mediaId, onRefresh, stopPolling],
  );

  return { suggest, loading, error };
}
