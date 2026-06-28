/**
 * Tests for apps/web/src/services/publicApi.ts
 *
 * Covers:
 *  getPublicShare:
 *   - calls the correct URL (/api/public/shares/:token)
 *   - sends NO Authorization header (public, unauthenticated)
 *   - unwraps { data: T } wrapper from response
 *   - returns unwrapped body directly when there is no data wrapper
 *   - throws PublicApiError on non-OK status (4xx / 5xx)
 *   - includes the HTTP status code in the thrown error
 *
 *  publicMediaUrl:
 *   - returns the expected proxy path for index 0
 *   - returns the expected proxy path for arbitrary indices
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPublicShare, publicMediaUrl, PublicApiError } from '../../services/publicApi';
import type { PublicShareResponse } from '../../types/sharing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publicApi', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // getPublicShare
  // -------------------------------------------------------------------------

  describe('getPublicShare', () => {
    const token = 'abc123';
    const mediaPayload: PublicShareResponse = {
      type: 'media_item',
      media: { mediaType: 'photo', width: 1920, height: 1080 },
    };

    it('calls the correct URL for the given token', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse({ data: mediaPayload }));

      await getPublicShare(token);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const calledUrl = (fetchSpy.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain(`/public/shares/${token}`);
    });

    it('sends NO Authorization header', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse({ data: mediaPayload }));

      await getPublicShare(token);

      // fetch was called with only one argument (the URL string — no init object with headers)
      const args = fetchSpy.mock.calls[0] as unknown[];
      const init = args[1] as RequestInit | undefined;

      if (init?.headers) {
        const headers =
          init.headers instanceof Headers
            ? init.headers
            : new Headers(init.headers as HeadersInit);
        expect(headers.has('Authorization')).toBe(false);
      } else {
        // No init / no headers at all — that is fine; confirms no auth header
        expect(init?.headers).toBeUndefined();
      }
    });

    it('unwraps { data: T } wrapper from response', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse({ data: mediaPayload }));

      const result = await getPublicShare(token);

      expect(result).toEqual(mediaPayload);
    });

    it('returns body directly when there is no data wrapper', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(mediaPayload));

      const result = await getPublicShare(token);

      expect(result).toEqual(mediaPayload);
    });

    it('throws PublicApiError on 404 response', async () => {
      fetchSpy.mockResolvedValue(
        makeFetchResponse({ message: 'Share not found' }, 404),
      );

      await expect(getPublicShare(token)).rejects.toThrow(PublicApiError);
    });

    it('throws PublicApiError on 403 response', async () => {
      fetchSpy.mockResolvedValue(
        makeFetchResponse({ message: 'Forbidden' }, 403),
      );

      await expect(getPublicShare(token)).rejects.toThrow(PublicApiError);
    });

    it('throws PublicApiError on 500 response', async () => {
      fetchSpy.mockResolvedValue(
        makeFetchResponse({ message: 'Server error' }, 500),
      );

      await expect(getPublicShare(token)).rejects.toThrow(PublicApiError);
    });

    it('includes the HTTP status code in the thrown error', async () => {
      fetchSpy.mockResolvedValue(
        makeFetchResponse({ message: 'Gone' }, 410),
      );

      try {
        await getPublicShare(token);
        expect.fail('Expected PublicApiError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PublicApiError);
        expect((err as PublicApiError).status).toBe(410);
      }
    });

    it('includes the server message in the thrown error', async () => {
      fetchSpy.mockResolvedValue(
        makeFetchResponse({ message: 'Share has expired' }, 410),
      );

      try {
        await getPublicShare(token);
      } catch (err) {
        expect((err as PublicApiError).message).toBe('Share has expired');
      }
    });

    it('falls back to "Request failed" when response has no message', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse({}, 404));

      try {
        await getPublicShare(token);
      } catch (err) {
        expect((err as PublicApiError).message).toBe('Request failed');
      }
    });

    it('handles malformed JSON on error response gracefully', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      try {
        await getPublicShare(token);
      } catch (err) {
        expect(err).toBeInstanceOf(PublicApiError);
        expect((err as PublicApiError).status).toBe(500);
      }
    });

    it('returns album share data correctly', async () => {
      const albumPayload: PublicShareResponse = {
        type: 'album',
        itemCount: 3,
        items: [
          { mediaType: 'photo', width: 1920, height: 1080 },
          { mediaType: 'video', width: 1280, height: 720 },
          { mediaType: 'photo', width: null, height: null },
        ],
      };
      fetchSpy.mockResolvedValue(makeFetchResponse({ data: albumPayload }));

      const result = await getPublicShare(token);

      expect(result).toEqual(albumPayload);
      expect(result.type).toBe('album');
    });
  });

  // -------------------------------------------------------------------------
  // publicMediaUrl
  // -------------------------------------------------------------------------

  describe('publicMediaUrl', () => {
    it('returns the proxy path for index 0', () => {
      const url = publicMediaUrl('tok1', 0);
      expect(url).toContain('/public/shares/tok1/media/0');
    });

    it('returns the proxy path for arbitrary index', () => {
      const url = publicMediaUrl('tok1', 7);
      expect(url).toContain('/public/shares/tok1/media/7');
    });

    it('includes the token in the path', () => {
      const token = 'my-unique-token';
      const url = publicMediaUrl(token, 0);
      expect(url).toContain(token);
    });

    it('includes the index in the path', () => {
      const url = publicMediaUrl('tok', 42);
      expect(url).toContain('42');
    });

    it('returns different URLs for different tokens', () => {
      const url1 = publicMediaUrl('token-a', 0);
      const url2 = publicMediaUrl('token-b', 0);
      expect(url1).not.toBe(url2);
    });

    it('returns different URLs for different indices', () => {
      const url1 = publicMediaUrl('tok', 0);
      const url2 = publicMediaUrl('tok', 1);
      expect(url1).not.toBe(url2);
    });
  });
});
