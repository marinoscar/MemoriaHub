import { useState, useCallback } from 'react';
import type {
  MediaItem,
  MediaKeysetMeta,
  MediaQueryParams,
  PatchMediaDto,
} from '../types.js';
import {
  listMedia as listMediaApi,
  patchMedia as patchMediaApi,
  deleteMedia as deleteMediaApi,
} from '../services/media.js';
import { useIsMounted } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Filter state shape — all optional so callers can compose them incrementally
// ---------------------------------------------------------------------------

/**
 * Media Filters.
 *
 * @stability experimental
 */
export interface MediaFilters {
  type?: MediaQueryParams['type'];
  favorite?: boolean;
  tag?: string;
  country?: string;
  region?: string;
  locality?: string;
  location?: string;
  capturedAtFrom?: string;
  capturedAtTo?: string;
  sortBy?: MediaQueryParams['sortBy'];
  sortOrder?: MediaQueryParams['sortOrder'];
  page?: number;
  circleId?: string;
}

/**
 * Hook: Media Result.
 *
 * @stability experimental
 */
export interface UseMediaResult {
  items: MediaItem[];
  meta: MediaKeysetMeta | null;
  isLoading: boolean;
  error: string | null;
  filters: MediaFilters;
  /** The `setFilters` function. */
  setFilters: (filters: MediaFilters) => void;
  /** Fetches media and returns the loaded items for callers that need them synchronously. */
  fetchMedia: (params?: MediaQueryParams) => Promise<MediaItem[]>;
  /** The `patchMedia` function. */
  patchMedia: (id: string, dto: PatchMediaDto) => Promise<void>;
  /** The `removeMedia` function. */
  removeMedia: (id: string) => Promise<void>;
  /** The `updateItemLocally` function. */
  updateItemLocally: (id: string, patch: Partial<MediaItem>) => void;
}

/**
 * Hook: Media.
 *
 * @stability experimental
 */
export function useMedia(): UseMediaResult {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [meta, setMeta] = useState<MediaKeysetMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<MediaFilters>({
    sortBy: 'capturedAt',
    sortOrder: 'desc',
    page: 1,
  });
  const isMounted = useIsMounted();

  const setFilters = useCallback((newFilters: MediaFilters) => {
    setFiltersState(newFilters);
  }, []);

  const fetchMedia = useCallback(async (params?: MediaQueryParams): Promise<MediaItem[]> => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listMediaApi(params);
      if (isMounted()) {
        setItems(response.items);
        setMeta(response.meta);
      }
      return response.items;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch media';
      if (isMounted()) {
        setError(message);
        setItems([]);
      }
      return [];
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const patchMedia = useCallback(async (id: string, dto: PatchMediaDto) => {
    setError(null);
    try {
      const updated = await patchMediaApi(id, dto);
      if (isMounted()) setItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update media item';
      if (isMounted()) setError(message);
      throw err;
    }
  }, [isMounted]);

  const removeMedia = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteMediaApi(id);
      if (isMounted()) setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete media item';
      if (isMounted()) setError(message);
      throw err;
    }
  }, [isMounted]);

  /** Apply a partial patch to an item in local state without an API call. */
  const updateItemLocally = useCallback((id: string, patch: Partial<MediaItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  return {
    items,
    meta,
    isLoading,
    error,
    filters,
    setFilters,
    fetchMedia,
    patchMedia,
    removeMedia,
    updateItemLocally,
  };
}
