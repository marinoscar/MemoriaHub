import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMedia } from './useMedia';
import { mediaApi } from '../services/api';
import type { MediaAssetDTO } from '@memoriahub/shared';

// Mock the media API
vi.mock('../services/api', () => ({
  mediaApi: {
    listMedia: vi.fn(),
  },
}));

const mockMediaList: MediaAssetDTO[] = [
  {
    id: 'media-1',
    libraryId: 'lib-1',
    originalFilename: 'photo1.jpg',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    fileSize: 1024000,
    fileSource: 'web',
    width: 1920,
    height: 1080,
    durationSeconds: null,
    cameraMake: null,
    cameraModel: null,
    latitude: null,
    longitude: null,
    country: null,
    state: null,
    city: null,
    locationName: null,
    capturedAtUtc: '2024-01-01T12:00:00Z',
    timezoneOffset: null,
    thumbnailUrl: 'https://example.com/thumb1.jpg',
    previewUrl: 'https://example.com/preview1.jpg',
    originalUrl: 'https://example.com/original1.jpg',
    status: 'READY',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

describe('useMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches media on mount when libraryId is provided', async () => {
    vi.mocked(mediaApi.listMedia).mockResolvedValue({
      data: mockMediaList,
      meta: { page: 1, limit: 24, total: 1 },
    });

    const { result } = renderHook(() => useMedia({ libraryId: 'lib-1' }));

    // Initial state
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.media).toHaveLength(1);
    expect(result.current.media[0].id).toBe('media-1');
    expect(mediaApi.listMedia).toHaveBeenCalledWith('lib-1', expect.objectContaining({
      page: 1,
      status: 'READY',
    }));
  });

  it('does not fetch when libraryId is undefined', async () => {
    const { result } = renderHook(() => useMedia({ libraryId: undefined }));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.media).toHaveLength(0);
    expect(mediaApi.listMedia).not.toHaveBeenCalled();
  });

  it('handles pagination with loadMore', async () => {
    vi.mocked(mediaApi.listMedia)
      .mockResolvedValueOnce({
        data: mockMediaList,
        meta: { page: 1, limit: 24, total: 50 },
      })
      .mockResolvedValueOnce({
        data: [{ ...mockMediaList[0], id: 'media-2' }],
        meta: { page: 2, limit: 24, total: 50 },
      });

    const { result } = renderHook(() => useMedia({ libraryId: 'lib-1' }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.hasMore).toBe(true);
    expect(result.current.media).toHaveLength(1);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.media).toHaveLength(2);
    expect(mediaApi.listMedia).toHaveBeenCalledTimes(2);
  });

  it('sets hasMore to false when all media is loaded', async () => {
    vi.mocked(mediaApi.listMedia).mockResolvedValue({
      data: mockMediaList,
      meta: { page: 1, limit: 24, total: 1 },
    });

    const { result } = renderHook(() => useMedia({ libraryId: 'lib-1' }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.hasMore).toBe(false);
  });

  it('handles fetch errors', async () => {
    vi.mocked(mediaApi.listMedia).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useMedia({ libraryId: 'lib-1' }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.media).toHaveLength(0);
  });

  it('applies filters to API call', async () => {
    vi.mocked(mediaApi.listMedia).mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 24, total: 0 },
    });

    renderHook(() => useMedia({
      libraryId: 'lib-1',
      mediaType: 'video',
      sortBy: 'createdAt',
      sortOrder: 'asc',
    }));

    await waitFor(() => {
      expect(mediaApi.listMedia).toHaveBeenCalledWith('lib-1', expect.objectContaining({
        mediaType: 'video',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      }));
    });
  });
});
