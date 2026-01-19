import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useLibrary } from './useLibrary';
import { libraryApi } from '../services/api';
import type { LibraryDTO } from '@memoriahub/shared';

// Mock the library API
vi.mock('../services/api', () => ({
  libraryApi: {
    getLibrary: vi.fn(),
  },
}));

const mockLibrary: LibraryDTO = {
  id: 'lib-1',
  ownerId: 'owner-1',
  name: 'Family Photos',
  description: 'Our family collection',
  visibility: 'private',
  coverAssetId: null,
  coverUrl: null,
  assetCount: 42,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('useLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches library on mount when libraryId is provided', async () => {
    vi.mocked(libraryApi.getLibrary).mockResolvedValue(mockLibrary);

    const { result } = renderHook(() => useLibrary('lib-1'));

    // Initial state
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.library).toEqual(mockLibrary);
    expect(libraryApi.getLibrary).toHaveBeenCalledWith('lib-1');
  });

  it('does not fetch when libraryId is undefined', () => {
    const { result } = renderHook(() => useLibrary(undefined));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.library).toBe(null);
    expect(libraryApi.getLibrary).not.toHaveBeenCalled();
  });

  it('handles fetch errors', async () => {
    vi.mocked(libraryApi.getLibrary).mockRejectedValue(new Error('Library not found'));

    const { result } = renderHook(() => useLibrary('lib-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Library not found');
    expect(result.current.library).toBe(null);
  });

  it('refetches when libraryId changes', async () => {
    const mockLibrary2: LibraryDTO = { ...mockLibrary, id: 'lib-2', name: 'Vacation Photos' };

    vi.mocked(libraryApi.getLibrary)
      .mockResolvedValueOnce(mockLibrary)
      .mockResolvedValueOnce(mockLibrary2);

    const { result, rerender } = renderHook(
      ({ id }) => useLibrary(id),
      { initialProps: { id: 'lib-1' } }
    );

    await waitFor(() => {
      expect(result.current.library?.id).toBe('lib-1');
    });

    rerender({ id: 'lib-2' });

    await waitFor(() => {
      expect(result.current.library?.id).toBe('lib-2');
    });

    expect(libraryApi.getLibrary).toHaveBeenCalledTimes(2);
  });

  it('clears library when libraryId becomes undefined', async () => {
    vi.mocked(libraryApi.getLibrary).mockResolvedValue(mockLibrary);

    const { result, rerender } = renderHook(
      ({ id }) => useLibrary(id),
      { initialProps: { id: 'lib-1' as string | undefined } }
    );

    await waitFor(() => {
      expect(result.current.library).toEqual(mockLibrary);
    });

    rerender({ id: undefined });

    expect(result.current.library).toBe(null);
    expect(result.current.error).toBe(null);
  });
});
