import { useState, useCallback, useEffect, useRef } from 'react';
import type { LibraryDTO } from '@memoriahub/shared';
import { libraryApi } from '../services/api';

/**
 * State for the single library hook
 */
interface UseLibraryState {
  library: LibraryDTO | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for fetching and managing a single library
 */
export function useLibrary(libraryId: string | undefined) {
  const [state, setState] = useState<UseLibraryState>({
    library: null,
    isLoading: false,
    error: null,
  });

  // Track if initial fetch has been done
  const initialFetchDone = useRef(false);
  const currentLibraryId = useRef(libraryId);

  /**
   * Fetch library by ID
   */
  const fetchLibrary = useCallback(async (id: string) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const library = await libraryApi.getLibrary(id);
      setState({
        library,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        library: null,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch library',
      }));
    }
  }, []);

  /**
   * Refresh the library data
   */
  const refresh = useCallback(() => {
    if (libraryId) {
      return fetchLibrary(libraryId);
    }
    return Promise.resolve();
  }, [libraryId, fetchLibrary]);

  // Fetch on mount or when libraryId changes
  useEffect(() => {
    if (!libraryId) {
      setState({ library: null, isLoading: false, error: null });
      return;
    }

    // Reset and refetch if libraryId changed
    if (currentLibraryId.current !== libraryId) {
      initialFetchDone.current = false;
      currentLibraryId.current = libraryId;
    }

    if (!initialFetchDone.current) {
      initialFetchDone.current = true;
      void fetchLibrary(libraryId);
    }
  }, [libraryId, fetchLibrary]);

  return {
    ...state,
    refresh,
  };
}
