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
  PlatformRequestOptions,
  PlatformSseOptions,
  PlatformViewer,
  PlatformWebHost,
} from '@marinoscar/platform-web/core';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { API_BASE_URL, api } from '../services/api';

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

/** The `PlatformApiClient` over this app's HTTP client. Built ONCE, at module scope. */
export const appPlatformApi: PlatformApiClient = {
  get: (path, options) => api.get(path, toRequestInit(options)),
  post: (path, body, options) => api.post(path, body, toRequestInit(options)),
  put: (path, body, options) => api.put(path, body, toRequestInit(options)),
  patch: (path, body, options) => api.patch(path, body, toRequestInit(options)),
  delete: (path, options) => api.delete(path, toRequestInit(options)),
  postSse: appPostSse,
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
