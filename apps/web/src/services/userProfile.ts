import { api, ApiError } from './api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// ---------------------------------------------------------------------------
// Types — self-scoped profile surface (GET/PATCH /api/users/me/profile).
//
// Distinct from the deprecated `user_settings.profile` namespace: the avatar is
// now first-class user state with an explicit SOURCE, not a pair of loosely
// coupled `useProviderImage` / `customImageUrl` keys that could disagree.
// ---------------------------------------------------------------------------

/**
 * Where the effective avatar comes from.
 *
 * - `oauth`  — the identity provider's picture (`providerProfileImageUrl`)
 * - `upload` — a square JPEG the user uploaded and cropped
 * - `person` — rendered from the linked `Person`'s picture / cover face
 */
export type AvatarSource = 'oauth' | 'upload' | 'person';

/** The `Person` this account is linked to, if any. */
export interface LinkedPerson {
  id: string;
  /** Unlabeled clusters have no name — render a fallback, never assume a string. */
  name: string | null;
  circleId: string;
  circleName: string;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string | null;
  /**
   * Full path to the effective avatar, already carrying the `?v=` cache-buster
   * (e.g. `/api/users/<id>/avatar?v=ab12cd`) — an API path when the avatar is
   * stored server-side, otherwise the provider's absolute URL. Never build this
   * yourself; the `v=` token is what makes a re-upload visible immediately.
   *
   * NOTE: the API-path form requires the Authorization header, so it cannot be
   * dropped into a bare `<img src>` — go through `useAuthedImage`.
   */
  avatarUrl: string | null;
  avatarSource: AvatarSource;
  /** Provider picture URL; null when the identity provider supplied none. */
  providerProfileImageUrl: string | null;
  linkedPerson: LinkedPerson | null;
}

export interface UpdateUserProfileBody {
  /** `null` clears the override and falls back to the provider's name. */
  displayName?: string | null;
  avatarSource?: AvatarSource;
  /** `null` unlinks the person (the stored avatar, if any, is untouched). */
  linkedPersonId?: string | null;
}

// ---------------------------------------------------------------------------
// Multipart helper
//
// `api.request` JSON-stringifies bodies and forces a JSON Content-Type, so the
// avatar upload cannot go through it — the browser must set the multipart
// boundary itself. This mirrors `api.request`'s auth/refresh/unwrap behavior
// for the one endpoint that needs a raw body.
// ---------------------------------------------------------------------------

async function postMultipart<T>(endpoint: string, form: FormData): Promise<T> {
  const send = () => {
    const token = api.getAccessToken();
    return fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      // Deliberately NO Content-Type — fetch derives it (with the boundary)
      // from the FormData body. Setting it by hand breaks the upload.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      credentials: 'include',
    });
  };

  let response = await send();

  // Mirror the single-retry refresh flow in ApiService.request.
  if (response.status === 401 && (await api.refreshToken())) {
    response = await send();
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.message || 'Upload failed',
      response.status,
      error.code,
      error.details,
    );
  }

  const data = await response.json();
  return data && typeof data === 'object' && 'data' in data ? data.data : data;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch the caller's own profile (avatar source, provider picture, person link). */
export async function getMyProfile(): Promise<UserProfile> {
  return api.get<UserProfile>('/users/me/profile');
}

/** Partial update — display name, avatar source, and/or the linked person. */
export async function updateMyProfile(
  body: UpdateUserProfileBody,
): Promise<UserProfile> {
  return api.patch<UserProfile>('/users/me/profile', body);
}

/**
 * Upload cropped avatar bytes. Sets `avatarSource='upload'` server-side, so no
 * follow-up PATCH is needed.
 */
export async function uploadMyAvatar(
  blob: Blob,
  filename = 'avatar.jpg',
): Promise<UserProfile> {
  const form = new FormData();
  form.append('file', blob, filename);
  return postMultipart<UserProfile>('/users/me/avatar', form);
}

/**
 * Re-render the avatar from the currently linked person. Rejects with 400 when
 * there is no link, or the person has no usable picture or face crop.
 *
 * Deliberately NOT named `useLinkedPersonAvatar` — a `use` prefix on a plain
 * async function reads as a React hook at every call site.
 */
export async function applyLinkedPersonAvatar(): Promise<UserProfile> {
  return api.post<UserProfile>('/users/me/avatar/from-person');
}

/**
 * Clear the stored avatar and fall back to the provider picture. The person
 * LINK survives — only the rendered bytes and the source are reset.
 */
export async function deleteMyAvatar(): Promise<UserProfile> {
  return api.delete<UserProfile>('/users/me/avatar');
}
