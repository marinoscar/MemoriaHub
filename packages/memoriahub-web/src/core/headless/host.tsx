// =============================================================================
// MemoriahubWebHost: the one thing a web slice reads from the app that mounts it
// =============================================================================
//
// A slice never imports the app's HTTP client, its auth context or its router
// helpers. It reads this object through `useMemoriahubHost()`, and the app
// provides it once with `MemoriahubWebHostProvider` (the web edition builds it in
// `apps/web/src/platform-memoriahub/host.ts`). That is what lets the same pages
// and hooks run in a host that is not the web edition. A packaged page that
// renders without a host refuses loudly (`MemoriahubHostMissingError`).
// =============================================================================

import { createContext, createElement, useContext } from 'react';
import type { ComponentType, ReactNode } from 'react';

import type { MemoriahubOwnerScopeValue } from './owner-scope.js';

/**
 * Options of one request over the host's API client.
 *
 * @stability experimental
 */
export interface MemoriahubRequestOptions {
  /** Extra request headers, for example `If-Match`. */
  headers?: Record<string, string>;
  /** Send the request without the bearer credential (a public route). */
  skipAuth?: boolean;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/**
 * The HTTP transport of a host.
 *
 * @remarks
 * Every method resolves with the response payload with the API's `{ data }`
 * envelope already removed, and rejects with a {@link MemoriahubApiError}.
 * Authentication, token refresh, the owner-scope rewrite of `circleId`
 * (`ownerGroupId` on the wire) and any app-wide error hook belong to the host.
 * `endpoint` is relative to the API root (`/media`, never `/api/media`).
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubApiClient {
  /** `GET`. */
  get<T>(endpoint: string, options?: MemoriahubRequestOptions): Promise<T>;
  /** `POST` with a JSON body. */
  post<T>(endpoint: string, body?: unknown, options?: MemoriahubRequestOptions): Promise<T>;
  /** `PUT` with a JSON body. */
  put<T>(endpoint: string, body?: unknown, options?: MemoriahubRequestOptions): Promise<T>;
  /** `PATCH` with a JSON body. */
  patch<T>(endpoint: string, body?: unknown, options?: MemoriahubRequestOptions): Promise<T>;
  /** `DELETE`. */
  delete<T>(endpoint: string, options?: MemoriahubRequestOptions): Promise<T>;
  /** Renews the access credential once (a 401 on a call that bypasses this client); `true` when renewed. */
  refreshToken(): Promise<boolean>;
  /** The owner-scope rewrite of an endpoint (`circleId` goes out as `ownerGroupId`), for the calls that bypass this client. */
  rewriteEndpoint(endpoint: string): string;
  /** The bearer credential, for the few calls that go out of the client (a byte upload). `null` when signed out. */
  getAccessToken(): string | null;
  /** The API root URL (`/api`), for the same calls. */
  readonly baseUrl: string;
}

/**
 * The signed-in user as a slice sees them.
 *
 * @stability experimental
 */
export interface MemoriahubPrincipal {
  /** The user's id. */
  id: string;
  /** The permission strings the user holds. */
  permissions: readonly string[];
  /** The names of the user's roles. */
  roles: readonly string[];
  /** The name to greet the user by, or `null`. */
  displayName: string | null;
  /** The raw stored IANA time zone of the user, `null` when they never chose one. */
  timeZone: string | null;
}

/**
 * The client-facing picture-enhancement policy (`GET /api/features`).
 *
 * @stability experimental
 */
export interface MemoriahubPictureEnhancementPolicy {
  /** `features.pictureEnhancement` AND the env kill-switch, resolved server-side. */
  enabled: boolean;
  /** When false, only "keep both" is offered on apply. */
  allowReplace: boolean;
  /** When true, "replace" is blocked if the enhanced image is smaller. */
  blockReplaceOnDownscale: boolean;
  /** The configured model NAME (never a credential); `null` when unset. */
  model: string | null;
  /** The most photos one bulk-enhance request may queue. */
  maxBatchSize: number;
}

/**
 * Deployment feature flags a slice reads.
 *
 * @stability experimental
 */
export interface MemoriahubFeatures {
  /** The raw global flag record; `null` while loading or when the read failed. */
  flags: Record<string, boolean> | null;
  /** The picture-enhancement policy; `null` while loading or when the read failed. */
  pictureEnhancement: MemoriahubPictureEnhancementPolicy | null;
  /** True while the flags load. */
  isLoading: boolean;
  /** The failure message, `null` when none. */
  error: string | null;
  /** Reload the flags. */
  refresh: () => Promise<void>;
}

/**
 * The user's settings a slice reads and patches.
 *
 * @stability experimental
 */
export interface MemoriahubSettingsPort {
  /** The settings document, `null` while loading. */
  value: Readonly<Record<string, unknown>> | null;
  /** Merge-patch the user's settings. */
  patch(partial: Record<string, unknown>): Promise<void>;
}

/**
 * How a slice tells the user something happened (a snackbar in the web edition).
 *
 * @stability experimental
 */
export type MemoriahubNotify = (message: string, severity?: 'success' | 'info' | 'warning' | 'error') => void;

/**
 * Options of `navigate`.
 *
 * @stability experimental
 */
export interface MemoriahubNavigateOptions {
  /** Replace the current history entry instead of pushing one. */
  replace?: boolean;
  /** Router state to carry. */
  state?: unknown;
}

/**
 * A deterministic search request a slice hands the host's search surface.
 *
 * @stability experimental
 */
export interface MemoriahubSearchRequest {
  /** The owner scope id the search runs in. */
  circleId: string;
  /** The filters, keyed by the search field ids. */
  filters: Record<string, unknown>;
}

/**
 * The host's search surface: a slice that has a filter to show (the map's "Show all
 * photos here") hands it over and the host navigates to the search page with it.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubSearchPort {
  /** Run a deterministic search and show its results. */
  runDeterministicSearch(request: MemoriahubSearchRequest): void;
}

/**
 * How a page asks the host's shell for a different layout of the main area.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubShellPort {
  /**
   * A React hook: while the calling page is mounted, the main area uses `variant`
   * (`full-bleed` drops the padding and the banners, as the map needs). It must be
   * the same function for the life of the host and follow the rules of hooks.
   */
  useMainVariant(variant: 'padded' | 'full-bleed'): void;
}

/**
 * Components of a slice that has not moved into this package yet, supplied by the host.
 *
 * @remarks
 * A slot is a bridge, not a design: when the slice that owns a component moves
 * into the package (J11 later parts), the package imports it directly and the
 * slot is deleted. Every slot is optional; a page that needs an absent slot
 * renders nothing in its place (`useMemoriahubSlot`). The prop types are the
 * contract the app's component already satisfies.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubWebSlots {
  /** Components registered by name; read with `useMemoriahubSlot`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: ComponentType<any> | undefined;
}

/**
 * Everything a web slice reads from its host. The only coupling between the
 * domain UI and the app that mounts it.
 *
 * @remarks
 * Build the object with `useMemo`: the state fields (`principal`, `features`,
 * `ownerScope`, `settings`, `timeZone`) change over a session and consumers
 * re-render when the object's identity changes; the transports (`apiClient`,
 * `navigate`, `notify`) are stable.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubWebHost {
  /** The HTTP transport. */
  apiClient: MemoriahubApiClient;
  /** Navigate to an app path (for code with no router, such as a hook). */
  navigate: (to: string, options?: MemoriahubNavigateOptions) => void;
  /** The signed-in user, `null` while nobody is signed in. */
  principal: MemoriahubPrincipal | null;
  /** Deployment feature flags. */
  features: MemoriahubFeatures;
  /** True while the session boots (the principal is not known yet). */
  authLoading: boolean;
  /** The user's settings. */
  settings: MemoriahubSettingsPort;
  /** The host's search surface; absent in a host that has none. */
  search?: MemoriahubSearchPort;
  /** The host's shell layout port; absent in a host whose shell has one layout. */
  shell?: MemoriahubShellPort;
  /** The active owner scope ("My library" or one group) and the caller's role in it. */
  ownerScope: MemoriahubOwnerScopeValue;
  /** Tell the user something happened. */
  notify: MemoriahubNotify;
  /** The IANA zone to render instants in (never `captured_at`, which is civil); `null` means the device's. */
  timeZone: string | null;
  /** Components the host supplies for slices that have not moved yet. */
  slots?: MemoriahubWebSlots;
}

/**
 * Thrown when a packaged page or hook runs without a `MemoriahubWebHostProvider`.
 *
 * @stability experimental
 */
export class MemoriahubHostMissingError extends Error {
  /** Names the missing provider so a stack trace is self-explanatory. */
  constructor() {
    super(
      'No MemoriahubWebHost: a @marinoscar/memoriahub-web page or hook needs a <MemoriahubWebHostProvider host={...}> above it. ' +
        'The app binds the host once (the web edition does it in apps/web/src/platform-memoriahub/).',
    );
    this.name = 'MemoriahubHostMissingError';
  }
}

const HostContext = createContext<MemoriahubWebHost | null>(null);

let activeHost: MemoriahubWebHost | null = null;

/**
 * Props of {@link MemoriahubWebHostProvider}.
 *
 * @stability experimental
 */
export interface MemoriahubWebHostProviderProps {
  /** The host. Build it with `useMemo`; consumers re-render when its identity changes. */
  host: MemoriahubWebHost;
  /** The tree that reads the host. */
  children?: ReactNode;
}

/**
 * Provides the host to the packaged pages and hooks, and binds it as the active
 * host the headless clients (`api`) send through.
 *
 * @param props - the host and the tree.
 * @returns the provider element.
 *
 * @stability experimental
 */
export function MemoriahubWebHostProvider({ host, children }: MemoriahubWebHostProviderProps): ReactNode {
  // The clients are plain functions called from effects and handlers, never
  // during render, so binding here (before the children render) is enough.
  activeHost = host;
  return createElement(HostContext.Provider, { value: host }, children);
}

/**
 * The host of the nearest provider.
 *
 * @returns the host.
 * @throws {@link MemoriahubHostMissingError} when there is no provider.
 *
 * @stability experimental
 */
export function useMemoriahubHost(): MemoriahubWebHost {
  const host = useContext(HostContext);
  if (!host) throw new MemoriahubHostMissingError();
  return host;
}

/**
 * Binds the active host without a provider (a bootstrap, a test of a plain function).
 *
 * @param host - the host, or `null` to clear it.
 *
 * @stability experimental
 */
export function setActiveMemoriahubHost(host: MemoriahubWebHost | null): void {
  activeHost = host;
}

/**
 * The active host, for the headless clients that run outside a component.
 *
 * @returns the active host.
 * @throws {@link MemoriahubHostMissingError} when none is bound.
 *
 * @stability experimental
 */
export function getActiveMemoriahubHost(): MemoriahubWebHost {
  if (!activeHost) throw new MemoriahubHostMissingError();
  return activeHost;
}

/**
 * A component the host supplies for a slice that has not moved into the package yet.
 *
 * @param name - the slot name.
 * @returns the component, or `undefined` when the host supplies none.
 *
 * @stability experimental
 */
export function useMemoriahubSlot<P = Record<string, unknown>>(name: string): ComponentType<P> | undefined {
  const host = useMemoriahubHost();
  return host.slots?.[name] as unknown as ComponentType<P> | undefined;
}
