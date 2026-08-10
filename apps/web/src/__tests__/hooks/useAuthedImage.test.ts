/**
 * Unit tests for useAuthedImage (issue #354, profile picture management).
 *
 * `GET /api/users/:id/avatar` is a byte proxy guarded by the JWT, so a bare
 * `<img src>` renders broken — this hook fetches the bytes with the bearer
 * token and hands back a local object URL.
 *
 * Covers:
 *  - Pass-through for already-signed / `https:` / `blob:` URLs (no fetch).
 *  - Fetches same-origin `/api/...` URLs with the bearer header and resolves
 *    an object URL.
 *  - Revokes the object URL on unmount and whenever `url` changes.
 *  - Resolves `src: null` on fetch failure so the caller falls back to
 *    initials.
 *
 * jsdom does not implement URL.createObjectURL / URL.revokeObjectURL, so both
 * are stubbed (same pattern as MediaPreviewContext.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAuthedImage } from '../../hooks/useAuthedImage';

vi.mock('../../services/api', () => ({
  api: {
    getAccessToken: vi.fn(),
    refreshToken: vi.fn(),
  },
}));

import { api } from '../../services/api';

const mockGetAccessToken = vi.mocked(api.getAccessToken);
const mockRefreshToken = vi.mocked(api.refreshToken);

let createObjectURLMock: ReturnType<typeof vi.fn>;
let revokeObjectURLMock: ReturnType<typeof vi.fn>;
let urlCounter = 0;

function makeBlobResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: () => Promise.resolve(new Blob(['fake-bytes'], { type: 'image/jpeg' })),
  } as unknown as Response;
}

describe('useAuthedImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    createObjectURLMock = vi.fn(() => `blob:mock-${++urlCounter}`);
    revokeObjectURLMock = vi.fn();
    (global as any).URL.createObjectURL = createObjectURLMock;
    (global as any).URL.revokeObjectURL = revokeObjectURLMock;
    mockGetAccessToken.mockReturnValue('test-access-token');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Pass-through
  // -------------------------------------------------------------------------
  describe('pass-through URLs', () => {
    it('passes an https:// provider URL through unchanged, without fetching', async () => {
      const providerUrl = 'https://lh3.googleusercontent.com/a/photo.jpg';
      const { result } = renderHook(() => useAuthedImage(providerUrl));

      await waitFor(() => {
        expect(result.current.src).toBe(providerUrl);
      });
      expect(result.current.isLoading).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('passes a blob: URL through unchanged, without fetching', async () => {
      const blobUrl = 'blob:http://localhost:3000/some-local-preview';
      const { result } = renderHook(() => useAuthedImage(blobUrl));

      await waitFor(() => {
        expect(result.current.src).toBe(blobUrl);
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('passes an already-signed storage URL through unchanged', async () => {
      const signedUrl = 'https://bucket.s3.amazonaws.com/thumb.jpg?X-Amz-Signature=abc';
      const { result } = renderHook(() => useAuthedImage(signedUrl));

      await waitFor(() => {
        expect(result.current.src).toBe(signedUrl);
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns null src and not loading for a null/undefined url', () => {
      const { result } = renderHook(() => useAuthedImage(null));
      expect(result.current.src).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Authenticated fetch
  // -------------------------------------------------------------------------
  describe('authenticated fetch', () => {
    it('fetches a same-origin /api/... URL with the bearer header and returns an object URL', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeBlobResponse(),
      );

      const { result } = renderHook(() =>
        useAuthedImage('/api/users/user-1/avatar?v=abc123'),
      );

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.src).toBe('blob:mock-1');
      });
      expect(result.current.isLoading).toBe(false);

      expect(fetch).toHaveBeenCalledWith(
        '/api/users/user-1/avatar?v=abc123',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-access-token' },
          credentials: 'include',
        }),
      );
      expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    });

    it('retries once after a 401 via api.refreshToken(), then succeeds', async () => {
      mockRefreshToken.mockResolvedValue(true);
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeBlobResponse(401))
        .mockResolvedValueOnce(makeBlobResponse(200));

      const { result } = renderHook(() =>
        useAuthedImage('/api/users/user-1/avatar'),
      );

      await waitFor(() => {
        expect(result.current.src).toBe('blob:mock-1');
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(mockRefreshToken).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------
  describe('object URL revocation', () => {
    it('revokes the object URL when the url prop changes', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeBlobResponse(),
      );

      const { result, rerender } = renderHook(
        ({ url }: { url: string }) => useAuthedImage(url),
        { initialProps: { url: '/api/users/user-1/avatar?v=1' } },
      );

      await waitFor(() => {
        expect(result.current.src).toBe('blob:mock-1');
      });

      rerender({ url: '/api/users/user-1/avatar?v=2' });

      await waitFor(() => {
        expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-1');
      });
      await waitFor(() => {
        expect(result.current.src).toBe('blob:mock-2');
      });
    });

    it('revokes the object URL on unmount', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeBlobResponse(),
      );

      const { result, unmount } = renderHook(() =>
        useAuthedImage('/api/users/user-1/avatar'),
      );

      await waitFor(() => {
        expect(result.current.src).toBe('blob:mock-1');
      });

      unmount();

      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-1');
    });
  });

  // -------------------------------------------------------------------------
  // Failure -> initials fallback
  // -------------------------------------------------------------------------
  describe('fetch failure', () => {
    it('resolves src: null when the fetch response is not ok (and refresh does not help)', async () => {
      mockRefreshToken.mockResolvedValue(false);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeBlobResponse(404),
      );

      const { result } = renderHook(() =>
        useAuthedImage('/api/users/user-1/avatar'),
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(result.current.src).toBeNull();
      expect(createObjectURLMock).not.toHaveBeenCalled();
    });

    it('resolves src: null when fetch itself rejects (network error)', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const { result } = renderHook(() =>
        useAuthedImage('/api/users/user-1/avatar'),
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(result.current.src).toBeNull();
    });
  });
});
