import { useState, useCallback, useEffect, useRef } from 'react';
import type { LibraryDTO, CreateLibraryInput, UpdateLibraryInput } from '@memoriahub/shared';
import { libraryApi, type ListLibrariesParams } from '../services/api';

/**
 * State for the libraries hook
 */
interface UseLibrariesState {
  libraries: LibraryDTO[];
  isLoading: boolean;
  error: string | null;
  total: number;
  page: number;
  limit: number;
}

/**
 * Hook for managing libraries
 */
export function useLibraries(params: ListLibrariesParams = {}) {
  const [state, setState] = useState<UseLibrariesState>({
    libraries: [],
    isLoading: false,
    error: null,
    total: 0,
    page: params.page || 1,
    limit: params.limit || 20,
  });

  // Use a ref to hold the latest params without causing re-renders
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Track if initial fetch has been done
  const initialFetchDone = useRef(false);

  /**
   * Fetch libraries
   */
  const fetchLibraries = useCallback(async (fetchParams: ListLibrariesParams = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const result = await libraryApi.listLibraries({
        ...paramsRef.current,
        ...fetchParams,
      });

      setState({
        libraries: result.data,
        isLoading: false,
        error: null,
        total: result.meta.total ?? 0,
        page: result.meta.page ?? 1,
        limit: result.meta.limit ?? 20,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch libraries',
      }));
    }
  }, []);

  /**
   * Create a new library
   */
  const createLibrary = useCallback(async (input: CreateLibraryInput): Promise<LibraryDTO> => {
    const library = await libraryApi.createLibrary(input);
    // Add to the list
    setState((prev) => ({
      ...prev,
      libraries: [library, ...prev.libraries],
      total: prev.total + 1,
    }));
    return library;
  }, []);

  /**
   * Update a library
   */
  const updateLibrary = useCallback(async (id: string, input: UpdateLibraryInput): Promise<LibraryDTO> => {
    const library = await libraryApi.updateLibrary(id, input);
    // Update in the list
    setState((prev) => ({
      ...prev,
      libraries: prev.libraries.map((lib) => (lib.id === id ? library : lib)),
    }));
    return library;
  }, []);

  /**
   * Delete a library
   */
  const deleteLibrary = useCallback(async (id: string): Promise<void> => {
    await libraryApi.deleteLibrary(id);
    // Remove from the list
    setState((prev) => ({
      ...prev,
      libraries: prev.libraries.filter((lib) => lib.id !== id),
      total: prev.total - 1,
    }));
  }, []);

  /**
   * Refresh the list
   */
  const refresh = useCallback(() => {
    return fetchLibraries();
  }, [fetchLibraries]);

  // Fetch on mount only (empty dependency array)
  useEffect(() => {
    if (!initialFetchDone.current) {
      initialFetchDone.current = true;
      void fetchLibraries();
    }
  }, [fetchLibraries]);

  return {
    ...state,
    fetchLibraries,
    createLibrary,
    updateLibrary,
    deleteLibrary,
    refresh,
  };
}
