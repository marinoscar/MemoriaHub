import { useEffect, useState } from 'react';
import { api } from '../services/api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * True when the URL points at our own API and therefore needs the bearer token.
 *
 * Everything else — a provider's absolute `https://` picture, an already-signed
 * storage URL, a `blob:`/`data:` URI — is renderable by the browser directly
 * and is passed through untouched, which is what lets this hook be a drop-in
 * replacement for a plain `src` wherever the URL's origin is not known ahead of
 * time.
 */
function requiresAuth(url: string): boolean {
  return url.startsWith(`${API_BASE_URL}/`) || url.startsWith('/api/');
}

async function fetchAuthedBlob(url: string): Promise<Blob> {
  const send = () => {
    const token = api.getAccessToken();
    return fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
  };

  let response = await send();

  // Single-retry refresh, mirroring ApiService.request.
  if (response.status === 401 && (await api.refreshToken())) {
    response = await send();
  }

  if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
  return response.blob();
}

interface UseAuthedImageReturn {
  /** Renderable `src`, or null while loading / on failure (fall back to initials). */
  src: string | null;
  isLoading: boolean;
}

/**
 * Render image bytes that sit behind an authenticated API route.
 *
 * `GET /api/users/:id/avatar` is a byte proxy guarded by the JWT, so a bare
 * `<img src="/api/users/…/avatar">` renders broken — the browser sends no
 * Authorization header. This fetches the bytes with the token and hands back an
 * object URL, revoked on unmount and whenever `url` changes so a re-upload (a
 * new `?v=` cache-buster) never leaks the previous blob.
 *
 * Failures resolve to `src: null` rather than throwing: a missing avatar must
 * degrade to the initials fallback, never break the surface hosting it.
 */
export function useAuthedImage(url: string | null | undefined): UseAuthedImageReturn {
  const [src, setSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!url) {
      setSrc(null);
      setIsLoading(false);
      return;
    }

    // Pass-through: no auth needed, or no object-URL support (jsdom/old browser).
    if (!requiresAuth(url) || typeof URL.createObjectURL !== 'function') {
      setSrc(url);
      setIsLoading(false);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    setIsLoading(true);

    fetchAuthedBlob(url)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (active) setSrc(null);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return { src, isLoading };
}
