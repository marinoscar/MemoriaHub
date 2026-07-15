import { useState, useCallback } from 'react';
import type {
  MediaItem,
  MediaKeysetMeta,
  MediaQueryParams,
  PatchMediaDto,
} from '../types/media';
import {
  listMedia as listMediaApi,
  patchMedia as patchMediaApi,
  deleteMedia as deleteMediaApi,
} from '../services/media';

// ---------------------------------------------------------------------------
// Filter state shape — all optional so callers can compose them incrementally
// ---------------------------------------------------------------------------

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

interface UseMediaResult {
  items: MediaItem[];
  meta: MediaKeysetMeta | null;
  isLoading: boolean;
  error: string | null;
  filters: MediaFilters;
  setFilters: (filters: MediaFilters) => void;
  /** Fetches media and returns the loaded items for callers that need them synchronously. */
  fetchMedia: (params?: MediaQueryParams) => Promise<MediaItem[]>;
  patchMedia: (id: string, dto: PatchMediaDto) => Promise<void>;
  removeMedia: (id: string) => Promise<void>;
  updateItemLocally: (id: string, patch: Partial<MediaItem>) => void;
}

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

  const setFilters = useCallback((newFilters: MediaFilters) => {
    setFiltersState(newFilters);
  }, []);

  const fetchMedia = useCallback(async (params?: MediaQueryParams): Promise<MediaItem[]> => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listMediaApi(params);
      setItems(response.items);
      setMeta(response.meta);
      return response.items;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch media';
      setError(message);
      setItems([]);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  const patchMedia = useCallback(async (id: string, dto: PatchMediaDto) => {
    setError(null);
    try {
      const updated = await patchMediaApi(id, dto);
      setItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update media item';
      setError(message);
      throw err;
    }
  }, []);

  const removeMedia = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteMediaApi(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete media item';
      setError(message);
      throw err;
    }
  }, []);

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
