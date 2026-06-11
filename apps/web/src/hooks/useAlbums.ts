import { useState, useCallback } from 'react';
import type { Album, MediaListMeta, CreateAlbumDto, AlbumQueryParams } from '../types/media';
import {
  listAlbums as listAlbumsApi,
  createAlbum as createAlbumApi,
} from '../services/media';

interface UseAlbumsResult {
  albums: Album[];
  meta: MediaListMeta | null;
  isLoading: boolean;
  error: string | null;
  fetchAlbums: (params?: AlbumQueryParams) => Promise<void>;
  addAlbum: (dto: CreateAlbumDto) => Promise<void>;
}

export function useAlbums(): UseAlbumsResult {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [meta, setMeta] = useState<MediaListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAlbums = useCallback(async (params?: AlbumQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await listAlbumsApi(params);
      setAlbums(response.items);
      setMeta(response.meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch albums';
      setError(message);
      setAlbums([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addAlbum = useCallback(
    async (dto: CreateAlbumDto) => {
      setError(null);
      try {
        await createAlbumApi(dto);
        // Refresh the list after creation
        await fetchAlbums({ page: 1, pageSize: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create album';
        setError(message);
        throw err;
      }
    },
    [fetchAlbums],
  );

  return {
    albums,
    meta,
    isLoading,
    error,
    fetchAlbums,
    addAlbum,
  };
}
