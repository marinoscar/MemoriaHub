/**
 * This app's binding of the platform host (RETRO-B1, #597).
 *
 * `@marinoscar/platform-web` pages and headless hooks take their transport and
 * the viewer from ONE `PlatformHostProvider`. This file is the host:
 *
 *   - `api`: `appPlatformApi`, a `PlatformApiClient` over this app's own
 *     `ApiService` (`services/api.ts`), so the packaged hooks share the one
 *     bearer token, the one refresh-and-retry on a 401 and the one maintenance
 *     recogniser as every other call. Built ONCE at module scope: packaged
 *     hooks key on its identity.
 *   - `viewer`: the signed-in user. `hasPermission` is `usePermissions`'s, the
 *     same predicate every route guard uses. `isFeatureEnabled` answers `false`
 *     for everything: the host pages read no feature (the settings feature
 *     registry arrives with RETRO-B5).
 *   - `formatRelativeTime`: left to the package's built-in formatter.
 *
 * Mount `AppPlatformHostProvider` once, inside the auth provider.
 *
 * PLATFORM-ADOPTION-SHIM(#597): `appPlatformApi` is hand-written because
 * `createPlatformApiClient` wraps the package's `PlatformHttpClient`, and this
 * app still owns its own client class. Removed by RETRO-F1/RETRO-B2, which move
 * the app onto `PlatformHttpClient`.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { PlatformHostProvider, postSse } from '@marinoscar/platform-web/core';
import { readMaintenanceBlock, reportMaintenanceBlock } from '@marinoscar/platform-web/host/headless';
import type {
  PlatformApiClient,
  PlatformBlobResponse,
  PlatformRequestOptions,
  PlatformSseOptions,
  PlatformViewer,
  PlatformWebHost,
} from '@marinoscar/platform-web/core';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { API_BASE_URL, ApiError, api } from '../services/api';

/** Maps the platform's request options onto this app's `fetch` options. */
function toRequestInit(options: PlatformRequestOptions | undefined): RequestInit {
  if (!options) return {};
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  const init: RequestInit = { headers };
  if (options.signal) init.signal = options.signal;
  if (options.jsonBody !== undefined) init.body = JSON.stringify(options.jsonBody);
  return init;
}

/**
 * The packaged `postSse` over this app's client: the same `Authorization`
 * header and the same one refresh-and-retry on a 401. Paths are relative to the
 * API base.
 */
export function appPostSse(path: string, body: unknown, options: PlatformSseOptions): Promise<void> {
  return postSse<unknown>({
    url: `${API_BASE_URL}${path}`,
    body,
    authorization: () => {
      const token = api.getAccessToken();
      return token ? `Bearer ${token}` : null;
    },
    reauthenticate: () => api.refreshToken(),
    onFrame: options.onFrame,
    signal: options.signal,
    onErrorResponse: (status, body) => {
      const block = readMaintenanceBlock(status, body);
      if (block) reportMaintenanceBlock(block);
    },
  });
}

/**
 * `GET` a binary body (the Doctor's support bundle). `ApiService` only reads
 * JSON, so this is the same `fetch` with the same bearer token and the same
 * one refresh-and-retry on a 401, returning the body and the headers (the
 * filename is in `Content-Disposition`).
 *
 * PLATFORM-ADOPTION-SHIM(#602): removed with `appPlatformApi` (RETRO-F1/B2).
 */
export async function appGetBlob(
  path: string,
  options?: PlatformRequestOptions,
): Promise<PlatformBlobResponse> {
  const send = () => {
    const token = api.getAccessToken();
    return fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      signal: options?.signal,
      headers: { ...(options?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  let response = await send();
  if (response.status === 401 && (await api.refreshToken())) response = await send();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const block = readMaintenanceBlock(response.status, body);
    if (block) reportMaintenanceBlock(block);
    throw new ApiError(body.message || 'Request failed', response.status, body.code, body.details);
  }
  return { blob: await response.blob(), headers: response.headers };
}

/**
 * `POST` a JSON body and read a binary answer (the telemetry explorer's export, RETRO-T2 #625):
 * the same `fetch`, bearer token, one refresh-and-retry on a 401 and maintenance recogniser as
 * {@link appGetBlob}.
 *
 * PLATFORM-ADOPTION-SHIM(#597): removed with `appPlatformApi` (RETRO-F1/B2).
 */
export async function appPostBlob(
  path: string,
  body?: unknown,
  options?: PlatformRequestOptions,
): Promise<PlatformBlobResponse> {
  const send = () => {
    const token = api.getAccessToken();
    return fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      signal: options?.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  let response = await send();
  if (response.status === 401 && (await api.refreshToken())) response = await send();
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const block = readMaintenanceBlock(response.status, errorBody);
    if (block) reportMaintenanceBlock(block);
    throw new ApiError(errorBody.message || 'Request failed', response.status, errorBody.code, errorBody.details);
  }
  return { blob: await response.blob(), headers: response.headers };
}

/**
 * `POST` a `multipart/form-data` body and read the `{ data }` envelope (the android-app slice's APK
 * upload, RETRO-D5 #586; the optional `postFormData` port of `createAndroidAppClient`). No
 * `Content-Type`: the browser sets it with the boundary. Same bearer token, one refresh-and-retry
 * on a 401 and maintenance recogniser as {@link appGetBlob}. The body streams from the `File`, it
 * is never read into memory here.
 *
 * PLATFORM-ADOPTION-SHIM(#597): removed with `appPlatformApi` (RETRO-F1/B2).
 */
export async function appPostFormData<T>(path: string, form: FormData): Promise<T> {
  const send = () => {
    const token = api.getAccessToken();
    return fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
  };
  let response = await send();
  if (response.status === 401 && (await api.refreshToken())) response = await send();
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const block = readMaintenanceBlock(response.status, body);
    if (block) reportMaintenanceBlock(block);
    throw new ApiError(
      typeof body.message === 'string' ? body.message : 'Request failed',
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      body.details,
    );
  }
  return ('data' in body ? body.data : body) as T;
}

/** The `PlatformApiClient` over this app's HTTP client, plus the multipart port. Built ONCE, at module scope. */
export const appPlatformApi: PlatformApiClient & { postFormData<T>(path: string, form: FormData): Promise<T> } = {
  get: (path, options) => api.get(path, toRequestInit(options)),
  post: (path, body, options) => api.post(path, body, toRequestInit(options)),
  put: (path, body, options) => api.put(path, body, toRequestInit(options)),
  patch: (path, body, options) => api.patch(path, body, toRequestInit(options)),
  delete: (path, options) => api.delete(path, toRequestInit(options)),
  postSse: appPostSse,
  getBlob: appGetBlob,
  postBlob: appPostBlob,
  postFormData: appPostFormData,
};

/** This app's {@link PlatformWebHost}, memoised. Must run inside the auth provider. */
export function useAppPlatformHost(): PlatformWebHost {
  const { user, refreshUser } = useAuth();
  const { hasPermission } = usePermissions();

  const userId = user?.id ?? null;
  const email = user?.email ?? null;

  const viewer = useMemo<PlatformViewer>(
    () => ({
      userId,
      email,
      hasPermission,
      isFeatureEnabled: () => false,
      refresh: refreshUser,
    }),
    // `hasPermission` is re-created every render by `usePermissions`; the user's
    // permission list (what it reads) is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, email, user?.permissions, refreshUser],
  );

  return useMemo<PlatformWebHost>(() => ({ api: appPlatformApi, viewer }), [viewer]);
}

/** Mounts the packaged `PlatformHostProvider` with {@link useAppPlatformHost}. */
export function AppPlatformHostProvider({ children }: { children: ReactNode }) {
  const host = useAppPlatformHost();
  return <PlatformHostProvider host={host}>{children}</PlatformHostProvider>;
}
