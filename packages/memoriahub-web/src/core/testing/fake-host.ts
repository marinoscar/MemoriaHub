// =============================================================================
// createFakeMemoriahubWebHost: an in-memory MemoriahubWebHost for tests
// =============================================================================
//
// No network I/O, ever. HTTP is a router over `routes`, every call is kept in
// `calls` for assertions. A slice's tests render the page under
// `renderWithMemoriahubHost` with this host instead of mocking `fetch`.
// =============================================================================

import { MemoriahubApiError } from '../headless/api.js';
import type { MemoriahubAiSettings, MemoriahubEmailReadiness, MemoriahubSystemSettings } from '../headless/admin.js';
import type {
  MemoriahubApiClient,
  MemoriahubFeatures,
  MemoriahubPrincipal,
  MemoriahubRequestOptions,
  MemoriahubWebHost,
} from '../headless/host.js';
import type { MemoriahubOwnerScopeValue } from '../headless/owner-scope.js';
import { createFakeAdminPort } from './fake-admin.js';
import type { FakeAdminPort } from './fake-admin.js';

/**
 * What a route handler receives.
 *
 * @stability experimental
 */
export interface FakeRouteRequest {
  /** The HTTP verb. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The endpoint as the slice sent it, with its query string. */
  endpoint: string;
  /** The endpoint WITHOUT the query string. */
  path: string;
  /** The query string, parsed. */
  query: URLSearchParams;
  /** The request body as given. */
  body: unknown;
  /** The request options. */
  options: MemoriahubRequestOptions | undefined;
}

/**
 * A route's answer: a function called with the request, or the payload as it is.
 * To fail, throw {@link fakeApiError}.
 *
 * @stability experimental
 */
export type FakeRoute = ((request: FakeRouteRequest) => unknown | Promise<unknown>) | string | number | boolean | null | object;

/**
 * One recorded call.
 *
 * @stability experimental
 */
export type FakeCall = FakeRouteRequest;

/**
 * Builds the error a route throws to answer with a failure.
 *
 * @param status - the HTTP status.
 * @param message - the server message.
 * @param code - the machine code.
 * @param details - the structured details.
 * @returns the error.
 *
 * @stability experimental
 */
export function fakeApiError(status: number, message = 'Request failed', code?: string, details?: unknown): MemoriahubApiError {
  return new MemoriahubApiError(message, status, code, details);
}

/**
 * Options of {@link createFakeMemoriahubWebHost}.
 *
 * @stability experimental
 */
export interface FakeMemoriahubWebHostOptions {
  /** Routes keyed `'GET /media/albums'`; a `:name` segment matches anything. */
  routes?: Record<string, FakeRoute>;
  /** The principal. Default: a user with no permission. */
  principal?: Partial<MemoriahubPrincipal> | null;
  /** Feature flags. Default: none on. */
  features?: Partial<MemoriahubFeatures>;
  /** The owner scope. Default: a personal library with the id `lib-1`. */
  ownerScope?: Partial<MemoriahubOwnerScopeValue>;
  /** Slots. */
  slots?: MemoriahubWebHost['slots'];
  /** The deployment settings the fake admin port serves; `null` keeps the settings hook loading. Default: an empty document. */
  systemSettings?: Partial<MemoriahubSystemSettings> | null;
  /** With `systemSettings: null`, the load failure the fake settings hook reports. */
  systemSettingsError?: string;
  /** The AI settings the fake admin port serves (`null` while loading). Default: no providers. */
  aiSettings?: MemoriahubAiSettings | null;
  /** The chat models the fake admin port lists for any provider. */
  aiModels?: string[];
  /** The email readiness the fake admin port answers with. Default: no provider, disabled. */
  emailReadiness?: MemoriahubEmailReadiness;
}

/**
 * A fake host and what it recorded.
 *
 * @stability experimental
 */
export interface FakeMemoriahubWebHost {
  /** The host to hand to `MemoriahubWebHostProvider`. */
  host: MemoriahubWebHost;
  /** Every API call, in order. */
  calls: FakeCall[];
  /** Every `navigate` target, in order. */
  navigations: string[];
  /** Every `notify` message, in order. */
  notifications: Array<{ message: string; severity?: string }>;
  /** The fake admin port (data table, header, settings hook) and its recordings. */
  admin: FakeAdminPort;
  /** Replace or add a route. */
  setRoute(key: string, route: FakeRoute): void;
}

function matches(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

/**
 * Creates an in-memory host.
 *
 * @param options - routes, principal, features, owner scope and slots.
 * @returns the host and its recordings.
 *
 * @stability experimental
 */
export function createFakeMemoriahubWebHost(options: FakeMemoriahubWebHostOptions = {}): FakeMemoriahubWebHost {
  const routes = new Map<string, FakeRoute>(Object.entries(options.routes ?? {}));
  const calls: FakeCall[] = [];
  const navigations: string[] = [];
  const notifications: Array<{ message: string; severity?: string }> = [];
  const admin = createFakeAdminPort(options.systemSettings, options.systemSettingsError ?? null, {
    ai: options.aiSettings,
    models: options.aiModels,
    email: options.emailReadiness,
  });

  async function send<T>(method: FakeCall['method'], endpoint: string, body: unknown, opts?: MemoriahubRequestOptions): Promise<T> {
    const [path, qs = ''] = endpoint.split('?');
    const call: FakeCall = { method, endpoint, path, query: new URLSearchParams(qs), body, options: opts };
    calls.push(call);
    for (const [key, route] of routes) {
      const [m, pattern] = key.split(' ');
      if (m !== method || !matches(pattern, path)) continue;
      return (typeof route === 'function' ? await route(call) : route) as T;
    }
    throw fakeApiError(404, `No fake route for ${method} ${path}`);
  }

  const apiClient: MemoriahubApiClient = {
    get: (e, o) => send('GET', e, undefined, o),
    post: (e, b, o) => send('POST', e, b, o),
    put: (e, b, o) => send('PUT', e, b, o),
    patch: (e, b, o) => send('PATCH', e, b, o),
    delete: (e, o) => send('DELETE', e, undefined, o),
    refreshToken: async () => false,
    rewriteEndpoint: (endpoint) => endpoint,
    rewriteBody: (_endpoint, body) => body,
    getAccessToken: () => 'fake-token',
    baseUrl: '/api',
  };

  const ownerScope: MemoriahubOwnerScopeValue = {
    scopes: [],
    activeScope: { kind: 'me' },
    activeOption: { id: 'lib-1', kind: 'me', name: 'My library', description: null, role: 'admin' },
    activeRole: 'admin',
    personalLibraryId: 'lib-1',
    setActiveScope: async () => undefined,
    refreshScopes: async () => undefined,
    circles: [],
    activeCircle: null,
    activeCircleId: 'lib-1',
    activeCircleRole: 'circle_admin',
    loading: false,
    setActiveCircle: async () => undefined,
    refreshCircles: async () => undefined,
    ...options.ownerScope,
  };

  const host: MemoriahubWebHost = {
    apiClient,
    navigate: (to) => {
      navigations.push(to);
    },
    principal:
      options.principal === null
        ? null
        : { id: 'user-1', permissions: [], roles: [], displayName: null, timeZone: null, ...options.principal },
    features: {
      flags: {},
      pictureEnhancement: null,
      isLoading: false,
      error: null,
      refresh: async () => undefined,
      ...options.features,
    },
    authLoading: false,
    settings: { value: {}, patch: async () => undefined },
    ownerScope,
    notify: (message, severity) => {
      notifications.push({ message, severity });
    },
    timeZone: null,
    slots: options.slots,
    admin: admin.port,
  };

  return { host, calls, navigations, notifications, admin, setRoute: (key, route) => void routes.set(key, route) };
}
