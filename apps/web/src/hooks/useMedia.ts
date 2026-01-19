import { useState, useCallback, useEffect, useRef } from 'react';
import type { MediaAssetDTO } from '@memoriahub/shared';
import { mediaApi, type ListMediaParams } from '../services/api';

/**
 * State for the media hook
 */
interface UseMediaState {
  media: MediaAssetDTO[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Options for the media hook
 */
export interface UseMediaOptions {
  libraryId: string | undefined;
  status?: string;
  mediaType?: 'image' | 'video';
  sortBy?: 'capturedAt' | 'createdAt' | 'filename' | 'fileSize';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
}

const DEFAULT_LIMIT = 24;

/**
 * Hook for fetching and managing media assets in a library
 *
 * Note: By default, no status filter is applied so all uploaded assets
 * are visible. This ensures assets show up even before the worker has
 * processed them (e.g., METADATA_EXTRACTED status).
 */
export function useMedia(options: UseMediaOptions) {
  const {
    libraryId,
    status,
    mediaType,
    sortBy = 'capturedAt',
    sortOrder = 'desc',
    limit = DEFAULT_LIMIT,
  } = options;

  const [state, setState] = useState<UseMediaState>({
    media: [],
    isLoading: false,
    isLoadingMore: false,
    error: null,
    total: 0,
    page: 1,
    limit,
    hasMore: false,
  });

  // Store current filters in ref for comparison
  const filtersRef = useRef({ libraryId, status, mediaType, sortBy, sortOrder, limit });
  const initialFetchDone = useRef(false);

  /**
   * Fetch media with given parameters
   */
  const fetchMedia = useCallback(async (
    id: string,
    params: ListMediaParams,
    append: boolean = false
  ) => {
    setState((prev) => ({
      ...prev,
      isLoading: !append,
      isLoadingMore: append,
      error: null,
    }));

    try {
      const result = await mediaApi.listMedia(id, params);
      const newMedia = result.data;
      const total = result.meta.total ?? 0;
      const page = result.meta.page ?? 1;
      const pageLimit = result.meta.limit ?? limit;

      setState((prev) => ({
        media: append ? [...prev.media, ...newMedia] : newMedia,
        isLoading: false,
        isLoadingMore: false,
        error: null,
        total,
        page,
        limit: pageLimit,
        hasMore: page * pageLimit < total,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isLoadingMore: false,
        error: error instanceof Error ? error.message : 'Failed to fetch media',
      }));
    }
  }, [limit]);

  /**
   * Load more media (pagination)
   */
  const loadMore = useCallback(async () => {
    if (!libraryId || state.isLoading || state.isLoadingMore || !state.hasMore) {
      return;
    }

    const nextPage = state.page + 1;
    await fetchMedia(libraryId, {
      page: nextPage,
      limit: state.limit,
      status,
      mediaType,
      sortBy,
      sortOrder,
    }, true);
  }, [libraryId, state.isLoading, state.isLoadingMore, state.hasMore, state.page, state.limit, status, mediaType, sortBy, sortOrder, fetchMedia]);

  /**
   * Refresh media from the beginning
   */
  const refresh = useCallback(() => {
    if (!libraryId) {
      return Promise.resolve();
    }

    return fetchMedia(libraryId, {
      page: 1,
      limit,
      status,
      mediaType,
      sortBy,
      sortOrder,
    });
  }, [libraryId, limit, status, mediaType, sortBy, sortOrder, fetchMedia]);

  // Fetch when libraryId or filters change
  useEffect(() => {
    if (!libraryId) {
      setState({
        media: [],
        isLoading: false,
        isLoadingMore: false,
        error: null,
        total: 0,
        page: 1,
        limit,
        hasMore: false,
      });
      initialFetchDone.current = false;
      return;
    }

    const currentFilters = { libraryId, status, mediaType, sortBy, sortOrder, limit };
    const filtersChanged = JSON.stringify(currentFilters) !== JSON.stringify(filtersRef.current);

    if (filtersChanged) {
      filtersRef.current = currentFilters;
      initialFetchDone.current = false;
    }

    if (!initialFetchDone.current) {
      initialFetchDone.current = true;
      void fetchMedia(libraryId, {
        page: 1,
        limit,
        status,
        mediaType,
        sortBy,
        sortOrder,
      });
    }
  }, [libraryId, status, mediaType, sortBy, sortOrder, limit, fetchMedia]);

  return {
    ...state,
    loadMore,
    refresh,
  };
}
