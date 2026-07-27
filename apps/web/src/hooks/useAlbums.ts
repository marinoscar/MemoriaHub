import { useState, useCallback } from 'react';
import type { Album, MediaListMeta, CreateAlbumDto, AlbumQueryParams, UpdateAlbumDto } from '../types/media';
import {
  listAlbums as listAlbumsApi,
  createAlbum as createAlbumApi,
  updateAlbum as updateAlbumApi,
  deleteAlbum as deleteAlbumApi,
} from '../services/media';
import { useIsMounted } from './useIsMounted';

interface UseAlbumsResult {
  albums: Album[];
  meta: MediaListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchAlbums: (params?: AlbumQueryParams) => Promise<void>;
  addAlbum: (dto: CreateAlbumDto) => Promise<void>;
  updateAlbum: (id: string, dto: UpdateAlbumDto) => Promise<void>;
  deleteAlbum: (id: string) => Promise<void>;
}

export function useAlbums(): UseAlbumsResult {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [meta, setMeta] = useState<MediaListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchAlbums = useCallback(async (params?: AlbumQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listAlbumsApi(params);
      if (!isMounted()) return;
      setAlbums(response.items);
      setMeta(response.meta);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch albums';
      setError(message);
      setAlbums([]);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  const addAlbum = useCallback(
    async (dto: CreateAlbumDto) => {
      setError(null);
      try {
        await createAlbumApi(dto);
        // Refresh the list after creation
        await fetchAlbums({ page: 1, pageSize: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create album';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAlbums, isMounted],
  );

  const updateAlbum = useCallback(
    async (id: string, dto: UpdateAlbumDto) => {
      setError(null);
      try {
        await updateAlbumApi(id, dto);
        // Refresh the list after update
        await fetchAlbums({ page: 1, pageSize: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update album';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAlbums, isMounted],
  );

  const deleteAlbum = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await deleteAlbumApi(id);
        // Refresh the list after deletion
        await fetchAlbums({ page: 1, pageSize: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete album';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAlbums, isMounted],
  );

  return {
    albums,
    meta,
    isLoading,
    error,
    fetchAlbums,
    addAlbum,
    updateAlbum,
    deleteAlbum,
  };
}
