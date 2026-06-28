import type { PublicShareResponse } from '../types/sharing';

// ---------------------------------------------------------------------------
// Public API client — no Authorization header, no 401 refresh
// ---------------------------------------------------------------------------

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

class PublicApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'PublicApiError';
  }
}

async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new PublicApiError(
      (error as { message?: string }).message || 'Request failed',
      response.status,
    );
  }

  const body = await response.json();
  // Handle both wrapped { data: T } and unwrapped T responses
  return (body.data ?? body) as T;
}

// ---------------------------------------------------------------------------
// Public share endpoints
// ---------------------------------------------------------------------------

export async function getPublicShare(token: string): Promise<PublicShareResponse> {
  return publicGet<PublicShareResponse>(`/public/shares/${token}`);
}

/**
 * Returns the URL for a media item within a public share.
 * @param token - The share token
 * @param idx   - Zero-based index of the media item within the share
 */
export function publicMediaUrl(token: string, idx: number): string {
  return `${API_BASE_URL}/public/shares/${token}/media/${idx}`;
}

export { PublicApiError };
