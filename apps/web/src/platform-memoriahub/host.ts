/**
 * The web edition's `MemoriahubWebHost` (RETRO-J11, #626): the one thing the
 * packaged domain slices (`@marinoscar/memoriahub-web`) read from this app.
 *
 * `appMemoriahubApi` is the app's single API client (`services/api.ts`: bearer
 * token, refresh on 401, the owner-scope rewrite of `circleId`) in the shape the
 * package asks for. `buildMemoriahubHost` assembles the host from the values the
 * binding reads from the app's contexts (`HostBinding.tsx`); the components of
 * slices that have not moved into the package yet are its `slots`
 * (`slots.tsx`).
 */
import type {
  MemoriahubApiClient,
  MemoriahubFeatures,
  MemoriahubNotify,
  MemoriahubOwnerScopeValue,
  MemoriahubPrincipal,
  MemoriahubWebHost,
} from '@marinoscar/memoriahub-web/core/headless';

import { useShellMainVariant } from '@marinoscar/platform-web/shell/headless';

import { API_BASE_URL, api, rewriteEndpoint } from '../services/api';
import { rewriteBody } from '../services/ownerScopeParams';
import { appMemoriahubAdmin } from './admin';
import { appMemoriahubSlots } from './slots';

/** The app's API client as the package's `MemoriahubApiClient`. */
export const appMemoriahubApi: MemoriahubApiClient = {
  get: (endpoint, options) => api.get(endpoint, options),
  post: (endpoint, body, options) => api.post(endpoint, body, options),
  put: (endpoint, body, options) => api.put(endpoint, body, options),
  patch: (endpoint, body, options) => api.patch(endpoint, body, options),
  delete: (endpoint, options) => api.delete(endpoint, options),
  refreshToken: () => api.refreshToken(),
  rewriteEndpoint,
  rewriteBody,
  getAccessToken: () => api.getAccessToken(),
  baseUrl: API_BASE_URL,
};

/**
 * The web edition has no global toast yet (each page keeps its own snackbar), so
 * `notify` publishes a window event a future toast host can listen to.
 */
export const MEMORIAHUB_NOTIFY_EVENT = 'memoriahub:notify';

const notify: MemoriahubNotify = (message, severity = 'info') => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MEMORIAHUB_NOTIFY_EVENT, { detail: { message, severity } }));
};

/** What the binding reads from the app's contexts to build the host. */
export interface MemoriahubHostInputs {
  /** The signed-in user. */
  principal: MemoriahubPrincipal | null;
  /** True while the session boots. */
  authLoading: boolean;
  /** The feature flags. */
  features: MemoriahubFeatures;
  /** The active owner scope. */
  ownerScope: MemoriahubOwnerScopeValue;
  /** The router's `navigate`. */
  navigate: MemoriahubWebHost['navigate'];
}

/**
 * Assembles the host. Call it inside `useMemo`: consumers re-render when the
 * object's identity changes.
 *
 * @param inputs - the values read from the app's contexts.
 * @returns the host.
 */
export function buildMemoriahubHost(inputs: MemoriahubHostInputs): MemoriahubWebHost {
  return {
    apiClient: appMemoriahubApi,
    navigate: inputs.navigate,
    principal: inputs.principal,
    authLoading: inputs.authLoading,
    features: inputs.features,
    // The packaged media slice reads no setting yet; settings stay the platform
    // settings slice's (`hooks/useUserSettings.ts`), so the value is not loaded here.
    settings: {
      value: null,
      patch: async (partial) => {
        await api.patch('/user-settings', partial);
      },
    },
    ownerScope: inputs.ownerScope,
    notify,
    timeZone: inputs.principal?.timeZone ?? null,
    shell: { useMainVariant: useShellMainVariant },
    slots: appMemoriahubSlots,
    admin: appMemoriahubAdmin,
  };
}
